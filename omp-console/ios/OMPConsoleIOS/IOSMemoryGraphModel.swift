// L'état observable du MODE GRAPHE de la section Mémoire de l'app iOS (S-3, S-4,
// S-6) : il lit une seule fois le graphe du Mac (`GET /v1/memory/graph`, via le
// client partagé), place les nœuds hors du fil principal, et porte les gestes de
// vue (pincer, glisser, toucher).
//
// Aucune écriture : la seule lecture est `client.memoryGraph(scope:)` — jamais une
// route d'écriture mémoire. Aucune scrutation : la bascule et « Rafraîchir » sont
// les deux seuls déclencheurs.
//
// L'état d'un souvenir vient du NŒUD du fil (`text`, `tags`, `scope`) : l'app ne
// recalcule rien.

import Combine
import ConsoleClient
import ConsoleCore
import CoreGraphics
import Foundation

@MainActor
final class IOSMemoryGraphModel: ObservableObject {
    /// Les états d'écran du graphe, ÉGALABLES pour être confrontés en test sans
    /// rendre de vue. « client non connecté » est dérivé de `client.state` (aucun
    /// cas dédié ici : rien n'a été lu).
    enum State: Equatable {
        case idle
        case loading
        case noProject
        case serviceOutdated
        case macOutdated
        case failed(IOSMacFailure)
        case empty
        case graph(
            nodes: [MemoryGraphNode],
            links: [MemoryGraphLink],
            positions: [MemoryGraphNodeID: CGPoint],
            truncated: Bool
        )
    }

    let client: any IOSMemoryReading

    /// Le mode graphe est-il affiché ? Faux au départ : la LISTE est le mode initial.
    @Published private(set) var shown = false
    @Published private(set) var state: State = .idle
    @Published private(set) var zoom: CGFloat = 1
    @Published private(set) var pan: CGSize = .zero
    /// L'id du souvenir sélectionné (la fiche s'ouvre dessus).
    @Published private(set) var selection: String?
    /// L'étiquette dont la famille est affichée, ou `nil` (vue entière).
    @Published private(set) var tagFilter: String?

    private var inFlight: Task<Void, Never>?
    private var panAtDragStart: CGSize?
    private var zoomAtGestureStart: CGFloat?

    init(client: any IOSMemoryReading) {
        self.client = client
    }

    // MARK: - Décisions PURES

    /// Seul `.connected` autorise une lecture (patron `IOSMemoryModel`).
    static func gesturesEnabled(_ state: ClientState) -> Bool {
        if case .connected = state { return true }
        return false
    }

    /// La classification d'une panne de lecture, par l'entrée Mémoire du traducteur
    /// partagé (`IOSMacFailure.ofMemoryRead`) : la route graphe n'émet aucun 404
    /// métier, tout `not_found` dit « app Mac trop ancienne » (D-4), et un délai
    /// dépassé reste distinct du Mac injoignable. Un 401 (`nil`) laisse l'état
    /// `.idle`, le parcours de révocation parle seul.
    static func failure(from error: Error) -> State {
        guard let cause = IOSMacFailure.ofMemoryRead(error) else { return .idle }
        switch cause {
        case .serviceOutdated: return .serviceOutdated
        case .macOutdated: return .macOutdated
        default: return .failed(cause)
        }
    }

    // MARK: - Ce que la vue lit

    /// Les lignes du graphe affiché, réduites par le filtre d'étiquette : la famille
    /// de l'étiquette (`MemoryGraph.tagFamily`, une seule règle), ou le graphe entier.
    var visible: (nodes: [MemoryGraphNode], links: [MemoryGraphLink]) {
        guard case let .graph(nodes, links, _, _) = state else { return ([], []) }
        if let tagFilter {
            return MemoryGraph.tagFamily(nodes: nodes, links: links, tag: tagFilter)
        }
        return (nodes, links)
    }

