// L'écran Accueil de l'app iOS (S-10, S-11) : cinq états — déconnecté, « OMP
// absent sur le Mac », chargement, premiers pas, tableau de bord — et, dans le
// tableau de bord, les deux bandeaux, la section « À vous », « En cours » et
// « Livrées récemment ».
//
// Aucune phrase n'est composée ici : les mots viennent du noyau partagé
// (`HomeText`, `ActionsText`, `ContractText`) et de `IOSHomeText` ; la vue rend
// les décisions pures de `IOSHomeState` et `IOSHomeContent`. Les rangées « En
// cours » et « Livrées récemment » s'empilent aux tailles d'accessibilité
// (`IOSHomeContent.rowAxis`) et restent sur une ligne aux tailles standard.
//
// Surfaces : `iosPanel()`/`iosCard()`/`iosBanner(tone:)`/`IOSStatusChip`, les
// composants système, jamais un contrôle maison (`onTapGesture` interdit ; les
// lignes tappables sont des `Button`).

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Une carte sélectionnée pour une feuille, identifiée par son id.
private struct SelectedCard: Identifiable {
    let card: KanbanCard
    var id: String { card.id }
}

struct HomeView: View {
    @ObservedObject var client: ConsoleClientModel
    /// Le crochet de recette `-home.recipe`, quand il est donné.
    let recipe: IOSHomeRecipe?
    /// Le crochet de recette `-home.row`, quand il est donné : la rangée à amener en
    /// haut du tableau de bord (captures des rangées en Dynamic Type).
    let recipeRow: Int?
    /// La feuille de connexion de la racine, ouverte par l'état déconnecté.
    @Binding var showConnection: Bool
    /// Sélection d'une section depuis l'Accueil (« Tout afficher », « Voir dans Pipelines »).
    let onSelectSection: (ConsoleSection) -> Void

    @Environment(\.openURL) private var openURL
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @State private var answerCard: SelectedCard?
    @State private var contractCard: SelectedCard?
    @State private var dismissedBannerID: String?
    @State private var gestureFailure: String?

    init(
        client: ConsoleClientModel,
        recipe: IOSHomeRecipe? = nil,
        recipeRow: Int? = nil,
        showConnection: Binding<Bool>,
        onSelectSection: @escaping (ConsoleSection) -> Void
    ) {
        self.client = client
        self.recipe = recipe
        self.recipeRow = recipeRow
        _showConnection = showConnection
        self.onSelectSection = onSelectSection
    }

    /// L'état de l'Accueil : le crochet de recette prime, sinon la machine à
    /// états partagée.
    private var state: IOSHomeState {
        if let recipe { return recipe.homeState }
        return IOSHomeState.resolve(state: client.state, board: client.board, omp: client.omp)
    }

    var body: some View {
        Group {
            switch state {
            case .disconnected(let clientState):
                disconnectedView(clientState)
            case .macMissingOMP:
                macMissingView
            case .loading:
                loadingView
            case .firstRun:
                firstRunView
            case .dashboard(let dashboard):
                dashboardView(dashboard)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle(ConsoleSection.home.title)
        .sheet(item: $answerCard) { selected in
            HomeAnswerSheet(card: selected.card, client: client)
        }
        .sheet(item: $contractCard) { selected in
            HomeContractSheet(card: selected.card, client: client, recipePayload: recipe?.contractPayload)
        }
        .onAppear { presentRecipeSheet() }
    }

    /// Le crochet `-home.recipe answer|contract` ouvre sa feuille sur la carte de
    /// la fixture partagée : une capture montre alors un chemin de code réel.
    private func presentRecipeSheet() {
        guard let recipe, let card = recipe.sheetCard else { return }
        if recipe == .contract {
            contractCard = SelectedCard(card: card)
        } else {
            answerCard = SelectedCard(card: card)
        }
    }

    // MARK: - États

    private func disconnectedView(_ clientState: ClientState) -> some View {
        VStack(spacing: 16) {
            setupBanner
            ContentUnavailableView {
                Label(IOSHomeText.disconnectedTitle, systemImage: "wifi.slash")
            } description: {
                VStack(spacing: 6) {
                    Text(ConnectionText.state(clientState))
                    Text(IOSHomeText.disconnectedBody)
                }
            } actions: {
                Button(IOSHomeText.connect) { showConnection = true }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier(IOSHomeAccessibility.connect)
            }
        }
        .padding(IOSMetrics.margin(sizeClass))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSHomeAccessibility.disconnected)
    }

    private var macMissingView: some View {
        VStack(spacing: 16) {
            setupBanner
            ContentUnavailableView(
                IOSHomeText.macMissingTitle,
                systemImage: "shippingbox",
                description: Text(IOSHomeText.macMissingBody)
            )
        }
        .padding(IOSMetrics.margin(sizeClass))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSHomeAccessibility.macMissingOMP)
    }

