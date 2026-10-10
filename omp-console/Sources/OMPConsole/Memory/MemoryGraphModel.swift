// L'état observable du MODE GRAPHE de la section « Mémoire » (S-1, S-2, S-5, S-6,
// S-7, S-8, S-9, S-10, S-11).
//
// Il vit à l'échelle de l'APP (comme `MemoryModel`) : la bascule liste ⇄ graphe ne
// perd ni la position, ni la sélection, ni les filtres. Le mode LISTE ne le touche
// jamais — ses seuls appels réseau sont `refresh()`, `search()` et les écritures.
//
// Aucun `@State` n'est employé dans cette section : tout l'état mutable vit ici, et
// les vues construisent leurs liaisons à la main.
//
// Trois canaux, et chacun a UN sens :
//  - `state` : ce que le canevas rend — jamais un graphe partiel silencieux ;
//  - `visible` : ce qui s'affiche vraiment (filtres projet/étiquette + recherche) ;
//  - `errorLine` / `sheetError` : le DERNIER message d'erreur, dans la fiche ou
//    dans la feuille ouverte.

import Combine
import ConsoleCore
import CoreGraphics
import Foundation

@MainActor
final class MemoryGraphModel: ObservableObject {
    /// Les états d'écran du graphe, ÉGALABLES pour être confrontés en test sans
    /// rendre de vue (S-2).
    enum State: Equatable, Sendable {
        case idle
        case loading
        case unavailable(address: String, detail: String)
        case empty
        case graph(rows: [MemoryRow], edges: [MemoryGraphEdge])
    }

    /// L'état de la recherche du graphe (S-7) : `nil` ⇒ aucune restriction.
    enum SearchState: Equatable, Sendable {
        case none
        case query(String, found: Int)
        case empty
    }

    /// La feuille ouverte — une seule à la fois.
    enum Sheet: Equatable, Identifiable, Sendable {
        case create
        case edit(String)
        case link(String)

        var id: String {
            switch self {
            case .create: "memoire.create"
            case let .edit(memory): "memoire.edit.\(memory)"
            case let .link(memory): "memoire.link.\(memory)"
            }
        }
    }

    /// Une direction de déplacement au clavier (S-5).
    enum Direction: Equatable, Sendable {
        case left, right, up, down
    }

    // MARK: - Ce que la vue lit

    /// Le mode graphe est-il affiché ? Faux au départ : la LISTE est le mode initial
    /// (S-1).
    @Published private(set) var shown = false
    @Published private(set) var state: State = .idle
    @Published private(set) var query = ""
    @Published private(set) var searchState: SearchState = .none
    @Published private(set) var searchIds: Set<String>?
    @Published private(set) var projectFilter: String?
    @Published private(set) var tagFilter: String?
    @Published private(set) var zoom: CGFloat = 1
    @Published private(set) var pan: CGSize = .zero
    @Published private(set) var positions: [MemoryGraphNodeID: CGPoint] = [:]
    /// L'id du souvenir sélectionné (la fiche s'ouvre dessus).
    @Published private(set) var selection: String?
    @Published private(set) var hovered: MemoryGraphNodeID?
    @Published private(set) var manualLinks: Set<MemoryLink>
    /// Incrémenté après CHAQUE écriture réussie : `MemoryView` l'observe et recharge
    /// alors la liste, pour qu'elle reflète le changement (AC-10, AC-11, AC-12).
    @Published private(set) var mutations = 0
    /// La dernière erreur d'écriture, affichée dans la fiche (jamais un silence).
    @Published private(set) var errorLine: String?

    /// La feuille ouverte, et ses champs. Les feuilles posent leur état ICI, la vue
    /// le présente.
    @Published private(set) var sheet: Sheet?
    @Published var draftText = ""
    @Published var draftTags = ""
    @Published var draftScope = ""
    @Published var linkFilter = ""
    @Published private(set) var linkSelection: String?
    @Published private(set) var sheetError: String?
    @Published private(set) var sheetBusy = false
    /// La confirmation de suppression en attente (le substitut de `@State`).
    @Published private(set) var pendingDelete: String?

