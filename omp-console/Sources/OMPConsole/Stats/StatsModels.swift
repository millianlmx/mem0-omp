// Les types du tableau « Statistiques » et les TEXTES exacts de S-5 : des valeurs
// pures, testables sans interface — la vue ne fait que les rendre.
//
// Un seul vocabulaire de durée (`elapsedLabel`) et de modèle (`absent`) est
// réutilisé, jamais réinventé.

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

/// Les textes exacts de S-5. Le chargement et le magasin absent sont REPRIS MOT
/// POUR MOT de `KanbanBoardState` : une seule formulation par situation dans l'app.
enum StatsText {
    static let loading = KanbanBoardState.loadingText

    static func storeAbsent(dir: String) -> String {
        KanbanBoardState.absentText(dir: dir)
    }

    static func noProject(dir: String) -> String {
        "Aucun projet dans le magasin d'état : \(dir)"
    }

    static let empty = "Aucun run lisible pour ce projet"

    static func hidden(_ count: Int) -> String {
        "\(count) feature(s) du plan sans run lisible"
    }

    /// `Projet <libellé> — entrée <n> · sortie <n> · durée <d> · tours <n>`.
    static func aggregate(label: String, totals: StatsTotals) -> String {
        "Projet \(label) — \(totalsSuffix(totals))"
    }

    /// `<slug> — entrée <n> · sortie <n> · durée <d> · tours <n>`.
    static func feature(slug: String, totals: StatsTotals) -> String {
        "\(slug) — \(totalsSuffix(totals))"
    }

    /// `<tag> · /<phase> · entrée <n> · sortie <n> · durée <d> · tours <n> · modèle <m|absent>`.
    static func run(
        tag: String, phase: PipelinePhase, metrics: SessionMetrics, isLive: Bool, nowMs: Double
    ) -> String {
        let duration = durationMs(metrics, isLive: isLive, nowMs: nowMs).map { elapsedLabel(ms: $0) } ?? "—"
        let model = metrics.model ?? "absent"
        return "\(tag) · /\(phase.rawValue) · entrée \(metrics.input) · sortie \(metrics.output)"
            + " · durée \(duration) · tours \(metrics.turns) · modèle \(model)"
    }

    /// `<tag> · /<phase> — <motif>` : un run illisible remplace tout.
    static func unreadableRun(tag: String, phase: PipelinePhase, reason: String) -> String {
        "\(tag) · /\(phase.rawValue) — \(reason)"
    }
}

/// La ligne d'un run, mesurée ou illisible.
func statsRunLine(_ run: RunStats, nowMs: Double) -> String {
    let tag = sessionTag(forSessionFile: run.sessionFile)
    switch run.metrics {
    case .measured(let metrics):
        return StatsText.run(
            tag: tag, phase: run.phase, metrics: metrics, isLive: run.isLive, nowMs: nowMs
        )
    case .unreadable(let reason):
        return StatsText.unreadableRun(tag: tag, phase: run.phase, reason: reason)
    }
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

/// Le suffixe commun de la ligne d'agrégat et de la ligne de totaux d'une feature.
private func totalsSuffix(_ totals: StatsTotals) -> String {
    "entrée \(totals.input) · sortie \(totals.output) · durée \(elapsedLabel(ms: totals.durationMs))"
        + " · tours \(totals.turns)"
}