    private var loadingView: some View {
        VStack(spacing: 8) {
            setupBanner
            ProgressView()
            Text(KanbanBoardState.loadingText)
                .foregroundStyle(.secondary)
        }
        .padding(IOSMetrics.margin(sizeClass))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSHomeAccessibility.loading)
    }

    private var firstRunView: some View {
        VStack(spacing: 16) {
            setupBanner
            ContentUnavailableView {
                Label(HomeText.firstRunTitle, systemImage: "sparkles")
            } description: {
                Text(HomeText.firstRunBody)
            }
        }
        .padding(IOSMetrics.margin(sizeClass))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSHomeAccessibility.firstRun)
    }

    // MARK: - Tableau de bord

    private func dashboardView(_ dashboard: HomeDashboard) -> some View {
        let showsRepo = HomePresentation.showsRepo(dashboard)
        let prominentID = HomePresentation.prominentAttentionID(dashboard)
        return ScrollViewReader { proxy in
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 28) {
                    setupBanner
                    launchBanner
                    if let gestureFailure {
                        Text(gestureFailure)
                            .font(.callout)
                            .iosBanner(tone: .danger)
                    }
                    attentionSection(dashboard, showsRepo: showsRepo, prominentID: prominentID)
                    runningSection(dashboard, showsRepo: showsRepo)
                    deliveredSection(dashboard, showsRepo: showsRepo)
                }
                .padding(IOSMetrics.margin(sizeClass))
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(IOSHomeAccessibility.dashboard)
            .onAppear { scrollToRecipeRow(dashboard, proxy: proxy) }
        }
    }

    /// Le crochet `-home.row <n>` : la rangée d'index `n` (« En cours » puis
    /// « Livrées récemment ») en haut de la zone de défilement. Un index absent ou
    /// hors bornes ne défile pas. Le défilement manuel reste libre ensuite.
    private func scrollToRecipeRow(_ dashboard: HomeDashboard, proxy: ScrollViewProxy) {
        guard let recipeRow, let id = IOSHomeContent.recipeRowID(dashboard, index: recipeRow) else { return }
        proxy.scrollTo(id, anchor: .top)
    }

    private func attentionSection(_ dashboard: HomeDashboard, showsRepo: Bool, prominentID: String?) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(HomeText.attentionHeader).font(.title2.bold())
                Spacer()
                Button(HomeText.allPipelines) { onSelectSection(IOSHomeContent.allPipelinesSection) }
                    .accessibilityIdentifier(IOSHomeAccessibility.allPipelines)
            }
            if dashboard.attention.isEmpty {
                emptyLine(HomeText.attentionEmpty)
            } else {
                ForEach(dashboard.attention) { attention in
                    attentionCard(attention, showsRepo: showsRepo, prominent: attention.id == prominentID)
                }
            }
        }
    }

    private func runningSection(_ dashboard: HomeDashboard, showsRepo: Bool) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(HomeText.runningHeader).font(.title3.bold())
            if dashboard.running.isEmpty {
                emptyLine(HomeText.runningEmpty)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(dashboard.running.enumerated()), id: \.element.id) { index, card in
                        if index > 0 { Divider() }
                        runningRow(card, showsRepo: showsRepo).id(card.id)
                    }
                }
                .iosCard()
            }
        }
    }

    private func deliveredSection(_ dashboard: HomeDashboard, showsRepo: Bool) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(HomeText.deliveredTitle).font(.title3.bold())
            if dashboard.delivered.isEmpty {
                emptyLine(HomeText.deliveredEmpty)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(dashboard.delivered.enumerated()), id: \.element.id) { index, card in
                        if index > 0 { Divider() }
                        deliveredRow(card, showsRepo: showsRepo).id(card.id)
                    }
                }
                .iosCard()
            }
        }
    }

    private func emptyLine(_ text: String) -> some View {
        Text(text).font(.callout).foregroundStyle(.secondary)
    }

    // MARK: - Carte d'attente

    private func attentionCard(_ attention: HomeAttention, showsRepo: Bool, prominent: Bool) -> some View {
        let card = attention.card
        return VStack(alignment: .leading, spacing: 10) {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                HStack(spacing: 10) {
                    Image(systemName: IOSHomeText.natureSymbol(attention.nature))
                        .foregroundStyle(.tint)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(HomeText.natureText(attention.nature))
                            .font(.caption.weight(.semibold))
                        Text(ConsoleFormat.relative(ms: card.startMs, nowMs: context.date.timeIntervalSince1970 * 1000))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Text(card.title).font(.headline)
            if showsRepo {
                Text(card.repo).font(.callout).foregroundStyle(.secondary)
            }
            Text(attention.prompt).font(.body)
            HStack(spacing: 8) {
                if ContractDocument.moment(for: card) != nil {
                    Button(ContractText.open) { contractCard = SelectedCard(card: card) }
                        .accessibilityIdentifier(IOSHomeAccessibility.attentionContract(card.id))
                }
                attentionButton(attention, prominent: prominent)
            }
        }
        .iosCard()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSHomeAccessibility.attention(card.id))
    }

    @ViewBuilder
    private func attentionButton(_ attention: HomeAttention, prominent: Bool) -> some View {
        let card = attention.card
        styledButton(attentionButtonLabel(attention, card: card), prominent: prominent)
            .accessibilityIdentifier(IOSHomeAccessibility.attentionAction(card.id))
    }

    @ViewBuilder
    private func attentionButtonLabel(_ attention: HomeAttention, card: KanbanCard) -> some View {
        switch IOSHomeContent.attentionButton(attention) {
        case .answer:
            Button(HomeText.answerEllipsis) { answerCard = SelectedCard(card: card) }
        case .validate:
            Button(KanbanText.validateSpecs) { sendVerdict(card, verdict: IOSHomeText.verdictSpecs) }
        case .accept:
            Button(KanbanText.acceptReview) { sendVerdict(card, verdict: IOSHomeText.verdictReview) }
        case .open:
            Button(HomeText.openInPipelines) { onSelectSection(IOSHomeContent.allPipelinesSection) }
        }
    }

    @ViewBuilder
    private func styledButton<Content: View>(_ content: Content, prominent: Bool) -> some View {
        if prominent {
            content.buttonStyle(.borderedProminent)
        } else {
            content.buttonStyle(.bordered)
        }
    }

    // MARK: - Lignes

    private func runningRow(_ card: KanbanCard, showsRepo: Bool) -> some View {
        rowLayout {
            VStack(alignment: .leading, spacing: 2) {
                Text(card.title).font(.body.weight(.medium))
                if let subtitle = HomeText.cardSubtitle(
                    card,
                    noPhase: ConsoleStatus.of(card: card).text,
                    showsRepo: showsRepo
                ) {
                    Text(subtitle).font(.callout).foregroundStyle(.secondary)
                }
            }
            if rowAxis == .horizontal { Spacer() }
            IOSStatusChip(status: ConsoleStatus.of(card: card))
            if KanbanActionPresentation.resumable(card), card.action != nil {
                Button(KanbanText.resume) { resume(card) }
                    .buttonStyle(.bordered)
                    .dynamicTypeSize(...IOSHomeContent.rowButtonMaximumSize)
                    .accessibilityIdentifier(IOSHomeAccessibility.resume(card.id))
            } else {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(ConsoleFormat.duration(ms: card.elapsedMs(nowMs: context.date.timeIntervalSince1970 * 1000)))
                        .font(.callout)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
        }
        .dynamicTypeSize(...IOSHomeContent.rowTextMaximumSize)
        .padding(.vertical, 8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSHomeAccessibility.running(card.id))
    }

    /// L'axe des rangées « titre | puce | bouton » (règle pure : `IOSHomeContent.rowAxis`).
    private var rowAxis: IOSHomeRowAxis { IOSHomeContent.rowAxis(dynamicTypeSize) }

    /// `AnyLayout` : la bascule d'axe à chaud conserve l'état des sous-vues.
    private var rowLayout: AnyLayout {
        switch rowAxis {
        case .horizontal: AnyLayout(HStackLayout(spacing: 12))
        case .stacked: AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
        }
    }

    private func deliveredRow(_ card: KanbanCard, showsRepo: Bool) -> some View {
        let link = IOSHomeContent.deliveredLink(card)
        return rowLayout {
            if let link {
                Button { openURL(link) } label: {
                    deliveredLabel(card, showsRepo: showsRepo)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier(IOSHomeAccessibility.delivered(card.id))
                Button(HomeText.openPR) { openURL(link) }
                    .buttonStyle(.bordered)
                    .dynamicTypeSize(...IOSHomeContent.rowButtonMaximumSize)
                    .accessibilityIdentifier(IOSHomeAccessibility.deliveredOpen(card.id))
            } else {
                deliveredLabel(card, showsRepo: showsRepo)
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier(IOSHomeAccessibility.delivered(card.id))
            }
        }
        .dynamicTypeSize(...IOSHomeContent.rowTextMaximumSize)
        .padding(.vertical, 8)
    }

    private func deliveredLabel(_ card: KanbanCard, showsRepo: Bool) -> some View {
        rowLayout {
            VStack(alignment: .leading, spacing: 2) {
                Text(card.title)
                if showsRepo {
                    Text(card.repo).foregroundStyle(.secondary)
                }
            }
            if rowAxis == .horizontal { Spacer() }
            IOSStatusChip(status: ConsoleStatus.of(card: card))
        }
        .contentShape(Rectangle())
    }

    // MARK: - Bandeaux

    @ViewBuilder
    private var setupBanner: some View {
        if let text = IOSHomeContent.setupBanner(components: client.components) {
            Text(text)
                .font(.callout)
                .iosBanner(tone: .attention)
                .accessibilityIdentifier(IOSHomeAccessibility.setupBanner)
        }
    }

    @ViewBuilder
    private var launchBanner: some View {
        if let entry = IOSHomeContent.launchBanner(journal: client.journal, dismissedID: dismissedBannerID) {
            HStack(spacing: 8) {
                Text(HomeText.launchBanner(title: entry.targetLabel, state: entry.state))
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button(HomeText.dismiss) { dismissedBannerID = entry.id }
                    .accessibilityIdentifier(IOSHomeAccessibility.launchBannerDismiss)
            }
            .iosBanner(tone: IOSHomeContent.launchTone(entry.state))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(IOSHomeAccessibility.launchBanner)
        }
    }

    // MARK: - Gestes

    private func sendVerdict(_ card: KanbanCard, verdict: String) {
        gestureFailure = nil
        Task {
            do {
                _ = try await client.verdict(cardId: card.id, verdict: verdict)
            } catch {
                gestureFailure = IOSHomeContent.failure(error)
            }
        }
    }

    private func resume(_ card: KanbanCard) {
        gestureFailure = nil
        Task {
            do {
                _ = try await client.resume(cardId: card.id)
            } catch {
                gestureFailure = IOSHomeContent.failure(error)
            }
        }
    }
}
