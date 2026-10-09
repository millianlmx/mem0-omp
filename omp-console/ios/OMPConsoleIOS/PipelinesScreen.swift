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
    /// Le crochet de recette `-pipelines.recipe <fiche|actions|arret>` : la fiche de
    /// la carte de fixture s'ouvre UNE fois, sans instantané du Mac.
    var cardRecipe: PipelinesCardRecipe?
    @State private var sheet: PipelinesSheet?
    @State private var recipeOpened = false
    /// Les voies terminales dépliées pendant CETTE visite (S-3) : remis à vide
    /// à la sortie de l'écran, jamais écrit nulle part.
    @State private var unfoldedLanes: Set<KanbanLane> = []
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.openURL) private var openURL

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 12) {
                if let banner = recipe.banner, let message = recipe.bannerMessage {
                    Text(message)
                        .font(.callout)
                        .iosBanner(tone: banner.tone)
                }
                content
            }
            .iosPanel()
        }
        .navigationTitle(ConsoleSection.kanban.title)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { sheet = .newFeature } label: {
                    Label(NewFeatureText.command, systemImage: "plus")
                }
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
            guard !recipeOpened, let card = cardRecipe?.card else { return }
            recipeOpened = true
            sheet = .card(card.id)
        }
        .accessibilityIdentifier(PipelinesAccessibility.screen)
        .task {
            if newFeatureRecipe != nil { sheet = .newFeature }
        }
    }

    // MARK: - Dérivation

    private static var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

    private var screenState: PipelinesScreenState {
        PipelinesModel.screen(
            connection: client.state,
            board: PipelinesModel.boardState(of: client, nowMs: Self.nowMs)
        )
    }

    // MARK: - Contenu

    @ViewBuilder
    private var content: some View {
        if let banner = PipelinesModel.connectionBanner(connection: client.state) {
            Text(banner.text)
                .font(.callout)
                .iosBanner(tone: banner.tone)
                .accessibilityIdentifier(PipelinesAccessibility.banner)
        }
        switch screenState {
        case .loading:
            emptyCard(KanbanBoardState.loadingText)
        case .noSnapshot:
            emptyCard(PipelinesText.noSnapshot)
        case .board(let boardState):
            switch boardState {
            case .loading:
                emptyCard(KanbanBoardState.loadingText)
            case .storeAbsent, .storeEmpty:
                emptyCard(KanbanText.noPipeline)
            case .board(let board):
                boardContent(board)
            }
        }
    }

    /// L'ardoise : en largeur COMPACTE (iPhone portrait) les voies s'empilent
    /// verticalement dans le défilement de l'écran, sans défilement propre ; en
    /// largeur RÉGULIÈRE (iPad) elles sont côte à côte dans un défilement
    /// horizontal, l'axe orthogonal : aucun défilement vertical n'est imbriqué.
    @ViewBuilder
    private func boardContent(_ board: KanbanBoard) -> some View {
        let showsRepo = Set(board.cards.map(\.repo)).count > 1
        let rows = PipelinesModel.laneRows(
            board.lanes, compact: sizeClass == .compact, unfolded: unfoldedLanes)
        if rows.isEmpty {
            emptyCard(KanbanText.noPipeline)
        } else if sizeClass == .compact {
            VStack(alignment: .leading, spacing: 16) {
                lanes(rows, showsRepo: showsRepo)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 12) {
                    lanes(rows, showsRepo: showsRepo)
                }
            }
        }
    }

    @ViewBuilder
    private func lanes(_ rows: [PipelinesLaneRow], showsRepo: Bool) -> some View {
        ForEach(rows) { row in
            laneView(row, showsRepo: showsRepo)
        }
    }

    @ViewBuilder
    private func laneView(_ row: PipelinesLaneRow, showsRepo: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if row.foldable {
                Button {
                    unfoldedLanes.formSymmetricDifference([row.lane])
                } label: {
                    HStack(spacing: 6) {
                        laneTitle(row)
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
                .accessibilityValue(row.folded ? PipelinesText.laneFolded : PipelinesText.laneUnfolded)
                .accessibilityIdentifier(PipelinesAccessibility.laneHeader(row.lane.rawValue))
            } else {
                HStack(spacing: 6) {
                    laneTitle(row)
                }
            }
            if !row.visibleCards.isEmpty {
                ForEach(row.visibleCards) { card in
                    cardButton(card, showsRepo: showsRepo)
                }
            } else if !row.folded && row.content.cards.isEmpty {
                Text(row.lane.emptyText)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(minWidth: sizeClass == .compact ? 0 : 240, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(PipelinesAccessibility.lane(row.lane.rawValue))
    }

    /// Le symbole teinté, le titre et le compte d'une voie — le même contenu
    /// pour l'en-tête repliable et pour l'en-tête simple.
    @ViewBuilder
    private func laneTitle(_ row: PipelinesLaneRow) -> some View {
        Image(systemName: row.lane.symbol)
            .foregroundStyle(row.lane.tone.tint)
        Text(row.lane.title).font(.headline)
        Text(PipelinesText.laneCount(row.content.cards.count))
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    /// La carte : le corps ouvre la feuille ; quand le magasin porte une adresse
    /// de PR ouvrable (`prUrl`), la même surface offre « Ouvrir la PR » — l'app
    /// n'écrit aucune adresse, elle valide celle du magasin par `httpURL`.
    @ViewBuilder
    private func cardButton(_ card: KanbanCard, showsRepo: Bool) -> some View {
        let prURL = card.prUrl.flatMap(httpURL)
        VStack(alignment: .leading, spacing: 0) {
            Button { sheet = .card(card.id) } label: {
                cardLabel(card, showsRepo: showsRepo)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(PipelinesAccessibility.card(card.id))
            if let prURL {
                Divider()
                Button(HomeText.openPR) { openURL(prURL) }
                    .frame(minHeight: IOSMetrics.minimumTarget)
                    .accessibilityIdentifier(PipelinesAccessibility.gesture(HomeText.openPR, card.id))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .iosCard()
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
            if let marks = card.marksText {
                Text(KanbanText.marks(marks))
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
    }

    @ViewBuilder
    private func emptyCard(_ message: String) -> some View {
        Text(message)
            .font(.headline)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .iosCard()
            .accessibilityIdentifier(PipelinesAccessibility.emptyCard)
    }
}
