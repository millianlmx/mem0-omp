// Les preuves de la règle d'AVANCEMENT des durées côté client (S-5, BR-3) : une
// durée reçue fait foi à l'instant de la réception, puis avance d'un milliseconde
// par milliseconde et par run VIVANT — sans un octet de trafic et sans horloge
// partagée avec le Mac.
//
// La règle vit dans `ConsoleClient` (extensions `totals(elapsedMs:)`), jamais dans
// une vue : cet ensemble la fige, et fige aussi le total du projet (AC-3) et la
// forme décodée du relevé.

@testable import ConsoleClient
import Foundation
import Testing

@Suite("Statistiques — avancement")
@MainActor
struct StatsAdvanceTests {
    private func feature(
        slug: String,
        input: Int = 0,
        output: Int = 0,
        cacheRead: Int? = nil,
        cacheWrite: Int? = nil,
        turns: Int = 0,
        durationMs: Double,
        liveRuns: Int,
        model: String? = nil
    ) -> RemoteStatsFeature {
        RemoteStatsFeature(
            slug: slug,
            input: input,
            output: output,
            cacheRead: cacheRead,
            cacheWrite: cacheWrite,
            turns: turns,
            durationMs: durationMs,
            liveRuns: liveRuns,
            model: model
        )
    }

    @Test("ios-statistiques/AC-6 : la durée avance d'un ms par ms et par run vivant, et ne bouge plus sans run vivant")
    func durationAdvancesWithLiveRunsOnly() {
        let live = feature(slug: "f", durationMs: 1_000, liveRuns: 2)
        // À l'instant de la réception, la durée est celle du relevé.
        #expect(live.totals(elapsedMs: 0).durationMs == 1_000)
        // Deux runs vivants, 3 000 ms plus tard : +6 000 ms.
        #expect(live.totals(elapsedMs: 3_000).durationMs == 1_000 + 6_000)

        // Aucun run vivant : un run clos se fige à sa dernière écriture.
        let closed = feature(slug: "f", durationMs: 1_000, liveRuns: 0)
        #expect(closed.totals(elapsedMs: 3_000).durationMs == 1_000)

        // Un temps écoulé négatif ou non fini ne fait reculer aucune durée.
        #expect(live.totals(elapsedMs: -5_000).durationMs == 1_000)
        #expect(live.totals(elapsedMs: .infinity).durationMs == 1_000)

        // Les tokens et les tours ne changent JAMAIS localement : ils ne bougent
        // qu'à l'écriture d'une session, donc à un relevé.
        let tokens = feature(slug: "f", input: 200, output: 40, turns: 2, durationMs: 1_000, liveRuns: 1)
        #expect(tokens.totals(elapsedMs: 60_000) == RemoteStatsTotals(input: 200, output: 40, turns: 2, durationMs: 61_000))
    }

    @Test("ios-statistiques/AC-3 : le total du projet est la somme des features listées, au même instant")
    func projectTotalSumsListedFeatures() {
        let payload = RemoteStatsPayload(
            projectKey: "k",
            project: "projet",
            projects: [RemoteStatsProject(key: "k", label: "projet")],
            features: [
                feature(slug: "f1", input: 100, output: 20, turns: 2, durationMs: 1_000, liveRuns: 1, model: "m"),
                feature(slug: "f2", input: 5, output: 1, turns: 1, durationMs: 500, liveRuns: 0),
            ],
            hiddenPlanFeatures: 3
        )

        // Au moment du relevé.
        #expect(payload.totals(elapsedMs: 0) == RemoteStatsTotals(input: 105, output: 21, turns: 3, durationMs: 1_500))
        // 2 000 ms plus tard : seul `f1` porte un run vivant, donc +2 000 ms.
        #expect(payload.totals(elapsedMs: 2_000) == RemoteStatsTotals(input: 105, output: 21, turns: 3, durationMs: 3_500))

        // Un relevé sans aucune feature listée ne totalise rien.
        let empty = RemoteStatsPayload(
            projectKey: "k",
            project: "projet",
            projects: [],
            features: [],
            hiddenPlanFeatures: 2
        )
        #expect(empty.totals(elapsedMs: 10_000) == .zero)
    }

    @Test("ios-statistiques/AC-1 : un relevé se décode dans son miroir, sans champ monétaire")
    func payloadDecodesWithoutMoney() throws {
        let json = """
        {
          "projectKey": "k",
          "project": "depot",
          "projects": [{"key": "k", "label": "depot"}],
          "features": [
            {"slug": "f1", "input": 200, "output": 40, "turns": 2, "durationMs": 1234.5, "liveRuns": 1,
             "model": "opencode-go/deepseek-v4.1-flash"}
          ],
          "hiddenPlanFeatures": 0
        }
        """
        let payload = try JSONDecoder().decode(RemoteStatsPayload.self, from: Data(json.utf8))
        #expect(payload.projectKey == "k")
        #expect(payload.projects == [RemoteStatsProject(key: "k", label: "depot")])
        #expect(payload.features.count == 1)
        #expect(payload.features[0].model == "opencode-go/deepseek-v4.1-flash")
        #expect(payload.features[0].liveRuns == 1)
        // Un Mac ANCIEN n'émet pas les clés de cache : ni erreur, ni valeur inventée.
        for decoded in payload.features {
            #expect(decoded.cacheRead == nil)
            #expect(decoded.cacheWrite == nil)
        }
        #expect(payload.hiddenPlanFeatures == 0)
        // Le modèle absent est un `nil`, jamais une chaîne vide.
        let withoutModel = try JSONDecoder().decode(
            RemoteStatsFeature.self,
            from: Data(#"{"slug":"f","input":0,"output":0,"turns":0,"durationMs":0,"liveRuns":0}"#.utf8)
        )
        #expect(withoutModel.model == nil)
    }

    @Test("ios-stats-tokens-envoyes-incoherent/AC-1, AC-2, AC-3 : « tokens envoyés » = entrée + cache lu + cache écrit")
    func sentCountsTheCache() {
        let cached = feature(
            slug: "f", input: 76, output: 40_233, cacheRead: 33_206, cacheWrite: 15_936, durationMs: 0, liveRuns: 0
        )
        #expect(cached.totals(elapsedMs: 0).sent == 49_218)

        // Le total du projet somme des entiers, jamais des chaînes compactes.
        let bare = feature(slug: "g", input: 5, durationMs: 0, liveRuns: 0)
        let payload = RemoteStatsPayload(
            projectKey: "k",
            project: "projet",
            projects: [],
            features: [cached, bare],
            hiddenPlanFeatures: 0
        )
        let total = payload.totals(elapsedMs: 0)
        #expect(total.sent == 49_223)
        #expect(total.sent == payload.features.reduce(0) { $0 + $1.totals(elapsedMs: 0).sent })
        #expect(total.sent == payload.totals(elapsedMs: 9_000).sent)

        // Mac ancien : cache absent ⇒ « envoyés » = entrée, jamais vide.
        #expect(bare.totals(elapsedMs: 0).sent == bare.input)
        #expect(RemoteStatsTotals.zero.sent == 0)
    }
}
