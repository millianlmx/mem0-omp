// La section Accueil (S-5 de omp-console-redesign) : quatre états — OMP requis
// (en arrière-plan de sa feuille), chargement, première fois, tableau de bord.
// L'écran est une fonction de `HomePresentation.state(omp:board:)` ; aucun texte
// n'est composé ici (`HomeText`). Les feuilles (bienvenue, OMP requis, Répondre,
// Nouvelle feature) sont présentées par la racine (`MainSheetPolicy`).
//
// Aucun texte n'est figé en hauteur (`fixedSize` vertical) hors d'un cadre
// borné : la hauteur MINIMALE d'un tel texte se calcule à largeur quasi nulle et
// imposait au `NavigationSplitView` ~2 000 pt de haut (mesuré le 2026-09-30).
//
// Surfaces (HIG Materials : pas de verre dans la couche de contenu) : cartes
// d'attente `.consoleCard(selected: false)` opaques, bandeau `.consoleBanner`,
// boutons standard ; les listes « En cours » et « Livrées récemment » sont des
// `GroupBox` système. Aucun `@State` : l'état vit dans `HomeModel` et
// `ActionsModel`.
//
// Audit HIG (2026-10-01) : UN seul bouton proéminent à l'écran (la première
// carte d'attente qui offre un geste, `prominentAttentionID`) ; le dépôt ne se
// lit sous les cartes et lignes que si plusieurs dépôts sont montrés ; les
// notifications refusées sont un bandeau NEUTRE en tête de l'Accueil (plus de
// bande rouge dans la barre latérale).

import AppKit
import ConsoleCore
import SwiftUI

struct HomeView: ConsoleSectionView {
    static let section = ConsoleSection.home

    @ObservedObject var home: HomeModel
    @ObservedObject var kanban: KanbanModel
    @ObservedObject var actions: ActionsModel
    @ObservedObject var console: ConsoleModel
    @ObservedObject var alerts: AlertsModel
    /// La feuille Contrat (S-6) : la carte « À vous » d'un moment de validation
    /// offre le geste secondaire « Lire le contrat ».
    @ObservedObject var contract: ContractModel
    /// La préparation de l'app (S-5) : le fond « composants manquants » et le
    /// bandeau « Reprendre… » en dépendent.
    @ObservedObject var setup: SetupModel

