// La CARTE d'une session (session en graphe), partagée par le Mac et l'iPhone/iPad : ce
// que l'agent a lu, cherché, testé, modifié et décidé, en deux parties.
// - Le parcours : une voie par étape, dans l'ordre, avec son avancement (fait, en cours,
//   bloqué) et ce qu'elle a fait, en pastilles disposées par `GraphFlowLayout`.
// - Les dossiers touchés : chacun se déplie sur ses fichiers ; un dossier qui a regroupé
//   ses fichiers dit combien.
// Les décisions et les questions sont teintées, et ce qui les fonde (`evidence`) est
// surligné. Une pastille dont l'entrée du direct est connue s'ouvre d'un geste.
//
// `CardExplorationView` montre, sous la carte d'une question, la partie de la carte qui
// la fonde (repliée sur iPhone) ; `RunGraphSections` est l'onglet « Carte » de la page
// d'une feature. Aucun mot en dur : tout vient de `SessionGraphText`.

import ConsoleClient
import ConsoleCore
import SwiftUI

// MARK: - Disposition

/// Des pastilles en lignes qui reviennent à la ligne : une `Layout` native.
struct GraphFlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) -> CGSize {
        let rows = rows(width: proposal.width ?? .infinity, subviews: subviews)
        let width = rows.map(\.width).max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal _: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
        var y = bounds.minY
        for row in rows(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.items {
                let size = subviews[index].sizeThatFits(.init(width: bounds.width, height: nil))
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: .init(width: min(size.width, bounds.width), height: size.height))
                x += min(size.width, bounds.width) + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row {
        var items: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func rows(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var current = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.init(width: width, height: nil))
            let itemWidth = min(size.width, width)
            if !current.items.isEmpty, current.width + spacing + itemWidth > width {
                rows.append(current)
                current = Row()
            }
            current.width += (current.items.isEmpty ? 0 : spacing) + itemWidth
            current.height = max(current.height, size.height)
            current.items.append(index)
        }
        if !current.items.isEmpty { rows.append(current) }
        return rows
    }
}

// MARK: - Pastille d'un nœud

/// Un nœud en pastille : son icône, son libellé, teinté s'il est une décision ou une
/// question, surligné s'il fonde l'une d'elles ; un bouton quand `open` est donné.
struct GraphNodeChip: View {
    let node: HarnessGraphNode
    let highlighted: Bool
    var open: (@MainActor () -> Void)?

    var body: some View {
        if let open {
            Button { open() } label: { chip }
                .buttonStyle(.plain)
                .accessibilityHint(SessionGraphText.openLive)
                .consoleID("graph.node")
        } else {
            chip
        }
    }

