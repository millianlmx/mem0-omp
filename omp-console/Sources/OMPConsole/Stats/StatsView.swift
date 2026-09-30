// La fenêtre « Statistiques » (S-5) : une surface en LECTURE SEULE — un sélecteur
// de projet, une ligne d'agrégat, le compte des features masquées, puis un bloc par
// feature et un rang par run.
//
// Aucun attribut macro SwiftUI (`@State`, `@Preview`) : interdits sous les Command
// Line Tools seuls. `@ObservedObject` est une vraie property wrapper, donc
// autorisée.
//
// L'horloge de rendu est `TimelineView(.periodic)` (Doc-4) : les durées et les
// totaux se recalculent à l'instant de rendu, donc un run vivant qui attend une
// réponse fait monter sa durée sans qu'un octet soit écrit.

import SwiftUI

struct StatsView: View {
    @ObservedObject var model: StatsModel

    /// Identifiants d'accessibilité (S-5) : ce que la sonde AX relève.
    static let projectIdentifier = "stats.project"
    static let stateIdentifier = "stats.state"
    static let emptyIdentifier = "stats.empty"
    static let aggregateIdentifier = "stats.aggregate"
    static let hiddenIdentifier = "stats.hidden"
    static func featureIdentifier(_ slug: String) -> String { "stats.feature.\(slug)" }
    static func runIdentifier(_ tag: String) -> String { "stats.run.\(tag)" }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            content(nowMs: context.date.timeIntervalSince1970 * 1000)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { model.start() }
        .onDisappear { model.stop() }
    }

    private func content(nowMs: Double) -> some View {
        Group {
            switch model.state {
            case .loading:
                message(StatsText.loading, identifier: Self.stateIdentifier)
            case .storeAbsent(let dir):
                message(StatsText.storeAbsent(dir: dir), identifier: Self.stateIdentifier)
            case .noProject(let dir):
                message(StatsText.noProject(dir: dir), identifier: Self.stateIdentifier)
            case .empty:
                message(StatsText.empty, identifier: Self.emptyIdentifier)
            case .board(let board):
                boardView(board, nowMs: nowMs)
            }
        }
    }

    /// Un message d'état : une ligne, au centre.
    private func message(_ text: String, identifier: String) -> some View {
        Text(text)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier(identifier)
    }

    /// Le tableau : sélecteur en tête, puis l'agrégat, le compte des features
    /// masquées, et un bloc par feature listée.
    private func boardView(_ board: StatsBoard, nowMs: Double) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Picker(
                "Projet",
                selection: Binding(
                    get: { model.selectedKey ?? board.project.repoKey },
                    set: { model.selectProject($0) }
                )
            ) {
                ForEach(model.projects) { project in
                    Text(project.label).tag(project.id)
                }
            }
            .accessibilityIdentifier(Self.projectIdentifier)
            .padding(12)

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(
                        StatsText.aggregate(
                            label: board.project.label,
                            totals: projectTotals(board.project, nowMs: nowMs)
                        )
                    )
                    .font(.headline)
                    .monospacedDigit()
                    .accessibilityIdentifier(Self.aggregateIdentifier)

                    Text(StatsText.hidden(board.project.hiddenPlanFeatures))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier(Self.hiddenIdentifier)

                    ForEach(board.project.features) { feature in
                        featureView(feature, nowMs: nowMs)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func featureView(_ feature: FeatureStats, nowMs: Double) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(
                StatsText.feature(
                    slug: feature.slug,
                    totals: featureTotals(feature, nowMs: nowMs)
                )
            )
            .font(.headline)
            .monospacedDigit()
            ForEach(feature.runs) { run in
                Text(statsRunLine(run, nowMs: nowMs))
                    .font(.body)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier(
                        Self.runIdentifier(sessionTag(forSessionFile: run.sessionFile))
                    )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier(Self.featureIdentifier(feature.slug))
    }
}
