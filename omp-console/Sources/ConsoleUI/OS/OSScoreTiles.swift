// L'« OS agentique » : les TROIS CHIFFRES de la boucle, en tuiles, sur « Maintenant » —
// la part livrée sans l'humain, le délai médian d'une décision, la part du travail lancé
// sans l'humain, sur sept jours. Chaque tuile porte sa valeur et sa tendance (les trois
// derniers jours face à la semaine), rien d'autre. La fenêtre ne dépasse jamais sept
// jours : le serveur borne la sienne à ce que son journal garde. Un serveur qui ne sert
// pas les chiffres ne montre rien.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Le sens d'un chiffre : sa valeur récente face à celle d'une fenêtre plus longue.
public enum OSScoreTrend: Equatable, Sendable {
    case up, down, flat

    /// La tendance de `recent` face à `longer`, stable sous `tolerance` d'écart ; `nil` quand
    /// l'une des deux valeurs manque.
    public static func of(_ recent: Double?, against longer: Double?, tolerance: Double) -> OSScoreTrend? {
        guard let recent, let longer else { return nil }
        if abs(recent - longer) <= tolerance { return .flat }
        return recent > longer ? .up : .down
    }

    var symbol: String {
        switch self {
        case .up: "arrow.up.right"
        case .down: "arrow.down.right"
        case .flat: "arrow.right"
        }
    }

    var label: String {
        switch self {
        case .up: OSWatchText.trendUp
        case .down: OSWatchText.trendDown
        case .flat: OSWatchText.trendFlat
        }
    }
}

public struct OSScoreTiles: View {
    @ObservedObject var scores: HarnessScoreboardModel
    let recent: HarnessScoreboard?

    /// La fenêtre récente, en jours.
    private static let recentDays = 3

    /// `recent` : les trois derniers jours, que la semaine sert à juger (`OSScoreTiles.load`) ;
    /// sans eux, les tuiles n'ont pas de tendance.
    public init(server: HarnessModel, recent: HarnessScoreboard?) {
        _scores = ObservedObject(wrappedValue: server.scoreboard)
        self.recent = recent
    }

    /// Relit les chiffres — il n'y a pas d'événement pour eux : les trois derniers jours
    /// d'abord, qu'elle rend, puis la semaine, que le modèle garde. L'écran qui pose les
    /// tuiles l'appelle à son ouverture.
    @MainActor
    public static func load(_ server: HarnessModel) async -> HarnessScoreboard? {
        await server.scoreboard.refresh(days: recentDays)
        let recent = server.scoreboard.failure == nil ? server.scoreboard.scoreboard : nil
        await server.scoreboard.refresh(days: HarnessScoreboardModel.defaultDays)
        return recent
    }

    public var body: some View {
        if scores.days == HarnessScoreboardModel.defaultDays, let week = scores.scoreboard {
            HStack(spacing: 10) {
                tile(
                    OSWatchText.scoreAlone,
                    value: week.aloneRate.map(PipelineServerText.percent),
                    trend: .of(recent?.aloneRate, against: week.aloneRate, tolerance: 0.02),
                    better: .up
                )
                tile(
                    OSWatchText.scoreDelay,
                    value: week.medianDecisionMs.map { ConsoleFormat.duration(ms: $0) },
                    trend: .of(recent?.medianDecisionMs, against: week.medianDecisionMs, tolerance: (week.medianDecisionMs ?? 0) / 10),
                    better: .down
                )
                tile(
                    OSWatchText.scoreStarted,
                    value: week.startedAloneRate.map(PipelineServerText.percent),
                    trend: .of(recent?.startedAloneRate, against: week.startedAloneRate, tolerance: 0.02),
                    better: .up
                )
            }
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// `better` : le sens qui est un progrès (vert) ; l'autre reste gris.
    private func tile(_ label: String, value: String?, trend: OSScoreTrend?, better: OSScoreTrend) -> some View {
        OSTile(
            value: value,
            label: label,
            mark: trend.map { OSTile.Mark(symbol: $0.symbol, tint: $0 == better ? .green : .secondary, label: $0.label) }
        )
    }
}
