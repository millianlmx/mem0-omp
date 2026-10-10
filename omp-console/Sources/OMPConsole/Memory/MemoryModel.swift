// L'état observable de la section « Mémoire » (S-1, S-3, S-4, S-5, S-6) : quelle
// portée, quelle liste, quel état de service, et lequel des états d'écran s'affiche.
//
// Trois canaux, et chacun a UN sens (une erreur, un texte) :
//  - `state` : ce que la vue rend — la zone de contenu n'est jamais ambiguë, et
//    l'indisponibilité n'y est JAMAIS une liste vide (S-6.3, AC-8) ;
//  - `serviceAvailable` / `serviceError` : la sonde et le DERNIER message d'erreur,
//    affichés en en-tête en permanence (S-6.2) ;
//  - `selected` : le souvenir ouvert, dont le détail montre le texte COMPLET (S-5).
//
// Aucune scrutation : les trois seuls déclencheurs réseau sont l'apparition de la
// section, le bouton « Rafraîchir » et l'envoi d'une recherche (S-6).

import Combine
import ConsoleCore
import Foundation

@MainActor
final class MemoryModel: ObservableObject {
    /// Ce que la liste affiche : le sommaire du projet, ou les résultats d'une
    /// recherche nommée.
    enum ListMode: Equatable, Sendable {
        case summary
        case search(query: String)
    }

    /// Les états d'écran de BR-3, en une valeur ÉGALABLE : un test les confronte
    /// sans rendre de vue.
    enum State: Equatable, Sendable {
        case loading
        case noProject
        case unavailable(address: String, detail: String)
        /// Quelqu'un répond à l'adresse SANS porter le jeton d'installation (S-2,
        /// S-4) : jamais un état « disponible ».
        case foreignOwned(ForeignOwnership)
        case summaryEmpty(scope: String)
        case summary(scope: String, total: Int, rows: [MemoryRow])
        case searchEmptyNoMatch
        case searchEmptyNoScore
        case searchEmptyBelowThreshold
        case search(query: String, rows: [MemoryRow])
    }

    // Le champ de recherche vit dans le modèle : aucun `@State` n'est employé dans
    // cette section (interdit sous les Command Line Tools).
    @Published private(set) var query = ""
    @Published private(set) var scope: String?
    @Published private(set) var mode: ListMode = .summary
    /// Le sommaire et la recherche gardent CHACUN leur liste : revenir au sommaire
    /// ne coûte alors aucune requête (S-1, cas de la requête vide).
    @Published private(set) var summaryRows: [MemoryRow] = []
    @Published private(set) var summaryTotal = 0
    @Published private(set) var searchRows: [MemoryRow] = []
    @Published private(set) var candidates = 0
    @Published private(set) var scored = 0
    @Published private(set) var selectedId: String?
    @Published private(set) var serviceAvailable = false
    @Published private(set) var serviceError: String?
    /// L'état du prérequis oMLX (S-6, AC-6) : publié comme les autres, `unknown`
    /// tant que le service mem0 n'a pas été trouvé disponible — la sonde ne part
    /// jamais dans ce cas, et le bandeau non plus.
    @Published private(set) var omlx: OMLXStatus = .unknown
    @Published private(set) var isLoading = false
    /// Le propriétaire de l'adresse quand elle répond sans notre jeton (S-2) :
    /// non nil ⇒ l'état d'écran est `foreignOwned`.
    @Published private(set) var foreign: ForeignOwnership?
    /// Vrai pendant l'action de reprise (S-6) : le bouton et le rafraîchissement
    /// sont désactivés tant qu'elle tourne.
    @Published private(set) var recovering = false
    /// Faux tant que la première sonde n'a pas rendu : la vue n'affiche pas
    /// « Aucun projet ouvert » avant de savoir (S-4, S-6).
    @Published private(set) var prepared = false

