// Le modèle de l'écran Mémoire de l'app iOS (BR-2) : il porte le client partagé,
// déclenche les lectures (les pages du sommaire du projet, une recherche), et
// dérive l'état d'écran par une fonction PURE, testable sans rendre de vue.
//
// Aucune scrutation : l'apparition de l'écran, le geste « Rafraîchir »/
// « Réessayer » et le retour du Mac (`onMacReconnected`, posé par l'écran)
// relisent la PREMIÈRE page ; l'arrivée du pied de liste à l'écran lit la page
// SUIVANTE (défilement continu, memoire-ios-expire-a-10-secondes S-4). Une donnée
// déjà chargée prime sur le statut de connexion ; une donnée jamais chargée
// laisse parler le composant d'état de connexion.

import Combine
import ConsoleClient
import ConsoleCore
import Foundation

/// La surface dont l'écran Mémoire a besoin : l'état du client et ses DEUX
/// lectures. `ConsoleClientModel` la satisfait telle quelle ; un test la double
/// avec un compteur, sans ouvrir de socket ni mentir sur le client — même motif
/// que `MemoryServing`/`ScriptedMemoryService` de la coque macOS.
@MainActor
protocol IOSMemoryReading: AnyObject {
    var state: ClientState { get }
    func memoryPage(scope: String?, offset: Int, limit: Int?) async throws -> RemoteMemoryPagePayload
    func memorySearch(query: String, scope: String?, limit: Int?) async throws -> RemoteMemorySearchPayload
    func memoryGraph(scope: String?) async throws -> RemoteMemoryGraphPayload
}

extension ConsoleClientModel: IOSMemoryReading {}

/// L'état de la page suivante du sommaire (S-4) : le pied de liste le rend.
enum IOSMemoryMore: Equatable {
    /// Toute la portée est chargée : aucun pied.
    case complete
    /// Une page suivante existe : le pied la lit dès qu'il paraît.
    case available
    /// La page suivante est en vol.
    case loading
    /// La page suivante a échoué : les lignes restent, le pied offre Réessayer.
    case failed(message: String)
}

/// Le sommaire ACCUMULÉ du projet : les pages lues, dans l'ordre servi, chaque
/// souvenir une seule fois (le premier `id` vu est gardé).
struct IOSMemorySummary: Equatable {
    let scope: String?
    var total: Int
    var rows: [RemoteMemoryRow]
    var nextOffset: Int?
    var more: IOSMemoryMore

    init(firstPage page: RemoteMemoryPagePayload) {
        scope = page.scope
        total = page.total
        rows = []
        nextOffset = nil
        more = .complete
        append(page, requested: page.offset)
    }

    /// Ajoute une page lue au décalage `offset` : les lignes dont l'`id` est déjà
    /// là sont ignorées, et un `nextOffset` qui n'avance pas clôt la liste (aucune
    /// boucle possible sur une coque fautive).
    mutating func append(_ page: RemoteMemoryPagePayload, requested offset: Int) {
        var seen = Set(rows.map(\.id))
        for row in page.rows where seen.insert(row.id).inserted {
            rows.append(row)
        }
        total = page.total
        nextOffset = page.nextOffset.flatMap { $0 > offset ? $0 : nil }
        more = nextOffset == nil ? .complete : .available
    }
}

/// Ce que la dernière lecture a rendu, ou la panne qu'elle a levée (S-3, S-4).
enum IOSMemoryLoad: Equatable {
    /// Rien n'a encore été lu.
    case idle
    /// Une lecture est en vol.
    case loading
    /// Le sommaire accumulé, page après page.
    case page(IOSMemorySummary)
    /// Une recherche, telle que le Mac l'a sélectionnée.
    case search(RemoteMemorySearchPayload)
    /// La lecture a échoué : la cause distinguable rendue par le traducteur partagé.
    case failed(IOSMacFailure)
}