    /// Les nœuds-étiquettes de la charge utile (l'ordre du fil : triés par nom) —
    /// le menu du retour à la vue entière les propose tous.
    var tagNodes: [MemoryGraphNode] {
        guard case let .graph(nodes, _, _, _) = state else { return [] }
        return nodes.filter { $0.id.tagName != nil }
    }

    /// Les positions de placement du graphe affiché.
    var positions: [MemoryGraphNodeID: CGPoint] {
        if case let .graph(_, _, positions, _) = state { return positions }
        return [:]
    }

    /// Les libellés des nœuds du graphe affiché, par identité (la fiche nomme
    /// l'autre extrémité d'un lien).
    var nodeLabels: [MemoryGraphNodeID: String] {
        guard case let .graph(nodes, _, _, _) = state else { return [:] }
        var labels: [MemoryGraphNodeID: String] = [:]
        for node in nodes { labels[node.id] = node.label }
        return labels
    }

    /// Le graphe servait-il une charge tronquée ?
    var isTruncated: Bool {
        if case let .graph(_, _, _, truncated) = state { return truncated }
        return false
    }

    /// Le bandeau de compte : il suit la famille affichée (S-6).
    var countBanner: String {
        let nodes = visible.nodes
        let memories = nodes.filter { $0.id.memoryId != nil }.count
        let projects = Set(nodes.compactMap { $0.id.memoryId != nil ? $0.scope : nil }).filter { !$0.isEmpty }.count
        let links = visible.links.filter { $0.kind == .manual }.count
        return MemoryText.graphCount(memories: memories, projects: projects, links: links)
    }

    /// La ligne d'un souvenir, construite depuis son NŒUD du fil (S-5) : le texte
    /// intégral, les étiquettes et la portée sont des faits du fil.
    func row(_ id: String) -> RemoteMemoryRow? {
        guard case let .graph(nodes, _, _, _) = state else { return nil }
        guard let node = nodes.first(where: { $0.id == .memory(id) }) else { return nil }
        return RemoteMemoryRow(
            id: id,
            text: node.text ?? node.label,
            updatedAt: nil,
            score: nil,
            tags: node.tags,
            agentId: node.scope
        )
    }

    /// Les liens incidents d'un souvenir, mis en évidence par la scène PARTAGÉE.
    func links(of id: String) -> [MemoryGraphLink] {
        visible.links.filter { $0.a.memoryId == id || $0.b.memoryId == id }
    }

    // MARK: - Cycle de vie

    /// L'activation depuis la bascule : le mode devient le graphe, et il charge s'il
    /// ne l'a jamais fait. Un retour sur la section ne relance RIEN.
    func activate() async {
        shown = true
        guard state == .idle else { return }
        await perform { await self.load() }
    }

    /// Le retour à la liste : le graphe garde son état (position, sélection,
    /// filtre), il n'est simplement plus affiché.
    func hide() {
        shown = false
    }

    /// La section disparaît : la requête en vol est annulée, et un chargement
    /// annulé ne laisse AUCUN état de chargement (un retour relit). Aucun sondage.
    func suspend() {
        inFlight?.cancel()
        inFlight = nil
        if state == .loading { state = .idle }
    }

    /// « Rafraîchir » : une lecture neuve du graphe.
    func refresh() async {
        guard Self.gesturesEnabled(client.state) else { return }
        await perform { await self.load() }
    }