    /// L'adresse affichée par l'état indisponible, celle de `MEM0_HTTP_URL` (S-1).
    let address: String

    // MARK: - Dépendances

    private let service: any MemoryServing
    private let scopeProvider: () async -> String?
    private let paths: AppPaths
    private let layoutSeed: UInt64
    private let layoutIterations: Int
    private var inFlight: Task<Void, Never>?
    /// Le projet ouvert, résolu au chargement : il pré-remplit le menu « Projet » de
    /// la création (S-10).
    private var project: String?
    /// Le déplacement au début d'un glisser : la translation d'un `DragGesture` est
    /// relative à son début, pas au déplacement précédent.
    private var panAtDragStart: CGSize?
    /// Le zoom au début d'un pincement : le facteur du geste est cumulé depuis là.
    private var zoomAtGestureStart: CGFloat?

    init(
        service: (any MemoryServing)? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        defaults: UserDefaults = .standard,
        fileManager: FileManager = .default,
        paths: AppPaths = .standard(),
        scope: (() async -> String?)? = nil,
        layoutSeed: UInt64 = MemoryGraphLayout.defaultSeed,
        layoutIterations: Int = MemoryGraphLayout.defaultIterations
    ) {
        let config = MemoryServiceConfig.resolved(environment: environment, paths: paths)
        self.service = service ?? HTTPMemoryService(config: config)
        self.address = config.baseURL.absoluteString
        self.paths = paths
        self.layoutSeed = layoutSeed
        self.layoutIterations = layoutIterations
        self.scopeProvider = scope ?? {
            await MemoryScope.currentProject(defaults: defaults, environment: environment, fileManager: fileManager)
        }
        // Les liens manuels survivent à la relance : ils sont relus au lancement,
        // d'un fichier tolérant (S-11).
        self.manualLinks = MemoryLinkStore.load(paths.memoryLinks)
    }

    // MARK: - Ce que le graphe affiche

    /// Les lignes chargées.
    var rows: [MemoryRow] {
        if case let .graph(rows, _) = state { return rows }
        return []
    }

    /// Les arêtes du service.
    var edges: [MemoryGraphEdge] {
        if case let .graph(_, edges) = state { return edges }
        return []
    }

    /// TOUS les liens dérivables des lignes chargées : étiquettes, service, manuels.
    var allLinks: [MemoryGraphLink] {
        MemoryGraph.links(rows: rows, edges: edges, manual: manualLinks)
    }

    /// Ce qui s'affiche VRAIMENT : filtres projet et étiquette et recherche
    /// s'appliquent ensemble (S-6, S-7).
    var visible: (nodes: [MemoryGraphNode], links: [MemoryGraphLink]) {
        MemoryGraph.visibility(
            rows: rows,
            links: allLinks,
            project: projectFilter,
            tag: tagFilter,
            searchIds: searchIds
        )
    }

    /// Le souvenir sélectionné, s'il est encore chargé.
    var selected: MemoryRow? {
        guard let selection else { return nil }
        return rows.first { $0.id == selection }
    }

    /// Les portées DISTINCTES des souvenirs chargés, triées (S-6) : la portée vide
    /// s'affiche « Sans projet ».
    var filterProjects: [String] {
        Set(rows.map { MemoryGraph.scope(of: $0) }).sorted()
    }

    /// Les étiquettes DISTINCTES des souvenirs chargés, triées (S-6).
    var filterTags: [String] {
        Set(rows.flatMap { MemoryGraph.tags(of: $0) }).sorted()
    }

