// Preuves de la SURFACE de la fenêtre « Statistiques » (S-5 de `statistiques`,
// S-17 de omp-console-redesign) : les textes dérivés d'un état, les barres et les
// lignes du tableau de bord, et l'absence de tout montant.
//
// Les vues SwiftUI ne se rendent pas sous les Command Line Tools : ce qui se
// vérifie ici est ce qu'elles LISENT (`StatsText`, `StatsPresentation`), le rendu
// graphique relevant de la recette.

import Testing

@testable import OMPConsole
import ConsoleCore

private let closedSession = "/tmp/sessions/2026-09-28T09-00-00-000Z_01a0e88e.jsonl"
private let missingSession = "/tmp/sessions/2026-09-28T10-00-00-000Z_02b1f99f.jsonl"
private let deniedSession = "/tmp/sessions/2026-09-28T11-00-00-000Z_03c2a00a.jsonl"
private let liveSession = "/tmp/sessions/2026-09-28T12-00-00-000Z_04d3b11b.jsonl"
private let liveStart: Double = 1_790_000_000_000

private func statsRun(
    _ sessionFile: String, phase: PipelinePhase = .impl, isLive: Bool = false, metrics: RunMetricsState
) -> RunStats {
    RunStats(id: sessionFile, sessionFile: sessionFile, phase: phase, isLive: isLive, metrics: metrics)
}

/// Deux features : la première porte un run clos 100/20 et un run illisible, la
/// seconde un run vivant 5/1 commencé à `liveStart`.
private func dashboardProject() -> ProjectStats {
    let closed = SessionMetrics(input: 100, output: 20, turns: 3, model: "m1", firstMs: 0, lastMs: 60_000)
    let live = SessionMetrics(input: 5, output: 1, turns: 1, model: nil, firstMs: liveStart, lastMs: liveStart)
    return ProjectStats(
        repoKey: "k",
        label: "depot",
        features: [
            FeatureStats(id: "f1", slug: "f1", runs: [
                statsRun(closedSession, phase: .specs, metrics: .measured(closed)),
                statsRun(missingSession, phase: .impl, metrics: .unreadable("session introuvable")),
            ]),
            FeatureStats(id: "f2", slug: "f2", runs: [
                statsRun(liveSession, phase: .review, isLive: true, metrics: .measured(live)),
            ]),
        ],
        hiddenPlanFeatures: 1
    )
}

@MainActor
@Test("statistiques/AC-1 : un run illisible rend son motif sur sa propre ligne")
func unreadableRunLineCarriesItsReason() throws {
    let measured = SessionMetrics(input: 1, output: 1, turns: 1, model: "m1", firstMs: 0, lastMs: 1_000)
    let project = ProjectStats(
        repoKey: "k",
        label: "depot",
        features: [
            FeatureStats(id: "f", slug: "f", runs: [
                statsRun(closedSession, metrics: .measured(measured)),
                statsRun(missingSession, metrics: .unreadable("session introuvable")),
                statsRun(deniedSession, phase: .review, metrics: .unreadable("session illisible : Permission denied")),
            ]),
        ],
        hiddenPlanFeatures: 0
    )

    let rows = StatsPresentation.rows(project, nowMs: 0)
    try #require(rows.count == 3)
    let missing = rows[1]
    let denied = rows[2]
    #expect(missing.unreadableReason == "session introuvable")
    #expect(denied.unreadableReason == "session illisible : Permission denied")
    for row in [missing, denied] {
        #expect(row.status.text == "Illisible")
        #expect(row.durationMs == -1)
    }
    #expect(missing.tag == "02b1f99f")
    #expect(denied.tag == "03c2a00a")
    // Un run lisible ne porte aucun motif.
    #expect(rows[0].unreadableReason == nil)
}

@MainActor
@Test("statistiques/AC-1 : le sélecteur et chaque ligne exposent leur identifiant d'accessibilité")
func accessibilityIdentifiersAreStable() {
    #expect(StatsView.runIdentifier("01a0e88e") == "stats.run.01a0e88e")
}