/// Ce que la section affiche : le sommaire du projet, ou les résultats d'une
/// recherche nommée (S-6).
enum IOSMemoryMode: Equatable {
    case summary
    case search(String)
}

/// Les états d'écran, en une valeur ÉGALABLE : un test les confronte sans rendre
/// de vue. Mêmes règles et mêmes mots que `MemoryModel.state` de la coque macOS.
enum IOSMemoryScreenState: Equatable {
    /// Rien de chargé, Mac non connecté : le composant d'état de connexion en
    /// plein écran (etats-non-connecte-heterogenes-ios, S-4).
    case offline(IOSConnectionStatus)
    case loading
    case noProject
    case failed(IOSMacFailure)
    case summaryEmpty(scope: String)
    case summary(scope: String, total: Int, rows: [RemoteMemoryRow], more: IOSMemoryMore)
    case searchEmptyNoMatch
    case searchEmptyNoScore
    case searchEmptyBelowThreshold
    case search(query: String, rows: [RemoteMemoryRow])
}

/// La cible de la feuille de détail : le souvenir PAR SON IDENTIFIANT (patron
/// `PipelinesSheet`), avec la ligne telle qu'elle a été touchée — la feuille ne
/// peut donc jamais s'ouvrir sur une ligne disparue.
struct IOSMemorySelection: Identifiable, Equatable {
    let row: RemoteMemoryRow
    var id: String { row.id }
}

@MainActor
final class IOSMemoryModel: ObservableObject {
    let client: any IOSMemoryReading

    @Published private(set) var query = ""
    @Published private(set) var mode: IOSMemoryMode = .summary
    @Published private(set) var load: IOSMemoryLoad = .idle
    /// Le souvenir ouvert, porté par l'identifiant de ligne.
    @Published var selection: IOSMemorySelection?

    /// Le sommaire accumulé, gardé pour que le retour depuis une recherche ne
    /// coûte aucune requête (S-6) et que les pages suivantes s'y ajoutent (S-4).
    private var summaryPage: IOSMemorySummary?
    private var inFlight: Task<Void, Never>?
    /// La lecture de la page suivante, annulée par tout rechargement.
    private var moreTask: Task<Void, Never>?

    init(client: any IOSMemoryReading) {
        self.client = client
    }

    // MARK: - Décisions PURES (testables sans render)

    /// Seul `.connected` autorise une lecture (patron `IOSProjectModel`).
    static func gesturesEnabled(_ state: ClientState) -> Bool {
        if case .connected = state { return true }
        return false
    }

    /// La classification d'une erreur de lecture : la cause vient du traducteur
    /// partagé, par son entrée Mémoire `IOSMacFailure.ofMemoryRead` — un délai
    /// dépassé n'y est jamais présenté comme un Mac injoignable (S-5). `nil` ⇔ 401 :
    /// le parcours de jeton révoqué parle seul, la section retombe sur l'état du client.
    static func load(from error: Error) -> IOSMemoryLoad {
        guard let cause = IOSMacFailure.ofMemoryRead(error) else { return .idle }
        return .failed(cause)
    }

    /// Le message d'une panne, tel que l'écran le montre : celui du pied de liste
    /// quand la page SUIVANTE échoue (S-5).
    static func failureMessage(_ load: IOSMemoryLoad) -> String {
        switch load {
        case .failed(let cause):
            return IOSMacErrorText.message(for: cause)
        case .idle, .loading, .page, .search:
            return IOSMacErrorText.message(for: .macUnreachable)
        }
    }

    /// L'état d'écran, dérivé du statut de connexion présenté, de la dernière
    /// lecture, du mode et du sommaire déjà servi. Hors connexion, une lecture
    /// aboutie (page ou recherche) reste affichée ; sinon le sommaire déjà servi
    /// reprend la main ; sinon c'est le composant d'état de connexion
    /// (etats-non-connecte-heterogenes-ios, S-4).
    static func screen(
        connection: IOSConnectionStatus,
        load: IOSMemoryLoad,
        mode: IOSMemoryMode,
        summary: IOSMemorySummary?
    ) -> IOSMemoryScreenState {
        guard connection != .connected else { return reading(load: load, mode: mode) }
        switch load {
        case .page, .search:
            return reading(load: load, mode: mode)
        case .idle, .loading, .failed:
            guard let summary else { return .offline(connection) }
            return reading(load: .page(summary), mode: .summary)
        }
    }