    /// L'action de reprise de l'ancienne pile (S-6), posée par `OMPConsoleApp` sur
    /// `SetupModel.takeOverLegacyStack` : UNE seule implémentation pour les deux
    /// surfaces (feuille de préparation et section Mémoire).
    var recoverOwnership: (@MainActor () async -> Void)?

    /// L'adresse affichée en en-tête, celle de `MEM0_HTTP_URL` EFFECTIF (S-7).
    let address: String

    private let service: any MemoryServing
    private let scopeProvider: () async -> String?
    private var inFlight: Task<Void, Never>?

    /// La configuration de la pile (S-2) : d'où vient l'URL sondée pour oMLX (S-6).
    private let stackConfig: StackConfig
    /// La session de la sonde oMLX : injectée pour que les tests la stubent sans
    /// ouvrir de socket (les doublures `URLProtocol` du dépôt).
    private let omlxSession: URLSession
    /// La sonde de propriété de l'adresse (S-2) : injectée pour que les tests la
    /// doublent sans lancer `lsof`/`ps`.
    private let portOwner: @Sendable (String) async -> ForeignOwnership?

    /// L'URL RÉELLEMENT sondée pour oMLX — c'est elle que le bandeau nomme.
    let omlxProbeURL: URL

    init(
        service: (any MemoryServing)? = nil,
        scope: (() async -> String?)? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        defaults: UserDefaults = .standard,
        fileManager: FileManager = .default,
        paths: AppPaths = .standard(),
        stackConfig: StackConfig? = nil,
        omlxSession: URLSession = .shared,
        portOwner: (@Sendable (String) async -> ForeignOwnership?)? = nil
    ) {
        // Le jeton d'INSTALLATION est lu sur le disque (S-4) : c'est lui qui rend la
        // sonde identitaire. `MemoryServiceConfig.resolved` réunit environnement et
        // jeton.
        let config = MemoryServiceConfig.resolved(environment: environment, paths: paths)
        self.service = service ?? HTTPMemoryService(config: config)
        self.address = config.baseURL.absoluteString
        self.portOwner = portOwner ?? { address in
            await StackOwnership.foreignOwnership(
                address: address,
                paths: paths,
                environment: environment,
                run: .live
            )
        }
        // `stack/env` absent (ou illisible) ⇒ les défauts de la pile : l'URL de
        // sonde est alors `http://127.0.0.1:8000/models` (S-6, cas limite).
        let stack = stackConfig ?? StackEnvStore.load(at: paths.stackEnv, fileManager: fileManager) ?? .defaults
        self.stackConfig = stack
        self.omlxProbeURL = stack.omlxProbeURL
        self.omlxSession = omlxSession
        if let scope {
            self.scopeProvider = scope
        } else {
            // La portée suit le projet OUVERT : elle est résolue à chaque
            // chargement, jamais figée au lancement (la fenêtre « Session OMP »
            // peut en changer). Même formule que le graphe.
            self.scopeProvider = {
                await MemoryScope.currentProject(defaults: defaults, environment: environment, fileManager: fileManager)
            }
        }
    }

    // MARK: - Ce que la vue lit

    /// L'état d'écran courant, dérivé de l'état observable — jamais posé à la main,
    /// donc jamais désynchronisé. L'ORDRE des gardes est la règle de BR-3 :
    /// chargement, projet, service, puis la liste.
    var state: State {
        if !prepared { return .loading }
        // L'identité de l'adresse passe AVANT la portée : un service étranger n'est
        // jamais « disponible », même sans projet ouvert (S-4, S-5).
        if let foreign { return .foreignOwned(foreign) }
        guard let scope else { return .noProject }
        guard serviceAvailable else { return .unavailable(address: address, detail: serviceError ?? "") }
        switch mode {
        case .summary:
            if isLoading, summaryRows.isEmpty { return .loading }
            if summaryTotal == 0 { return .summaryEmpty(scope: scope) }
            return .summary(scope: scope, total: summaryTotal, rows: summaryRows)
        case let .search(query):
            if isLoading, searchRows.isEmpty { return .loading }
            if candidates == 0 { return .searchEmptyNoMatch }
            if scored == 0 { return .searchEmptyNoScore }
            if searchRows.isEmpty { return .searchEmptyBelowThreshold }
            return .search(query: query, rows: searchRows)
        }
    }

