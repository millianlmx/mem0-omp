// Preuves de la SURFACE de la fenêtre « Statistiques » (S-5) : les textes dérivés
// d'un état et l'absence de tout montant.
//
// Les vues SwiftUI ne se rendent pas sous les Command Line Tools : ce qui se
// vérifie ici est ce qu'elles LISENT (les textes du modèle), le rendu graphique
// relevant de la recette de BR-4.

import Testing

@testable import OMPConsole

@MainActor
@Test("statistiques/AC-1 : les textes des états du magasin sont exacts")
func stateTextsAreExact() {
    #expect(StatsText.storeAbsent(dir: "/tmp/etat") == "Magasin d'état absent : /tmp/etat")
    #expect(StatsText.noProject(dir: "/tmp/etat") == "Aucun projet dans le magasin d'état : /tmp/etat")
    #expect(StatsText.hidden(3) == "3 feature(s) du plan sans run lisible")
    // La ligne des features masquées s'affiche même à zéro.
    #expect(StatsText.hidden(0) == "0 feature(s) du plan sans run lisible")
}

@MainActor
@Test("statistiques/AC-1 : la ligne d'agrégat, la ligne de feature et le rang d'un run sont exacts")
func tableLinesAreExact() {
    let totals = StatsTotals(input: 1234, output: 56, turns: 7, durationMs: 90_000)
    #expect(
        StatsText.aggregate(label: "mem0-omp", totals: totals)
            == "Projet mem0-omp — entrée 1234 · sortie 56 · durée 1:30 · tours 7"
    )
    #expect(
        StatsText.feature(slug: "statistiques", totals: totals)
            == "statistiques — entrée 1234 · sortie 56 · durée 1:30 · tours 7"
    )

    let metrics = SessionMetrics(input: 10, output: 2, turns: 1, model: "m1", firstMs: 0, lastMs: 5_000)
    #expect(
        StatsText.run(tag: "01a0e88e", phase: .impl, metrics: metrics, isLive: false, nowMs: 0)
            == "01a0e88e · /impl · entrée 10 · sortie 2 · durée 0:05 · tours 1 · modèle m1"
    )
    // Un modèle absent s'écrit « absent » ; une durée inconnue s'écrit « — ».
    var unknown = metrics
    unknown.model = nil
    unknown.firstMs = nil
    unknown.lastMs = nil
    #expect(
        StatsText.run(tag: "01a0e88e", phase: .review, metrics: unknown, isLive: false, nowMs: 0)
            == "01a0e88e · /review · entrée 10 · sortie 2 · durée — · tours 1 · modèle absent"
    )
}

@MainActor
@Test("statistiques/AC-1 : un run illisible rend son motif sur sa propre ligne")
func unreadableRunLineCarriesItsReason() {
    let missing = RunStats(
        id: "a", sessionFile: "/tmp/sessions/2026-09-28T09-00-00-000Z_01a0e88e.jsonl",
        phase: .impl, isLive: false, metrics: .unreadable("session introuvable")
    )
    #expect(statsRunLine(missing, nowMs: 0) == "01a0e88e · /impl — session introuvable")

    let unreadable = RunStats(
        id: "b", sessionFile: "/tmp/sessions/2026-09-28T09-00-00-000Z_02b1f99f.jsonl",
        phase: .review, isLive: false, metrics: .unreadable("session illisible : Permission denied")
    )
    #expect(statsRunLine(unreadable, nowMs: 0) == "02b1f99f · /review — session illisible : Permission denied")
}

@MainActor
@Test("statistiques/AC-1 : le sélecteur et chaque ligne exposent leur identifiant d'accessibilité")
func accessibilityIdentifiersAreStable() {
    #expect(StatsView.featureIdentifier("statistiques") == "stats.feature.statistiques")
    #expect(StatsView.runIdentifier("01a0e88e") == "stats.run.01a0e88e")
}

@MainActor
@Test("statistiques/AC-2 : aucune chaîne rendue ne porte de signe monétaire ni de coût")
func noCurrencyAnywhere() {
    let metrics = SessionMetrics(input: 10, output: 2, turns: 1, model: "m1", firstMs: 0, lastMs: 1_000)
    let totals = StatsTotals(input: 10, output: 2, turns: 1, durationMs: 1_000)
    let run = RunStats(
        id: "a", sessionFile: "/tmp/sessions/2026-09-28T09-00-00-000Z_01a0e88e.jsonl",
        phase: .impl, isLive: true, metrics: .measured(metrics)
    )
    let rendered = [
        StatsText.loading,
        StatsText.storeAbsent(dir: "/tmp/etat"),
        StatsText.noProject(dir: "/tmp/etat"),
        StatsText.empty,
        StatsText.hidden(0),
        StatsText.aggregate(label: "depot", totals: totals),
        StatsText.feature(slug: "statistiques", totals: totals),
        statsRunLine(run, nowMs: 2_000),
        statsRunLine(run, nowMs: 3_000),
        statsRunLine(
            RunStats(id: "b", sessionFile: "b", phase: .impl, isLive: false, metrics: .unreadable("session introuvable")),
            nowMs: 0
        ),
    ]
    for text in rendered {
        #expect(!text.contains("$"))
        #expect(!text.contains("€"))
        #expect(!text.contains("cost"))
    }
}
