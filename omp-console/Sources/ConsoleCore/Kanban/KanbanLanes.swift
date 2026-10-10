// Les VOIES du tableau Pipelines (refonte du 2026-10-02) : les onze colonnes de
// l'ardoise (`KanbanColumn`, parité avec `/pipelines`) restent le modèle, mais
// l'écran les regroupe en cinq voies qui suivent le cours d'une feature — pas
// commencée, en cours, à vous, livrée, arrêtée. Onze colonnes côte à côte
// débordaient la fenêtre et cachaient à droite ce qui attend l'utilisateur
// (« Specs à valider », « Revue à accepter »), et une feature en pause tombait
// dans « En échec ».
//
// Fonctions PURES : la vue et le clavier lisent le même ordre.
//
// VIT DANS `ConsoleCore` : les deux coques partagent le regroupement.

import Foundation

public enum KanbanLane: String, CaseIterable, Identifiable, Sendable {
    case pasCommencees = "pas-commencees"
    case enCours = "en-cours"
    case aVous = "a-vous"
    case livrees = "livrees"
    case arretees = "arretees"

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .pasCommencees: "Pas commencées"
        case .enCours: "En cours"
        case .aVous: "À vous"
        case .livrees: "Livrées"
        case .arretees: "Arrêtées"
        }
    }

    public var symbol: String {
        switch self {
        case .pasCommencees: "circle.dashed"
        case .enCours: "play.circle"
        case .aVous: "hand.raised"
        case .livrees: "checkmark.circle"
        case .arretees: "stop.circle"
        }
    }

    public var tone: ConsoleTone {
        switch self {
        case .pasCommencees: .neutral
        case .enCours: .info
        case .aVous: .attention
        case .livrees: .success
        case .arretees: .danger
        }
    }

    /// Le texte d'une voie vide.
    public var emptyText: String {
        switch self {
        case .pasCommencees: "Aucune feature en attente de lancement."
        case .enCours: "Rien ne tourne en ce moment."
        case .aVous: "Rien ne vous attend."
        case .livrees: "Aucune livraison récente."
        case .arretees: "Aucune feature arrêtée."
        }
    }

    /// Une voie toujours montrée, même vide. « Arrêtées » n'apparaît que si elle
    /// a des cartes : une voie d'échecs vide n'apprend rien.
    public var isPermanent: Bool { self != .arretees }

    /// La voie d'une carte. Une carte que « Reprendre » peut relancer est EN
    /// COURS (en pause) quelle que soit sa colonne : la feature vit encore.
    public static func of(_ card: KanbanCard) -> KanbanLane {
        if KanbanActionPresentation.resumable(card) { return .enCours }
        switch card.column {
        case .enAttente: return .pasCommencees
        case .enCours: return .enCours
        case .questionEnVol, .jalonSpecs, .jalonReview: return .aVous
        case .prOuverte, .prCreee, .fusionne, .prFermee, .termineeSansPr: return .livrees
        case .echec, .bloquee, .annuleeRetiree: return .arretees
        }
    }
}

/// Une voie affichée et ses cartes.
public struct KanbanLaneContent: Identifiable, Equatable {
    public var lane: KanbanLane
    public var cards: [KanbanCard]

    public var id: String { lane.rawValue }

    public init(lane: KanbanLane, cards: [KanbanCard]) {
        self.lane = lane
        self.cards = cards
    }
}

extension KanbanBoard {
    /// Les voies affichées, dans l'ordre : les voies permanentes toujours, les
    /// autres seulement si elles ont des cartes. Dans une voie, les cartes
    /// suivent l'ordre des colonnes de S-1 (question, specs, revue…), puis
    /// l'ordre de l'ardoise.
    public var lanes: [KanbanLaneContent] {
        let columnOrder = Dictionary(uniqueKeysWithValues: KanbanColumn.allCases.enumerated().map { ($1, $0) })
        let indexed = cards.enumerated().map { (index: $0, card: $1) }
        return KanbanLane.allCases.compactMap { lane in
            let laneCards = indexed
                .filter { KanbanLane.of($0.card) == lane }
                .sorted {
                    let left = columnOrder[$0.card.column] ?? 0
                    let right = columnOrder[$1.card.column] ?? 0
                    return left != right ? left < right : $0.index < $1.index
                }
                .map(\.card)
            guard lane.isPermanent || !laneCards.isEmpty else { return nil }
            return KanbanLaneContent(lane: lane, cards: laneCards)
        }
    }
}

/// La disposition des voies : `condensed` (iPhone et Mac) écarte les voies sans
/// carte et replie les voies terminales ; `full` (iPad) rend chaque voie de
/// `lanes`, vides comprises, sans repli — l'affichage d'avant.
public enum KanbanLaneLayout: Equatable, Sendable {
    case condensed
    case full
}

/// Une voie telle qu'un écran Pipelines la rend.
public struct KanbanLaneRow: Identifiable, Equatable {
    /// La voie et TOUTES ses cartes : le compte de l'en-tête reste celui de la
    /// voie, repliée ou non.
    public let content: KanbanLaneContent
    /// L'en-tête replie et déplie la voie.
    public let foldable: Bool
    /// Repliée : seul l'en-tête est rendu.
    public let folded: Bool