    var selected: MemoryRow? {
        guard let selectedId else { return nil }
        return displayedRows.first { $0.id == selectedId }
    }

    private var displayedRows: [MemoryRow] {
        switch mode {
        case .summary: summaryRows
        case .search: searchRows
        }
    }

    var canShowSummary: Bool {
        mode != .summary && !isLoading
    }

    var canRefresh: Bool {
        !isLoading && !recovering
    }

    // MARK: - Prérequis oMLX (S-6, AC-6)

    /// Le bandeau oMLX de la section, ou `nil` quand il n'y a rien à nommer.
    ///
    /// Il n'apparaît QUE si le service mem0 est disponible (quand il est
    /// indisponible, son propre message suffit — S-6) ET qu'oMLX est en défaut :
    /// injoignable, ou jeton refusé. Joignable ou encore `unknown` ⇒ aucun bandeau.
    /// C'est une LECTURE seule : aucun geste, aucune écriture.
    var omlxBanner: String? {
        guard serviceAvailable else { return nil }
        switch omlx {
        case .unreachable:
            return MemoryText.omlxUnreachable(url: omlxProbeURL.absoluteString)
        case .unauthorized:
            return MemoryText.omlxUnauthorized
        case .unknown, .reachable:
            return nil
        }
    }

    // MARK: - Geste : le champ de recherche

    /// Le champ de recherche de la barre d'outils. Le vider (croix du champ ou
    /// effacement) ramène la liste au sommaire DÉJÀ lu, sans aucune requête (S-1).
    func updateQuery(_ text: String) {
        query = text
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, mode != .summary {
            mode = .summary
            selectedId = nil
        }
    }

    // MARK: - Gestes : les trois déclencheurs réseau

    /// L'apparition de la section et le bouton « Rafraîchir » : une sonde neuve, puis
    /// la vue courante rechargée (S-6.3). C'est ce qui fait repasser l'état de
    /// « indisponible » à « disponible » après un redémarrage du service.
    func refresh() async {
        await perform { await self.probeAndReload() }
    }

    /// La validation du champ de recherche (S-1) : la sonde précède CHAQUE
    /// recherche, et une recherche demandée alors que le service est indisponible
    /// n'est jamais émise. Une requête vide après trim n'émet RIEN et ramène la
    /// liste au sommaire.
    func search() async {
        let requested = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !requested.isEmpty else {
            mode = .summary
            return
        }
        mode = .search(query: requested)
        searchRows = []
        candidates = 0
        scored = 0
        selectedId = nil
        await perform { await self.probeAndSearch(requested) }
    }

    /// Le bouton « Sommaire » de la barre d'outils (S-3) : retour au sommaire, le
    /// champ de recherche vidé pour que ce qu'il affiche corresponde à la liste. Le
    /// sommaire se recharge, sans sonde propre (S-6 n'en compte que trois).
    func showSummary() async {
        query = ""
        mode = .summary
        await perform { await self.loadSummaryIfPossible() }
    }

    /// Le bouton de reprise de l'état « pas la pile d'OMP Console » (S-6) : appelle
    /// l'action posée par l'app (`SetupModel.takeOverLegacyStack`) PUIS recharge la
    /// section — aucun état intermédiaire inventé, la vérité vient de la sonde
    /// suivante.
    func takeOverLegacyStack() async {
        guard !recovering else { return }
        recovering = true
        defer { recovering = false }
        await recoverOwnership?()
        await refresh()
    }

    // MARK: - Geste : ouvrir un souvenir

    func select(_ row: MemoryRow) {
        selectedId = row.id
    }

