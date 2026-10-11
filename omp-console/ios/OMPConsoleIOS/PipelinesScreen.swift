import ConsoleClient
import ConsoleCore
import SwiftUI

/// L'écran Pipelines de la coque iOS (S-2, S-3, S-4) : les cinq voies et les
/// cartes de l'ardoise partagée, dérivée de l'instantané du client. Aucune donnée
/// n'est inventée ni mise en cache ; la trame `store` met tout à jour.
struct PipelinesScreen: View {
    @ObservedObject var client: ConsoleClientModel
    /// Le crochet de recette `-ios.state error` (bandeau danger par-dessus).
    let recipe: IOSScreenState
    /// Le crochet de recette `-pipelines.recipe <vide|choisi|rempli>` : la feuille
    /// « Nouvelle feature » s'ouvre d'elle-même dans l'état forcé.
    let newFeatureRecipe: IOSPipelinesRecipe?
    /// Le crochet de recette `-pipelines.recipe <fiche|actions|arret|ardoise>` : la fiche
    /// de la carte de fixture s'ouvre UNE fois, ou l'ardoise de fixture remplace
    /// l'instantané du Mac (`ardoise`), sans instantané du Mac.
    var cardRecipe: PipelinesCardRecipe?
    /// Le crochet de recette `-pipelines.board` : une ardoise de fixture à la place
    /// de celle du client, sans bandeau de connexion.
    let boardRecipe: IOSPipelinesBoardRecipe?
    @State private var sheet: PipelinesSheet?
    @State private var recipeOpened = false
    /// Les voies terminales dépliées pendant CETTE visite (S-3) : remis à vide
    /// à la sortie de l'écran, jamais écrit nulle part.
    @State private var unfoldedLanes: Set<KanbanLane> = []
    /// La feuille Connexion de la racine, ouverte par « Se connecter ».
    @Binding var showConnection: Bool
    /// La demande d'ouvrir « Nouvelle feature » posée par ⌘N depuis la racine :
    /// consommée à l'apparition ou à son changement, elle ouvre UNE feuille.
    @Binding var newFeatureRequested: Bool
    /// Le signal de prêt de `-pipelines.board` n'est écrit qu'UNE fois.
    @State private var boardAnnounced = false
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// La largeur d'une voie iPad, `IOSMetrics.laneWidth` mise à l'échelle par
    /// Dynamic Type (S-1) : la même pour toutes les voies.
    @ScaledMetric(relativeTo: .body) private var laneWidth: CGFloat = IOSMetrics.laneWidth
    /// L'espacement entre le corps d'une carte et sa ligne « Ouvrir la PR »
    /// (8 pt mis à l'échelle) : aucun filet, l'espace seul les sépare.
    @ScaledMetric(relativeTo: .body) private var cardSpacing: CGFloat = 8
    @Environment(\.openURL) private var openURL

