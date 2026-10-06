// Le MODE GRAPHE de la section « Mémoire » (BR-3, BR-4) : la barre de contrôles,
// le canevas, la fiche (lecture + écriture) et les feuilles.
//
// Aucun attribut macro n'est employé ici (`@State`, `@Preview` ne compilent pas sous
// les Command Line Tools) : l'état vit dans `MemoryGraphModel`, les liaisons sont
// construites à la main, et les textes viennent TOUS de `MemoryText` — la vue ne
// compose jamais une phrase.
//
// L'ordre du dessin EST la profondeur : liens d'abord, nœuds ensuite, sélection en
// dernier (S-5).

import AppKit
import SwiftUI

struct MemoryGraphView: View {
    @ObservedObject var model: MemoryGraphModel

    var body: some View {
        VStack(spacing: 0) {
            controls
            content
        }
        .sheet(item: sheetBinding) { sheet in
            sheetView(sheet)
        }
        .memoryDeleteConfirmation(
            isPresented: deleteBinding,
            onConfirm: { Task { await model.confirmDelete() } }
        )
    }

    // MARK: - Barre de contrôles (S-6, S-5)

    private var controls: some View {
        HStack(spacing: 10) {
            Picker(
                MemoryText.projectMenu,
                selection: Binding(
                    get: { model.projectFilter },
                    set: { model.setProjectFilter($0) }
                )
            ) {
                Text(MemoryText.allProjects).tag(String?.none)
                ForEach(model.filterProjects, id: \.self) { scope in
                    Text(verbatim: MemoryText.scopeLabel(scope)).tag(String?.some(scope))
                }
            }
            .frame(maxWidth: 200)
            .help(MemoryText.projectMenu)
            .accessibilityIdentifier("memoire.graph.project")

            Picker(
                MemoryText.tagMenu,
                selection: Binding(
                    get: { model.tagFilter },
                    set: { model.setTagFilter($0) }
                )
            ) {
                Text(MemoryText.allTags).tag(String?.none)
                ForEach(model.filterTags, id: \.self) { tag in
                    Text(verbatim: MemoryText.tagLabel(tag)).tag(String?.some(tag))
                }
            }
            .frame(maxWidth: 200)
            .help(MemoryText.tagMenu)
            .accessibilityIdentifier("memoire.graph.tag")

            Text(verbatim: model.countBanner)
                .font(.callout)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("memoire.graph.count")

            Spacer(minLength: 0)

            Button(MemoryText.zoomOut) { model.zoomOut() }
                .help(MemoryText.zoomOutHelp)
                .keyboardShortcut("-", modifiers: .command)
                .disabled(model.state == .idle)
                .accessibilityIdentifier("memoire.graph.zoomOut")
            Button(MemoryText.zoomIn) { model.zoomIn() }
                .help(MemoryText.zoomInHelp)
                .keyboardShortcut("+", modifiers: .command)
                .disabled(model.state == .idle)
                .accessibilityIdentifier("memoire.graph.zoomIn")
            Button(MemoryText.recenter) { model.recenter() }
                .help(MemoryText.recenterHelp)
                .keyboardShortcut("0", modifiers: .command)
                .disabled(model.state == .idle)
                .accessibilityIdentifier("memoire.graph.recenter")

            Button {
                model.beginCreate()
            } label: {
                Label(MemoryText.createMemory, systemImage: "plus")
            }
            .help(MemoryText.createMemoryHelp)
            .disabled(!hasLoadedGraph)
            .accessibilityIdentifier("memoire.graph.create")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var hasLoadedGraph: Bool {
        if case .graph = model.state { return true }
        return false
    }

    // MARK: - Corps : chaque état du graphe

    @ViewBuilder private var content: some View {
        switch model.state {
        case .idle, .loading:
            VStack(spacing: 10) {
                ProgressView()
                Text(verbatim: MemoryText.graphLoading)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case let .unavailable(address, detail):
            ContentUnavailableView {
                Label(MemoryText.unavailableTitle, systemImage: "exclamationmark.triangle")
            } description: {
                Text(MemoryText.unavailableDescription)
            } actions: {
                Button(MemoryText.retry) { Task { await model.refresh() } }
                Text(verbatim: MemoryText.unavailableDetail(address: address, error: detail))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("memoire.graph.unavailable.detail")
            }

        case .empty:
            ContentUnavailableView(
                MemoryText.emptySummaryTitle,
                systemImage: "brain",
                description: Text(MemoryText.emptyGraphDescription)
            )

        case .graph:
            graphBody
        }
    }

    private var graphBody: some View {
        HSplitView {
            VStack(alignment: .leading, spacing: 0) {
                if case let .query(query, found) = model.searchState {
                    searchBanner(query: query, found: found)
                }
                canvasArea
            }
            .frame(minWidth: 320)

            detailPane
        }
    }

    private func searchBanner(query: String, found: Int) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
            Text(verbatim: MemoryText.searchResults(query))
            Text(verbatim: MemoryText.graphCount(memories: found, projects: 0, links: 0))
                .foregroundStyle(.secondary)
            Spacer()
        }
        .font(.callout)
        .frame(maxWidth: .infinity, alignment: .leading)
        .consoleBanner(tint: .accentColor)
        .padding(.horizontal, 8)
        .padding(.top, 8)
        .accessibilityIdentifier("memoire.graph.search.banner")
    }

    @ViewBuilder private var canvasArea: some View {
        switch model.searchState {
        case .empty:
            ContentUnavailableView(
                MemoryText.noResultTitle,
                systemImage: "magnifyingglass",
                description: Text(MemoryText.graphNoMatch)
            )
        case .none, .query:
            if model.visible.nodes.isEmpty {
                // Filtres actifs sans résultat : même état vide, menus toujours
                // accessibles (S-6).
                ContentUnavailableView(
                    MemoryText.emptySummaryTitle,
                    systemImage: "brain",
                    description: Text(MemoryText.emptyGraphDescription)
                )
            } else {
                canvas
            }
        }
    }

    // MARK: - Le canevas (S-5)

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
            .focusable()
            .focusEffectDisabled()
            .onKeyPress(.leftArrow) { model.moveSelection(.left); return .handled }
            .onKeyPress(.rightArrow) { model.moveSelection(.right); return .handled }
            .onKeyPress(.upArrow) { model.moveSelection(.up); return .handled }
            .onKeyPress(.downArrow) { model.moveSelection(.down); return .handled }
            .onKeyPress(.escape) { model.select(nil); return .handled }
            .onContinuousHover { phase in
                switch phase {
                case let .active(point):
                    model.hover(
                        MemoryGraphHitTest.node(
                            at: point,
                            positions: model.positions,
                            zoom: model.zoom,
                            pan: model.pan,
                            size: proxy.size
                        )
                    )
                case .ended:
                    model.hover(nil)
                }
            }
            .accessibilityIdentifier("memoire.graph.canvas")
            .accessibilityLabel(model.countBanner)
        }
    }

    /// Le canevas ne fait que PEINDRE la scène pure : l'ordre du dessin (liens,
    /// grappes, nœuds, libellés) est celui de `MemoryGraphScene`, qui se confronte en
    /// test sans rendre de vue.
    private func draw(context: inout GraphicsContext, size: CGSize) {
        let viewport = MemoryGraphViewport(size: size, zoom: model.zoom, pan: model.pan)
        let visible = model.visible
        let scene = MemoryGraphScene.build(
            nodes: visible.nodes,
            links: visible.links,
            positions: model.positions,
            viewport: viewport,
            selection: model.selection,
            hovered: model.hovered
        )
        for shape in scene.shapes {
            switch shape {
            case let .line(from, to, kind, highlighted):
                var path = Path()
                path.move(to: from)
                path.addLine(to: to)
                switch kind {
                case .manual:
                    // Un lien MANUEL se distingue d'un dérivé : trait discontinu, accentué.
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

    // MARK: - La fiche (S-5, S-8, S-9, S-11)

    @ViewBuilder private var detailPane: some View {
        Group {
            if let row = model.selected {
                MemoryDetailView(row: row, scope: row.agentId) {
                    graphActions(row)
                }
            } else {
                Text(verbatim: MemoryText.nothingSelected)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(minWidth: 320)
        .accessibilityIdentifier("memoire.graph.detail")
    }

    private func graphActions(_ row: MemoryRow) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider()
            HStack(spacing: 8) {
                Button(MemoryText.edit) { model.beginEdit(row.id) }
                    .help(MemoryText.editHelp)
                    .accessibilityIdentifier("memoire.graph.edit")
                Button(MemoryText.delete, role: .destructive) { model.requestDelete(row.id) }
                    .help(MemoryText.deleteHelp)
                    .accessibilityIdentifier("memoire.graph.delete")
            }
            manualLinksBlock(row)
            if let error = model.errorLine {
                Text(verbatim: error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("memoire.graph.error")
            }
        }
        .font(.callout)
    }

    private func manualLinksBlock(_ row: MemoryRow) -> some View {
        let links = model.manualLinks(of: row.id)
        return VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: MemoryText.manualLinks)
                .font(.headline)
                .foregroundStyle(.secondary)
            if links.isEmpty {
                Text(verbatim: MemoryText.noManualLink)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(links, id: \.self) { link in
                    HStack(spacing: 8) {
                        if let other = model.otherEnd(of: link, than: row.id), let linked = model.row(other) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(verbatim: MemoryText.title(linked.text))
                                Text(verbatim: MemoryText.scopeLabel(linked.agentId))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 0)
                        Button(MemoryText.detach) { model.detach(link) }
                            .accessibilityIdentifier("memoire.graph.detach.\(otherOf(link, row.id) ?? "?")")
                    }
                }
            }
            Button(MemoryText.linkTo) { model.beginLink(row.id) }
                .accessibilityIdentifier("memoire.graph.link")
        }
    }

    private func otherOf(_ link: MemoryLink, _ id: String) -> String? {
        model.otherEnd(of: link, than: id)
    }

    // MARK: - Les feuilles (S-8, S-10, S-11)

    private var sheetBinding: Binding<MemoryGraphModel.Sheet?> {
        Binding(
            get: { model.sheet },
            set: { if $0 == nil { model.closeSheet() } }
        )
    }

    private var deleteBinding: Binding<Bool> {
        Binding(
            get: { model.pendingDelete != nil },
            set: { if !$0 { model.cancelDelete() } }
        )
    }

    @ViewBuilder private func sheetView(_ sheet: MemoryGraphModel.Sheet) -> some View {
        switch sheet {
        case .create:
            MemoryMemoryFormSheet(
                model: model,
                title: MemoryText.createTitle,
                showsProject: true,
                identifier: "memoire.create.sheet"
            )
        case .edit:
            MemoryMemoryFormSheet(
                model: model,
                title: MemoryText.editTitle,
                showsProject: false,
                identifier: "memoire.edit.sheet"
            )
        case .link:
            MemoryLinkSheet(model: model)
        }
    }
}

// MARK: - Feuille « Nouveau souvenir » / « Modifier le souvenir »

/// Les deux feuilles d'écriture partagent leurs champs : seuls le titre et la
/// présence du menu « Projet » les distinguent (S-8, S-10).
private struct MemoryMemoryFormSheet: View {
    @ObservedObject var model: MemoryGraphModel
    let title: String
    let showsProject: Bool
    let identifier: String

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(verbatim: title)
                .font(.title3.bold())

            VStack(alignment: .leading, spacing: 6) {
                Text(verbatim: MemoryText.textLabel)
                    .font(.headline)
                ZStack(alignment: .topLeading) {
                    TextEditor(text: $model.draftText)
                        .font(.body)
                        .frame(minHeight: 120)
                        .scrollContentBackground(.hidden)
                        .padding(4)
                        .background(Color(nsColor: .textBackgroundColor))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3)))
                        .accessibilityIdentifier("\(identifier).text")
                    if model.draftText.isEmpty {
                        Text(verbatim: MemoryText.textPlaceholder)
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 4)
                            .allowsHitTesting(false)
                    }
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                Text(verbatim: MemoryText.tagsLabel)
                    .font(.headline)
                TextField(MemoryText.tagsPlaceholder, text: $model.draftTags, prompt: Text(MemoryText.tagsPlaceholder))
                    .labelsHidden()
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("\(identifier).tags")
            }

            if showsProject {
                VStack(alignment: .leading, spacing: 6) {
                    Text(verbatim: MemoryText.projectMenu)
                        .font(.headline)
                    if model.createScopes.isEmpty {
                        Text(verbatim: MemoryText.noKnownProject)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("\(identifier).noProject")
                    } else {
                        Picker(MemoryText.projectMenu, selection: $model.draftScope) {
                            ForEach(model.createScopes, id: \.self) { scope in
                                Text(verbatim: MemoryText.scopeLabel(scope)).tag(scope)
                            }
                        }
                        .labelsHidden()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("\(identifier).project")
                    }
                }
            }

            if let error = model.sheetError {
                Text(verbatim: error)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("\(identifier).error")
            }

            HStack(spacing: 8) {
                Spacer()
                Button(MemoryText.cancel) { model.closeSheet() }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("\(identifier).cancel")
                Button(MemoryText.save) { Task { await model.saveDraft() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!model.canSaveDraft)
                    .accessibilityIdentifier("\(identifier).save")
            }
        }
        .padding(20)
        .frame(width: 520)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }
}