    /// L'état d'une lecture. L'ORDRE est la règle : une page à portée nulle ⇒
    /// « aucun projet » AVANT toute autre considération.
    private static func reading(load: IOSMemoryLoad, mode: IOSMemoryMode) -> IOSMemoryScreenState {
        switch load {
        case .idle, .loading:
            return .loading
        case .failed(let cause):
            return .failed(cause)
        case .page(let payload):
            guard let scope = payload.scope else { return .noProject }
            if case .search = mode { return .loading }
            if payload.total == 0 { return .summaryEmpty(scope: scope) }
            return .summary(scope: scope, total: payload.total, rows: payload.rows, more: payload.more)
        case .search(let result):
            guard case let .search(query) = mode else { return .loading }
            if result.candidates == 0 { return .searchEmptyNoMatch }
            if result.scored == 0 { return .searchEmptyNoScore }
            if result.rows.isEmpty { return .searchEmptyBelowThreshold }
            return .search(query: query, rows: result.rows)
        }
    }

    // MARK: - Faits dérivés

    /// L'état d'écran courant pour le statut présenté, jamais posé à la main
    /// (patron `MemoryModel.state`).
    func state(connection: IOSConnectionStatus) -> IOSMemoryScreenState {
        Self.screen(connection: connection, load: load, mode: mode, summary: summaryPage)
    }

    /// Le sommaire accumulé, ou `nil`.
    var summary: IOSMemorySummary? { summaryPage }

    /// La recherche telle que le Mac l'a sélectionnée, ou `nil`.
    var search: RemoteMemorySearchPayload? {
        if case let .search(payload) = load { return payload }
        return nil
    }

    /// La portée servie par le Mac : elle vient de la page, jamais d'un calcul local.
    var scope: String? { summaryPage?.scope }

    var isLoading: Bool { load == .loading }
    var isSearching: Bool { if case .search = mode { return true }; return false }
    var canRefresh: Bool { !isLoading }
    var canShowSummary: Bool { isSearching && !isLoading }

    /// Pourquoi « Sommaire » est indisponible, ou `nil` s'il l'est. La première
    /// règle qui s'applique gagne : le graphe, puis le sommaire déjà courant, puis
    /// une recherche en vol. `nil` ⇔ `canShowSummary` hors graphe.
    static func summaryUnavailableReason(graphShown: Bool, isSearching: Bool, isLoading: Bool) -> String? {
        if graphShown { return IOSMemoryText.summaryReasonGraph }
        if !isSearching { return IOSMemoryText.summaryReasonShown }
        if isLoading { return IOSMemoryText.summaryReasonSearching }
        return nil
    }

    func summaryUnavailableReason(graphShown: Bool) -> String? {
        Self.summaryUnavailableReason(graphShown: graphShown, isSearching: isSearching, isLoading: isLoading)
    }

    // MARK: - Gestes : les seuls déclencheurs réseau (S-9)

    /// L'apparition de l'écran ET le geste « Rafraîchir »/« Réessayer » : la MÊME
    /// entrée, qui relance le chargement courant — en sommaire, la PREMIÈRE page,
    /// qui remplace tout le sommaire accumulé. Une lecture en vol, page suivante
    /// comprise, est annulée avant la suivante (patron `MemoryModel.perform`).
    func refresh() async {
        guard Self.gesturesEnabled(client.state) else { return }
        dropPendingMore()
        inFlight?.cancel()
        let task = Task { @MainActor in await perform() }
        inFlight = task
        await task.value
    }