    /// Publie une charge utile DÉJÀ lue (crochet de recette) : rien n'est appelé.
    /// C'est le seul chemin qui ne dépend pas de l'état du client — la recette ne
    /// lit rien.
    func apply(_ payload: RemoteMemoryGraphPayload) async {
        await publish(payload)
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

    /// Le graphe tient dans la zone visible (zoom 1, aucun déplacement).
    func recenter() {
        zoom = 1
        pan = .zero
    }

    // MARK: - Gestes : sélection et filtre

    func select(_ id: String?) {
        selection = id
    }

    /// Le clic sur le canevas : un nœud de souvenir ouvre sa fiche, un nœud-étiquette
    /// APPLIQUE le filtre de cette étiquette (même chemin que macOS), le vide
    /// désélectionne.
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

    func setTagFilter(_ tag: String?) {
        tagFilter = tag
    }

    /// La marque du menu d'étiquettes (S-6) : vrai quand `tag` (`nil` = « Toutes ») est le choix courant.
    func isCurrentTag(_ tag: String?) -> Bool {
        tagFilter == tag
    }

    // MARK: - Travail

    private func perform(_ work: @escaping @Sendable @MainActor () async -> Void) async {
        inFlight?.cancel()
        let task = Task { @MainActor in await work() }
        inFlight = task
        await task.value
    }

    /// La lecture : une seule route (`memoryGraph`), et rien hors `.connected`.
    private func load() async {
        guard Self.gesturesEnabled(client.state) else { return }
        state = .loading
        do {
            let payload = try await client.memoryGraph(scope: nil)
            if Task.isCancelled { return }
            await publish(payload)
        } catch {
            if Task.isCancelled { return }
            state = Self.failure(from: error)
        }
    }

    /// Le placement (hors du fil principal) puis la publication de l'état : le
    /// chargement couvre la lecture ET le placement, le canevas n'est jamais vide.
    private func publish(_ payload: RemoteMemoryGraphPayload) async {
        // La coque n'a résolu aucune portée : « aucun projet », jamais un graphe vide.
        guard payload.scope != nil else {
            resetVanished(nodes: [])
            state = .noProject
            return
        }
        let nodes = payload.nodes.compactMap(Self.node)
        let links = payload.links.compactMap(Self.link)
        // La frontière d'isolation ne transporte qu'un tableau de points (POD) : un
        // dictionnaire clé par une `String` y est un piège mesuré en release.
        let points = await Task.detached(priority: .userInitiated) {
            MemoryGraphLayout.points(nodes: nodes, links: links)
        }.value
        var positions: [MemoryGraphNodeID: CGPoint] = [:]
        for (index, node) in nodes.enumerated() where index < points.count {
            positions[node.id] = points[index]
        }
        resetVanished(nodes: nodes)
        state = nodes.isEmpty
            ? .empty
            : .graph(nodes: nodes, links: links, positions: positions, truncated: payload.truncated)
    }

    /// Une sélection ou un filtre dont la valeur a disparu après un rechargement
    /// revient à son défaut (même règle que `resetVanishedFilters` macOS).
    private func resetVanished(nodes: [MemoryGraphNode]) {
        if let tagFilter, !nodes.contains(where: { $0.id == .tag(tagFilter) }) {
            self.tagFilter = nil
        }
        if let selection, !nodes.contains(where: { $0.id == .memory(selection) }) {
            self.selection = nil
        }
    }

    /// Un nœud du fil, ou `nil` si son identifiant est illisible (entrée ignorée).
    private static func node(_ wire: RemoteMemoryGraphNode) -> MemoryGraphNode? {
        guard let id = MemoryGraphWire.nodeID(wire.id) else { return nil }
        let scope = wire.scope.isEmpty ? nil : wire.scope
        return MemoryGraphNode(id: id, label: wire.label, scope: scope, text: wire.text, tags: wire.tags ?? [])
    }

    /// Un lien du fil, ou `nil` si une extrémité est illisible ou la nature inconnue.
    private static func link(_ wire: RemoteMemoryGraphLink) -> MemoryGraphLink? {
        guard let a = MemoryGraphWire.nodeID(wire.a),
              let b = MemoryGraphWire.nodeID(wire.b),
              let kind = MemoryGraphWire.kind(wire.kind, score: wire.score)
        else { return nil }
        return MemoryGraphLink(a: a, b: b, kind: kind)
    }
}
