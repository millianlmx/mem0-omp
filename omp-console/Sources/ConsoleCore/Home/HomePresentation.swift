// La présentation de l'Accueil (S-5 de omp-console-redesign) : fonctions PURES
// de l'état d'OMP et de l'état du tableau — vérifiables sans rendre une vue.
//
// VIT DANS `ConsoleCore` : les deux coques dérivent les mêmes faits (S-1, S-2).
// Les membres « notifications » de `HomePresentation` (qui nomment la
// `AlertAuthorization` de la coque macOS et une URL de Réglages Système) restent
// déclarés par la coque, en extension, dans `Sources/OMPConsole/Home/`.

import Foundation

/// OMP trouvé (le binaire du composant de l'app), ou introuvable : l'app affiche
/// alors sa préparation et propose « Réessayer » (S-5).
public enum OmpStatus: Equatable, Sendable {
    case available(URL)
    case missing
}

/// L'écran de l'Accueil, dans l'ordre de ses règles.
public enum HomeState: Equatable, Sendable {
    /// Le composant OMP n'est pas (encore) installé : l'Accueil montre la
    /// préparation en arrière-plan (S-5).
    case ompMissing
    case loading
    case firstRun
    case dashboard(HomeDashboard)
}

/// Le tableau de bord : ce qui attend l'utilisateur, ce qui tourne, ce qui est
/// livré.
public struct HomeDashboard: Equatable, Sendable {
    public var attention: [HomeAttention]
    public var running: [KanbanCard]
    public var delivered: [KanbanCard]

    public init(attention: [HomeAttention], running: [KanbanCard], delivered: [KanbanCard]) {
        self.attention = attention
        self.running = running
        self.delivered = delivered
    }
}

public enum HomeAttentionNature: Equatable, Sendable {
    case question
    case milestoneSpecs
    case milestoneReview
}

/// Une attente : la carte, sa nature et la question à montrer.
public struct HomeAttention: Equatable, Identifiable, Sendable {
    public var id: String { card.id }
    public var card: KanbanCard
    public var nature: HomeAttentionNature
    public var prompt: String

    public init(card: KanbanCard, nature: HomeAttentionNature, prompt: String) {
        self.card = card
        self.nature = nature
        self.prompt = prompt
    }
}

/// Le bouton d'une carte d'attente.
public enum HomeCardAction: Equatable {
    case answer, validate, accept, open
}

public enum HomePresentation {
    /// Au plus cinq livraisons récentes.
    public static let deliveredLimit = 5

    /// (1) OMP introuvable prime sur tout ; (2) chargement ; (3) magasin absent ou
    /// vide ⇒ première fois ; (4) tableau ⇒ tableau de bord.
    public static func state(omp: OmpStatus, board: KanbanBoardState) -> HomeState {
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
    public static func dashboard(_ board: KanbanBoard) -> HomeDashboard {
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
            case .prOuverte, .prCreee, .fusionne, .prFermee:
                if delivered.count < deliveredLimit { delivered.append(card) }
            case .bloquee, .termineeSansPr, .annuleeRetiree:
                break
            }
        }
        return HomeDashboard(attention: attention, running: running, delivered: delivered)
    }

    /// Le nombre d'attentes (badge de la barre latérale), 0 hors tableau de bord.
    public static func attentionCount(omp: OmpStatus, board: KanbanBoardState) -> Int {
        guard case .dashboard(let dashboard) = state(omp: omp, board: board) else { return 0 }
        return dashboard.attention.count
    }

    /// Le geste du bouton d'une carte d'attente : répondre tant qu'elle attend une
    /// réponse, valider ou accepter un jalon actionnable, sinon l'ouvrir dans
    /// Pipelines.
    public static func cardAction(_ attention: HomeAttention) -> HomeCardAction {
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
    public static func prominentAttentionID(_ dashboard: HomeDashboard) -> String? {
        dashboard.attention.first { cardAction($0) != .open }?.id
    }

    /// Le dépôt se lit sous chaque carte et ligne seulement quand le tableau de
    /// bord en montre plusieurs : un dépôt unique répété partout est du bruit.
    public static func showsRepo(_ dashboard: HomeDashboard) -> Bool {
        let cards = dashboard.attention.map(\.card) + dashboard.running + dashboard.delivered
        return Set(cards.map(\.repo)).count > 1
    }

    /// Le bandeau de lancement : l'entrée `lancement` la plus récente du journal,
    /// sauf celle que l'utilisateur a masquée.
    public static func launchBannerEntry(journal: [ActionJournalEntry], dismissedID: String?) -> ActionJournalEntry? {
        guard let latest = journal.first(where: { $0.kindLabel == ActionsText.launchLabel }),
              latest.id != dismissedID else { return nil }
        return latest
    }
}
