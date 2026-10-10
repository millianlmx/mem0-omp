// L'écran Mémoire de la coque iOS (BR-2) : le sommaire du projet ouvert — les
// MÊMES souvenirs que la section « Mémoire » de macOS —, une recherche qui se
// SOUMET (jamais à la frappe), et l'état de la mémoire dit sans masquer sa cause.
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
    @ObservedObject var client: ConsoleClientModel
    /// Le crochet de recette `-ios.state error` (bandeau danger par-dessus).
    let recipe: IOSScreenState
    /// Le crochet de recette `-memoire.recipe` du mode graphe.
    let graphRecipe: IOSMemoryGraphRecipe?
    /// La feuille Connexion de la racine, ouverte par « Se connecter ».
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
    /// La raison montrée dans la bulle de « Sommaire » : figée au toucher, tant que
    /// la bulle est ouverte.
    @State private var summaryReason: String?
    /// La présentation du champ de recherche, lue par `searchPresentedBinding`.
    @State private var searchPresented = false

    init(
        client: ConsoleClientModel,
        recipe: IOSScreenState,
        graphRecipe: IOSMemoryGraphRecipe? = nil,
        showConnection: Binding<Bool>
    ) {
        self.client = client
        self.recipe = recipe
        self.graphRecipe = graphRecipe
        _showConnection = showConnection
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
                    .disabled(!connection.gesturesEnabled || (graph.shown ? graph.state == .loading : !model.canRefresh))
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
            .onMacReconnected(client) {
                // Retour du Mac (S-4) : la liste relit, et le graphe s'il est affiché.
                Task {
                    await model.refresh()
                    if graph.shown { await graph.refresh() }
                }
            }
            .onAppear { applyGraphRecipe() }
            .onDisappear { graph.suspend() }
            .accessibilityElement(children: .contain)
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
    /// réseau : le chemin de rendu est celui de production. La recette `liste` garde
    /// la LISTE et ouvre la fiche de son souvenir par le présentateur de la liste.
    private func applyGraphRecipe() {
        guard let graphRecipe else { return }
        Task {
            await graphRecipe.activate(graph)
            if let selection = graphRecipe.listSelection(graph) {
                model.selection = selection
            }
        }
    }

    // MARK: - Statut de connexion

    /// Le statut présenté. Sous le crochet `-memoire.recipe`, la fixture tient
    /// lieu de Mac : l'écran est connecté (etats-non-connecte-heterogenes-ios, S-4).
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
                .onSubmit(of: .search) {
                    guard connection.gesturesEnabled else { return }
                    Task { await model.submitQuery() }
                }
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
        if let status = fullScreenStatus {
            // Rien de chargé, Mac non connecté : le composant partagé SEUL, hors
            // du défilement et du panneau.
            IOSConnectionStateView(status: status, layout: .screen, onConnect: openConnection)
        } else if graph.shown {
            stack.iosPanel()
        } else {
            ScrollView(.vertical) {
                stack.iosPanel()
            }
        }
    }

    /// La saisie de la recherche. Hors connexion, la recherche (soumise au Mac)
    /// est inerte : les écritures sont ignorées (etats-non-connecte-heterogenes-ios,
    /// S-5). Écart MESURÉ à D-2 : un `.disabled` sur la vue qui porte `.searchable`
    /// laisse le champ `.automatic` actif sur iOS 27 et grise tout le panneau, dont
    /// « Se connecter » du bandeau et les rangées. Une écriture ignorée redessine
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

    /// Le contenu de la section : le graphe quand la bascule l'a demandé, la LISTE
    /// sinon (mode d'ouverture, B-4).
    @ViewBuilder private var displayed: some View {
        if graph.shown {
            IOSMemoryGraphView(model: graph, connection: connection, showConnection: $showConnection)
        } else {
            subject
        }
    }

    // MARK: - Contenu, état par état

    @ViewBuilder
    private var subject: some View {
        if connection != .connected {
            // Données conservées hors connexion : le bandeau en tête (S-4).
            IOSConnectionStateView(status: connection, layout: .banner, onConnect: openConnection)
        }
        switch listState {
        case .offline:
            // Rendu en plein écran par `surface`, jamais dans le panneau.
            EmptyView()
        case .loading:
            ProgressView()
            Text(verbatim: MemoryText.loading)
                .font(.callout)
                .foregroundStyle(.secondary)
        case .failed(.macUnreachable):
            banner(IOSMacErrorText.message(for: .macUnreachable), tone: .attention)
            card(IOSMemoryText.noData)
            retryButton
        case .failed(.macTimedOut):
            banner(IOSMacErrorText.message(for: .macTimedOut), tone: .attention)
            card(IOSMemoryText.noData)
            retryButton
        case .failed(.macOutdated):
            banner(IOSMacErrorText.message(for: .macOutdated), tone: .attention)
            retryButton
        case .noProject:
            card(MemoryText.noProjectTitle, detail: IOSMemoryText.noProjectDetail)
        case .failed(let cause):
            banner(IOSMacErrorText.message(for: cause), tone: .danger)
            retryButton
        case .summaryEmpty(let scope):
            card(MemoryText.emptySummaryTitle, detail: MemoryText.emptySummary(scope))
        case .summary(_, let total, let rows, let more):
            header(MemoryText.summaryCount(total), identifier: IOSMemoryAccessibility.count)
            rowsList(rows, more: more)
        case .search(let query, let rows):
            header(MemoryText.searchResults(query), identifier: IOSMemoryAccessibility.results)
            rowsList(rows, more: nil)
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
                .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget)
                .contentShape(Rectangle())
        }
        .disabled(!connection.gesturesEnabled || !model.canRefresh)
        .accessibilityIdentifier(IOSMemoryAccessibility.retry)
    }

    /// La liste des souvenirs, dans l'ORDRE reçu (aucun tri local) : la ligne de
    /// contexte est rafraîchie à la minute par `TimelineView`, SANS relire la
    /// mémoire. Le pied de la page suivante est le DERNIER élément du
    /// `LazyVStack` : il n'est créé qu'à l'approche du bas, et change d'identité
    /// à chaque page pour que son apparition relise la suivante.
    private func rowsList(_ rows: [RemoteMemoryRow], more: IOSMemoryMore?) -> some View {
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
                if let more {
                    moreFooter(more)
                        .id(rows.count)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
            .padding(.top, 12)
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

    private func rowLabel(_ row: RemoteMemoryRow, nowMs: Double) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: IOSMemoryDetailView.text(row))
                .font(.body)
                .lineLimit(IOSMetrics.memoryRowLines(horizontalSizeClass))
                .truncationMode(.tail)
                .multilineTextAlignment(.leading)
            rowContext(row, nowMs: nowMs)
        }
        .dynamicTypeSize(...IOSHomeContent.rowTextMaximumSize)
        .padding(.vertical, rowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// La ligne de contexte : une bande jointe par « · » aux tailles ordinaires,
    /// un segment par ligne aux tailles d'accessibilité (règle de l'Accueil,
    /// `IOSHomeContent.rowAxis`, lue sur la SEULE taille système, largeur `nil`).
    @ViewBuilder
    private func rowContext(_ row: RemoteMemoryRow, nowMs: Double) -> some View {
        switch IOSHomeContent.rowAxis(dynamicTypeSize, width: nil) {
        case .horizontal, .twoLine:
            let subtitle = IOSMemoryDetailView.subtitle(row, nowMs: nowMs)
            if !subtitle.isEmpty {
                Text(verbatim: subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
            }
        case .stacked:
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
