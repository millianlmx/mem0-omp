// Ce que la coque garde de la présentation « Statistiques » : les fonctions qui
// nomment un type de la coque (`ProjectStats`, `RunStats`). Les types de valeur
// rendus (`StatsBar`, `StatsRow`) et l'ordre des étapes vivent dans
// `ConsoleCore/Stats/StatsPresentation.swift`.

import ConsoleCore

extension StatsPresentation {
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
}
