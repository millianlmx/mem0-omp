// L'écran Mémoire de la coque iOS (BR-2) : le sommaire d'un projet de la mémoire
// du serveur — les MÊMES souvenirs que la section « Mémoire » de macOS quand le Mac
// est relié au même serveur —, un menu du projet lu, une recherche qui se SOUMET
// (jamais à la frappe), et l'état de la mémoire dit sans masquer sa cause.
//
// Chaque état rendu par `IOSMemoryModel.screen` a sa branche ici, et aucune phrase
// n'est composée : les mots viennent du noyau partagé (`MemoryText`) ou du
// vocabulaire de l'app (`IOSMemoryText`). Aucun geste d'écriture, aucun graphe.
//
// Contrôles SYSTÈME uniquement (aucun `onTapGesture`), cibles ≥ 44 pt. Le texte
// d'un souvenir est plafonné dans la liste par `IOSMetrics.memoryRowLines(_:)`
// (« … » en fin), et intégral dans la feuille ; rien d'autre n'est tronqué.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct IOSMemoryScreen: View {
    /// La mémoire du serveur (le code d'appairage) : les lectures et le projet lu.
    @ObservedObject var client: MemoryAccess
    /// Le crochet de recette `-ios.state error` (bandeau danger par-dessus).
    let recipe: IOSScreenState
    /// Le crochet de recette `-memoire.recipe` : mode graphe, ou liste sur fixture.
    let graphRecipe: IOSMemoryGraphRecipe?
    /// La feuille Serveur de la racine, ouverte par « Relier le serveur ».
    @Binding var showConnection: Bool
    @StateObject private var model: IOSMemoryModel
    @StateObject private var graph: IOSMemoryGraphModel
    /// La largeur disponible : elle fixe le plafond de lignes d'un souvenir (S-5).
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    /// La taille de texte système : elle décide de l'axe de la ligne de contexte (S-6).
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// La marge verticale d'une rangée, mise à l'échelle comme le corps de
    /// texte : aucun texte ne touche le filet voisin (rangees-sessions-memoire-serrees, S-4).
    @ScaledMetric(relativeTo: .body) private var rowPadding: CGFloat = IOSMetrics.rowVerticalPadding
    /// La présentation du champ de recherche, lue par `searchPresentedBinding`
    /// (⌘F la présente ; la bascule Graphe/Liste la retire).
    @State private var searchPresented = false
    /// Le focus du champ de recherche, posé par ⌘F.
    @FocusState private var searchFocused: Bool

    init(
        client: MemoryAccess,
        recipe: IOSScreenState,
        graphRecipe: IOSMemoryGraphRecipe? = nil,
        showConnection: Binding<Bool>
    ) {
        self.client = client
        self.recipe = recipe
        self.graphRecipe = graphRecipe
        _showConnection = showConnection
        if graphRecipe?.fails == true {
            // Les recettes de panne : la liste et le graphe lisent le MÊME lecteur qui échoue.
            let failing = IOSMemoryFailureReader()
            _model = StateObject(wrappedValue: IOSMemoryModel(client: failing))
            _graph = StateObject(wrappedValue: IOSMemoryGraphModel(client: failing))
        } else {
            let reader: any IOSMemoryReading = graphRecipe == .clavier ? IOSMemoryRecipeReader() : client
            _model = StateObject(wrappedValue: IOSMemoryModel(client: reader))
            _graph = StateObject(wrappedValue: IOSMemoryGraphModel(client: client))
        }
    }

    var body: some View {
        panel
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { projectMenu }
                ToolbarItem(placement: .topBarTrailing) { summaryButton }
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
            .task {
                await model.refresh()
                graphRecipe?.announce(list: model)
            }
            .onMemoryConfigured(client) {
                // Un code d'appairage vient d'être collé (S-4) : la liste relit, et le
                // graphe s'il est affiché.
                Task { await reload() }
            }
            .onAppear { applyGraphRecipe() }
            .onDisappear { graph.suspend() }
            .focusedSceneValue(\.iosRefresh, IOSCommandAction(
                owner: .memory,
                isEnabled: connection.gesturesEnabled && canRefreshShown
            ) { refreshShown() })
            .focusedSceneValue(\.iosSearch, IOSCommandAction(owner: .memory, isEnabled: offersSearch) {
                searchPresented = true
                searchFocused = true
            })
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(IOSMemoryAccessibility.screen)
    }

    /// Le projet lu : les portées de la mémoire, la plus récemment écrite en tête.
    /// En choisir une relit la liste, et le graphe s'il est affiché.
    private var projectMenu: some View {
        Menu {
            ForEach(client.scopes, id: \.self) { scope in
                Button {
                    client.choose(scope: scope)
                    Task { await reload() }
                } label: {
                    if scope == model.scope {
                        Label(scope, systemImage: "checkmark")
                    } else {
                        Text(verbatim: scope)
                    }
                }
                .accessibilityIdentifier(IOSMemoryAccessibility.projectOption(scope))
            }
        } label: {
            Label(IOSMemoryText.projectMenu, systemImage: IOSMemoryText.projectSymbol)
        }
        .disabled(!connection.gesturesEnabled || client.scopes.isEmpty)
        .accessibilityIdentifier(IOSMemoryAccessibility.project)
    }

    /// Une relecture complète : la liste, et le graphe s'il est affiché.
    private func reload() async {
        await model.refresh()
        if graph.shown { await graph.refresh() }
    }

    /// « Sommaire » est TOUJOURS là. Indisponible (mode Graphe, sommaire déjà
    /// affiché, recherche en cours), c'est un bouton désactivé du système : ni
    /// teinte maison ni bulle, comme sur le Mac.
    private var summaryButton: some View {
        Button {
            model.showSummary()
        } label: {
            Label(MemoryText.summaryButton, systemImage: IOSMemoryText.summarySymbol)
        }
        .disabled(!model.summaryAvailable(graphShown: graph.shown))
        .accessibilityIdentifier(IOSMemoryAccessibility.summary)
    }

    /// Le rafraîchissement de la vue affichée par ⌘R « Actualiser » (la liste
    /// a aussi son tirage, le graphe se relit à chaque passage).
    private func refreshShown() {
        if graph.shown {
            Task { await graph.refresh() }
        } else {
            Task { await model.refresh() }
        }
    }

    /// La disponibilité de ⌘R (hors connexion à part) :
    /// aucune relecture pendant une lecture en cours.
    private var canRefreshShown: Bool {
        graph.shown ? graph.state != .loading : model.canRefresh
    }

    /// Le crochet de recette force le mode graphe sur la fixture partagée, sans
    /// réseau : le chemin de rendu est celui de production. La recette `liste` garde
    /// la LISTE et ouvre la fiche de son souvenir par le présentateur de la liste ;
    /// la recette `clavier` garde la liste sans fiche : seul son lecteur de fixture
    /// change (`init`). Les recettes de panne passent par `activate` : `injoignable`
    /// n'y active rien (son signal suit la lecture de la liste, `.task`),
    /// `serviceAncien` y montre le graphe qui échoue.
    private func applyGraphRecipe() {
        guard let graphRecipe, graphRecipe != .clavier else { return }
        Task {
            await graphRecipe.activate(graph)
            if let selection = graphRecipe.listSelection(graph) {
                model.selection = selection
            }
        }
    }

    // MARK: - Statut de connexion

    /// Le statut présenté. Sous le crochet `-memoire.recipe`, la fixture tient
    /// lieu de serveur : l'écran est relié (etats-non-connecte-heterogenes-ios, S-4).
    private var connection: IOSConnectionStatus {
        if graphRecipe != nil { return .connected }
        return IOSConnectionStatus.of(client)
    }

    /// L'état de la liste pour le statut présenté.
    private var listState: IOSMemoryScreenState {
        model.state(connection: connection)
    }

    /// Le statut à rendre EN PLEIN ÉCRAN, à la place du panneau : hors connexion,
    /// quand le mode affiché n'a rien chargé (S-4). `nil` sinon.
    private var fullScreenStatus: IOSConnectionStatus? {
        guard connection != .connected else { return nil }
        if graph.shown {
            return IOSMemoryGraphModel.hasData(graph.state) ? nil : connection
        }
        if case .offline(let status) = listState { return status }
        return nil
    }

    private func openConnection() {
        showConnection = true
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
                    isPresented: searchPresentedBinding,
                    placement: .automatic,
                    prompt: Text(verbatim: MemoryText.searchPrompt)
                )
                .searchFocused($searchFocused)
                .onSubmit(of: .search) {
                    guard connection.gesturesEnabled else { return }
                    Task { await model.submitQuery() }
                }
        } else {
            content
        }
    }

    /// La surface : en mode GRAPHE, le panneau hors de tout défilement, pour que
    /// le canevas garde son déplacement et son zoom (le geste ne défile pas la
    /// page) ; en mode LISTE, la liste groupée de l'écran, son seul défilement
    /// (ios-listes-groupees-natives, S-3).
    @ViewBuilder
    private var surface: some View {
        let stack = VStack(alignment: .leading, spacing: 12) {
            recipeBanner
            IOSMemoryGraphView(model: graph, connection: connection, showConnection: $showConnection)
        }
        if let status = fullScreenStatus {
            // Rien de chargé, mémoire non reliée : le composant partagé SEUL, hors
            // du défilement et du panneau.
            IOSConnectionStateView(status: status, layout: .screen, onConnect: openConnection)
        } else if graph.shown {
            stack.iosPanel()
        } else {
            List {
                recipeBanner
                subject
            }
            .iosGroupedList()
            // Tirer pour actualiser (ios-gestes-et-retours-natifs, S-2) : la
            // relecture est attendue, l'indicateur système reste jusqu'à sa fin.
            .refreshable { await model.refresh() }
        }
    }

    /// Le bandeau du crochet de recette `-ios.state error`, quand il est donné :
    /// rangée nue dans la liste, sans effet dans le panneau du graphe.
    @ViewBuilder
    private var recipeBanner: some View {
        if let banner = recipe.banner, let message = recipe.bannerMessage {
            Text(verbatim: message)
                .font(.callout)
                .iosBanner(tone: banner.tone)
                .iosBareListRow()
        }
    }

    /// La saisie de la recherche. Mémoire non reliée, la recherche (soumise au
    /// serveur) est inerte : les écritures sont ignorées (etats-non-connecte-heterogenes-ios,
    /// S-5). Écart MESURÉ à D-2 : un `.disabled` sur la vue qui porte `.searchable`
    /// laisse le champ `.automatic` actif sur iOS 27 et grise tout le panneau, dont
    /// « Relier le serveur » du bandeau et les rangées. Une écriture ignorée redessine
    /// aussitôt l'écran : sans cela, le champ garde la frappe affichée jusqu'au
    /// rendu suivant (MESURÉ par la recette, contrôle 7).
    private var queryBinding: Binding<String> {
        Binding(
            get: { model.query },
            set: {
                if connection.gesturesEnabled {
                    model.updateQuery($0)
                } else {
                    model.objectWillChange.send()
                }
            }
        )
    }

    /// La présentation du champ : forcée à `false` hors connexion, le toucher
    /// n'ouvre ni focus ni clavier (etats-non-connecte-heterogenes-ios, S-5). Une
    /// présentation refusée redessine aussitôt l'écran, qui referme le champ.
    private var searchPresentedBinding: Binding<Bool> {
        Binding(
            get: { searchPresented && connection.gesturesEnabled },
            set: {
                if connection.gesturesEnabled {
                    searchPresented = $0
                } else {
                    model.objectWillChange.send()
                }
            }
        )
    }

    private var offersSearch: Bool {
        guard !graph.shown else { return false }
        switch listState {
        case .summary, .summaryEmpty, .search, .searchEmptyNoMatch, .searchEmptyNoScore, .searchEmptyBelowThreshold:
            return true
        default:
            return false
        }
    }

    // MARK: - Contenu, état par état

    /// Les rangées de la liste, état par état : bandeaux en rangées nues, états
    /// vides en rangées titre et détail, souvenirs dans une section dont
    /// l'en-tête natif dit le compte ou la recherche.
    @ViewBuilder
    private var subject: some View {
        if connection != .connected {
            // Données conservées hors connexion : le bandeau en tête (S-4).
            IOSConnectionStateView(status: connection, layout: .banner, onConnect: openConnection)
                .iosBareListRow()
        }
        switch listState {
        case .offline:
            // Rendu en plein écran par `surface`, jamais dans la liste.
            EmptyView()
        case .loading:
            HStack(spacing: 8) {
                ProgressView()
                Text(verbatim: MemoryText.loading)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        case .failed(.unreachable):
            banner(IOSMemoryErrorText.message(for: .unreachable), tone: .attention)
            stateRow(IOSMemoryText.noData)
            retryButton
        case .failed(.timedOut):
            banner(IOSMemoryErrorText.message(for: .timedOut), tone: .attention)
            stateRow(IOSMemoryText.noData)
            retryButton
        case .noProject:
            stateRow(MemoryText.noProjectTitle, detail: IOSMemoryText.noProjectDetail)
        case .failed(let cause):
            banner(IOSMemoryErrorText.message(for: cause), tone: .danger)
            retryButton
        case .summaryEmpty(let scope):
            stateRow(MemoryText.emptySummaryTitle, detail: MemoryText.emptySummary(scope))
        case .summary(_, let total, let rows, let more):
            rowsSection(rows, more: more) {
                header(MemoryText.summaryCount(total), identifier: IOSMemoryAccessibility.count)
            }
        case .search(let query, let rows):
            rowsSection(rows, more: nil) {
                header(MemoryText.searchResults(query), identifier: IOSMemoryAccessibility.results)
            }
        case .searchEmptyNoMatch:
            stateRow(MemoryText.noResultTitle, detail: MemoryText.noMatch)
        case .searchEmptyNoScore:
            stateRow(MemoryText.searchUnsupportedTitle, detail: MemoryText.noSemanticScore)
        case .searchEmptyBelowThreshold:
            stateRow(MemoryText.noResultTitle, detail: MemoryText.belowThreshold)
        }
    }

    // MARK: - Composants

    private func banner(_ text: String, tone: ConsoleTone) -> some View {
        Text(verbatim: text)
            .font(.callout)
            .iosBanner(tone: tone)
            .accessibilityIdentifier(IOSMemoryAccessibility.banner)
            .iosBareListRow()
    }

    /// L'en-tête natif de la section des souvenirs, au libellé exact (D-3).
    private func header(_ title: String, identifier: String) -> some View {
        Text(verbatim: title)
            .textCase(nil)
            .multilineTextAlignment(.leading)
            .accessibilityIdentifier(identifier)
    }

    /// La rangée d'un état sans souvenir : le titre, puis le détail, sans carte.
    private func stateRow(_ message: String, detail: String? = nil) -> some View {
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
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var retryButton: some View {
        Button { Task { await model.refresh() } } label: {
            Label(MemoryText.retry, systemImage: "arrow.clockwise")
                .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget)
                .contentShape(Rectangle())
        }
        .disabled(!connection.gesturesEnabled || !model.canRefresh)
        .accessibilityIdentifier(IOSMemoryAccessibility.retry)
    }

    /// La section des souvenirs, dans l'ORDRE reçu (aucun tri local), séparés par
    /// le système. Le pied de la page suivante est la DERNIÈRE rangée : la List,
    /// paresseuse, ne la crée qu'à l'approche du bas, et elle change d'identité
    /// à chaque page pour que son apparition relise la suivante.
    private func rowsSection<Header: View>(
        _ rows: [RemoteMemoryRow],
        more: IOSMemoryMore?,
        @ViewBuilder header: () -> Header
    ) -> some View {
        Section {
            ForEach(rows, id: \.id) { row in
                Button { model.selection = IOSMemorySelection(row: row) } label: {
                    rowLabel(row)
                }
                .buttonStyle(.plain)
                .frame(minHeight: IOSMetrics.minimumTarget, alignment: .leading)
                .accessibilityIdentifier(IOSMemoryAccessibility.row(row.id))
                .contextMenu {
                    IOSContextMenuItems(actions: IOSContextMenu.memory(row)) { action in
                        if case .copy(let copied) = action { IOSPasteboard.copy(copied) }
                    }
                }
                .iosHoverEffect()
            }
            if let more {
                moreFooter(more)
                    .id(rows.count)
            }
        } header: {
            header()
        }
    }

    /// Le pied de liste selon l'état de la page suivante (S-4) : seule la vue
    /// `.available` lit à son apparition ; hors connexion, aucun pied — le bandeau
    /// du composant d'état de connexion parle déjà en tête — et la reconnexion le
    /// remonte (donc relit) ; un échec garde les lignes et offre Réessayer ; une
    /// liste complète n'a aucun pied.
    @ViewBuilder
    private func moreFooter(_ more: IOSMemoryMore) -> some View {
        switch more {
        case .complete:
            EmptyView()
        case .available:
            if connection.gesturesEnabled {
                moreProgress
                    .onAppear { Task { await model.loadMore() } }
            }
        case .loading:
            moreProgress
        case .failed(let message):
            VStack(alignment: .leading, spacing: 8) {
                Text(verbatim: message)
                    .font(.callout)
                    .iosBanner(tone: .attention)
                Button { Task { await model.loadMore() } } label: {
                    Label(MemoryText.retry, systemImage: "arrow.clockwise")
                        .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget)
                        .contentShape(Rectangle())
                }
                .disabled(!connection.gesturesEnabled)
                .accessibilityIdentifier(IOSMemoryAccessibility.moreRetry)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(IOSMemoryAccessibility.more)
        }
    }

    /// Le retour visuel de la lecture de la page suivante : un seul élément
    /// accessible, dont le libellé est le texte affiché.
    private var moreProgress: some View {
        HStack(spacing: 8) {
            ProgressView()
            Text(verbatim: IOSMemoryText.loadingMore)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.leading)
        }
        .frame(maxWidth: .infinity, minHeight: IOSMetrics.minimumTarget, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: IOSMemoryText.loadingMore))
        .accessibilityIdentifier(IOSMemoryAccessibility.more)
    }

    /// Le texte du souvenir, puis sa ligne de contexte, seule rafraîchie à la
    /// minute par `TimelineView`, SANS relire la mémoire ni reconstruire la liste.
    private func rowLabel(_ row: RemoteMemoryRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: IOSMemoryDetailView.text(row))
                .font(.body)
                .lineLimit(IOSMetrics.memoryRowLines(horizontalSizeClass))
                .truncationMode(.tail)
                .multilineTextAlignment(.leading)
            TimelineView(.periodic(from: .now, by: 60)) { context in
                rowContext(row, nowMs: context.date.timeIntervalSince1970 * 1000)
            }
        }
        .padding(.vertical, rowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Toute la largeur de la rangée répond au toucher et au survol (S-7).
        .contentShape(Rectangle())
    }

    /// La ligne de contexte : une bande jointe par « · » aux tailles ordinaires,
    /// un segment par ligne aux tailles d'accessibilité.
    @ViewBuilder
    private func rowContext(_ row: RemoteMemoryRow, nowMs: Double) -> some View {
        if !dynamicTypeSize.isAccessibilitySize {
            let subtitle = IOSMemoryDetailView.subtitle(row, nowMs: nowMs)
            if !subtitle.isEmpty {
                Text(verbatim: subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
            }
        } else {
            let segments = IOSMemoryDetailView.subtitleSegments(row, nowMs: nowMs)
            if !segments.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(segments, id: \.self) { segment in
                        Text(verbatim: segment)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.leading)
                    }
                }
            }
        }
    }
}
