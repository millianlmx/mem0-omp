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
struct StatsBar: Identifiable, Equatable {
    var id: String
    var feature: String
    var kind: String
    var tokens: Int
}

/// Une ligne du tableau : un run. Les champs numériques servent au tri, les
/// champs `…Text` au rendu.
struct StatsRow: Identifiable, Equatable {
    /// Le `sessionFile`.
    var id: String
    var tag: String
    var feature: String
    var phaseTitle: String
    var phaseOrder: Int
    var model: String
    /// -1 quand la durée est inconnue (tri en tête en ordre croissant).
    var durationMs: Double
    var durationText: String
    var turns: Int
    var tokens: Int
    var tokensText: String
    var status: ConsoleStatus
    var unreadableReason: String?
}

enum StatsPresentation {
    /// Deux barres par feature listée, dans l'ordre : « envoyés » puis « reçus ».
    static func bars(_ project: ProjectStats, nowMs: Double) -> [StatsBar] {
        project.features.flatMap { feature -> [StatsBar] in
            let totals = featureTotals(feature, nowMs: nowMs)
            return [
                StatsBar(
                    id: "\(feature.slug).\(StatsText.sentKind)",
                    feature: feature.slug, kind: StatsText.sentKind, tokens: totals.input
                ),
                StatsBar(
                    id: "\(feature.slug).\(StatsText.receivedKind)",
                    feature: feature.slug, kind: StatsText.receivedKind, tokens: totals.output
                ),
            ]
        }
    }

    /// Les runs des features listées, features puis runs dans l'ordre de S-1 de
    /// `statistiques`.
    static func rows(_ project: ProjectStats, nowMs: Double) -> [StatsRow] {
        project.features.flatMap { feature in
            feature.runs.map { row($0, feature: feature.slug, nowMs: nowMs) }
        }
    }

    private static func row(_ run: RunStats, feature: String, nowMs: Double) -> StatsRow {
        var row = StatsRow(
            id: run.sessionFile,
            tag: sessionTag(forSessionFile: run.sessionFile),
            feature: feature,
            phaseTitle: PhaseText.title(run.phase),
            phaseOrder: phaseOrder(run.phase),
            model: "—",
            durationMs: -1,
            durationText: "—",
            turns: 0,
            tokens: 0,
            tokensText: "—",
            status: ConsoleStatus(text: "Illisible", tone: .danger),
            unreadableReason: nil
        )
        switch run.metrics {
        case .measured(let metrics):
            let duration = durationMs(metrics, isLive: run.isLive, nowMs: nowMs)
            row.model = metrics.model ?? "—"
            row.durationMs = duration ?? -1
            row.durationText = duration.map { ConsoleFormat.duration(ms: $0) } ?? "—"
            row.turns = metrics.turns
            row.tokens = metrics.input + metrics.output
            row.tokensText = ConsoleFormat.tokens(row.tokens)
            row.status = run.isLive
                ? ConsoleStatus(text: "En cours", tone: .info)
                : ConsoleStatus(text: "Terminé", tone: .success)
        case .unreadable(let reason):
            row.unreadableReason = reason
        }
        return row
    }

    /// L'ordre des étapes du pipeline, pour trier la colonne « Étape ».
    private static func phaseOrder(_ phase: PipelinePhase) -> Int {
        switch phase {
        case .req: return 0
        case .specs: return 1
        case .impl: return 2
        case .review: return 3
        case .release: return 4
        }
    }
}