// MARK: - Feuille « Relier à un souvenir »

private struct MemoryLinkSheet: View {
    @ObservedObject var model: MemoryGraphModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(verbatim: MemoryText.linkTitle)
                .font(.title3.bold())

            TextField(MemoryText.linkFilter, text: $model.linkFilter, prompt: Text(MemoryText.linkFilter))
                .labelsHidden()
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("memoire.link.filter")

            let candidates = model.linkCandidates
            if candidates.isEmpty {
                Text(verbatim: MemoryText.noCandidate)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("memoire.link.empty")
            } else {
                List(selection: linkSelection) {
                    ForEach(candidates) { row in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: MemoryText.title(row.text))
                            Text(verbatim: MemoryText.scopeLabel(row.agentId))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .tag(Optional(row.id))
                    }
                }
                .frame(minHeight: 220)
                .accessibilityIdentifier("memoire.link.list")
            }

            if let error = model.sheetError {
                Text(verbatim: error)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("memoire.link.error")
            }

            HStack(spacing: 8) {
                Spacer()
                Button(MemoryText.cancel) { model.closeSheet() }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("memoire.link.cancel")
                Button(MemoryText.link) { model.createLink() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(model.linkSelection == nil)
                    .accessibilityIdentifier("memoire.link.confirm")
            }
        }
        .padding(20)
        .frame(width: 520)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("memoire.link.sheet")
    }

    private var linkSelection: Binding<String?> {
        Binding(
            get: { model.linkSelection },
            set: { model.selectLinkCandidate($0) }
        )
    }
}

// MARK: - Confirmation de suppression

extension View {
    /// La confirmation d'une suppression de souvenir (S-9) : le titre, le message et
    /// le bouton destructif sont figés, l'état vit dans le modèle (`@State` interdit
    /// sous CLT).
    func memoryDeleteConfirmation(isPresented: Binding<Bool>, onConfirm: @escaping () -> Void) -> some View {
        confirmationDialog(
            MemoryText.deleteConfirmTitle,
            isPresented: isPresented,
            titleVisibility: .visible
        ) {
            Button(MemoryText.deleteConfirm, role: .destructive, action: onConfirm)
            Button(MemoryText.cancel, role: .cancel) {}
        } message: {
            Text(MemoryText.deleteConfirmMessage)
        }
    }
}
