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
    @ObservedObject var model: IOSMemoryGraphModel
    /// Le statut présenté par l'écran Mémoire. Hors connexion, l'écran ne rend
    /// cette vue que sur un graphe reçu (`IOSMemoryGraphModel.hasData`) : il reste
    /// affiché sous le bandeau (etats-non-connecte-heterogenes-ios, S-4).
    let connection: IOSConnectionStatus
    /// La feuille Connexion de la racine, ouverte par « Se connecter ».
    @Binding var showConnection: Bool
    /// La catégorie Dynamic Type courante : les textes du canevas sont mesurés à
    /// cette taille avant d'être décollés (S-6).
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// Les tailles mesurées des textes du canevas, mémoïsées d'une peinture à
    /// l'autre.
    @State private var labelSizes = IOSMemoryGraphLabelSizes()

    /// Le panneau du graphe occupe toute la hauteur restante et aligne son contenu en
    /// haut à gauche, dans chaque état (S-7) : sans ce cadre, le panneau hors
    /// `ScrollView` de `IOSMemoryScreen` serait centré verticalement.
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
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
        if connection != .connected {
            IOSConnectionStateView(status: connection, layout: .banner, onConnect: { showConnection = true })
        }
        switch model.state {
        case .idle, .loading:
            loading
        case .failed(.timedOut):
            banner(IOSMemoryErrorText.message(for: .timedOut), tone: .attention)
            retry
        case .noProject:
            card(MemoryText.noProjectTitle, detail: IOSMemoryText.noProjectDetail)
        case .serviceOutdated:
            banner(IOSMemoryText.graphServiceOutdated, tone: .attention)
            retry
        case .failed(.unreachable):
            banner(IOSMemoryErrorText.message(for: .unreachable), tone: .attention)
            card(IOSMemoryText.noData)
            retry
        case let .failed(cause):
            banner(IOSMemoryErrorText.message(for: cause), tone: .danger)
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

    /// Le compteur, puis le menu d'étiquettes et les trois commandes de zoom
    /// (ios-dynamic-type-ax-residuel, S-6) : les commandes restent ensemble et
    /// passent sous le menu quand elles ne tiennent pas à côté, au lieu de couper
    /// « Étiquette » ; le compteur garde la hauteur de son texte replié.
    private var commands: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: model.countBanner)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier(IOSMemoryAccessibility.graphCount)
            IOSAdaptiveRow(spacing: 8) {
                tagMenu
                HStack(spacing: 8) {
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
                .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget)
                .contentShape(Rectangle())
        }
        .accessibilityIdentifier(IOSMemoryAccessibility.graphTagMenu)
    }

    /// Une entrée du menu d'étiquettes : la marque du choix courant (S-6).
    @ViewBuilder private func tagChoice(_ title: String, isCurrent: Bool) -> some View {
        if isCurrent {
            Label {
                Text(verbatim: title)
            } icon: {
                Image(systemName: IOSShellText.selectedSymbol)
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
            // Un élément VoiceOver par nœud affiché (S-5) : ces vues ne sont jamais
            // dessinées, le canevas devient leur conteneur et garde son libellé.
            .accessibilityChildren {
                ZStack(alignment: .topLeading) {
                    ForEach(model.accessibilityElements(size: proxy.size)) { element in
                        graphElement(element)
                    }
                }
            }
        }
    }

    /// L'élément synthétique d'un nœud : un rectangle transparent posé sur le nœud,
    /// activé par le double-toucher de VoiceOver via la voie du toucher. Les titres
    /// liés se lisent à la demande (rotor « Plus de contenu »).
    @ViewBuilder
    private func graphElement(_ element: IOSMemoryGraphElement) -> some View {
        let base = Color.clear
            .frame(width: element.frame.width, height: element.frame.height)
            .position(x: element.frame.midX, y: element.frame.midY)
            .accessibilityElement()
            .accessibilityLabel(element.label)
            .accessibilityHint(element.hint)
            .accessibilityAddTraits(element.isSelected ? [.isButton, .isSelected] : .isButton)
            .accessibilityIdentifier(element.id)
            .accessibilityAction { model.activate(element.target) }
        if element.linked.isEmpty {
            base
        } else {
            base.accessibilityCustomContent(
                Text(IOSMemoryText.graphLinkedTitles),
                Text(verbatim: element.linked.joined(separator: ", ")),
                importance: .default
            )
        }
    }

    /// Le canevas ne fait que PEINDRE la scène pure : l'ordre du dessin (liens,
    /// grappes, nœuds, libellés) est celui de `MemoryGraphScene`, sans les textes
    /// qui en chevaucheraient un autre (`IOSMemoryGraphLabels.declutter`, S-6) ; une
    /// capsule d'étiquette sans place devient une pastille.
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
        let category = UIContentSizeCategory(dynamicTypeSize)
        let sizes = labelSizes
        let decluttered = IOSMemoryGraphLabels.declutter(scene, canvas: size) { text, font in
            sizes.size(text, font: font, category: category)
        }
        for shape in decluttered.shapes {
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
                context.fill(Path(ellipseIn: box), with: .color(Color(uiColor: IOSDataPalette.scope(hue: hue))))
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
                let style = hue.map { Color(uiColor: IOSDataPalette.scope(hue: $0)) } ?? Color.primary
                let font: Font = hue == nil ? .caption2 : .caption.bold()
                context.draw(Text(text).font(font).foregroundStyle(style), at: center, anchor: .center)
            }
        }
        let markerRadius = MemoryGraphStyle.nodeRadius * model.zoom
        for marker in decluttered.markers {
            let box = CGRect(
                x: marker.x - markerRadius,
                y: marker.y - markerRadius,
                width: markerRadius * 2,
                height: markerRadius * 2
            )
            context.fill(Path(ellipseIn: box), with: .color(Color.secondary.opacity(0.18)))
            context.stroke(Path(ellipseIn: box), with: .color(Color.secondary.opacity(0.6)), lineWidth: 1)
        }
    }

    // MARK: - Composants

    private func banner(_ text: String, tone: ConsoleTone) -> some View {
        Text(verbatim: text)
            .font(.callout)
            .iosBanner(tone: tone)
            .accessibilityIdentifier(IOSMemoryAccessibility.banner)
    }

    private func card(_ message: String, detail: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: message)
                .font(.headline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.leading)
            if let detail {
                Text(verbatim: detail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
            }
        }
        .iosCard()
    }

    private var retry: some View {
        Button { Task { await model.refresh() } } label: {
            Label(MemoryText.retry, systemImage: "arrow.clockwise")
                .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget)
                .contentShape(Rectangle())
        }
        .disabled(!connection.gesturesEnabled)
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
