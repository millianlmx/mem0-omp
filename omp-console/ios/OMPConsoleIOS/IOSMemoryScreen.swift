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
    /// Le crochet de recette `-memoire.recipe` : mode graphe, ou liste sur fixture.
    let graphRecipe: IOSMemoryGraphRecipe?
    @StateObject private var model: IOSMemoryModel
    @StateObject private var graph: IOSMemoryGraphModel
    /// La recherche présentée (⌘F la présente ; la bascule Graphe/Liste la retire).
    @State private var searchPresented = false
    /// Le focus du champ de recherche, posé par ⌘F.
    @FocusState private var searchFocused: Bool

    init(client: ConsoleClientModel, recipe: IOSScreenState, graphRecipe: IOSMemoryGraphRecipe? = nil) {
        self.client = client
        self.recipe = recipe
        self.graphRecipe = graphRecipe
        let reader: any IOSMemoryReading = graphRecipe == .liste ? IOSMemoryRecipeReader() : client
        _model = StateObject(wrappedValue: IOSMemoryModel(client: reader))
        _graph = StateObject(wrappedValue: IOSMemoryGraphModel(client: client))
    }

    var body: some View {
        panel
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { refreshShown() } label: {
                        Label(MemoryText.refresh, systemImage: "arrow.clockwise")
                    }
                    .disabled(!canRefreshShown)
                    .accessibilityIdentifier(IOSMemoryAccessibility.refresh)
                }
                if !graph.shown {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { model.showSummary() } label: {
                            Label(MemoryText.summaryButton, systemImage: "list.bullet")
                        }
                        .disabled(!model.canShowSummary)
                        .accessibilityIdentifier(IOSMemoryAccessibility.summary)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        searchPresented = false
                        if graph.shown {
                            graph.hide()
                        } else {
                            Task { await graph.activate() }
                        }
                    } label: {
                        if graph.shown {
                            Label(MemoryText.listButton, systemImage: "list.bullet")
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
            .focusedSceneValue(\.iosRefresh, IOSCommandAction(
                owner: .memory,
                isEnabled: IOSMemoryModel.gesturesEnabled(model.client.state) && canRefreshShown
            ) { refreshShown() })
            .focusedSceneValue(\.iosSearch, IOSCommandAction(owner: .memory, isEnabled: offersSearch) {
                searchPresented = true
                searchFocused = true
            })
            .accessibilityIdentifier(IOSMemoryAccessibility.screen)
    }

    /// Le rafraîchissement de la vue affichée : le bouton Rafraîchir de la barre
    /// d'outils et ⌘R passent tous deux par ici.
    private func refreshShown() {
        if graph.shown {
            Task { await graph.refresh() }
        } else {
            Task { await model.refresh() }
        }
    }

    /// Le contraire du `.disabled` du bouton Rafraîchir : aucune relecture pendant
    /// une lecture en cours.
    private var canRefreshShown: Bool {
        graph.shown ? graph.state != .loading : model.canRefresh
    }

    /// Le crochet de recette force le mode graphe sur la fixture partagée, sans
    /// réseau : le chemin de rendu est celui de production. La recette `liste`
    /// garde la liste : seul son lecteur de fixture change (`init`).
    private func applyGraphRecipe() {
        guard let graphRecipe, graphRecipe != .liste else { return }
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
                    isPresented: $searchPresented,
                    placement: .automatic,
                    prompt: Text(verbatim: MemoryText.searchPrompt)
                )
                .searchFocused($searchFocused)
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
                stack.iosPanel().iosReadableWidth()
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