    private var chip: some View {
        Label(Self.title(of: node), systemImage: Self.symbol(of: node))
            .font(.caption)
            .lineLimit(2)
            .foregroundStyle(node.isAmbiguity ? tint : Color.primary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .frame(minHeight: ConsolePlatform.minimumTarget > 0 && open != nil ? ConsolePlatform.minimumTarget : 0)
            .background(node.isAmbiguity ? tint.opacity(0.14) : Color.secondary.opacity(0.08), in: .capsule)
            .overlay {
                Capsule().strokeBorder(highlighted ? Color.orange : Color.clear, lineWidth: 1.5)
            }
            .help(node.path ?? node.pattern ?? node.label)
    }

    private var tint: Color { node.kind == "escalation" ? .orange : .purple }

    /// Ce que la pastille dit du nœud.
    static func title(of node: HarnessGraphNode) -> String {
        switch node.kind {
        case "step": return HarnessRun.label(forStep: node.label)
        case "dir":
            let path = node.path ?? node.label
            return node.grouped && node.files > 0 ? path + " · " + SessionGraphText.grouped(node.files) : path
        case "file":
            let name = (node.path ?? node.label).split(separator: "/").last.map(String.init) ?? node.label
            var parts = [name]
            if node.reads > 0 { parts.append(SessionGraphText.reads(node.reads)) }
            if node.edits > 0 { parts.append(SessionGraphText.edited) }
            return parts.joined(separator: " · ")
        case "search": return node.pattern.map(SessionGraphText.search) ?? node.label
        case "test":
            let outcome = switch node.outcome {
            case "pass": SessionGraphText.testPassed
            case "fail": SessionGraphText.testFailed
            default: SessionGraphText.testStopped
            }
            return node.label.isEmpty ? outcome : outcome + " · " + node.label
        case "edit": return SessionGraphText.edits(node.label)
        case "decision": return SessionGraphText.decision + " · " + node.label
        case "escalation": return SessionGraphText.escalation + " · " + node.label
        default: return node.label
        }
    }

    static func symbol(of node: HarnessGraphNode) -> String {
        switch node.kind {
        case "step": SessionGraphText.stepSymbol
        case "dir": SessionGraphText.dirSymbol
        case "search": SessionGraphText.searchSymbol
        case "test": SessionGraphText.testSymbol
        case "edit": SessionGraphText.editSymbol
        case "decision": SessionGraphText.decisionSymbol
        case "escalation": SessionGraphText.escalationSymbol
        default: SessionGraphText.fileSymbol
        }
    }
}

// MARK: - Carte

/// La carte d'un graphe : le parcours par étape, puis les dossiers touchés.
/// `focus` non vide : seulement ce qui touche ces nœuds (la carte d'une question).
/// `link` donne l'entrée du direct d'un nœud ; `open` l'ouvre.
public struct SessionGraphMapView: View {
    let graph: HarnessGraph
    let runState: String?
    var focus: Set<String> = []
    var link: (@MainActor (HarnessGraphNode) -> Int?)?
    var open: (@MainActor (Int) -> Void)?
    @State private var expanded: Set<String> = []

    public init(
        graph: HarnessGraph, runState: String?, focus: Set<String> = [],
        link: (@MainActor (HarnessGraphNode) -> Int?)? = nil, open: (@MainActor (Int) -> Void)? = nil
    ) {
        self.graph = graph
        self.runState = runState
        self.focus = focus
        self.link = link
        self.open = open
    }

    public var body: some View {
        let map = HarnessGraphMap.of(graph, runState: runState, focus: focus)
        let highlighted = focus.isEmpty ? graph.allHighlighted : focus
        VStack(alignment: .leading, spacing: 12) {
            if !map.lanes.isEmpty {
                Text(SessionGraphText.lanes)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(map.lanes.enumerated()), id: \.element.id) { index, lane in
                        laneRow(lane, last: index == map.lanes.count - 1, highlighted: highlighted)
                    }
                }
            }
            if !map.folders.isEmpty {
                Text(SessionGraphText.folders)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(map.folders) { folder in
                        folderRow(folder, highlighted: highlighted)
                    }
                }
            }
        }
        .consoleID("graph.map")
    }

    private func laneRow(_ lane: HarnessGraphLane, last: Bool, highlighted: Set<String>) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(spacing: 0) {
                Circle()
                    .fill(color(lane.progress))
                    .frame(width: 10, height: 10)
                    .padding(.top, 4)
                if !last {
                    Rectangle()
                        .fill(Color.secondary.opacity(0.35))
                        .frame(width: 1.5)
                        .frame(maxHeight: .infinity)
                }
            }
            .frame(width: 12)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    chip(lane.step, highlighted: highlighted)
                    Text(progressLabel(lane.progress))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(color(lane.progress))
                }
                let nodes = lane.actions + lane.reads
                if !nodes.isEmpty {
                    GraphFlowLayout {
                        ForEach(nodes) { node in
                            chip(node, highlighted: highlighted)
                        }
                    }
                }
            }
            .padding(.bottom, last ? 0 : 12)
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func folderRow(_ folder: HarnessGraphFolder, highlighted: Set<String>) -> some View {
        if folder.canExpand {
            DisclosureGroup(isExpanded: Binding(
                get: { !focus.isEmpty || expanded.contains(folder.id) },
                set: { open in
                    if open { expanded.insert(folder.id) } else { expanded.remove(folder.id) }
                }
            )) {
                GraphFlowLayout {
                    ForEach(folder.files) { file in
                        chip(file, highlighted: highlighted)
                    }
                }
                .padding(.vertical, 4)
            } label: {
                chip(folder.node, highlighted: highlighted)
            }
            .consoleID("graph.folder")
        } else {
            chip(folder.node, highlighted: highlighted)
        }
    }

    private func chip(_ node: HarnessGraphNode, highlighted: Set<String>) -> GraphNodeChip {
        let seq = link?(node)
        let action: (@MainActor () -> Void)? = if let seq, let open { { open(seq) } } else { nil }
        return GraphNodeChip(node: node, highlighted: highlighted.contains(node.id), open: action)
    }

    private func color(_ progress: HarnessGraphProgress) -> Color {
        switch progress {
        case .done: .green
        case .running: .blue
        case .blocked: .orange
        }
    }

    private func progressLabel(_ progress: HarnessGraphProgress) -> String {
        switch progress {
        case .done: SessionGraphText.done
        case .running: SessionGraphText.running
        case .blocked: SessionGraphText.blocked
        }
    }
}

