// Le contenu PUR de la section Statistiques de l'app iOS (S-4) : les lignes d'une
// carte (libellé/valeur DÉJÀ formés), le total du projet et la mention des
// features masquées. C'est ce contenu que les tests figent ; la vue ne fait que le
// rendre.
//
// Aucune somme n'est refaite ici : les valeurs viennent des extensions
// d'avancement de `ConsoleClient` (`totals(elapsedMs:)`), qui appliquent la MÊME
// règle que la fenêtre macOS, et la mise en forme vient de `ConsoleFormat`
// (`ConsoleCore`) — aucun formateur local, aucune interpolation composée.

import ConsoleClient
import ConsoleCore

/// Une ligne libellé/valeur d'une carte (une grandeur par ligne, S-4).
struct IOSStatsLine: Equatable {
    let label: String
    let value: String
}

/// Une carte : un titre et ses lignes. Le titre d'une carte de feature est son
/// slug ; celui du total, `IOSStatsText.total`.
struct IOSStatsCard: Equatable {
    let title: String
    let lines: [IOSStatsLine]
}

/// Le contenu pur de l'écran (S-4).
enum IOSStatsContent {
    /// Le modèle absent se dit d'un tiret cadratin, comme la coque macOS.
    static let noModel = "—"

    /// Les lignes d'une carte de feature, `elapsedMs` après la réception du
    /// relevé : la durée avance, les tokens et les tours non (S-5).
    static func featureCard(_ feature: RemoteStatsFeature, elapsedMs: Double) -> IOSStatsCard {
        let totals = feature.totals(elapsedMs: elapsedMs)
        return IOSStatsCard(
            title: feature.slug,
            lines: [
                IOSStatsLine(label: StatsPresentation.columnModel, value: feature.model ?? noModel),
                IOSStatsLine(label: StatsPresentation.timeSpent, value: ConsoleFormat.duration(ms: totals.durationMs)),
                IOSStatsLine(label: StatsPresentation.turns, value: count(totals.turns)),
                IOSStatsLine(label: StatsPresentation.sentTokens, value: ConsoleFormat.tokens(totals.sent)),
                IOSStatsLine(label: StatsPresentation.receivedTokens, value: ConsoleFormat.tokens(totals.output)),
            ]
        )
    }

    /// La carte du total du projet : les quatre grandeurs sommées sur les features
    /// LISTÉES, rien d'autre (AC-3).
    static func totalCard(_ payload: RemoteStatsPayload, elapsedMs: Double) -> IOSStatsCard {
        let totals = payload.totals(elapsedMs: elapsedMs)
        return IOSStatsCard(
            title: IOSStatsText.total,
            lines: [
                IOSStatsLine(label: StatsPresentation.timeSpent, value: ConsoleFormat.duration(ms: totals.durationMs)),
                IOSStatsLine(label: StatsPresentation.turns, value: count(totals.turns)),
                IOSStatsLine(label: StatsPresentation.sentTokens, value: ConsoleFormat.tokens(totals.sent)),
                IOSStatsLine(label: StatsPresentation.receivedTokens, value: ConsoleFormat.tokens(totals.output)),
            ]
        )
    }

    /// Les cartes d'une feature, dans l'ordre servi (l'ordre du plan).
    static func cards(_ payload: RemoteStatsPayload, elapsedMs: Double) -> [IOSStatsCard] {
        payload.features.map { featureCard($0, elapsedMs: elapsedMs) }
    }

    /// Le message de l'état vide, ou `nil` quand des features sont listées.
    static func emptyMessage(_ payload: RemoteStatsPayload) -> String? {
        payload.features.isEmpty ? StatsPresentation.empty : nil
    }

    /// La mention des features masquées, ou `nil` quand il n'y en a aucune.
    static func hiddenMention(_ payload: RemoteStatsPayload) -> String? {
        payload.hiddenPlanFeatures > 0 ? StatsPresentation.hidden(payload.hiddenPlanFeatures) : nil
    }

    /// Un nombre en chiffres, dans la locale de la coque (un tour se lit comme la
    /// tuile macOS, sans unité répétée sous son libellé).
    static func count(_ n: Int) -> String {
        n.formatted(.number.locale(ConsoleFormat.locale))
    }
}