@MainActor
@Test("statistiques-etat-vide-et-non-defilables/AC-5 : avant le premier instantané, la fenêtre dit « Chargement des statistiques… », pas celui des pipelines")
func statsLoadingNamesStatistics() {
    // Avant `start()`, aucun instantané : c'est l'état où la vue montre
    // `StatsText.loading`. Le magasin n'est jamais ouvert.
    let model = StatsModel(stateDir: "/tmp/etat")
    defer { model.stop() }
    #expect(model.state == .loading)
    #expect(model.state.shownBoard == nil)
    #expect(StatsText.loading == "Chargement des statistiques\u{2026}")
    #expect(StatsText.loading != KanbanBoardState.loadingText)
}

@MainActor
@Test("statistiques/AC-2 : aucune chaîne rendue ne porte de signe monétaire ni de coût")
func noCurrencyAnywhere() {
    let project = dashboardProject()
    let nowMs = liveStart + 3_000
    let totals = projectTotals(project, nowMs: nowMs)
    var rendered = [
        StatsText.loading,
        StatsText.storeAbsent(dir: "/tmp/etat"),
        StatsText.noProject,
        StatsText.empty,
        StatsText.hidden(project.hiddenPlanFeatures),
        StatsText.noStatsTitle,
        StatsText.noProjectTitle,
        StatsText.sentTokens,
        StatsText.receivedTokens,
        StatsText.timeSpent,
        StatsText.turns,
        StatsText.chartTitle,
        StatsText.tableTitle,
        StatsText.columnFeature,
        StatsText.columnStep,
        StatsText.columnModel,
        StatsText.columnDuration,
        StatsText.columnTurns,
        StatsText.columnTokens,
        StatsText.columnState,
        ConsoleFormat.tokens(totals.input),
        ConsoleFormat.tokens(totals.output),
        ConsoleFormat.duration(ms: totals.durationMs),
        "\(totals.turns)",
    ]
    rendered += StatsPresentation.bars(project, nowMs: nowMs).map(\.kind)
    for row in StatsPresentation.rows(project, nowMs: nowMs) {
        rendered += [row.feature, row.phaseTitle, row.model, row.durationText, row.tokensText, row.status.text]
        rendered += [row.unreadableReason].compactMap { $0 }
    }
    for text in rendered {
        #expect(!text.contains("$"))
        #expect(!text.contains("€"))
        #expect(!text.contains("cost"))
    }
}

@MainActor
@Test("omp-console-redesign/S-17 : le tableau de bord additionne les runs lisibles et garde leur ordre")
func dashboardSumsReadableRunsInOrder() throws {
    let project = dashboardProject()

    // Le run illisible n'entre pas dans les sommes de sa feature.
    #expect(StatsPresentation.bars(project, nowMs: liveStart) == [
        StatsBar(id: "f1.envoyés", feature: "f1", kind: "envoyés", tokens: 100),
        StatsBar(id: "f1.reçus", feature: "f1", kind: "reçus", tokens: 20),
        StatsBar(id: "f2.envoyés", feature: "f2", kind: "envoyés", tokens: 5),
        StatsBar(id: "f2.reçus", feature: "f2", kind: "reçus", tokens: 1),
    ])

    let rows = StatsPresentation.rows(project, nowMs: liveStart)
    #expect(rows.map(\.id) == [closedSession, missingSession, liveSession])
    #expect(rows.map(\.feature) == ["f1", "f1", "f2"])
    try #require(rows.count == 3)
    #expect(rows[0].tokens == 120)
    #expect(rows[0].status == ConsoleStatus(text: "Terminé", tone: .success))
    #expect(rows[2].status == ConsoleStatus(text: "En cours", tone: .info))

    // La durée d'un run vivant court jusqu'à l'instant de rendu.
    let later = StatsPresentation.rows(project, nowMs: liveStart + 2_000)
    #expect(later[2].durationMs == rows[2].durationMs + 2_000)
}