    /// Les projets proposés à la création (S-10) : les portées distinctes des
    /// souvenirs chargés ET le projet courant, triés. Une ligne sans portée ne
    /// propose pas « Sans projet » comme cible d'écriture — un souvenir s'écrit
    /// DANS un projet.
    var createScopes: [String] {
        var scopes = Set(rows.map { MemoryGraph.scope(of: $0) }.filter { !$0.isEmpty })
        if let project, !project.isEmpty { scopes.insert(project) }
        return scopes.sorted()
    }

    /// Le bandeau de compte du graphe (S-2).
    var countBanner: String {
        MemoryText.graphCount(
            memories: rows.count,
            projects: filterProjects.filter { !$0.isEmpty }.count,
            links: manualLinks.count
        )
    }

    // MARK: - Cycle de vie

    /// L'activation depuis la bascule : le mode devient le graphe, et il charge s'il
    /// ne l'a jamais fait. Un retour sur la section ne relance RIEN (c'est ⌘R qui
    /// rafraîchit, S-2).
    func activate() async {
        shown = true
        guard state == .idle else { return }
        await refresh()
    }

    /// Le retour à la liste : le graphe garde son état (position, sélection,
    /// filtres), il n'est simplement plus affiché.
    func hide() {
        shown = false
    }

    /// La section disparaît : la requête en vol est annulée. Aucun sondage
    /// périodique n'existe (S-2).
    func suspend() {
        inFlight?.cancel()
        inFlight = nil
    }

    /// ⌘R / « Rafraîchir » : une sonde neuve puis les DEUX lectures (sommaire toutes
    /// portées + arêtes). C'est ce qui fait apparaître un souvenir écrit par un agent
    /// pendant la session (AC-6).
    func refresh() async {
        await perform { await self.load() }
    }

    // MARK: - Geste : la recherche