    var body: some View {
        Group {
            switch HomePresentation.state(omp: home.omp, board: kanban.state) {
            case .ompMissing:
                VStack(spacing: 16) {
                    setupBanner
                    ContentUnavailableView(
                        SetupText.homeMissingTitle,
                        systemImage: "shippingbox",
                        description: Text(SetupText.homeMissingBody)
                    )
                    .accessibilityIdentifier("home.ompMissing.background")
                }
            case .loading:
                VStack(spacing: 8) {
                    setupBanner
                    ProgressView()
                    Text(KanbanBoardState.loadingText).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("home.loading")
            case .firstRun:
                firstRunView
            case .dashboard(let dashboard):
                dashboardView(dashboard)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Première fois

    private var firstRunView: some View {
        VStack(spacing: 16) {
            setupBanner
            notificationsBanner
            launchBanner
            ContentUnavailableView {
                Label(HomeText.firstRunTitle, systemImage: "sparkles")
            } description: {
                Text(HomeText.firstRunBody)
            } actions: {
                Button {
                    actions.launchFormShown = true
                } label: {
                    Label(HomeText.newFeature, systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(!home.canLaunch)
                .accessibilityIdentifier("home.firstRun.start")
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home.firstRun")
    }

    // MARK: - Tableau de bord

    private func dashboardView(_ dashboard: HomeDashboard) -> some View {
        let showsRepo = HomePresentation.showsRepo(dashboard)
        let prominentID = HomePresentation.prominentAttentionID(dashboard)
        return ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 28) {
                setupBanner
                notificationsBanner
                launchBanner

                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(HomeText.attentionHeader).font(.title2.bold())
                        Spacer()
                        Button(HomeText.allPipelines) { console.select(.kanban) }
                            .buttonStyle(.link)
                            .accessibilityIdentifier("home.allPipelines")
                    }
                    if dashboard.attention.isEmpty {
                        emptyLine(HomeText.attentionEmpty)
                    } else {
                        LazyVGrid(
                            columns: [GridItem(.adaptive(minimum: 280, maximum: 440), spacing: 16, alignment: .top)],
                            alignment: .leading,
                            spacing: 16
                        ) {
                            ForEach(dashboard.attention) { attention in
                                attentionCard(
                                    attention,
                                    showsRepo: showsRepo,
                                    prominent: attention.id == prominentID
                                )
                            }
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 12) {
                    Text(HomeText.runningHeader).font(.title3.bold())
                    if dashboard.running.isEmpty {
                        emptyLine(HomeText.runningEmpty)
                    } else {
                        GroupBox {
                            rows(dashboard.running) { card in runningRow(card, showsRepo: showsRepo) }
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 12) {
                    Text(HomeText.deliveredTitle).font(.title3.bold())
                    if dashboard.delivered.isEmpty {
                        emptyLine(HomeText.deliveredEmpty)
                    } else {
                        GroupBox {
                            rows(dashboard.delivered) { card in deliveredRow(card, showsRepo: showsRepo) }
                        }
                    }
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home.dashboard")
    }

    private func emptyLine(_ text: String) -> some View {
        Text(text).font(.callout).foregroundStyle(.secondary)
    }

    /// Les lignes d'une liste, séparées par un `Divider`.
    private func rows<Row: View>(_ cards: [KanbanCard], @ViewBuilder row: @escaping (KanbanCard) -> Row) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(cards.enumerated()), id: \.element.id) { index, card in
                if index > 0 { Divider() }
                row(card)
            }
        }
    }

    // MARK: - Carte d'attente

    private func attentionCard(_ attention: HomeAttention, showsRepo: Bool, prominent: Bool) -> some View {
        let card = attention.card
        let style = Self.natureStyle(attention.nature)
        return VStack(alignment: .leading, spacing: 10) {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                HStack(spacing: 10) {
                    ZStack {
                        Circle().fill(style.tint.opacity(0.18))
                        Image(systemName: style.symbol).foregroundStyle(style.tint)
                    }
                    .frame(width: 32, height: 32)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(HomeText.natureText(attention.nature))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(style.tint)
                        Text(ConsoleFormat.relative(ms: card.startMs, nowMs: context.date.timeIntervalSince1970 * 1000))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Text(card.title)
                .font(.title3.weight(.semibold))
            if showsRepo {
                Text(card.repo)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Text(attention.prompt)
                .font(.body)
                .lineLimit(3)
            Spacer(minLength: 0)
            HStack {
                Spacer()
                // Le geste secondaire, à GAUCHE du geste principal : la
                // proéminence de la carte reste au bouton principal.
                if ContractDocument.moment(for: card) != nil {
                    Button(ContractText.open) { contract.open(card) }
                        .accessibilityIdentifier("home.attention.\(card.id).contract")
                }
                attentionButton(attention, prominent: prominent)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, minHeight: 190, alignment: .topLeading)
        .consoleCard(selected: false)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home.attention.\(card.id)")
    }

    /// Le bouton d'une carte d'attente : proéminent seulement pour la carte
    /// `prominent` (un seul par écran), standard sinon.
    private func attentionButton(_ attention: HomeAttention, prominent: Bool) -> some View {
        let card = attention.card
        return Group {
            switch HomePresentation.cardAction(attention) {
            case .answer:
                Button(HomeText.answerEllipsis) {
                    home.openAnswer(card.id, actions: actions)
                }
            case .validate:
                Button(KanbanText.validateSpecs) {
                    if let action = card.action { actions.validate(action) }
                }
            case .accept:
                Button(KanbanText.acceptReview) {
                    if let action = card.action { actions.accept(action) }
                }
            case .open:
                Button(HomeText.openInPipelines) {
                    kanban.select(card.id)
                    console.select(.kanban)
                }
            }
        }
        .consoleButtonProminence(prominent)
        .accessibilityIdentifier("home.attention.\(card.id).action")
    }

    /// Symbole et teinte d'une nature d'attente.
    private static func natureStyle(_ nature: HomeAttentionNature) -> (symbol: String, tint: Color) {
        switch nature {
        case .question: ("questionmark.bubble.fill", .blue)
        case .milestoneSpecs: ("doc.text.magnifyingglass", .purple)
        case .milestoneReview: ("checkmark.seal.fill", .green)
        }
    }

    // MARK: - Lignes

    private func runningRow(_ card: KanbanCard, showsRepo: Bool) -> some View {
        HStack(spacing: 12) {
            Button {
                kanban.select(card.id)
                console.select(.kanban)
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: PhaseText.symbol(card.phase))
                        .foregroundStyle(Color.accentColor)
                        .frame(width: 22)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(card.title)
                            .font(.body.weight(.medium))
                        if let subtitle = HomeText.cardSubtitle(
                            card,
                            noPhase: ConsoleStatus.of(card: card).text,
                            showsRepo: showsRepo
                        ) {
                            Text(subtitle)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("home.running.\(card.id)")
            // « Reprendre » vit HORS du bouton de ligne : deux gestes distincts.
            if KanbanActionPresentation.resumable(card), let action = card.action {
                StatusBadge(status: ConsoleStatus.of(card: card))
                Button(KanbanText.resume) { actions.resume(action) }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("home.resume.\(card.id)")
            } else {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let nowMs = context.date.timeIntervalSince1970 * 1000
                    Text(ConsoleFormat.duration(ms: (card.endMs ?? nowMs) - card.startMs))
                        .font(.callout)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 8)
    }

    private func deliveredRow(_ card: KanbanCard, showsRepo: Bool) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "arrow.triangle.pull")
                .foregroundStyle(.green)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(card.title)
                if showsRepo {
                    Text(card.repo).foregroundStyle(.secondary)
                }
            }
            Spacer()
            StatusBadge(status: ConsoleStatus.of(card: card))
            if let prUrl = card.prUrl, let url = httpURL(prUrl) {
                Link(HomeText.openPR, destination: url)
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("home.delivered.open.\(card.id)")
            }
        }
        .padding(.vertical, 8)
    }

    // MARK: - Bandeaux

    /// Le bandeau de préparation (S-5) : visible seulement quand la feuille a été
    /// fermée et que la préparation n'est pas finie — « Reprendre… » la ramène.
    @ViewBuilder
    private var setupBanner: some View {
        if let text = SetupText.banner(state: setup.state, dismissed: setup.dismissed) {
            HStack(spacing: 8) {
                Text(text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button(SetupText.resume) { setup.present() }
            }
            .consoleBanner(tint: .orange)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("home.setupBanner")
        }
    }

    /// Les notifications refusées : un bandeau NEUTRE (pas une erreur), avec le
    /// chemin vers les Réglages et « Ignorer », persisté par `HomeModel`.
    @ViewBuilder
    private var notificationsBanner: some View {
        if HomePresentation.showsNotificationsBanner(
            authorization: alerts.authorization,
            dismissed: home.notificationsBannerDismissed
        ) {
            GroupBox {
                HStack(spacing: 10) {
                    Image(systemName: "bell.slash")
                        .foregroundStyle(.secondary)
                    Text(HomeText.notificationsDenied)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button(HomeText.openSettings) {
                        NSWorkspace.shared.open(HomePresentation.notificationsSettingsURL)
                    }
                    .accessibilityIdentifier("home.notifications.openSettings")
                    Button(HomeText.ignore) { home.dismissNotificationsBanner() }
                        .accessibilityIdentifier("home.notifications.ignore")
                }
                .padding(4)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("home.notificationsBanner")
        }
    }

    @ViewBuilder
    private var launchBanner: some View {
        if let entry = HomePresentation.launchBannerEntry(journal: actions.journal, dismissedID: home.dismissedBannerID) {
            HStack(spacing: 8) {
                Text(HomeText.launchBanner(title: entry.targetLabel, state: entry.state))
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button(HomeText.dismiss) { home.dismissedBannerID = entry.id }
            }
            .consoleBanner(tint: Self.bannerTint(entry.state))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("home.launchBanner")
        }
    }

    private static func bannerTint(_ state: ActionJournalState) -> Color {
        switch state {
        case .awaitingAck, .taken, .delivered: .accentColor
        case .refused, .failed, .unacknowledged: .red
        }
    }
}

// Les membres « notifications » de `HomePresentation` (S-16) : ils nomment
// `AlertAuthorization` (coque macOS) et une URL de Réglages Système sans sens sur
// iOS — le noyau partagé ne les porte donc pas.
extension HomePresentation {
    /// Réglages Système ▸ Notifications (« Ouvrir les Réglages » du bandeau).
    static let notificationsSettingsURL = URL(
        string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
    )!

    /// Le bandeau « notifications désactivées » : seulement quand l'autorisation
    /// est REFUSÉE (`unknown` — pas encore répondu — et `unavailable` — hors
    /// bundle — ne l'affichent pas) et que l'utilisateur ne l'a pas ignoré.
    static func showsNotificationsBanner(authorization: AlertAuthorization, dismissed: Bool) -> Bool {
        authorization == .denied && !dismissed
    }
}
