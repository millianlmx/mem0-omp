// Le MODE GRAPHE de la section Mémoire de l'app iOS (S-4, S-5, S-6) : la rangée de
// commandes (compte, étiquettes, zoom, recentrer) puis le canevas — un `Canvas` qui
// ne fait que PEINDRE la scène partagée `MemoryGraphScene` — puis la fiche d'un
// souvenir (feuille, lecture seule).
//
// Trois gestes SIMULTANÉS, jamais `onTapGesture` : `SpatialTapGesture` (toucher un
// nœud), `MagnifyGesture` (pincer) et `DragGesture` (glisser). Aucun littéral
// alphabétique : les mots viennent de `MemoryText`, `IOSMemoryText` et des
// identifiants `IOSMemoryAccessibility`.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct IOSMemoryGraphView: View {
    @ObservedObject var client: ConsoleClientModel
    @ObservedObject var model: IOSMemoryGraphModel

    var body: some View {
        content
            .sheet(item: detailBinding) { target in
                IOSMemoryDetailView(
                    row: target.row,
                    scope: target.row.agentId,
                    links: model.links(of: target.row.id),
                    labels: model.nodeLabels
                )
            }
    }

    // MARK: - Chaque état du graphe

    @ViewBuilder private var content: some View {
        if !IOSMemoryGraphModel.gesturesEnabled(client.state), model.state == .idle {
            banner(ConnectionText.state(client.state), tone: .attention)
            card(IOSMemoryText.noData)
        } else {
            switch model.state {
            case .idle, .loading:
                loading
            case .macUnreachable:
                banner(IOSMemoryText.macUnreachable, tone: .attention)
                card(IOSMemoryText.noData)
                retry
            case .serviceOutdated:
                banner(IOSMemoryText.graphServiceOutdated, tone: .attention)
                retry
            case .macOutdated:
                banner(IOSMemoryText.graphMacOutdated, tone: .attention)
                retry
            case let .unavailable(detail):
                banner(IOSMemoryText.unavailable(detail: detail), tone: .danger)
                retry
            case .empty:
                ContentUnavailableView(
                    MemoryText.emptySummaryTitle,
                    systemImage: "brain",
                    description: Text(verbatim: MemoryText.emptyGraphDescription)
                )
            case .graph:
                graphBody
            }
        }
    }

    private var loading: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProgressView()
            Text(verbatim: MemoryText.graphLoading)
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    private var graphBody: some View {
        VStack(alignment: .leading, spacing: 12) {
            commands
            if model.isTruncated {
                Text(verbatim: IOSMemoryText.graphPartial)
                    .font(.caption)
                    .iosBanner(tone: .attention)
                    .accessibilityIdentifier(IOSMemoryAccessibility.graphPartial)
            }
            canvas
        }
    }

    // MARK: - Rangée de commandes

    private var commands: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: model.countBanner)
                .font(.callout)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier(IOSMemoryAccessibility.graphCount)
            HStack(spacing: 8) {
                tagMenu
                Spacer(minLength: 0)
                command(MemoryText.zoomOut, systemImage: "minus.magnifyingglass", id: IOSMemoryAccessibility.graphZoomOut) {
                    model.zoomOut()
                }
                command(MemoryText.zoomIn, systemImage: "plus.magnifyingglass", id: IOSMemoryAccessibility.graphZoomIn) {
                    model.zoomIn()
                }
                command(MemoryText.recenter, systemImage: "arrow.up.left.and.arrow.down.right", id: IOSMemoryAccessibility.graphRecenter) {
                    model.recenter()
                }
            }
        }
    }

    private var tagMenu: some View {
        Menu {
            Button { model.setTagFilter(nil) } label: { tagChoice(MemoryText.allTags, isCurrent: model.isCurrentTag(nil)) }
            ForEach(model.tagNodes, id: \.id) { node in
                Button { model.setTagFilter(node.id.tagName) } label: {
                    tagChoice(node.label, isCurrent: model.isCurrentTag(node.id.tagName))
                }
            }
        } label: {
            Label(MemoryText.tagMenu, systemImage: "tag")
        }
        .frame(minHeight: IOSMetrics.minimumTarget)
        .accessibilityIdentifier(IOSMemoryAccessibility.graphTagMenu)
    }

    /// Une entrée du menu d'étiquettes : la marque du choix courant (S-6).
    @ViewBuilder private func tagChoice(_ title: String, isCurrent: Bool) -> some View {
        if isCurrent {
            Label {
                Text(verbatim: title)
            } icon: {
                Image(systemName: IOSHomeText.selectedSymbol)
            }
        } else {
            Text(verbatim: title)
        }
    }

    private func command(_ title: String, systemImage: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .labelStyle(.iconOnly)
                .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget)
        }
        .accessibilityLabel(title)
        .accessibilityIdentifier(id)
    }

    // MARK: - Le canevas

    private var canvas: some View {
        GeometryReader { proxy in
            Canvas { context, size in
                draw(context: &context, size: size)
            }
            .contentShape(Rectangle())
            .simultaneousGesture(
                SpatialTapGesture()
                    .onEnded { value in model.click(at: value.location, size: proxy.size) }
            )
            .simultaneousGesture(
                MagnifyGesture()
                    .onChanged { value in
                        model.magnify(by: value.magnification, at: value.startLocation, size: proxy.size)
                    }
                    .onEnded { _ in model.endMagnify() }
            )
            .simultaneousGesture(
                DragGesture(minimumDistance: 2)
                    .onChanged { value in model.drag(by: value.translation) }
                    .onEnded { _ in model.endDrag() }
            )
            .accessibilityIdentifier(IOSMemoryAccessibility.graphCanvas)
            .accessibilityLabel(model.countBanner)
        }
    }

    /// Le canevas ne fait que PEINDRE la scène pure : l'ordre du dessin (liens,
    /// grappes, nœuds, libellés) est celui de `MemoryGraphScene`.
    private func draw(context: inout GraphicsContext, size: CGSize) {
        let viewport = MemoryGraphViewport(size: size, zoom: model.zoom, pan: model.pan)
        let visible = model.visible
        let scene = MemoryGraphScene.build(
            nodes: visible.nodes,
            links: visible.links,
            positions: model.positions,
            viewport: viewport,
            selection: model.selection,
            hovered: nil
        )
        for shape in scene.shapes {
            switch shape {
            case let .line(from, to, kind, highlighted):
                var path = Path()
                path.move(to: from)
                path.addLine(to: to)
                switch kind {
                case .manual:
                    context.stroke(
                        path,
                        with: .color(Color.accentColor.opacity(highlighted ? 1 : 0.85)),
                        style: StrokeStyle(lineWidth: highlighted ? 2 : 1.5, dash: [6, 4])
                    )
                case .semantic:
                    context.stroke(
                        path,
                        with: .color(Color.secondary.opacity(highlighted ? 0.9 : 0.35)),
                        lineWidth: highlighted ? 1.5 : 1
                    )
                case .tag:
                    context.stroke(
                        path,
                        with: .color(Color.secondary.opacity(highlighted ? 0.7 : 0.25)),
                        lineWidth: 1
                    )
                }
            case let .disc(center, radius, hue, selected, hovered):
                let box = CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
                context.fill(Path(ellipseIn: box), with: .color(Color(hue: hue, saturation: 0.65, brightness: 0.85)))
                if hovered {
                    let ring = box.insetBy(dx: -2, dy: -2)
                    context.stroke(Path(ellipseIn: ring), with: .color(Color.primary.opacity(0.5)), lineWidth: 1.5)
                }
                if selected {
                    let ring = box.insetBy(dx: -3, dy: -3)
                    context.stroke(Path(ellipseIn: ring), with: .color(Color.accentColor), lineWidth: 2)
                }
            case let .capsule(center, size, label):
                let box = CGRect(
                    x: center.x - size.width / 2,
                    y: center.y - size.height / 2,
                    width: size.width,
                    height: size.height
                )
                context.fill(
                    Path(roundedRect: box, cornerRadius: box.height / 2),
                    with: .color(Color.secondary.opacity(0.18))
                )
                context.draw(
                    Text(label).font(.caption2).foregroundStyle(.secondary),
                    at: center,
                    anchor: .center
                )
            case let .label(center, text, hue):
                let style = hue.map { Color(hue: $0, saturation: 0.8, brightness: 0.7) } ?? Color.primary
                let font: Font = hue == nil ? .caption2 : .caption.bold()
                context.draw(Text(text).font(font).foregroundStyle(style), at: center, anchor: .center)
            }
        }
    }

    // MARK: - Composants

    private func banner(_ text: String, tone: ConsoleTone) -> some View {
        Text(verbatim: text)
            .font(.callout)
            .iosBanner(tone: tone)
            .accessibilityIdentifier(IOSMemoryAccessibility.banner)
    }

    private func card(_ message: String) -> some View {
        Text(verbatim: message)
            .font(.headline)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.leading)
            .iosCard()
    }

    private var retry: some View {
        Button { Task { await model.refresh() } } label: {
            Label(MemoryText.retry, systemImage: "arrow.clockwise")
        }
        .accessibilityIdentifier(IOSMemoryAccessibility.retry)
    }

    // MARK: - La fiche (S-5)

    /// La sélection courante, portée par sa LIGNE (patron `IOSMemorySelection`) : la
    /// feuille ne s'ouvre jamais sur un souvenir disparu.
    private var detail: IOSMemorySelection? {
        guard let id = model.selection, let row = model.row(id) else { return nil }
        return IOSMemorySelection(row: row)
    }

    private var detailBinding: Binding<IOSMemorySelection?> {
        Binding(
            get: { detail },
            set: { if $0 == nil { model.select(nil) } }
        )
    }
}