    /// Le champ de recherche du graphe. Le vider lève la restriction SANS réseau
    /// (S-7).
    func updateQuery(_ text: String) {
        query = text
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            searchIds = nil
            searchState = .none
        }
    }

    /// La validation du champ : recherche TOUTES portées (aucun `agent_id`), pool de
    /// la liste, mais sans sa troncature à 6 (S-7).
    func search() async {
        let requested = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !requested.isEmpty else {
            searchIds = nil
            searchState = .none
            return
        }
        await perform { await self.loadSearch(requested) }
    }

    // MARK: - Gestes : les filtres

    func setProjectFilter(_ scope: String?) {
        projectFilter = scope
    }

    func setTagFilter(_ tag: String?) {
        tagFilter = tag
    }

    /// Les filtres dont la valeur a disparu après un rechargement reviennent à
    /// « tous » (S-6).
    private func resetVanishedFilters() {
        if let projectFilter, !filterProjects.contains(projectFilter) { self.projectFilter = nil }
        if let tagFilter, !filterTags.contains(tagFilter) { self.tagFilter = nil }
    }

    // MARK: - Gestes : la vue

    func setZoom(_ value: CGFloat) {
        zoom = min(MemoryGraphStyle.maxZoom, max(MemoryGraphStyle.minZoom, value))
    }

    func zoomIn() {
        setZoom(zoom * 1.25)
    }

    func zoomOut() {
        setZoom(zoom / 1.25)
    }

    /// Le pincement : le point sous le geste reste sous le geste (zoom centré). Le
    /// facteur d'un `MagnifyGesture` est CUMULÉ depuis son début : le zoom de départ
    /// est figé au premier changement, jamais à chaque image.
    func magnify(by factor: CGFloat, at anchor: CGPoint, size: CGSize) {
        let base = zoomAtGestureStart ?? zoom
        zoomAtGestureStart = base
        let target = min(MemoryGraphStyle.maxZoom, max(MemoryGraphStyle.minZoom, base * factor))
        guard target != zoom else { return }
        pan = MemoryGraphViewport(size: size, zoom: zoom, pan: pan).pan(keeping: anchor, zoom: target)
        zoom = target
    }

    func endMagnify() {
        zoomAtGestureStart = nil
    }

    /// Le déplacement de la vue : la translation d'un `DragGesture` est relative au
    /// DÉBUT du geste, donc le déplacement de départ est figé au premier changement.
    func drag(by translation: CGSize) {
        let origin = panAtDragStart ?? pan
        panAtDragStart = origin
        pan = CGSize(width: origin.width + translation.width, height: origin.height + translation.height)
    }

    func endDrag() {
        panAtDragStart = nil
    }

    /// ⌘0 : le graphe tient dans la zone visible (zoom 1, aucun déplacement).
    func recenter() {
        zoom = 1
        pan = .zero
    }

    // MARK: - Gestes : sélection, survol, clavier

    func select(_ id: String?) {
        selection = id
    }

    func hover(_ id: MemoryGraphNodeID?) {
        hovered = id
    }

    /// Le clic sur le canevas : un nœud de souvenir ouvre sa fiche, un nœud-étiquette
    /// applique le filtre de cette étiquette, le vide désélectionne (S-5).
    func click(at point: CGPoint, size: CGSize) {
        switch MemoryGraphHitTest.node(at: point, positions: positions, zoom: zoom, pan: pan, size: size) {
        case let .memory(id)?:
            selection = id
        case let .tag(name)?:
            tagFilter = name
        case nil:
            selection = nil
        }
    }

    /// Le déplacement au clavier : le nœud de souvenir le plus proche DANS cette
    /// direction. Aucun candidat ⇒ la sélection ne bouge pas (S-5).
    func moveSelection(_ direction: Direction) {
        let candidates = visible.nodes.compactMap { node -> (String, CGPoint)? in
            guard let id = node.id.memoryId, let position = positions[node.id] else { return nil }
            return (id, position)
        }
        guard !candidates.isEmpty else { return }
        let origin = selection.flatMap { id in positions[.memory(id)] } ?? CGPoint(x: 0.5, y: 0.5)

        func isAhead(_ point: CGPoint) -> Bool {
            let dx = point.x - origin.x
            let dy = point.y - origin.y
            switch direction {
            case .right: return dx > 0.0000001 && abs(dy) <= dx
            case .left: return dx < -0.0000001 && abs(dy) <= -dx
            case .down: return dy > 0.0000001 && abs(dx) <= dy
            case .up: return dy < -0.0000001 && abs(dx) <= -dy
            }
        }

        func distance(_ point: CGPoint) -> CGFloat {
            let dx = point.x - origin.x
            let dy = point.y - origin.y
            return (dx * dx + dy * dy).squareRoot()
        }

        let ahead = candidates.filter { isAhead($0.1) }
        let ranked = ahead.sorted { left, right in
            let dl = distance(left.1)
            let dr = distance(right.1)
            if dl != dr { return dl < dr }
            return left.0 < right.0
        }
        guard let next = ranked.first else { return }
        selection = next.0
    }

    // MARK: - Écriture : création, correction, suppression (S-8, S-9, S-10)

    func beginCreate() {
        draftText = ""
        draftTags = ""
        draftScope = project ?? createScopes.first ?? ""
        sheetError = nil
        sheet = .create
    }

    func beginEdit(_ id: String) {
        guard let row = rows.first(where: { $0.id == id }) else { return }
        // Pré-remplissage VERBATIM : aucun titre court, aucune transformation (S-8).
        draftText = row.text
        draftTags = MemoryTags.display(row.tags)
        sheetError = nil
        sheet = .edit(id)
    }

    func closeSheet() {
        sheet = nil
        sheetError = nil
        linkSelection = nil
        linkFilter = ""
    }

    /// « Enregistrer » n'est actif que si le texte n'est pas blanc après trim — et
    /// jamais pendant une écriture.
    var canSaveDraft: Bool {
        guard !sheetBusy, !draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        if sheet == .create, draftScope.isEmpty { return false }
        return true
    }

    /// La validation d'une feuille de création ou d'édition. Une erreur du service
    /// laisse la feuille OUVERTE et affiche son message : jamais « enregistré ».
    func saveDraft() async {
        guard canSaveDraft else { return }
        sheetBusy = true
        sheetError = nil
        defer { sheetBusy = false }
        switch sheet {
        case .create:
            do {
                try await service.add(text: draftText, scope: draftScope, tags: MemoryTags.list(draftTags))
            } catch {
                sheetError = MemoryServiceError.message(for: error)
                return
            }
        case let .edit(id):
            do {
                try await service.update(id: id, text: draftText, tags: MemoryTags.list(draftTags))
            } catch {
                sheetError = MemoryServiceError.message(for: error)
                return
            }
        case .link, nil:
            return
        }
        closeSheet()
        await afterMutation()
    }

    func requestDelete(_ id: String) {
        pendingDelete = id
    }

    func cancelDelete() {
        pendingDelete = nil
    }

    /// La suppression confirmée : le service d'abord, puis le rechargement — le
    /// souvenir quitte le graphe ET la liste, et ses liens manuels sont élagués du
    /// fichier par ce même rechargement (AC-11, AC-15).
    func confirmDelete() async {
        guard let id = pendingDelete else { return }
        pendingDelete = nil
        do {
            try await service.delete(id: id)
        } catch {
            errorLine = MemoryServiceError.message(for: error)
            return
        }
        if selection == id { selection = nil }
        await afterMutation()
    }

    // MARK: - Écriture : les liens manuels (S-11)

    func beginLink(_ id: String) {
        linkFilter = ""
        linkSelection = nil
        sheetError = nil
        sheet = .link(id)
    }

    /// Les candidats d'un lien : les souvenirs chargés, hors soi-même et hors liens
    /// déjà existants, filtrés par le champ texte local.
    var linkCandidates: [MemoryRow] {
        guard case let .link(source) = sheet else { return [] }
        let attached = Set(manualLinks.filter { $0.a == source || $0.b == source }.map { $0.a == source ? $0.b : $0.a })
        let needle = linkFilter.trimmingCharacters(in: .whitespaces).lowercased()
        return rows.filter { row in
            guard row.id != source, !attached.contains(row.id) else { return false }
            guard !needle.isEmpty else { return true }
            return row.text.lowercased().contains(needle)
        }
    }

    func selectLinkCandidate(_ id: String?) {
        linkSelection = id
    }

    /// La création du lien : le lien est visible IMMÉDIATEMENT (l'ensemble publié
    /// change), et l'échec d'écriture est dit — le lien reste pour la session.
    func createLink() {
        guard case let .link(source) = sheet,
              let target = linkSelection,
              let link = MemoryLinkStore.normalized(source, target) else { return }
        var links = manualLinks
        links.insert(link)
        manualLinks = links
        if !MemoryLinkStore.save(links, to: paths.memoryLinks) {
            errorLine = MemoryText.linkNotSaved
        }
        closeSheet()
        mutations += 1
    }

    func detach(_ link: MemoryLink) {
        var links = manualLinks
        links.remove(link)
        manualLinks = links
        if !MemoryLinkStore.save(links, to: paths.memoryLinks) {
            errorLine = MemoryText.linkNotSaved
        }
        mutations += 1
    }

    /// Les liens manuels d'un souvenir, dans l'ordre de leurs extrémités.
    func manualLinks(of id: String) -> [MemoryLink] {
        manualLinks
            .filter { $0.a == id || $0.b == id }
            .sorted()
    }

    /// L'autre extrémité d'un lien.
    func otherEnd(of link: MemoryLink, than id: String) -> String? {
        if link.a == id { return link.b }
        if link.b == id { return link.a }
        return nil
    }

    func row(_ id: String) -> MemoryRow? {
        rows.first { $0.id == id }
    }

    // MARK: - Travail

    private func perform(_ work: @escaping @Sendable @MainActor () async -> Void) async {
        inFlight?.cancel()
        let task = Task { @MainActor in await work() }
        inFlight = task
        await task.value
    }

    /// La sonde puis les DEUX lectures, ENSEMBLE : le sommaire de toutes les portées
    /// (aucun `agent_id`) et les arêtes du service (S-2). L'échec de l'une des deux
    /// rend l'état indisponible — jamais un graphe partiel silencieux.
    private func load() async {
        state = .loading
        errorLine = nil
        project = await scopeProvider()

        let health = await service.health()
        guard health.isAvailable else {
            state = .unavailable(address: address, detail: health.errorMessage ?? MemoryText.unreadableResponse)
            return
        }

        let page: MemoryPage
        let graph: MemoryGraphEdges
        do {
            async let loadedPage = service.all(scope: nil)
            async let loadedGraph = service.graph()
            (page, graph) = try await (loadedPage, loadedGraph)
        } catch {
            state = .unavailable(address: address, detail: MemoryServiceError.message(for: error))
            return
        }
        if Task.isCancelled { return }

        apply(page: page, graph: graph)
        state = page.rows.isEmpty ? .empty : .graph(rows: page.rows, edges: graph.edges)
        // Le placement s'exécute HORS du fil principal : il ne bloque jamais l'UI.
        // Ce qui traverse la frontière est un tableau de points (POD) — jamais un
        // dictionnaire clé par une `String`, dont le hachage est un piège mesuré en
        // release sur ce dépôt.
        let nodes = MemoryGraph.nodes(rows: page.rows)
        let links = MemoryGraph.links(rows: page.rows, edges: graph.edges, manual: manualLinks)
        let seed = layoutSeed
        let iterations = layoutIterations
        let points = await Task.detached(priority: .userInitiated) {
            MemoryGraphLayout.points(nodes: nodes, links: links, seed: seed, iterations: iterations)
        }.value
        var placed: [MemoryGraphNodeID: CGPoint] = [:]
        for (index, node) in nodes.enumerated() where index < points.count {
            placed[node.id] = points[index]
        }
        positions = placed
    }

    /// Ce qu'un chargement réussi met à jour : l'élagage des liens orphelins (écrit
    /// seulement s'il a changé), les filtres disparus, la sélection disparue.
    private func apply(page: MemoryPage, graph: MemoryGraphEdges) {
        let ids = Set(page.rows.map(\.id))
        let pruned = MemoryLinkStore.prune(manualLinks, keeping: ids)
        if pruned != manualLinks {
            manualLinks = pruned
            _ = MemoryLinkStore.save(pruned, to: paths.memoryLinks)
        }
        if let selection, !ids.contains(selection) { self.selection = nil }
        resetVanishedFilters()
    }

    private func loadSearch(_ requested: String) async {
        do {
            let pool = MemorySearch.pool(requested: MemorySearch.defaultLimit)
            let received = try await service.search(query: requested, scope: nil, pool: pool)
            if Task.isCancelled { return }
            // MÊME sélection que la liste (seuil, tri par cosinus), SANS sa troncature
            // à 6 : le graphe garde jusqu'au pool.
            let selection = MemorySearch.select(rows: received, floor: MemorySearch.threshold, limit: pool)
            let found = Set(selection.kept.map(\.id))
            searchIds = found
            searchState = found.isEmpty ? .empty : .query(requested, found: found.count)
        } catch {
            // Le service est muet : la restriction en place ne bouge pas, et l'état
            // indisponible porte la ligne d'erreur (S-7).
            state = .unavailable(address: address, detail: MemoryServiceError.message(for: error))
        }
    }

    /// Après une écriture réussie : le compteur publié (la liste se rechargera) et le
    /// graphe relu — le souvenir neuf ou disparu apparaît sans geste.
    private func afterMutation() async {
        mutations += 1
        await refresh()
    }
}
