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
    @Published private(set) var isLoading = false
    /// Faux tant que la première sonde n'a pas rendu : la vue n'affiche pas
    /// « Aucun projet ouvert » avant de savoir (S-4, S-6).
    @Published private(set) var prepared = false

    /// L'adresse affichée en en-tête, celle de `MEM0_HTTP_URL` EFFECTIF (S-7).
    let address: String

    private let service: any MemoryServing
    private let scopeProvider: () async -> String?
    private var inFlight: Task<Void, Never>?

    init(
        service: (any MemoryServing)? = nil,
        scope: (() async -> String?)? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        defaults: UserDefaults = .standard,
        fileManager: FileManager = .default
    ) {
        let config = MemoryServiceConfig.fromEnvironment(environment)
        self.service = service ?? HTTPMemoryService(config: config)
        self.address = config.baseURL.absoluteString
        if let scope {
            self.scopeProvider = scope
        } else {
            // La portée suit le projet OUVERT : elle est résolue à chaque
            // chargement, jamais figée au lancement (la fenêtre « Session OMP »
            // peut en changer).
            self.scopeProvider = {
                guard let root = ProjectRoot.resolve(defaults: defaults, fileManager: fileManager) else {
                    return nil
                }
                switch GitBinary.resolve(environment: environment, path: root.path, fileManager: fileManager) {
                case let .success(binary):
                    return await MemoryScope.scope(
                        projectRoot: root.path,
                        environment: environment,
                        git: GitCLI(binary: binary)
                    )
                case .failure:
                    return nil
                }
            }
        }
    }

    // MARK: - Ce que la vue lit

    /// L'état d'écran courant, dérivé de l'état observable — jamais posé à la main,
    /// donc jamais désynchronisé. L'ORDRE des gardes est la règle de BR-3 :
    /// chargement, projet, service, puis la liste.
    var state: State {
        if !prepared { return .loading }
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
        !isLoading
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
        apply(health)
        // La portée est résolue MÊME si le service est muet : elle ne coûte aucun
        // appel réseau, et sans elle l'état afficherait « Aucun projet ouvert » au
        // lieu de l'indisponibilité (S-4, S-6.3).
        guard await resolveScope() != nil else {
            prepared = true
            return
        }
        await loadCurrent()
        prepared = true
    }

    private func probeAndSearch(_ requested: String) async {
        let health = await service.health()
        apply(health)
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
    /// service indisponible (S-6.3, S-6.4).
    private func apply(_ health: MemoryHealth) {
        serviceAvailable = health.isAvailable
        serviceError = health.isAvailable ? nil : (health.errorMessage ?? MemoryText.unreadableResponse)
    }

    private func fail(_ error: Error) {
        serviceAvailable = false
        serviceError = MemoryServiceError.message(for: error)
    }
}
