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
/// en pause, ce qui n'a jamais été lancé, ce qui est livré. Chaque carte est
/// dans AU PLUS UNE liste (`HomePresentation.dashboard`).
public struct HomeDashboard: Equatable, Sendable {
    public var attention: [HomeAttention]
    /// « En cours » : les pipelines réellement en marche (colonne `.enCours`).
    public var running: [KanbanCard]
    /// « À reprendre » : les pipelines en pause (`KanbanActionPresentation.resumable`).
    public var paused: [KanbanCard]
    /// « Pas commencées » : les features jamais lancées (colonne `.enAttente`).
    public var notStarted: [KanbanCard]
    public var delivered: [KanbanCard]

    public init(
        attention: [HomeAttention],
        running: [KanbanCard],
        paused: [KanbanCard],
        notStarted: [KanbanCard],
        delivered: [KanbanCard]
    ) {
        self.attention = attention
        self.running = running
        self.paused = paused
        self.notStarted = notStarted
        self.delivered = delivered
    }
}

/// Les deux comptes de l'item de barre de menus : « À vous » et « En cours »,
/// pris sur les MÊMES listes que l'Accueil.
public struct HomeCounts: Equatable, Sendable {
    public var attention: Int
    public var running: Int

    public static let zero = HomeCounts(attention: 0, running: 0)

    public init(attention: Int, running: Int) {
        self.attention = attention
        self.running = running
    }
}

public enum HomeAttentionNature: Equatable, Sendable {
    case question
    case milestoneSpecs
    case milestoneReview
    /// Une feature de lot en échec, relançable (`KanbanActionPresentation.relaunchable`).
    case failed
    /// Une feature de lot bloquée, relançable.
    case blocked
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
    case answer, validate, accept, relaunch, open
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

    /// Les cinq listes, chacune dans l'ordre de l'ardoise. Les règles
    /// s'appliquent dans cet ordre ; la première qui s'applique gagne, donc une
    /// carte n'est jamais dans deux listes.
    public static func dashboard(_ board: KanbanBoard) -> HomeDashboard {
        var attention: [HomeAttention] = []
        var running: [KanbanCard] = []
        var paused: [KanbanCard] = []
        var notStarted: [KanbanCard] = []
        var delivered: [KanbanCard] = []
        for card in board.cards {
            // 1. En pause (pilote mort, « Reprendre » la relance par le pilote),
            // quelle que soit sa colonne : une question ou un jalon au pilote mort
            // attend d'abord d'être repris.
            if KanbanActionPresentation.resumable(card) {
                paused.append(card)
                continue
            }
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
            case .echec:
                // Seule une feature de lot relançable remonte ; les runs
                // d'historique et les échecs de projet n'ont aucun geste.
                if KanbanActionPresentation.relaunchable(card) {
                    attention.append(HomeAttention(card: card, nature: .failed, prompt: HomeText.failedPrompt(card.phase)))
                }
            case .bloquee:
                if KanbanActionPresentation.relaunchable(card) {
                    attention.append(HomeAttention(card: card, nature: .blocked, prompt: HomeText.blockedPrompt(card.phase)))
                }
            case .enCours:
                running.append(card)
            case .enAttente:
                notStarted.append(card)
            case .prOuverte, .prCreee, .fusionne, .prFermee:
                if delivered.count < deliveredLimit { delivered.append(card) }
            case .termineeSansPr, .annuleeRetiree:
                break
            }
        }
        return HomeDashboard(
            attention: attention, running: running, paused: paused, notStarted: notStarted, delivered: delivered
        )
    }

    /// Les comptes de l'item de barre de menus : « À vous » et « En cours » de
    /// l'Accueil. Les pauses et les features pas commencées ne comptent jamais.
    public static func counts(_ board: KanbanBoard) -> HomeCounts {
        let dashboard = dashboard(board)
        return HomeCounts(attention: dashboard.attention.count, running: dashboard.running.count)
    }

    /// Le nombre d'attentes (badge de la barre latérale), 0 hors tableau de bord.
    public static func attentionCount(omp: OmpStatus, board: KanbanBoardState) -> Int {
        guard case .dashboard(let dashboard) = state(omp: omp, board: board) else { return 0 }
        return dashboard.attention.count
    }

    /// Le geste du bouton d'une carte d'attente : répondre tant qu'elle attend une
    /// réponse, valider ou accepter un jalon actionnable, relancer une pipeline en
    /// échec ou bloquée, sinon l'ouvrir dans Pipelines.
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
        case .failed, .blocked:
            return .relaunch
        }
        return .open
    }

    /// La carte d'attente dont le bouton est PROÉMINENT : la première qui offre
    /// un vrai geste (répondre, valider, accepter, relancer). Un seul bouton
    /// proéminent à l'écran (HIG Buttons) ; « Voir dans Pipelines » ne l'est jamais.
    public static func prominentAttentionID(_ dashboard: HomeDashboard) -> String? {
        dashboard.attention.first { cardAction($0) != .open }?.id
    }

    /// Le dépôt se lit sous chaque carte et ligne seulement quand le tableau de
    /// bord en montre plusieurs : un dépôt unique répété partout est du bruit.
    public static func showsRepo(_ dashboard: HomeDashboard) -> Bool {
        let cards = dashboard.attention.map(\.card) + dashboard.running + dashboard.paused
            + dashboard.notStarted + dashboard.delivered
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
