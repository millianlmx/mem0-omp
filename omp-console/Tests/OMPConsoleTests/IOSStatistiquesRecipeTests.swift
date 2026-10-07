// La recette OUTILLÉE de la feature ios-statistiques (BR-5) : lire le tableau d'un
// projet DEPUIS LE CLIENT iOS, contre une coque réelle (pile locale sur un port
// éphémère, vraies routes, vrai registre, vrai flux) et le MÊME magasin que la
// fenêtre macOS.
//
// Elle est GATED par `MEM0_REMOTE_RECIPE=1` (patron `iosProjetRecipe` de
// `ProjectIOSRecipeTests.swift`) : sans la variable, elle rend la main sans rien
// éprouver — le rejeu MANUEL de la recette pas à pas reste la preuve d'écran, il
// est documenté dans `omp-console/README.md` § Coque iOS. Son nom de fonction est
// ce que `swift test --filter iosStatistiquesRecipe` cible.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

/// Découverte muette : le client se connecte par l'adresse manuelle, jamais par
/// Bonjour (ce que la recette n'éprouve pas).
@MainActor
private final class StatsRecipeDiscovery: DiscoverySource {
    var onChange: (([DiscoveredMac]) -> Void)?
    var onProtocolVersion: ((Int) -> Void)?
    var onDenied: ((Bool) -> Void)?
    func start(serviceType: String) {}
    func stop() {}
}

@MainActor
private final class StatsRecipePath: ClientPathSource {
    var onChange: ((Bool) -> Void)?
    func start() {}
    func stop() {}
}