    /// La sélection telle que la `List` l'écrit : un identifiant, résolu en ligne.
    func select(id: String?) {
        guard let id else { return }
        selectedId = id
    }

    /// La section disparaît : la requête en vol est annulée. Il n'y a AUCUN sondage
    /// périodique à arrêter (S-6) — rien d'autre ne survit à la vue.
    func suspend() {
        inFlight?.cancel()
        inFlight = nil
    }

    // MARK: - Travail

    private func perform(_ work: @escaping @Sendable @MainActor () async -> Void) async {
        inFlight?.cancel()
        let task = Task { @MainActor in await work() }
        inFlight = task
        await task.value
    }

    private func probeAndReload() async {
        let health = await service.health()
        await apply(health)
        // La portée est résolue MÊME si le service est muet : elle ne coûte aucun
        // appel réseau, et sans elle l'état afficherait « Aucun projet ouvert » au
        // lieu de l'indisponibilité (S-4, S-6.3).
        if await resolveScope() != nil {
            await loadCurrent()
        }
        // La sonde oMLX (S-6) vient APRÈS la sonde de santé, et SEULEMENT quand le
        // service est disponible : sinon le message de la mémoire suffit, et la
        // sonde n'aurait aucun sens. Elle est placée après la lecture de la liste
        // pour que le prérequis ne bloque jamais la section ; son état est publié
        // comme les autres, jamais levé.
        if serviceAvailable {
            omlx = await OMLXProbe.status(config: stackConfig, session: omlxSession)
        }
        prepared = true
    }

    private func probeAndSearch(_ requested: String) async {
        let health = await service.health()
        await apply(health)
        prepared = true
        guard let scope = await resolveScope(), serviceAvailable else { return }
        await loadSearch(query: requested, scope: scope)
    }

    private func loadCurrent() async {
        guard serviceAvailable, let scope else { return }
        switch mode {
        case .summary:
            await loadSummary(scope: scope)
        case let .search(query):
            await loadSearch(query: query, scope: scope)
        }
    }

    private func loadSummaryIfPossible() async {
        guard await resolveScope() != nil else { return }
        await loadCurrent()
    }

    private func loadSummary(scope: String) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await service.all(scope: scope)
            if Task.isCancelled { return }
            summaryTotal = page.total
            summaryRows = page.rows
            selectedId = nil
        } catch {
            if Task.isCancelled { return }
            fail(error)
        }
    }

    private func loadSearch(query: String, scope: String) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let pool = MemorySearch.pool(requested: MemorySearch.defaultLimit)
            let received = try await service.search(query: query, scope: scope, pool: pool)
            if Task.isCancelled { return }
            let selection = MemorySearch.select(
                rows: received,
                floor: MemorySearch.threshold,
                limit: MemorySearch.defaultLimit
            )
            searchRows = selection.kept
            candidates = selection.candidates
            scored = selection.scored
            selectedId = nil
        } catch {
            if Task.isCancelled { return }
            fail(error)
        }
    }

    /// La portée est celle du projet courant, ou rien : dans ce cas AUCUN appel de
    /// portée n'est émis (S-4).
    private func resolveScope() async -> String? {
        let resolved = await scopeProvider()
        scope = resolved
        return resolved
    }

    /// Un succès efface le dernier message ; un échec le remplace et marque le
    /// service indisponible (S-6.3, S-6.4). Quand la réponse est « étrangère »
    /// (S-4), la sonde de propriété NOMME le titulaire de l'adresse (S-2) — sans
    /// elle, l'état resterait une indisponibilité muette.
    private func apply(_ health: MemoryHealth) async {
        serviceAvailable = health.isAvailable
        serviceError = health.isAvailable ? nil : (health.errorMessage ?? MemoryText.unreadableResponse)
        foreign = health.isForeign ? await portOwner(address) : nil
    }

    private func fail(_ error: Error) {
        serviceAvailable = false
        serviceError = MemoryServiceError.message(for: error)
    }
}