    public var id: String { content.id }
    public var lane: KanbanLane { content.lane }
    public var visibleCards: [KanbanCard] { folded ? [] : content.cards }

    public init(content: KanbanLaneContent, foldable: Bool, folded: Bool) {
        self.content = content
        self.foldable = foldable
        self.folded = folded
    }
}

/// La règle UNIQUE des voies rendues, partagée par les deux coques.
public enum KanbanLaneRows {
    /// Les voies que l'en-tête peut replier : les deux voies terminales.
    public static let foldable: Set<KanbanLane> = [.livrees, .arretees]

    /// Les voies rendues, dans l'ordre de `lanes`. `full` : une rangée par voie,
    /// voies vides comprises, rien de repliable. `condensed` : seulement les
    /// voies qui ont au moins une carte ; une voie terminale est repliée sauf si
    /// elle est dans `unfolded`. Les cartes d'une voie ne sont jamais tronquées.
    public static func rows(_ lanes: [KanbanLaneContent], layout: KanbanLaneLayout, unfolded: Set<KanbanLane>) -> [KanbanLaneRow] {
        switch layout {
        case .full:
            return lanes.map { KanbanLaneRow(content: $0, foldable: false, folded: false) }
        case .condensed:
            return lanes.filter { !$0.cards.isEmpty }.map { content in
                let isFoldable = Self.foldable.contains(content.lane)
                return KanbanLaneRow(content: content, foldable: isFoldable, folded: isFoldable && !unfolded.contains(content.lane))
            }
        }
    }
}

/// Les deux lignes de modèle d'une carte : « Modèle /req et /specs : <nom> » et
/// « Modèle /impl et /review : <nom> ».
public struct KanbanModelLines: Equatable, Sendable {
    public let reqSpecs: String
    public let implReview: String

    public init(reqSpecs: String, implReview: String) {
        self.reqSpecs = reqSpecs
        self.implReview = implReview
    }
}

/// Ce qu'une carte montre, en fonctions PURES.
public enum KanbanCardPresentation {
    /// Le titre sans le préfixe « dépôt/ » des runs hors lot : le dépôt a sa
    /// propre ligne (« mem0-omp/export-csv » devient « export-csv »).
    public static func title(_ card: KanbanCard) -> String {
        let prefix = card.repo + "/"
        guard !card.repo.isEmpty, card.title.hasPrefix(prefix), card.title.count > prefix.count else { return card.title }
        return String(card.title.dropFirst(prefix.count))
    }

    /// Le badge d'une carte, ou `nil` quand la voie dit déjà son état (« En
    /// cours » dans « En cours », « Pas commencée » dans « Pas commencées »).
    public static func badge(_ card: KanbanCard) -> ConsoleStatus? {
        let status = ConsoleStatus.of(card: card)
        switch KanbanLane.of(card) {
        case .pasCommencees:
            return nil
        case .enCours:
            return status.tone == .paused ? status : nil
        case .aVous:
            // « À vous » répéterait la voie : la nature de l'attente le remplace.
            return card.column == .questionEnVol ? ConsoleStatus(text: "Question", tone: .attention) : status
        case .livrees, .arretees:
            return status
        }
    }

    /// Le texte de l'attente : la question de l'agent, ou `nil`.
    public static func preview(_ card: KanbanCard) -> String? {
        for zone in KanbanActionPresentation.zones(for: card) {
            switch zone {
            case .pendingQuestion(_, let question, _):
                return question
            case .textQuestion(_, let prompt):
                return prompt
            default:
                continue
            }
        }
        return nil
    }

    /// Les deux lignes de modèle d'une carte, `nil` quand elle n'en porte aucun
    /// (aucune ligne n'est alors écrite). Chaque sélecteur est nommé par le
    /// catalogue (`ModelCatalog.displayName`), le sélecteur en repli ; un groupe
    /// vide reste « défaut OMP ».
    public static func modelLines(_ card: KanbanCard, names: [String: String]?) -> KanbanModelLines? {
        guard let models = card.models else { return nil }
        return KanbanModelLines(
            reqSpecs: modelLine(KanbanText.modelReqSpecs, models.reqSpecs.map { ModelCatalog.displayName($0, names: names) }),
            implReview: modelLine(KanbanText.modelImplReview, models.implReview.map { ModelCatalog.displayName($0, names: names) })
        )
    }

    /// `<libellé> : <valeur|défaut OMP>` — un groupe vide s'affiche « défaut OMP ».
    public static func modelLine(_ label: String, _ value: String?) -> String {
        "\(label) : \(value ?? KanbanText.modelDefault)"
    }

    /// L'étape et l'avancement n'ont de sens que pour une feature vivante.
    public static func showsProgress(_ card: KanbanCard) -> Bool {
        let lane = KanbanLane.of(card)
        return (lane == .enCours || lane == .aVous) && card.phase != nil
    }

    /// La durée n'a de sens que pour ce qui tourne ou attend.
    public static func showsDuration(_ card: KanbanCard) -> Bool {
        let lane = KanbanLane.of(card)
        return lane == .enCours || lane == .aVous
    }
}