@MainActor
@Suite("Recette ios-statistiques (coque réelle)")
struct IOSStatistiquesRecipeTests {
    @Test("ios-statistiques/AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7 : recette réelle — le relevé d'un projet lu depuis l'iPad")
    func iosStatistiquesRecipe() async throws {
        guard ProcessInfo.processInfo.environment["MEM0_REMOTE_RECIPE"] == "1" else { return }

        // Un magasin réel : un projet, deux features (l'une vivante, l'autre sans
        // session écrite), des sessions RÉELLES sur le disque.
        let store = StoreFixture()
        let repoRoot = joinPath(store.root, "depot")
        try FileManager.default.createDirectory(atPath: repoRoot, withIntermediateDirectories: true)
        let worktreeA = joinPath(repoRoot, "wt-a")
        let worktreeB = joinPath(repoRoot, "wt-b")
        for path in [worktreeA, worktreeB] {
            try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        }
        let session = joinPath(store.root, "sessions/vivante.jsonl")
        let missing = joinPath(store.root, "sessions/absente.jsonl")
        try FileManager.default.createDirectory(
            atPath: (session as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true
        )
        let assistant = ViewerLines.json([
            "type": "message",
            "id": "a1",
            "parentId": "u1",
            "timestamp": ViewerLines.stamp,
            "message": [
                "role": "assistant",
                "model": "opencode-go/deepseek-v4.1-flash",
                "usage": ["input": 100, "output": 20, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 120],
                "content": [["type": "text", "text": "réponse"]],
            ],
        ])
        try Data(([
            ViewerLines.header(id: "session-1"),
            ViewerLines.user("premier prompt", id: "u1"),
            assistant,
            ViewerLines.user("second prompt", id: "u2"),
            assistant,
        ].joined(separator: "\n") + "\n").utf8).write(to: URL(fileURLWithPath: session))

        let key = ProjectPaths.key(forRoot: repoRoot)
        store.publish(
            .projects,
            "\(fixtureId(10)).json",
            object: projectObject(
                repoKey: key,
                repoRoot: repoRoot,
                segments: [[
                    "name": "Segment",
                    "features": [projectFeatureObject(slug: "feature-a"), projectFeatureObject(slug: "feature-b")],
                ]],
                current: 0
            )
        )
        store.publish(
            .lots,
            "\(fixtureId(11)).json",
            object: lotObject(
                repoRoot: repoRoot,
                features: [
                    lotFeatureObject(slug: "feature-a", worktree: worktreeA),
                    lotFeatureObject(slug: "feature-b", worktree: worktreeB),
                ]
            )
        )
        store.publish(
            .running,
            "\(fixtureId(12)).json",
            object: runningObject(
                id: fixtureId(12),
                cwd: worktreeA,
                phaseStartedAt: fixtureT0,
                updatedAt: fixtureT0,
                ownerPid: Double(getpid()),
                sessionFile: session
            )
        )
        store.publish(
            .running,
            "\(fixtureId(13)).json",
            object: runningObject(
                id: fixtureId(13),
                cwd: worktreeB,
                phaseStartedAt: fixtureT0,
                updatedAt: fixtureT0,
                ownerPid: Double(getpid()),
                sessionFile: missing
            )
        )

        let stack = try await RemoteStack.make(stateDir: store.root)
        defer { stack.stop() }

        // Le client iOS réel, branché sur l'adresse manuelle de la pile.
        let client = ConsoleClientModel(
            transport: URLSessionTransport(),
            discovery: StatsRecipeDiscovery(),
            preferences: InMemoryClientPreferences(),
            tokens: InMemoryTokenStore(),
            pacer: LiveClientPacer(),
            pathSource: StatsRecipePath()
        )
        defer { client.stop() }
        client.start()
        _ = client.setManualAddress("127.0.0.1:\(stack.port)")
        let code = try stack.registry.generateCode()
        try await client.pair(code: code.value, deviceName: "Recette iPad")

        // AC-1 : le premier relevé (sans paramètre) sert le projet et ses features.
        let payload = try await client.statistics()
        #expect(payload.projectKey == key)
        #expect(payload.projects.map(\.key) == [key])
        let feature = try #require(payload.features.first { $0.slug == "feature-a" })
        #expect(feature.turns == 2)
        #expect(feature.input == 200)
        #expect(feature.output == 40)
        #expect(feature.model == "opencode-go/deepseek-v4.1-flash")
        #expect(feature.durationMs >= 0)

        // AC-2 : les totaux de la feature égaux à ceux de sa session, relus par la
        // coque (aucun run illisible n'y entre).
        let reader = SessionReader(path: session)
        _ = reader.read()
        let expected = sessionMetrics(reader.conversation)
        #expect(feature.input == expected.input)
        #expect(feature.output == expected.output)
        #expect(feature.turns == expected.turns)

        // AC-3 : le total du projet est la somme des features LISTÉES.
        let total = payload.totals(elapsedMs: 0)
        #expect(total.input == payload.features.reduce(0) { $0 + $1.input })
        #expect(total.output == payload.features.reduce(0) { $0 + $1.output })
        #expect(total.turns == payload.features.reduce(0) { $0 + $1.turns })

        // AC-4 : parité avec le tableau publié par la fenêtre macOS, au même instant.
        stack.stats.start()
        let ready = await awaitMainTrue {
            if case .board = stack.stats.state { return true }
            return false
        }
        #expect(ready)
        if case .board(let board) = stack.stats.state {
            for served in payload.features {
                let macFeature = try #require(board.project.features.first { $0.slug == served.slug })
                let macTotals = featureTotals(macFeature, nowMs: stack.clock.nowMs)
                #expect(served.input == macTotals.input)
                #expect(served.output == macTotals.output)
                #expect(served.turns == macTotals.turns)
                #expect(served.liveRuns == featureLiveRuns(macFeature))
                #expect(served.model == featureModel(macFeature))
            }
            #expect(payload.hiddenPlanFeatures == board.project.hiddenPlanFeatures)
        }

        // AC-5 : la feature sans session lisible n'est pas servie à zéro, elle est
        // comptée masquée (et sa mention est ce que la section iOS affiche).
        #expect(payload.features.map(\.slug) == ["feature-a"])
        #expect(payload.hiddenPlanFeatures == 1)
        #expect(StatsPresentation.hidden(payload.hiddenPlanFeatures) == "1 feature du plan sans données")

        // AC-6 : la durée d'un run VIVANT avance entre deux instants espacés, sans
        // un octet de trafic ; celle d'un run clos ne bouge pas.
        let live = try #require(payload.features.first { $0.liveRuns > 0 })
        let later = live.totals(elapsedMs: 5_000)
        #expect(later.durationMs == live.totals(elapsedMs: 0).durationMs + Double(live.liveRuns) * 5_000)
        #expect(later.turns == live.turns)
        #expect(later.input == live.input)

        // AC-7 : aucun montant dans la charge utile ni dans ce que la section relit.
        let body = try HTTPJSON.encode(payload)
        let text = String(decoding: body, as: UTF8.self).lowercased()
        for token in ["cost", "montant", "dollar", "prix", "usd"] {
            #expect(!text.contains(token), "la charge utile porte « \(token) »")
        }
    }
}
