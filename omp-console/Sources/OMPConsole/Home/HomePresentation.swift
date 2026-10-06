// La présentation de l'Accueil (S-5 de omp-console-redesign) : fonctions PURES
// de l'état d'OMP et de l'état du tableau — vérifiables sans rendre une vue.

import ConsoleCore
import Foundation

/// L'écran de l'Accueil, dans l'ordre de ses règles.
enum HomeState: Equatable, Sendable {
    /// Le composant OMP n'est pas (encore) installé : l'Accueil montre la
    /// préparation en arrière-plan (S-5).
    case ompMissing
    case loading
    case firstRun
    case dashboard(HomeDashboard)
}

/// Le tableau de bord : ce qui attend l'utilisateur, ce qui tourne, ce qui est
/// livré.
struct HomeDashboard: Equatable, Sendable {
    var attention: [HomeAttention]
    var running: [KanbanCard]
    var delivered: [KanbanCard]
}

enum HomeAttentionNature: Equatable, Sendable {
    case question
    case milestoneSpecs
    case milestoneReview
}

/// Une attente : la carte, sa nature et la question à montrer.
struct HomeAttention: Equatable, Identifiable, Sendable {
    var id: String { card.id }
    var card: KanbanCard
    var nature: HomeAttentionNature
    var prompt: String
}

/// Le bouton d'une carte d'attente.
enum HomeCardAction: Equatable {
    case answer, validate, accept, open
}

enum HomePresentation {
    /// Au plus cinq livraisons récentes.
    static let deliveredLimit = 5

    /// (1) OMP introuvable prime sur tout ; (2) chargement ; (3) magasin absent ou
    /// vide ⇒ première fois ; (4) tableau ⇒ tableau de bord.
    static func state(omp: OmpStatus, board: KanbanBoardState) -> HomeState {
        if case .missing = omp {
            return .ompMissing
        }
        switch board {
        case .loading: return .loading
        case .storeAbsent, .storeEmpty: return .firstRun
        case .board(let board): return .dashboard(dashboard(board))
        }
    }

    /// Les trois listes, chacune dans l'ordre de l'ardoise.
    static func dashboard(_ board: KanbanBoard) -> HomeDashboard {
        var attention: [HomeAttention] = []
        var running: [KanbanCard] = []
        var delivered: [KanbanCard] = []
        for card in board.cards {
            switch card.column {
            case .questionEnVol:
                let prompt = card.action?.run?.pendingAsk?.question
                    ?? card.action?.waitPrompt
                    ?? HomeText.questionWithoutText
                attention.append(HomeAttention(card: card, nature: .question, prompt: prompt))
            case .jalonSpecs:
                attention.append(HomeAttention(card: card, nature: .milestoneSpecs, prompt: HomeText.specsPrompt))
            case .jalonReview:
                attention.append(HomeAttention(card: card, nature: .milestoneReview, prompt: HomeText.reviewPrompt))
            case .enAttente, .enCours:
                running.append(card)
            case .echec:
                // Une carte `en-cours` au pilote mort est rangée en échec ; elle
                // reste « en cours » ici tant que « Reprendre » peut la relancer.
                if KanbanActionPresentation.resumable(card) { running.append(card) }
            case .prOuverte, .fusionne:
                if delivered.count < deliveredLimit { delivered.append(card) }
            case .bloquee, .termineeSansPr, .annuleeRetiree:
                break
            }
        }
        return HomeDashboard(attention: attention, running: running, delivered: delivered)
    }

    /// Le nombre d'attentes (badge de la barre latérale), 0 hors tableau de bord.
    static func attentionCount(omp: OmpStatus, board: KanbanBoardState) -> Int {
        guard case .dashboard(let dashboard) = state(omp: omp, board: board) else { return 0 }
        return dashboard.attention.count
    }

    /// Le geste du bouton d'une carte d'attente : répondre tant qu'elle attend une
    /// réponse, valider ou accepter un jalon actionnable, sinon l'ouvrir dans
    /// Pipelines.
    static func cardAction(_ attention: HomeAttention) -> HomeCardAction {
        let zones = KanbanActionPresentation.zones(for: attention.card)
        switch attention.nature {
        case .question:
            if MainSheetPolicy.answerZone(for: attention.card) != nil { return .answer }
        case .milestoneSpecs:
            if zones.contains(where: { if case .milestone(_, .specs) = $0 { true } else { false } }) {
                return .validate
            }
        case .milestoneReview:
            if zones.contains(where: { if case .milestone(_, .review) = $0 { true } else { false } }) {
                return .accept
            }
        }
        return .open
    }

    /// La carte d'attente dont le bouton est PROÉMINENT : la première qui offre
    /// un vrai geste (répondre, valider, accepter). Un seul bouton proéminent à
    /// l'écran (HIG Buttons) ; « Voir dans Pipelines » ne l'est jamais.
    static func prominentAttentionID(_ dashboard: HomeDashboard) -> String? {
        dashboard.attention.first { cardAction($0) != .open }?.id
    }

    /// Le dépôt se lit sous chaque carte et ligne seulement quand le tableau de
    /// bord en montre plusieurs : un dépôt unique répété partout est du bruit.
    static func showsRepo(_ dashboard: HomeDashboard) -> Bool {
        let cards = dashboard.attention.map(\.card) + dashboard.running + dashboard.delivered
        return Set(cards.map(\.repo)).count > 1
    }

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

    /// Le bandeau de lancement : l'entrée `lancement` la plus récente du journal,
    /// sauf celle que l'utilisateur a masquée.
    static func launchBannerEntry(journal: [ActionJournalEntry], dismissedID: String?) -> ActionJournalEntry? {
        guard let latest = journal.first(where: { $0.kindLabel == ActionsText.launchLabel }),
              latest.id != dismissedID else { return nil }
        return latest
    }
}
