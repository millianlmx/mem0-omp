// Les types du tableau « Statistiques » et ses TEXTES exacts (S-5 de
// `statistiques`, S-17 de omp-console-redesign) : des valeurs pures, testables
// sans interface — la vue ne fait que les rendre. Durées et tokens passent par
// `ConsoleFormat`, jamais par un format maison.

import ConsoleCore
import Foundation

/// L'état des métriques d'un run : mesuré, ou illisible avec son motif DÉJÀ
/// formulé pour l'affichage (S-5).
enum RunMetricsState: Equatable, Sendable {
    case measured(SessionMetrics)
    /// Motif affichable : `session introuvable` ou `session illisible : <message>`.
    case unreadable(String)
}

/// Un run d'une feature, prêt à afficher.
struct RunStats: Equatable, Sendable, Identifiable {
    /// Le `sessionFile` : identité du run.
    var id: String
    var sessionFile: String
    var phase: PipelinePhase
    var isLive: Bool
    var metrics: RunMetricsState
}

/// Une feature du plan LISTÉE, avec ses runs dans l'ordre de S-1.
struct FeatureStats: Equatable, Sendable, Identifiable {
    /// Le slug.
    var id: String
    var slug: String
    var runs: [RunStats]
}

/// Le projet affiché : son libellé de sélecteur, ses features listées, le compte
/// des features du plan sans run lisible.
struct ProjectStats: Equatable, Sendable {
    var repoKey: String
    var label: String
    var features: [FeatureStats]
    var hiddenPlanFeatures: Int
}

/// Le tableau : un projet affiché.
struct StatsBoard: Equatable, Sendable {
    var project: ProjectStats
}

/// Une somme de colonnes.
struct StatsTotals: Equatable, Sendable {
    var input: Int
    var output: Int
    var cacheRead: Int = 0
    var cacheWrite: Int = 0
    var turns: Int
    var durationMs: Double

    static let zero = StatsTotals(input: 0, output: 0, turns: 0, durationMs: 0)
}

/// Une entrée du sélecteur de projet : la clé du magasin, son libellé.
struct StatsProjectOption: Equatable, Sendable, Identifiable {
    var id: String
    var label: String
}

/// L'état publié de la fenêtre, dans l'ordre de priorité de S-5.
enum StatsViewState: Equatable, Sendable {
    case loading
    case storeAbsent(dir: String)
    case noProject(dir: String)
    case empty
    case board(StatsBoard)
}

/// Les textes exacts de la fenêtre. Le chargement et le magasin absent sont REPRIS
/// MOT POUR MOT de `KanbanBoardState` : une seule formulation par situation dans
/// l'app. Aucun chemin, aucune clé, aucun mot du protocole n'est montré (audit HIG
/// du 2026-10-01) ; un « run » se dit « exécution ».
enum StatsText {
    static let loading = KanbanBoardState.loadingText

    static func storeAbsent(dir: String) -> String {
        KanbanBoardState.absentText(dir: dir)
    }

    static let noProject = StatsPresentation.noProject

    static let empty = StatsPresentation.empty

    static func hidden(_ count: Int) -> String {
        StatsPresentation.hidden(count)
    }

    static let noStatsTitle = "Aucune statistique"
    static let noProjectTitle = StatsPresentation.noProjectTitle

    /// Les tuiles.
    static let sentTokens = StatsPresentation.sentTokens
    static let receivedTokens = StatsPresentation.receivedTokens
    static let timeSpent = StatsPresentation.timeSpent
    static let turns = StatsPresentation.turns

    /// Le graphique : un panneau par série, chacun à sa propre échelle.
    static let chartTitle = "Tokens par feature"
    static let sentKind = "envoyés"
    static let receivedKind = "reçus"

    /// Le tableau et ses colonnes (noms courts, Doc-9).
    static let tableTitle = "Exécutions"
    static let columnFeature = StatsPresentation.columnFeature
    static let columnStep = "Étape"
    static let columnModel = StatsPresentation.columnModel
    static let columnDuration = StatsPresentation.columnDuration
    static let columnTurns = StatsPresentation.columnTurns
    static let columnTokens = StatsPresentation.columnTokens
    static let columnState = "État"
}

/// Le motif d'un incident de lecture, DÉJÀ formulé pour l'affichage (S-5) ; `nil`
/// pour une réécriture (`truncated`/`replaced`), qui n'est jamais montrée.
func statsUnreadableReason(_ issue: SessionIssue) -> String? {
    switch issue {
    case .fileMissing: return "session introuvable"
    case .unreadable(let message): return "session illisible : \(message)"
    case .truncated, .replaced: return nil
    }
}