    /// L'arrivée du pied de liste à l'écran, ou son bouton « Réessayer » : lit la
    /// page SUIVANTE de la portée du sommaire (S-4). Ne lit rien hors `.connected`,
    /// hors du sommaire, sans page suivante, ou quand une page est déjà en vol —
    /// `more` passe à `.loading` AVANT la lecture, un second appel ne lit donc rien.
    func loadMore() async {
        guard Self.gesturesEnabled(client.state), mode == .summary,
              var summary = summaryPage, let scope = summary.scope, let offset = summary.nextOffset
        else { return }
        switch summary.more {
        case .available, .failed:
            break
        case .loading, .complete:
            return
        }
        summary.more = .loading
        publish(summary)
        let task = Task { @MainActor in await performMore(scope: scope, offset: offset) }
        moreTask = task
        await task.value
    }

    /// Le champ de recherche : le vider (croix système, ou blancs) ramène au
    /// sommaire DÉJÀ lu, sans émettre la moindre requête (S-6).
    func updateQuery(_ text: String) {
        query = text
        guard text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        guard isSearching else { return }
        showSummary()
    }

    /// La validation du champ (retour clavier) : une requête blanche n'émet RIEN.
    func submitQuery() async {
        let requested = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !requested.isEmpty, Self.gesturesEnabled(client.state) else { return }
        dropPendingMore()
        mode = .search(requested)
        inFlight?.cancel()
        let task = Task { @MainActor in await perform() }
        inFlight = task
        await task.value
    }

    /// Le bouton « Sommaire » : retour au sommaire DÉJÀ lu, aucune requête.
    func showSummary() {
        inFlight?.cancel()
        query = ""
        mode = .summary
        load = summaryPage.map(IOSMemoryLoad.page) ?? .idle
        selection = nil
    }

    // MARK: - Travail

    private func perform() async {
        load = .loading
        switch mode {
        case .summary:
            do {
                let page = try await client.memoryPage(scope: nil, offset: 0, limit: nil)
                if Task.isCancelled { return }
                let summary = IOSMemorySummary(firstPage: page)
                summaryPage = summary
                load = .page(summary)
            } catch {
                if Task.isCancelled { return }
                load = Self.load(from: error)
            }
        case let .search(query):
            do {
                let payload = try await client.memorySearch(query: query, scope: nil, limit: nil)
                if Task.isCancelled { return }
                load = .search(payload)
            } catch {
                if Task.isCancelled { return }
                load = Self.load(from: error)
            }
        }
    }

    /// La page suivante, lue à la portée EXPLICITE de la première page. Son
    /// résultat n'est appliqué que si elle n'a pas été annulée ET que le sommaire
    /// courant attend toujours ce décalage : une page tardive n'atterrit jamais
    /// dans un sommaire relu entre-temps.
    private func performMore(scope: String, offset: Int) async {
        let result: Result<RemoteMemoryPagePayload, Error>
        do {
            result = .success(try await client.memoryPage(scope: scope, offset: offset, limit: nil))
        } catch {
            result = .failure(error)
        }
        guard !Task.isCancelled, var summary = summaryPage,
              summary.more == .loading, summary.nextOffset == offset
        else { return }
        switch result {
        case .success(let page):
            summary.append(page, requested: offset)
        case .failure(let error):
            summary.more = .failed(message: Self.failureMessage(Self.load(from: error)))
        }
        publish(summary)
    }

    /// Annule la page suivante en vol et rend son pied à `.available` : la
    /// lecture reprendra quand le pied reparaîtra.
    private func dropPendingMore() {
        moreTask?.cancel()
        moreTask = nil
        guard var summary = summaryPage, summary.more == .loading else { return }
        summary.more = .available
        publish(summary)
    }

    /// Le sommaire accumulé devient la vérité ; l'écran ne le montre que s'il
    /// montrait déjà le sommaire.
    private func publish(_ summary: IOSMemorySummary) {
        summaryPage = summary
        if case .page = load { load = .page(summary) }
    }
}