// MARK: - Sous la carte d'une question

/// La carte d'exploration sous une question : la partie du graphe qui la fonde (sa
/// question et ses preuves surlignées), ouverte sur le Mac, repliée sur iPhone. Rien
/// n'est montré d'un serveur sans graphe, ni d'un graphe vide.
public struct CardExplorationView: View {
    @StateObject private var graph: HarnessRunGraph
    let escalationId: Int
    let runState: String?

    public init(server: HarnessModel, runId: String, escalationId: Int, runState: String?) {
        _graph = StateObject(wrappedValue: HarnessRunGraph(harness: server, runId: runId))
        self.escalationId = escalationId
        self.runState = runState
    }

    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif

    public var body: some View {
        // Un conteneur toujours présent : la lecture part même tant que rien n'est montré.
        VStack(alignment: .leading, spacing: 0) {
            if let read = graph.graph, !read.isEmpty {
                let focus = read.highlighted(escalation: escalationId)
                if collapses {
                    DisclosureGroup {
                        content(read, focus: focus)
                            .padding(.top, 6)
                    } label: {
                        title
                    }
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        title
                        content(read, focus: focus)
                    }
                }
            }
        }
        .task { await graph.load() }
        .consoleID("card.exploration")
    }

    /// Repliée sur iPhone (largeur compacte), ouverte ailleurs.
    private var collapses: Bool {
        #if os(iOS)
        sizeClass == .compact
        #else
        false
        #endif
    }

    private var title: some View {
        Label(SessionGraphText.explorationTitle, systemImage: SessionGraphText.explorationSymbol)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
    }

    private func content(_ read: HarnessGraph, focus: Set<String>) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(SessionGraphText.explorationHint)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            SessionGraphMapView(graph: read, runState: runState, focus: focus)
        }
    }
}

// MARK: - Onglet « Carte »

/// L'onglet « Carte » de la page d'une feature : le graphe de session en direct, ou ce
/// qui empêche de le lire. Le serveur sans graphe n'a pas d'onglet (`showsTab`).
public struct RunGraphSections: View {
    @ObservedObject var graph: HarnessRunGraph
    let runState: String?
    var link: (@MainActor (HarnessGraphNode) -> Int?)?
    var open: (@MainActor (Int) -> Void)?

    public init(
        graph: HarnessRunGraph, runState: String?,
        link: (@MainActor (HarnessGraphNode) -> Int?)? = nil, open: (@MainActor (Int) -> Void)? = nil
    ) {
        self.graph = graph
        self.runState = runState
        self.link = link
        self.open = open
    }

    public var body: some View {
        switch graph.availability {
        case .loading, .absent:
            Section {
                ProgressView()
                    .frame(maxWidth: .infinity)
            }
        case let .failed(failure):
            Section {
                ConsoleFailureBanner(failure: failure)
                Text(SessionGraphText.failed)
                    .foregroundStyle(.secondary)
            }
        case let .loaded(read):
            Section {
                if read.isEmpty {
                    Text(SessionGraphText.empty)
                        .foregroundStyle(.secondary)
                } else {
                    Text(SessionGraphText.legend)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    SessionGraphMapView(graph: read, runState: runState, link: link, open: open)
                }
            } header: {
                Label(SessionGraphText.tab, systemImage: SessionGraphText.tabSymbol)
            }
            .consoleID("run.graph")
        }
    }
}
