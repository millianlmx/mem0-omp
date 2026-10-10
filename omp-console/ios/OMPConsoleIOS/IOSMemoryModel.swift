// Le modèle de l'écran Mémoire de l'app iOS (BR-2) : il porte le client partagé,
// déclenche les DEUX seules lectures (le sommaire du projet, une recherche), et
// dérive l'état d'écran par une fonction PURE, testable sans rendre de vue.
//
// Aucune scrutation : l'apparition de l'écran, le geste « Rafraîchir »/
// « Réessayer » et le retour du Mac (`onMacReconnected`, posé par l'écran) sont
// les SEULS déclencheurs (B-4, S-9). Une donnée déjà chargée prime sur le statut
// de connexion ; une donnée jamais chargée laisse parler le composant d'état de
// connexion.

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
    func memory(scope: String?, limit: Int?) async throws -> RemoteMemoryPagePayload
    func memorySearch(query: String, scope: String?, limit: Int?) async throws -> RemoteMemorySearchPayload
    func memoryGraph(scope: String?) async throws -> RemoteMemoryGraphPayload
}

extension ConsoleClientModel: IOSMemoryReading {}

/// Ce que la dernière lecture a rendu, ou la panne qu'elle a levée (S-3, S-4).
enum IOSMemoryLoad: Equatable {
    /// Rien n'a encore été lu.
    case idle
    /// Une lecture est en vol.
    case loading
    /// Le sommaire, tel que le Mac le sert.
    case page(RemoteMemoryPagePayload)
    /// Une recherche, telle que le Mac l'a sélectionnée.
    case search(RemoteMemorySearchPayload)
    /// La mémoire est injoignable côté Mac : le message relayé porte sa cause.
    case memoryUnavailable(String)
    /// Le Mac n'a pas répondu : l'état du CLIENT, jamais une cause mémoire.
    case macUnreachable
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
    case unavailable(detail: String)
    case macUnreachable
    case summaryEmpty(scope: String)
    case summary(scope: String, total: Int, rows: [RemoteMemoryRow], truncated: Bool)
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

    /// Le sommaire lu, gardé pour que le retour depuis une recherche ne coûte
    /// aucune requête (S-6).
    private var summaryPage: RemoteMemoryPagePayload?
    private var inFlight: Task<Void, Never>?

    init(client: any IOSMemoryReading) {
        self.client = client
    }

    // MARK: - Décisions PURES (testables sans render)

    /// Seul `.connected` autorise une lecture (patron `IOSProjectModel`).
    static func gesturesEnabled(_ state: ClientState) -> Bool {
        if case .connected = state { return true }
        return false
    }

    /// La classification d'une erreur de lecture (S-4) : une panne de TRANSPORT
    /// n'est jamais présentée comme une panne mémoire, et une erreur du contrat
    /// d'API l'est toujours.
    static func load(from error: Error) -> IOSMemoryLoad {
        guard let failure = error as? ClientError else { return .macUnreachable }
        switch failure {
        case .notConnected, .transport, .incompatibleProtocol, .decoding:
            return .macUnreachable
        case .api(let api):
            return .memoryUnavailable(api.message ?? "")
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
        summary: RemoteMemoryPagePayload?
    ) -> IOSMemoryScreenState {
        guard connection != .connected else { return reading(load: load, mode: mode) }
        switch load {
        case .page, .search:
            return reading(load: load, mode: mode)
        case .idle, .loading, .macUnreachable, .memoryUnavailable:
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
        case .macUnreachable:
            return .macUnreachable
        case .memoryUnavailable(let message):
            return .unavailable(detail: message.isEmpty ? IOSMemoryText.noData : message)
        case .page(let payload):
            guard let scope = payload.scope else { return .noProject }
            if case .search = mode { return .loading }
            if payload.total == 0 { return .summaryEmpty(scope: scope) }
            return .summary(scope: scope, total: payload.total, rows: payload.rows, truncated: payload.truncated)
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

    /// Le sommaire tel que le Mac l'a servi, ou `nil`.
    var summary: RemoteMemoryPagePayload? { summaryPage }

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

    // MARK: - Gestes : les deux seuls déclencheurs réseau (S-9)

    /// L'apparition de l'écran ET le geste « Rafraîchir »/« Réessayer » : la MÊME
    /// entrée, qui relance le chargement courant. Une lecture en vol est annulée
    /// avant la suivante (patron `MemoryModel.perform`).
    func refresh() async {
        guard Self.gesturesEnabled(client.state) else { return }
        inFlight?.cancel()
        let task = Task { @MainActor in await perform() }
        inFlight = task
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
                let page = try await client.memory(scope: nil, limit: nil)
                if Task.isCancelled { return }
                summaryPage = page
                load = .page(page)
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
}
