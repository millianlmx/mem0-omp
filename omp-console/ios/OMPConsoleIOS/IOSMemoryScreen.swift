// L'écran Mémoire de la coque iOS (BR-2) : le sommaire du projet ouvert — les
// MÊMES souvenirs que la section « Mémoire » de macOS —, une recherche qui se
// SOUMET (jamais à la frappe), et l'état de la mémoire dit sans masquer sa cause.
//
// Chaque état rendu par `IOSMemoryModel.screen` a sa branche ici, et aucune phrase
// n'est composée : les mots viennent du noyau partagé (`MemoryText`) ou du
// vocabulaire de l'app (`IOSMemoryText`). Aucun geste d'écriture, aucun graphe.
//
// Contrôles SYSTÈME uniquement (aucun `onTapGesture`), cibles ≥ 44 pt, aucun
// `lineLimit` numérique : Dynamic Type maximum ne tronque rien.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct IOSMemoryScreen: View {
    @ObservedObject var client: ConsoleClientModel
    /// Le crochet de recette `-ios.state error` (bandeau danger par-dessus).
    let recipe: IOSScreenState
    /// Le crochet de recette `-memoire.recipe` du mode graphe.
    let graphRecipe: IOSMemoryGraphRecipe?
    @StateObject private var model: IOSMemoryModel
    @StateObject private var graph: IOSMemoryGraphModel
    /// La raison montrée dans la bulle de « Sommaire » : figée au toucher, tant que
    /// la bulle est ouverte.
    @State private var summaryReason: String?

    init(client: ConsoleClientModel, recipe: IOSScreenState, graphRecipe: IOSMemoryGraphRecipe? = nil) {
        self.client = client
        self.recipe = recipe
        self.graphRecipe = graphRecipe
        _model = StateObject(wrappedValue: IOSMemoryModel(client: client))
        _graph = StateObject(wrappedValue: IOSMemoryGraphModel(client: client))
    }

    var body: some View {
        panel
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        if graph.shown {
                            Task { await graph.refresh() }
                        } else {
                            Task { await model.refresh() }
                        }
                    } label: {
                        Label(MemoryText.refresh, systemImage: "arrow.clockwise")
                    }
                    .disabled(graph.shown ? graph.state == .loading : !model.canRefresh)
                    .accessibilityIdentifier(IOSMemoryAccessibility.refresh)
                }
                ToolbarItem(placement: .topBarTrailing) { summaryButton }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        if graph.shown {
                            graph.hide()
                        } else {
                            Task { await graph.activate() }
                        }
                    } label: {
                        if graph.shown {
                            Label(MemoryText.listButton, systemImage: IOSMemoryText.listSymbol)
                        } else {
                            Label(MemoryText.graphButton, systemImage: "point.3.connected.trianglepath.dotted")
                        }
                    }
                    .accessibilityIdentifier(IOSMemoryAccessibility.graphToggle)
                }
            }
            .sheet(item: $model.selection) { target in
                IOSMemoryDetailView(row: target.row, scope: model.scope)
            }
            .task { await model.refresh() }
            .onAppear { applyGraphRecipe() }
            .onDisappear { graph.suspend() }
            .accessibilityIdentifier(IOSMemoryAccessibility.screen)
    }

    /// « Sommaire » est TOUJOURS là. Indisponible, il est grisé et un toucher en
    /// dit la raison dans une bulle — il n'appelle pas `showSummary()`. Le grisé passe
    /// par `.tint` : la barre d'outils ignore `.foregroundStyle` et `.opacity` (mesuré).
    private var summaryButton: some View {
        let reason = model.summaryUnavailableReason(graphShown: graph.shown)
        return Button {
            if let reason {
                summaryReason = reason
            } else {
                model.showSummary()
            }
        } label: {
            Label(MemoryText.summaryButton, systemImage: IOSMemoryText.summarySymbol)
        }
        .tint(reason == nil ? nil : Color(uiColor: .tertiaryLabel))
        .accessibilityValue(reason == nil ? "" : IOSMemoryText.summaryUnavailable)
        .accessibilityHint(reason ?? "")
        .popover(isPresented: Binding(get: { summaryReason != nil }, set: { if !$0 { summaryReason = nil } })) {
            Text(summaryReason ?? "")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
                .padding()
                .presentationCompactAdaptation(.popover)
                .accessibilityIdentifier(IOSMemoryAccessibility.summaryReason)
        }
        .accessibilityIdentifier(IOSMemoryAccessibility.summary)
    }

    /// Le crochet de recette force le mode graphe sur la fixture partagée, sans
    /// réseau : le chemin de rendu est celui de production.
    private func applyGraphRecipe() {
        guard let graphRecipe else { return }
        Task { await graphRecipe.activate(graph) }
    }

    // MARK: - Panneau et champ de recherche

    /// Le champ de recherche se pose sur la VUE DE DÉTAIL (cet écran), pas sur la
    /// racine, et seulement là où une portée est connue (S-6) : jamais devant
    /// « Aucun projet ouvert », l'état du client, un chargement ou une panne.
    @ViewBuilder
    private var panel: some View {
        let content = surface
            .navigationTitle(ConsoleSection.memory.title)

        if offersSearch {
            content
                .searchable(
                    text: queryBinding,
                    placement: .automatic,
                    prompt: Text(verbatim: MemoryText.searchPrompt)
                )
                .onSubmit(of: .search) { Task { await model.submitQuery() } }
        } else {
            content
        }
    }

    /// Le panneau : en mode LISTE il est le contenu du seul défilement vertical de
    /// l'écran ; en mode GRAPHE il reste hors de tout `ScrollView`, pour que le
    /// canevas garde son déplacement et son zoom (le geste ne défile pas la page).
    @ViewBuilder
    private var surface: some View {
        let stack = VStack(alignment: .leading, spacing: 12) {
            if let banner = recipe.banner, let message = recipe.bannerMessage {
                Text(verbatim: message)
                    .font(.callout)
                    .iosBanner(tone: banner.tone)
            }
            displayed
        }
        if graph.shown {
            stack.iosPanel()
        } else {
            ScrollView(.vertical) {
                stack.iosPanel()
            }
        }
    }

    private var queryBinding: Binding<String> {
        Binding(
            get: { model.query },
            set: { model.updateQuery($0) }
        )
    }

    private var offersSearch: Bool {
        guard !graph.shown else { return false }
        switch model.state {
        case .summary, .summaryEmpty, .search, .searchEmptyNoMatch, .searchEmptyNoScore, .searchEmptyBelowThreshold:
            return true
        default:
            return false
        }
    }

    /// Le contenu de la section : le graphe quand la bascule l'a demandé, la LISTE
    /// sinon (mode d'ouverture, B-4).
    @ViewBuilder private var displayed: some View {
        if graph.shown {
            IOSMemoryGraphView(client: client, model: graph)
        } else {
            subject
        }
    }

    // MARK: - Contenu, état par état

    @ViewBuilder
    private var subject: some View {
        switch model.state {
        case .clientState(let state):
            banner(ConnectionText.state(state), tone: .attention)
            card(IOSMemoryText.noData)
        case .loading:
            ProgressView()
            Text(verbatim: MemoryText.loading)
                .font(.callout)
                .foregroundStyle(.secondary)
        case .macUnreachable:
            banner(IOSMemoryText.macUnreachable, tone: .attention)
            card(IOSMemoryText.noData)
            retryButton
        case .noProject:
            card(MemoryText.noProjectTitle, detail: IOSMemoryText.noProjectDetail)
        case .unavailable(let detail):
            banner(IOSMemoryText.unavailable(detail: detail), tone: .danger)
            retryButton
        case .summaryEmpty(let scope):
            card(MemoryText.emptySummaryTitle, detail: MemoryText.emptySummary(scope))
        case .summary(_, let total, let rows, let truncated):
            header(MemoryText.summaryCount(total), identifier: IOSMemoryAccessibility.count)
            if truncated {
                Text(verbatim: IOSMemoryText.truncated(shown: rows.count, total: total))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier(IOSMemoryAccessibility.truncated)
            }
            rowsList(rows)
        case .search(let query, let rows):
            header(MemoryText.searchResults(query), identifier: IOSMemoryAccessibility.results)
            rowsList(rows)
        case .searchEmptyNoMatch:
            card(MemoryText.noResultTitle, detail: MemoryText.noMatch)
        case .searchEmptyNoScore:
            card(MemoryText.searchUnsupportedTitle, detail: MemoryText.noSemanticScore)
        case .searchEmptyBelowThreshold:
            card(MemoryText.noResultTitle, detail: MemoryText.belowThreshold)
        }
    }

    // MARK: - Composants

    private func banner(_ text: String, tone: ConsoleTone) -> some View {
        Text(verbatim: text)
            .font(.callout)
            .iosBanner(tone: tone)
            .accessibilityIdentifier(IOSMemoryAccessibility.banner)
    }

    private func header(_ title: String, identifier: String) -> some View {
        Text(verbatim: title)
            .font(.headline)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.leading)
            .accessibilityIdentifier(identifier)
    }

    private func card(_ message: String, detail: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: message)
                .font(.headline)
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

    private var retryButton: some View {
        Button { Task { await model.refresh() } } label: {
            Label(MemoryText.retry, systemImage: "arrow.clockwise")
        }
        .disabled(!model.canRefresh)
        .accessibilityIdentifier(IOSMemoryAccessibility.retry)
    }

    /// La liste des souvenirs, dans l'ORDRE reçu (aucun tri local) : la ligne de
    /// contexte est rafraîchie à la minute par `TimelineView`, SANS relire la
    /// mémoire.
    private func rowsList(_ rows: [RemoteMemoryRow]) -> some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let nowMs = context.date.timeIntervalSince1970 * 1000
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    if index > 0 {
                        Divider()
                    }
                    Button { model.selection = IOSMemorySelection(row: row) } label: {
                        rowLabel(row, nowMs: nowMs)
                    }
                    .buttonStyle(.plain)
                    .frame(minHeight: IOSMetrics.minimumTarget, alignment: .leading)
                    .accessibilityIdentifier(IOSMemoryAccessibility.row(row.id))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func rowLabel(_ row: RemoteMemoryRow, nowMs: Double) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: IOSMemoryDetailView.text(row))
                .font(.body)
                .multilineTextAlignment(.leading)
            let subtitle = IOSMemoryDetailView.subtitle(row, nowMs: nowMs)
            if !subtitle.isEmpty {
                Text(verbatim: subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