    var body: some View {
        Group {
            switch screenState {
            case .unavailable(let status):
                // Rien de reçu, Mac non connecté : le composant partagé SEUL, hors
                // de la liste (S-4).
                IOSConnectionStateView(status: status, layout: .screen, onConnect: { showConnection = true })
            case .loading:
                list { emptyRow(KanbanBoardState.loadingText) }
            case .board(let boardState):
                boardBody(boardState)
            }
        }
        .navigationTitle(ConsoleSection.kanban.title)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                refreshButton
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { sheet = .newFeature } label: {
                    Label(NewFeatureText.command, systemImage: "plus")
                }
                // Le Mac crée la feature : visible mais grisé hors connexion (etats-non-connecte-heterogenes-ios, S-5).
                .disabled(!connection.gesturesEnabled)
                .accessibilityIdentifier(PipelinesAccessibility.newFeature)
            }
        }
        .sheet(item: $sheet) { target in
            switch target {
            case .card(let cardId):
                PipelinesCardSheet(client: client, cardId: cardId, recipe: cardRecipe)
            case .newFeature:
                NewFeatureSheetView(client: client, recipe: newFeatureRecipe)
            }
        }
        .onDisappear { unfoldedLanes = [] }
        .onAppear {
            guard !recipeOpened, let cardRecipe else { return }
            if cardRecipe.forcedBoard != nil {
                recipeOpened = true
                cardRecipe.announce()
                return
            }
            guard let card = cardRecipe.card else { return }
            recipeOpened = true
            sheet = .card(card.id)
        }
        // ⌘R (menu Présentation) : le même geste que « Rafraîchir », la relecture
        // de l'état des PR par le Mac ; la commande de scène porte le raccourci.
        .focusedSceneValue(\.iosRefresh, IOSCommandAction(owner: .kanban, isEnabled: canRefresh) { refreshPullRequests() })
        .onAppear { consumeNewFeatureRequest() }
        .onChange(of: newFeatureRequested) { consumeNewFeatureRequest() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(PipelinesAccessibility.screen)
        .task {
            if newFeatureRecipe != nil { sheet = .newFeature }
            if let boardRecipe, !boardAnnounced {
                boardAnnounced = true
                boardRecipe.announce()
            }
        }
    }

    /// ⌘N : la même feuille que le bouton « + », ouverte une seule fois — la
    /// demande est un booléen remis à faux avant l'ouverture. Comme le bouton,
    /// elle n'ouvre rien hors connexion (etats-non-connecte-heterogenes-ios, S-5) :
    /// la section Pipelines est montrée, avec son état de connexion.
    private func consumeNewFeatureRequest() {
        guard newFeatureRequested else { return }
        newFeatureRequested = false
        guard connection.gesturesEnabled else { return }
        sheet = .newFeature
    }

    // MARK: - Dérivation

    private static var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

    /// Le statut présenté. Sous un crochet `-pipelines.recipe` ou
    /// `-pipelines.board`, la fixture tient lieu de Mac : l'écran est connecté (S-4).
    private var connection: IOSConnectionStatus {
        if newFeatureRecipe != nil || cardRecipe != nil || boardRecipe != nil { return .connected }
        return IOSConnectionStatus.of(client)
    }

    private var screenState: PipelinesScreenState {
        if let boardRecipe { return boardRecipe.screenState }
        return PipelinesModel.screen(
            connection: connection,
            board: cardRecipe?.forcedBoard ?? PipelinesModel.boardState(of: client, nowMs: Self.nowMs)
        )
    }

    // MARK: - Rafraîchir (S-7)

    /// Vrai pendant une relecture des PR par le Mac (trame `pull-request-states`).
    private var refreshing: Bool { client.pullRequestStates?.refreshing == true }

    /// Demande au Mac de relire l'état des PR. Aucun message : un échec (Mac
    /// ancien, réseau) laisse le bouton tel quel, le retour visible est le
    /// libellé des cartes. ⌘R (`IOSKeyboardCommands`) passe aussi par ici.
    private func refreshPullRequests() {
        Task { _ = try? await client.refreshPullRequestStates() }
    }

    private var canRefresh: Bool {
        PipelinesModel.canRefresh(connection: client.state, refreshing: refreshing)
    }

    private var refreshButton: some View {
        Button {
            refreshPullRequests()
        } label: {
            if refreshing {
                ProgressView()
            } else {
                Label(KanbanText.refresh, systemImage: "arrow.clockwise")
            }
        }
        .disabled(!canRefresh)
        .accessibilityLabel(KanbanText.refresh)
        .accessibilityIdentifier(PipelinesAccessibility.refresh)
    }

    // MARK: - Contenu

    /// La liste groupée de l'écran, son seul défilement (ios-listes-groupees-natives,
    /// S-5) : le bandeau de connexion en première rangée nue quand l'ardoise
    /// conservée est affichée hors connexion, puis le bandeau du crochet
    /// `-ios.state`, puis le contenu.
    private func list<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        List {
            if connection != .connected {
                connectionBanner
                    .iosBareListRow()
            }
            if let banner = recipe.banner, let message = recipe.bannerMessage {
                recipeBanner(message, tone: banner.tone)
                    .iosBareListRow()
            }
            content()
        }
        .iosGroupedList()
    }

    /// Le bandeau de connexion, quand l'ardoise conservée est affichée hors connexion.
    private var connectionBanner: some View {
        IOSConnectionStateView(status: connection, layout: .banner, onConnect: { showConnection = true })
    }

    /// Le bandeau du crochet de recette `-ios.state`.
    private func recipeBanner(_ message: String, tone: ConsoleTone) -> some View {
        Text(message)
            .font(.callout)
            .iosBanner(tone: tone)
    }

    @ViewBuilder
    private func boardBody(_ boardState: KanbanBoardState) -> some View {
        switch boardState {
        case .loading:
            list { emptyRow(KanbanBoardState.loadingText) }
        case .storeAbsent, .storeEmpty:
            list { emptyRow(KanbanText.noPipeline) }
        case .board(let board):
            boardContent(board)
        }
    }

    /// L'ardoise : en largeur COMPACTE (iPhone portrait) une section de la liste
    /// groupée par voie ; en largeur RÉGULIÈRE (iPad) le kanban, voies côte à côte
    /// et cartes élevées (`regularBoard`).
    @ViewBuilder
    private func boardContent(_ board: KanbanBoard) -> some View {
        let showsRepo = Set(board.cards.map(\.repo)).count > 1
        let rows = KanbanLaneRows.rows(
            board.lanes, layout: sizeClass == .compact ? .condensed : .full, unfolded: unfoldedLanes)
        if rows.isEmpty {
            list { emptyRow(KanbanText.noPipeline) }
        } else if sizeClass == .compact {
            list { lanes(rows, showsRepo: showsRepo) }
        } else {
            regularBoard(rows, showsRepo: showsRepo)
        }
    }

    /// Les voies en sections de la liste (largeur compacte) : l'en-tête de voie
    /// est l'en-tête natif de la section, chaque carte une rangée système. Une
    /// voie repliée n'a aucune rangée ; une voie vide, la rangée de son texte vide.
    @ViewBuilder
    private func lanes(_ rows: [KanbanLaneRow], showsRepo: Bool) -> some View {
        ForEach(rows) { row in
            Section {
                ForEach(row.visibleCards) { card in
                    // Deux gestes dans la rangée : sans style explicite, la List
                    // étendrait chacun à toute la rangée (D-4).
                    cardContent(card, showsRepo: showsRepo)
                        .buttonStyle(.borderless)
                }
                if laneShowsEmptyText(row) {
                    laneEmptyText(row)
                }
            } header: {
                laneHeader(row)
                    .textCase(nil)
            }
        }
    }

    /// Le kanban de l'iPad (largeur régulière) : les bandeaux puis les voies côte
    /// à côte dans un défilement horizontal, le tout dans le défilement vertical
    /// de l'écran, sur le fond groupé. Chaque voie a une largeur fixe, la même
    /// pour toutes (`PipelinesModel.laneWidth`), alignée en haut ; ses cartes
    /// sont élevées et rigides en hauteur : la voie la plus haute reçoit tout
    /// juste sa hauteur idéale et ne comprime aucun titre. Le défilement
    /// horizontal finit sur la marge de l'écran, après la dernière voie : une
    /// voie défilée jusqu'au bout n'est jamais coupée au bord droit.
    private func regularBoard(_ rows: [KanbanLaneRow], showsRepo: Bool) -> some View {
        let scaled = laneWidth
        let endMargin = IOSMetrics.margin(sizeClass)
        return ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 12) {
                if connection != .connected {
                    connectionBanner
                }
                if let banner = recipe.banner, let message = recipe.bannerMessage {
                    recipeBanner(message, tone: banner.tone)
                }
                ScrollView(.horizontal) {
                    HStack(alignment: .top, spacing: 12) {
                        ForEach(rows) { row in
                            VStack(alignment: .leading, spacing: 8) {
                                laneHeader(row)
                                ForEach(row.visibleCards) { card in
                                    cardContent(card, showsRepo: showsRepo)
                                        .iosCard(raised: true)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                if laneShowsEmptyText(row) {
                                    laneEmptyText(row)
                                }
                            }
                            .containerRelativeFrame(.horizontal, alignment: .topLeading) { length, _ in
                                PipelinesModel.laneWidth(scaled: scaled, container: length, endMargin: endMargin)
                            }
                            .accessibilityElement(children: .contain)
                            .accessibilityIdentifier(PipelinesAccessibility.lane(row.lane.rawValue))
                        }
                    }
                }
                .contentMargins(.trailing, endMargin, for: .scrollContent)
            }
            .padding(endMargin)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    /// L'en-tête d'une voie : bouton repliable de 44 pt pour une voie terminale,
    /// en-tête simple sinon — annoncé comme en-tête dans les deux cas.
    @ViewBuilder
    private func laneHeader(_ row: KanbanLaneRow) -> some View {
        if row.foldable {
            Button {
                unfoldedLanes.formSymmetricDifference([row.lane])
            } label: {
                HStack(alignment: .top, spacing: 6) {
                    headerLayout { laneTitle(row) }
                    Spacer(minLength: 0)
                    Image(systemName: IOSSessionText.chevron(!row.folded))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                }
                .frame(maxWidth: .infinity, minHeight: IOSMetrics.minimumTarget, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(.isHeader)
            .accessibilityValue(row.folded ? KanbanText.laneFolded : KanbanText.laneUnfolded)
            .accessibilityIdentifier(PipelinesAccessibility.laneHeader(row.lane.rawValue))
        } else {
            headerLayout { laneTitle(row) }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier(PipelinesAccessibility.laneHeader(row.lane.rawValue))
        }
    }

    /// Une voie dépliée sans aucune carte montre son texte vide.
    private func laneShowsEmptyText(_ row: KanbanLaneRow) -> Bool {
        row.visibleCards.isEmpty && !row.folded && row.content.cards.isEmpty
    }

    private func laneEmptyText(_ row: KanbanLaneRow) -> some View {
        Text(row.lane.emptyText)
            .font(.callout)
            .foregroundStyle(.secondary)
    }

    /// La disposition de l'en-tête d'une voie (règle pure :
    /// `PipelinesModel.headerAxis`) : sur une ligne aux tailles standard, empilé
    /// aux tailles d'accessibilité. `AnyLayout` : la bascule à chaud conserve
    /// l'état des sous-vues.
    private var headerLayout: AnyLayout {
        switch PipelinesModel.headerAxis(dynamicTypeSize) {
        case .horizontal, .twoLine: AnyLayout(HStackLayout(spacing: 6))
        case .stacked: AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
        }
    }

    /// Le symbole teinté, le titre et le compte d'une voie — le même contenu
    /// pour l'en-tête repliable et pour l'en-tête simple. Le titre passe à la
    /// ligne, il n'est jamais tronqué.
    @ViewBuilder
    private func laneTitle(_ row: KanbanLaneRow) -> some View {
        Image(systemName: row.lane.symbol)
            .foregroundStyle(row.lane.tone.tint)
            .accessibilityHidden(true)
        Text(row.lane.title)
            .font(.headline)
            .fixedSize(horizontal: false, vertical: true)
        Text(PipelinesText.laneCount(row.content.cards.count))
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    /// Le contenu d'une carte, le même en rangée de la liste (iPhone) et en carte
    /// élevée du kanban (iPad) : le corps ouvre la feuille ; quand le magasin
    /// porte une adresse de PR ouvrable (`prUrl`), la ligne « Ouvrir la PR » suit
    /// le corps, séparée par un espace — l'app n'écrit aucune adresse, elle
    /// valide celle du magasin par `httpURL`. Sans adresse ouvrable : ni ligne
    /// d'action, ni espace réservé. La hauteur de la ligne d'action ne dépend que
    /// de son libellé et de la taille de texte (bornée comme l'Accueil), jamais
    /// du titre de la carte.
    @ViewBuilder
    private func cardContent(_ card: KanbanCard, showsRepo: Bool) -> some View {
        let prURL = card.prUrl.flatMap(httpURL)
        VStack(alignment: .leading, spacing: cardSpacing) {
            Button { sheet = .card(card.id) } label: {
                cardLabel(card, showsRepo: showsRepo)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(PipelinesAccessibility.card(card.id))
            if let prURL {
                Button { openURL(prURL) } label: {
                    Text(HomeText.openPR)
                        .frame(maxWidth: .infinity, minHeight: IOSMetrics.minimumTarget, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .dynamicTypeSize(...IOSHomeContent.rowButtonMaximumSize)
                .accessibilityIdentifier(PipelinesAccessibility.gesture(HomeText.openPR, card.id))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func cardLabel(_ card: KanbanCard, showsRepo: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(KanbanCardPresentation.title(card))
                .font(.headline)
                .multilineTextAlignment(.leading)
            if showsRepo, !card.repo.isEmpty {
                Text(card.repo)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 8) {
                IOSStatusChip(status: ConsoleStatus.of(card: card))
                if let phase = card.phase {
                    Text(PhaseText.title(phase))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if let date = PipelinesModel.cardDate(card) {
                Text(date)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            if let preview = KanbanCardPresentation.preview(card) {
                Text(preview)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
            }
            if let sentence = KanbanText.marksSentence(card.marks) {
                Text(sentence)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if card.endMs == nil {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    Text(ConsoleFormat.duration(ms:
                        card.elapsedMs(nowMs: context.date.timeIntervalSince1970 * 1000)
                    ))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(minHeight: IOSMetrics.minimumTarget, alignment: .top)
        .contentShape(Rectangle())
    }

    /// La rangée d'un état sans ardoise (chargement, aucune pipeline) : une
    /// rangée système, sans carte.
    private func emptyRow(_ message: String) -> some View {
        Text(message)
            .font(.headline)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier(PipelinesAccessibility.emptyCard)
    }
}
