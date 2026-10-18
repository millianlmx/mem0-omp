// L'écran Accueil de l'app iOS (S-10, S-11) : cinq états — indisponible (le
// composant partagé d'état de connexion en plein écran), « OMP absent sur le
// Mac », chargement, premiers pas, tableau de bord — et, dans le tableau de bord,
// les deux bandeaux, la section « À vous », « En cours », « À reprendre »,
// « Pas commencées » et « Livrées récemment » ; les deux du milieu sont masquées
// quand elles sont vides. Chaque carte est dans une seule section
// (`HomePresentation.dashboard`, la MÊME règle que le Mac). Hors connexion, une
// ardoise déjà reçue reste affichée sous le bandeau du composant partagé
// (feature etats-non-connecte-heterogenes-ios, S-4).
//
// Aucune phrase n'est composée ici : les mots viennent du noyau partagé
// (`HomeText`, `ActionsText`, `ContractText`) et de `IOSHomeText` ; la vue rend
// les décisions pures de `IOSHomeState` et `IOSHomeContent`. Les rangées suivent
// `IOSAdaptiveRow` : tout sur une ligne quand tout y tient, sinon le titre sur sa
// ligne puis la puce et le bouton, sinon chacun sur sa ligne — selon le contenu,
// jamais selon la taille de texte, qui n'est plafonnée nulle part.
//
// Les gestes de carte (« Valider les specs », « Accepter la revue », « Reprendre »
// d'une rangée en pause ou d'une carte en échec ou bloquée) passent par
// `IOSHomeGestureModel`, possédé par la racine : bouton désactivé avec « Envoi en
// cours » jusqu'à la réponse du Mac, confirmation pour les specs seulement, échec
// affiché sur la carte, aucun message de succès.
//
// Surfaces : le tableau de bord est une liste groupée native
// (ios-listes-groupees-natives, S-4) — bandeaux en rangées nues, une section par
// groupe, en-têtes et séparateurs du système ; seules les cartes « À vous » sont
// des cartes élevées (`iosCard(raised: true)`), distinctes du fond groupé dans les
// deux apparences. `iosBanner(tone:)`/`IOSStatusChip`, les composants système,
// jamais un contrôle maison (`onTapGesture` interdit ; les seules cibles sont des
// `Button`, le texte d'une rangée n'en est pas une).

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
    /// Les gestes de carte : état en vol, échecs, confirmation des specs.
    @ObservedObject var gestures: IOSHomeGestureModel
    /// Le crochet de recette `-home.recipe`, quand il est donné.
    let recipe: IOSHomeRecipe?
    /// Le crochet de recette `-home.row`, quand il est donné : la rangée à amener en
    /// haut du tableau de bord (captures des rangées en Dynamic Type).
    let recipeRow: Int?
    /// La feuille de connexion de la racine, ouverte par « Se connecter ».
    @Binding var showConnection: Bool
    /// Sélection d'une section depuis l'Accueil (« Tout afficher », « Voir dans Pipelines »).
    let onSelectSection: (ConsoleSection) -> Void

    @Environment(\.openURL) private var openURL
    @Environment(\.horizontalSizeClass) private var sizeClass
    /// « Réduire les animations » : le défilement vers un échec se fait d'un saut (S-8).
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var answerCard: SelectedCard?
    @State private var contractCard: SelectedCard?
    @State private var dismissedBannerID: String?
    /// La feuille Répondre a signalé une question qui n'attend plus de réponse :
    /// l'alerte attend sa fermeture (`onDismiss`), une seule présentation à la fois.
    @State private var answerGonePending = false
    /// L'alerte « Réponse non envoyée » posée à la fermeture de la feuille ; « OK » seul.
    @State private var answerGone: IOSMenuFailure?

    init(
        client: ConsoleClientModel,
        gestures: IOSHomeGestureModel,
        recipe: IOSHomeRecipe? = nil,
        recipeRow: Int? = nil,
        showConnection: Binding<Bool>,
        onSelectSection: @escaping (ConsoleSection) -> Void
    ) {
        self.client = client
        self.gestures = gestures
        self.recipe = recipe
        self.recipeRow = recipeRow
        _showConnection = showConnection
        self.onSelectSection = onSelectSection
    }

    /// Le statut de connexion présenté : celui du crochet de recette, sinon celui
    /// du client.
    private var connection: IOSConnectionStatus {
        recipe?.connection ?? IOSConnectionStatus.of(client)
    }

    /// L'état de l'Accueil : le crochet de recette prime, sinon la machine à
    /// états partagée.
    private var state: IOSHomeState {
        if let recipe { return recipe.homeState }
        return IOSHomeState.resolve(connection: connection, board: client.board, omp: client.omp)
    }

    var body: some View {
        Group {
            switch state {
            case .unavailable(let status):
                IOSConnectionStateView(status: status, layout: .screen, onConnect: { showConnection = true })
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
        .sheet(item: $answerCard, onDismiss: {
            guard answerGonePending else { return }
            answerGonePending = false
            answerGone = IOSMenuFailure(title: IOSHomeText.answerNotSentTitle, message: IOSHomeText.answerQuestionGone)
        }) { selected in
            HomeAnswerSheet(
                card: selected.card,
                client: client,
                connection: connection,
                onQuestionGone: { answerGonePending = true }
            )
        }
        .sheet(item: $contractCard) { selected in
            HomeContractSheet(card: selected.card, client: client, recipePayload: recipe?.contractPayload)
        }
        .alert(
            answerGone?.title ?? "",
            isPresented: Binding(get: { answerGone != nil }, set: { if !$0 { answerGone = nil } }),
            presenting: answerGone
        ) { _ in
        } message: { failure in
            Text(failure.message)
        }
        .onAppear { presentRecipeSheet() }
        .focusedSceneValue(\.iosRefresh, IOSKeyboard.storeRefresh(client: client, owner: .home))
    }

    /// Le crochet `-home.recipe answer|contract|contractLong` ouvre sa feuille sur la carte de
    /// la fixture partagée : une capture montre alors un chemin de code réel.
    private func presentRecipeSheet() {
        guard let recipe, let card = recipe.sheetCard else { return }
        if recipe == .contract || recipe == .contractLong {
            contractCard = SelectedCard(card: card)
        } else {
            answerCard = SelectedCard(card: card)
        }
    }

    // MARK: - États


    private var macMissingView: some View {
        VStack(spacing: 16) {
            connectionBanner
            setupBanner
            ContentUnavailableView(
                IOSHomeText.macMissingTitle,
                systemImage: "shippingbox",
                description: Text(IOSHomeText.macMissingBody)
            )
        }
        .padding(IOSMetrics.margin(sizeClass))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .iosReadableWidth()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSHomeAccessibility.macMissingOMP)
    }

    private var loadingView: some View {
        VStack(spacing: 8) {
            setupBanner
            ProgressView()
        }
        .padding(IOSMetrics.margin(sizeClass))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .iosReadableWidth()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSHomeAccessibility.loading)
    }

    private var firstRunView: some View {
        VStack(spacing: 16) {
            connectionBanner
            setupBanner
            ContentUnavailableView {
                Label(HomeText.firstRunTitle, systemImage: "sparkles")
            } description: {
                Text(HomeText.firstRunBody)
            }
        }
        .padding(IOSMetrics.margin(sizeClass))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .iosReadableWidth()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSHomeAccessibility.firstRun)
    }

    // MARK: - Tableau de bord

    private func dashboardView(_ dashboard: HomeDashboard) -> some View {
        let showsRepo = HomePresentation.showsRepo(dashboard)
        let prominentID = HomePresentation.prominentAttentionID(dashboard)
        return ScrollViewReader { proxy in
            List {
                connectionBanner
                setupBanner
                launchBanner
                attentionSection(dashboard, showsRepo: showsRepo, prominentID: prominentID)
                runningSection(dashboard, showsRepo: showsRepo)
                pausedSection(dashboard, showsRepo: showsRepo)
                notStartedSection(dashboard, showsRepo: showsRepo)
                deliveredSection(dashboard, showsRepo: showsRepo)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(IOSHomeAccessibility.dashboard)
            .iosGroupedList()
            .onAppear { scrollToRecipeRow(dashboard, proxy: proxy) }
            .onChange(of: IOSHomeContent.offeredGestures(dashboard), initial: true) { _, offered in
                gestures.retain(offered)
            }
            .onChange(of: gestures.failures) { old, new in
                guard let key = new.keys.first(where: { old[$0] == nil }) else { return }
                withAnimation(IOSMotion.scrollAnimation(reduceMotion: reduceMotion)) {
                    proxy.scrollTo(IOSHomeAccessibility.failure(key.cardId), anchor: nil)
                }
            }
        }
    }

    /// Le crochet `-home.row <n>` : la rangée d'index `n` (`IOSHomeContent.rows` :
    /// « En cours », « À reprendre », « Pas commencées », puis « Livrées
    /// récemment ») en haut de la zone de défilement. Un index absent ou
    /// hors bornes ne défile pas. Le défilement manuel reste libre ensuite.
    private func scrollToRecipeRow(_ dashboard: HomeDashboard, proxy: ScrollViewProxy) {
        guard let recipeRow, let id = IOSHomeContent.recipeRowID(dashboard, index: recipeRow) else { return }
        proxy.scrollTo(id, anchor: .top)
    }

    /// « À vous » : l'en-tête natif porte « Tout afficher » ; chaque élément est
    /// une carte élevée dans une rangée nue.
    private func attentionSection(_ dashboard: HomeDashboard, showsRepo: Bool, prominentID: String?) -> some View {
        Section {
            if dashboard.attention.isEmpty {
                emptyLine(HomeText.attentionEmpty)
            } else {
                ForEach(dashboard.attention) { attention in
                    attentionCard(attention, showsRepo: showsRepo, prominent: attention.id == prominentID)
                        .iosBareListRow()
                }
            }
        } header: {
            IOSAdaptiveRow(spacing: 8) {
                Text(HomeText.attentionHeader)
                Button {
                    onSelectSection(IOSHomeContent.allPipelinesSection)
                } label: {
                    Text(HomeText.allPipelines)
                        .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget)
                        .contentShape(Rectangle())
                }
                .accessibilityIdentifier(IOSHomeAccessibility.allPipelines)
            }
            .textCase(nil)
        }
    }

    private func runningSection(_ dashboard: HomeDashboard, showsRepo: Bool) -> some View {
        Section {
            if dashboard.running.isEmpty {
                emptyLine(HomeText.runningEmpty)
            } else {
                rows(dashboard.running) { runningRow($0, showsRepo: showsRepo) }
            }
        } header: {
            sectionHeader(HomeText.runningHeader)
        }
    }

    /// « À reprendre » : les pipelines en pause. Masquée quand elle est vide.
    @ViewBuilder
    private func pausedSection(_ dashboard: HomeDashboard, showsRepo: Bool) -> some View {
        if !dashboard.paused.isEmpty {
            Section {
                rows(dashboard.paused) { pausedRow($0, showsRepo: showsRepo) }
            } header: {
                sectionHeader(HomeText.pausedHeader)
            }
        }
    }

    /// « Pas commencées » : les features jamais lancées. Masquée quand elle est vide.
    @ViewBuilder
    private func notStartedSection(_ dashboard: HomeDashboard, showsRepo: Bool) -> some View {
        if !dashboard.notStarted.isEmpty {
            Section {
                rows(dashboard.notStarted) { notStartedRow($0, showsRepo: showsRepo) }
            } header: {
                sectionHeader(HomeText.notStartedHeader)
            }
        }
    }

    private func deliveredSection(_ dashboard: HomeDashboard, showsRepo: Bool) -> some View {
        Section {
            if dashboard.delivered.isEmpty {
                emptyLine(HomeText.deliveredEmpty)
            } else {
                rows(dashboard.delivered) { deliveredRow($0, showsRepo: showsRepo) }
            }
        } header: {
            sectionHeader(HomeText.deliveredTitle)
        }
    }

    /// L'en-tête natif d'une section, dans la casse exacte de son libellé (D-3).
    private func sectionHeader(_ title: String) -> some View {
        Text(title).textCase(nil)
    }

    /// Les rangées d'une section, séparées par le système. Chaque rangée porte
    /// l'id de sa carte, cible du crochet `-home.row`.
    private func rows<Row: View>(_ cards: [KanbanCard], @ViewBuilder row: @escaping (KanbanCard) -> Row) -> some View {
        ForEach(cards, id: \.id) { card in
            row(card).id(card.id)
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
                IOSAdaptiveRow(spacing: 8, pinsControlsTrailing: false) {
                    Image(systemName: IOSHomeText.natureSymbol(attention.nature))
                        .foregroundStyle(.tint)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(HomeText.natureText(attention.nature))
                            .font(.caption.weight(.semibold))
                        Text(ConsoleFormat.relative(ms: card.startMs, nowMs: context.date.timeIntervalSince1970 * 1000))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Text(IOSHomeText.featureName(card.title)).font(.headline).accessibilityLabel(card.title)
            if showsRepo {
                Text(card.repo).font(.callout).foregroundStyle(.secondary)
            }
            Text(attention.prompt).font(.body)
            if let motive = attention.motive {
                Text(motive).font(.callout).foregroundStyle(.secondary)
            }
            IOSAdaptiveRow(spacing: 8, pinsControlsTrailing: false) {
                if ContractDocument.moment(for: card) != nil {
                    Button {
                        contractCard = SelectedCard(card: card)
                    } label: {
                        Text(ContractText.open)
                            .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget)
                            .contentShape(Rectangle())
                    }
                    .accessibilityIdentifier(IOSHomeAccessibility.attentionContract(card.id))
                    .disabled(!connection.gesturesEnabled)
                }
                attentionButton(attention, prominent: prominent)
            }
            failureBanner(IOSHomeContent.attentionGestureKey(attention))
        }
        .iosCard(raised: true)
        // Plusieurs gestes sur la carte : chacun borné à son libellé (D-4, T-5).
        .buttonStyle(.borderless)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSHomeAccessibility.attention(card.id))
        .contextMenu {
            IOSContextMenuItems(actions: IOSContextMenu.homeAttention(
                attention,
                gesturesEnabled: connection.gesturesEnabled,
                sending: IOSHomeContent.attentionGestureKey(attention).map(gestures.inFlight.contains) ?? false
            )) { performMenu($0, card: card) }
        }
    }

    @ViewBuilder
    private func attentionButton(_ attention: HomeAttention, prominent: Bool) -> some View {
        let card = attention.card
        styledButton(attentionButtonLabel(attention, card: card), prominent: prominent)
            .disabled(IOSHomeContent.attentionNeedsMac(IOSHomeContent.attentionButton(attention)) && !connection.gesturesEnabled)
            .accessibilityIdentifier(IOSHomeAccessibility.attentionAction(card.id))
            .confirmationDialog(
                IOSHomeText.specsConfirmTitle(card.title),
                isPresented: specsConfirmationShown(card.id),
                titleVisibility: .visible
            ) {
                // Ouverte avant une coupure, la confirmation n'envoie rien hors connexion.
                Button(IOSHomeText.specsConfirm) {
                    guard connection.gesturesEnabled else { return }
                    gestures.confirmSpecs(cardId: card.id, send: send)
                }
                Button(KanbanText.cancel, role: .cancel) {}
            } message: {
                Text(IOSHomeText.specsConfirmMessage)
            }
    }

    @ViewBuilder
    private func attentionButtonLabel(_ attention: HomeAttention, card: KanbanCard) -> some View {
        switch IOSHomeContent.attentionButton(attention) {
        case .answer:
            Button(HomeText.answerEllipsis) { answerCard = SelectedCard(card: card) }
        case .validate:
            gestureButton(KanbanText.validateSpecs, key: IOSHomeGestureKey(cardId: card.id, gesture: .validateSpecs))
        case .accept:
            gestureButton(KanbanText.acceptReview, key: IOSHomeGestureKey(cardId: card.id, gesture: .acceptReview))
        case .relaunch:
            // Une pipeline en échec ou bloquée : la route de reprise de la carte,
            // que le Mac traduit en relance de son maillon.
            gestureButton(KanbanText.resume, key: IOSHomeGestureKey(cardId: card.id, gesture: .resume))
        case .open:
            Button(HomeText.openInPipelines) { onSelectSection(IOSHomeContent.allPipelinesSection) }
        }
    }

    /// La confirmation de « Valider les specs » de la carte : ouverte tant que le
    /// modèle la désigne ; fermée par le système (« Annuler », toucher hors de la
    /// bulle, ou après « Valider »), elle s'efface sans rien envoyer.
    private func specsConfirmationShown(_ cardId: String) -> Binding<Bool> {
        Binding(
            get: { gestures.specsConfirmation == cardId },
            set: { if !$0 { gestures.cancelSpecs() } }
        )
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

    /// « En cours » : une pipeline réellement en marche, avec sa durée — ou que
    /// l'arbitre tient en arrière-plan, son état en pastille.
    private func runningRow(_ card: KanbanCard, showsRepo: Bool) -> some View {
        IOSAdaptiveRow(spacing: 12) {
            rowTitle(card, showsRepo: showsRepo)
            if card.action?.arbiter.isArbitrating == true {
                IOSStatusChip(status: ConsoleStatus.of(card: card))
            }
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text(ConsoleFormat.duration(ms: card.elapsedMs(nowMs: context.date.timeIntervalSince1970 * 1000)))
                    .font(.callout)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSHomeAccessibility.running(card.id))
        .contextMenu { rowMenu(card, kind: .running) }
    }

    /// « À reprendre » : une pipeline en pause, sa puce « En pause » et
    /// « Reprendre » ; l'échec du geste s'affiche sous la ligne.
    private func pausedRow(_ card: KanbanCard, showsRepo: Bool) -> some View {
        let key = IOSHomeGestureKey(cardId: card.id, gesture: .resume)
        return VStack(alignment: .leading, spacing: 8) {
            IOSAdaptiveRow(spacing: 12) {
                rowTitle(card, showsRepo: showsRepo)
                IOSStatusChip(status: ConsoleStatus.of(card: card))
                if card.action != nil {
                    gestureButton(KanbanText.resume, key: key)
                        .buttonStyle(.bordered)
                        .disabled(!connection.gesturesEnabled)
                        .accessibilityIdentifier(IOSHomeAccessibility.resume(card.id))
                }
            }
            failureBanner(key)
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSHomeAccessibility.paused(card.id))
        .contextMenu { rowMenu(card, kind: .paused) }
    }

    /// « Pas commencées » : une feature jamais lancée, titre et sous-titre seuls.
    private func notStartedRow(_ card: KanbanCard, showsRepo: Bool) -> some View {
        rowTitle(card, showsRepo: showsRepo)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 8)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(IOSHomeAccessibility.notStarted(card.id))
            .contextMenu { rowMenu(card, kind: .notStarted) }
    }

    /// Le titre et le sous-titre d'une rangée « En cours », « À reprendre » ou
    /// « Pas commencées ».
    private func rowTitle(_ card: KanbanCard, showsRepo: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(IOSHomeText.featureName(card.title))
                .font(.body.weight(.medium))
                .accessibilityLabel(card.title)
                .accessibilityIdentifier(IOSHomeAccessibility.rowTitle(card.id))
            if let subtitle = HomeText.cardSubtitle(
                card,
                noPhase: ConsoleStatus.of(card: card).text,
                showsRepo: showsRepo
            ) {
                Text(subtitle).font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    /// Une livraison récente : seul « Ouvrir la PR » est une cible ; le titre, le
    /// dépôt et la puce ne réagissent pas au toucher.
    private func deliveredRow(_ card: KanbanCard, showsRepo: Bool) -> some View {
        let link = IOSHomeContent.deliveredLink(card)
        return IOSAdaptiveRow(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(IOSHomeText.featureName(card.title))
                    .accessibilityLabel(card.title)
                    .accessibilityIdentifier(IOSHomeAccessibility.rowTitle(card.id))
                if showsRepo {
                    Text(card.repo).foregroundStyle(.secondary)
                }
            }
            IOSStatusChip(status: ConsoleStatus.of(card: card))
            if let link {
                Button { openURL(link) } label: {
                    Text(HomeText.openPR)
                        .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier(IOSHomeAccessibility.deliveredOpen(card.id))
            }
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSHomeAccessibility.delivered(card.id))
        .contextMenu { rowMenu(card, kind: .delivered) }
    }

    // MARK: - Bandeaux

    /// Hors connexion, le bandeau du composant partagé au-dessus des données
    /// conservées (S-4) ; il disparaît dès la connexion.
    @ViewBuilder
    private var connectionBanner: some View {
        if connection != .connected {
            IOSConnectionStateView(status: connection, layout: .banner, onConnect: { showConnection = true })
                .iosBareListRow()
        }
    }

    @ViewBuilder
    private var setupBanner: some View {
        if let text = IOSHomeContent.setupBanner(components: client.components) {
            Text(text)
                .font(.callout)
                .iosBanner(tone: .attention)
                .accessibilityIdentifier(IOSHomeAccessibility.setupBanner)
                .iosBareListRow()
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
            .iosBareListRow()
        }
    }

    // MARK: - Gestes

    /// L'envoi des gestes : celui de la recette quand elle en donne un (`slowMac`),
    /// sinon les routes du client.
    private var send: IOSHomeGestureModel.Send {
        recipe?.gestureSend ?? IOSHomeGestureModel.live(client)
    }

    /// Un bouton de geste : en vol, il est désactivé et montre un indicateur devant
    /// son libellé (la largeur ne saute pas) avec la valeur « Envoi en cours ».
    private func gestureButton(_ title: String, key: IOSHomeGestureKey) -> some View {
        let sending = gestures.inFlight.contains(key)
        return Button {
            gestures.tap(key, send: send)
        } label: {
            if sending {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(title)
                }
            } else {
                Text(title)
            }
        }
        .disabled(sending)
        .accessibilityValue(sending ? IOSHomeText.gestureInFlight : "")
    }

    // MARK: - Menus contextuels (ios-gestes-et-retours-natifs, S-4)

    /// Le menu d'une rangée : « Reprendre » d'une pause disparaît tant que son
    /// geste est en vol.
    private func rowMenu(_ card: KanbanCard, kind: IOSHomeRowKind) -> some View {
        IOSContextMenuItems(actions: IOSContextMenu.homeRow(
            card,
            kind: kind,
            gesturesEnabled: connection.gesturesEnabled,
            sending: gestures.inFlight.contains(IOSHomeGestureKey(cardId: card.id, gesture: .resume))
        )) { performMenu($0, card: card) }
    }

    /// Un choix du menu emprunte le chemin du contrôle existant : la feuille
    /// « Répondre », la même clé de geste que le bouton (« Valider les specs »
    /// ouvre sa confirmation), la section Pipelines, la feuille du contrat, la PR.
    /// Un échec s'affiche sur la carte, comme pour le bouton.
    private func performMenu(_ action: IOSMenuAction, card: KanbanCard) {
        switch action {
        case .answer:
            answerCard = SelectedCard(card: card)
        case .validateSpecs:
            gestures.tap(IOSHomeGestureKey(cardId: card.id, gesture: .validateSpecs), send: send)
        case .acceptReview:
            gestures.tap(IOSHomeGestureKey(cardId: card.id, gesture: .acceptReview), send: send)
        case .resume:
            gestures.tap(IOSHomeGestureKey(cardId: card.id, gesture: .resume), send: send)
        case .showInPipelines:
            onSelectSection(IOSHomeContent.allPipelinesSection)
        case .readContract:
            contractCard = SelectedCard(card: card)
        case .openPR(let url):
            openURL(url)
        case .copy(let copied):
            IOSPasteboard.copy(copied)
        case .launch, .stop, .copyPath, .openInProject, .stopAudit:
            // Jamais offerts par l'Accueil (`IOSContextMenu.homeAttention`/`homeRow`).
            break
        }
    }

    /// L'échec du geste d'une carte, sur la carte : pleine largeur, ton `danger`.
    /// Son `id` sert au défilement minimal qui le rend visible à son apparition.
    @ViewBuilder
    private func failureBanner(_ key: IOSHomeGestureKey?) -> some View {
        if let key, let message = gestures.failures[key] {
            Text(message)
                .font(.callout)
                .iosBanner(tone: .danger)
                .accessibilityIdentifier(IOSHomeAccessibility.failure(key.cardId))
                .id(IOSHomeAccessibility.failure(key.cardId))
        }
    }
}
