// Ce que le tableau de bord « Statistiques » rend (S-17 de omp-console-redesign) :
// les barres du graphique et les lignes du tableau, en fonctions PURES du projet
// affiché et de l'instant de rendu.
//
// Aucune somme n'est refaite ici : les barres lisent `featureTotals`, la durée
// d'un run `durationMs` (StatsBoard.swift, StatsMetrics.swift) — une seule règle
// de calcul par grandeur. Aucun montant n'est lu ni rendu (AC-2 de
// `statistiques`).

import Foundation

/// Une barre du graphique : une feature, une série (« envoyés » ou « reçus »),
/// un nombre de tokens.
public struct StatsBar: Identifiable, Equatable, Codable {
    public var id: String
    public var feature: String
    public var kind: String
    public var tokens: Int

    public init(id: String, feature: String, kind: String, tokens: Int) {
        self.id = id
        self.feature = feature
        self.kind = kind
        self.tokens = tokens
    }
}

/// Une ligne du tableau : un run. Les champs numériques servent au tri, les
/// champs `…Text` au rendu.
public struct StatsRow: Identifiable, Equatable, Codable {
    /// Le `sessionFile`.
    public var id: String
    public var tag: String
    public var feature: String
    public var phaseTitle: String
    public var phaseOrder: Int
    public var model: String
    /// -1 quand la durée est inconnue (tri en tête en ordre croissant).
    public var durationMs: Double
    public var durationText: String
    public var turns: Int
    public var tokens: Int
    public var tokensText: String
    public var status: ConsoleStatus
    public var unreadableReason: String?

    public init(id: String, tag: String, feature: String, phaseTitle: String, phaseOrder: Int, model: String, durationMs: Double, durationText: String, turns: Int, tokens: Int, tokensText: String, status: ConsoleStatus, unreadableReason: String?) {
        self.id = id
        self.tag = tag
        self.feature = feature
        self.phaseTitle = phaseTitle
        self.phaseOrder = phaseOrder
        self.model = model
        self.durationMs = durationMs
        self.durationText = durationText
        self.turns = turns
        self.tokens = tokens
        self.tokensText = tokensText
        self.status = status
        self.unreadableReason = unreadableReason
    }
}

public enum StatsPresentation {

    /// L'état vide d'un projet non choisi : le titre et la phrase que les deux
    /// coques affichent mot pour mot (S-4 de design-ios). La coque macOS les lit
    /// par `StatsText`, jamais une seconde déclaration du même mot.
    public static let noProjectTitle = "Aucun projet"
    public static let noProject = "Les statistiques apparaîtront dès qu'un projet sera piloté."

    /// L'état vide d'un projet affiché sans aucune feature listée (S-4).
    public static let empty = "Aucune donnée pour ce projet"

    /// Les grandeurs d'une ligne de statistiques : les mots que les DEUX coques
    /// affichent (l'app iOS en fait les libellés de ses cartes, macOS ses tuiles
    /// et ses colonnes). Une seule déclaration par mot, comme `noProject` : la
    /// coque macOS les lit par `StatsText`.
    public static let sentTokens = "Tokens envoyés"
    public static let receivedTokens = "Tokens reçus"
    public static let timeSpent = "Temps passé"
    public static let turns = "Tours"

    /// Les colonnes du tableau de runs de la coque macOS.
    public static let columnFeature = "Feature"
    public static let columnModel = "Modèle"
    public static let columnDuration = "Durée"
    public static let columnTurns = "Tours"
    public static let columnTokens = "Tokens"

    /// La mention des features du plan sans run lisible (S-4) : le compte est
    /// celui des features MASQUÉES, jamais un montant.
    public static func hidden(_ count: Int) -> String {
        ConsoleFormat.count(count, "feature du plan sans données", "features du plan sans données")
    }

    /// L'ordre des étapes du pipeline, pour trier la colonne « Étape ».
    ///
    /// PUBLIC : la coque garde `rows(_:nowMs:)`, qui remplit `phaseOrder` d'une
    /// ligne — un membre appelé depuis la coque doit être visible de l'autre
    /// module (c'était `private` tant que tout vivait dans le même).
    public static func phaseOrder(_ phase: PipelinePhase) -> Int {
        switch phase {
        case .req: return 0
        case .specs: return 1
        case .impl: return 2
        case .review: return 3
        case .release: return 4
        }
    }
}
