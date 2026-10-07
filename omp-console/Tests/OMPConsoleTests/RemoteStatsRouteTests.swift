// Les preuves de la route des STATISTIQUES (S-1, S-2) : le tableau du projet
// DEMANDÉ, dérivé par les mêmes fonctions pures que la fenêtre macOS.
//
// Le magasin et les sessions sont RÉELS (fixtures sous `NSTemporaryDirectory()`),
// l'horloge est INJECTÉE (`RemoteClock`) et la charge utile est confrontée à
// `featureTotals` du tableau publié par un `StatsModel` sur le MÊME magasin, au
// MÊME instant : c'est la parité de la fenêtre Statistiques macOS (AC-4).

import ConsoleCore
import Foundation
import Testing

@testable import OMPConsole

@Suite("Remote statistiques")
@MainActor
struct RemoteStatsRouteTests {

    // MARK: - Outillage

    private static func writeSession(_ path: String, lines: [String]) throws {
        try FileManager.default.createDirectory(
            atPath: (path as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true
        )
        try Data((lines.joined(separator: "\n") + "\n").utf8).write(to: URL(fileURLWithPath: path))
    }

    /// Une réponse assistant PORTANT un usage : deux d'entre elles font 200 d'entrée,
    /// 40 de sortie, sur deux tours (deux `user`).
    private static func usageAssistant(_ id: String) -> String {
        ViewerLines.json([
            "type": "message",
            "id": id,
            "parentId": "u1",
            "timestamp": ViewerLines.stamp,
            "message": [
                "role": "assistant",
                "model": "opencode-go/deepseek-v4.1-flash",
                "usage": [
                    "input": 100, "output": 20, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 120,
                ],
                "content": [["type": "text", "text": "réponse"]],
            ],
        ])
    }

    private static func sessionLines() -> [String] {
        [
            ViewerLines.header(id: "session-1"),
            ViewerLines.user("premier prompt", id: "u1"),
            usageAssistant("a1"),
            ViewerLines.user("second prompt", id: "u2"),
            usageAssistant("a2"),
        ]
    }

    /// Publie un projet (une feature), son lot (le worktree) et un run `running/`
    /// apparié : c'est la forme que la dérivation attend pour dresser un tableau.
    private static func publishFeature(
        _ fixture: StoreFixture,
        seed: Int,
        repoRoot: String,
        worktree: String,
        sessionFile: String,
        slug: String = "feature-a"
    ) {
        let key = ProjectPaths.key(forRoot: repoRoot)
        fixture.publish(
            .projects,
            "\(fixtureId(seed)).json",
            object: projectObject(
                repoKey: key,
                repoRoot: repoRoot,
                segments: [[
                    "name": "Segment",
                    "features": [projectFeatureObject(slug: slug)],
                ]],
                current: 0
            )
        )
        fixture.publish(
            .lots,
            "\(fixtureId(seed + 1)).json",
            object: lotObject(
                repoRoot: repoRoot,
                features: [lotFeatureObject(slug: slug, worktree: worktree)]
            )
        )
        fixture.publish(
            .running,
            "\(fixtureId(seed + 2)).json",
            object: runningObject(
                id: fixtureId(seed + 2),
                cwd: worktree,
                phaseStartedAt: fixtureT0,
                updatedAt: fixtureT0,
                ownerPid: Double(getpid()),
                sessionFile: sessionFile
            )
        )
    }

    private static func makeRepo(_ fixture: StoreFixture, _ name: String) throws -> String {
        let root = joinPath(fixture.root, name)
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
        return root
    }

    /// Attend que le modèle macOS publie un TABLEAU (le magasin est lu à `start()`).
    private static func board(_ model: StatsModel) async -> StatsBoard? {
        let ready = await awaitMainTrue {
            if case .board = model.state { return true }
            return false
        }
        guard ready, case .board(let board) = model.state else { return nil }
        return board
    }

    // MARK: - AC-1 : le tableau du projet demandé, par feature

    @Test("ios-statistiques/AC-1, AC-2 : la route sert le tableau du projet demandé, une entrée par feature")
    func servesTheRequestedProject() async throws {
        let fixture = StoreFixture()
        let repoRoot = try Self.makeRepo(fixture, "depot")
        let sessionPath = joinPath(fixture.root, "session.jsonl")
        try Self.writeSession(sessionPath, lines: Self.sessionLines())
        Self.publishFeature(fixture, seed: 10, repoRoot: repoRoot, worktree: repoRoot, sessionFile: sessionPath)

        let stack = try await RemoteStack.make(stateDir: fixture.root)
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/stats", token: token)
        #expect(reply.status == 200)
        let payload = try reply.json(RemoteStatsPayload.self)

        // Le profil du projet : sa clé et son libellé de sélecteur, jamais un chemin.
        #expect(payload.projectKey == ProjectPaths.key(forRoot: repoRoot))
        #expect(payload.project == (repoRoot as NSString).lastPathComponent)
        #expect(payload.projects.map(\.label) == [payload.project])
        #expect(payload.projects.map(\.key) == [payload.projectKey])

        // Une entrée par feature LISTÉE, mesurée sur la session réellement écrite :
        // 2 tours (deux `user`), 200 d'entrée, 40 de sortie.
        let feature = try #require(payload.features.first)
        #expect(payload.features.count == 1)
        #expect(feature.slug == "feature-a")
        #expect(feature.turns == 2)
        #expect(feature.input == 200)
        #expect(feature.output == 40)
        #expect(feature.model == "opencode-go/deepseek-v4.1-flash")
        #expect(feature.liveRuns == 1)
        #expect(feature.durationMs >= 0)
        #expect(payload.hiddenPlanFeatures == 0)
    }

    // MARK: - AC-3 : le total du projet, somme des features servies

    @Test("ios-statistiques/AC-3 : la charge utile ne porte que des features, leur somme est le total")
    func servedFeaturesCarryTheirOwnTotals() async throws {
        let fixture = StoreFixture()
        let repoRoot = try Self.makeRepo(fixture, "depot")
        let sessionPath = joinPath(fixture.root, "session.jsonl")
        try Self.writeSession(sessionPath, lines: Self.sessionLines())
        Self.publishFeature(fixture, seed: 10, repoRoot: repoRoot, worktree: repoRoot, sessionFile: sessionPath)

        let stack = try await RemoteStack.make(stateDir: fixture.root)
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/stats", token: token)
        let payload = try reply.json(RemoteStatsPayload.self)
        // Rien d'autre que des features ne porte de totaux : le client somme les
        // features LISTÉES (AC-3) — aucun agrégat servi en plus.
        #expect(payload.features.reduce(0) { $0 + $1.turns } == 2)
        #expect(payload.features.reduce(0) { $0 + $1.input } == 200)
        #expect(payload.features.reduce(0) { $0 + $1.output } == 40)
    }

    // MARK: - AC-5 : une feature sans run lisible est comptée masquée

    @Test("ios-statistiques/AC-5 : une feature sans run lisible est comptée masquée, jamais servie à zéro")
    func hiddenPlanFeatureIsCounted() async throws {
        let fixture = StoreFixture()
        let repoRoot = try Self.makeRepo(fixture, "depot")
        let worktreeA = try Self.makeRepo(fixture, "depot/wt-a")
        let worktreeB = try Self.makeRepo(fixture, "depot/wt-b")
        let good = joinPath(fixture.root, "sessions/bonne.jsonl")
        let missing = joinPath(fixture.root, "sessions/absente.jsonl")
        try Self.writeSession(good, lines: Self.sessionLines())

        // Le plan porte DEUX features, chacune dans son worktree : l'une avec un run
        // lisible, l'autre dont le seul run n'a pas de session écrite.
        let key = ProjectPaths.key(forRoot: repoRoot)
        fixture.publish(
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
        fixture.publish(
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
        fixture.publish(
            .running,
            "\(fixtureId(12)).json",
            object: runningObject(
                id: fixtureId(12),
                cwd: worktreeA,
                phaseStartedAt: fixtureT0,
                updatedAt: fixtureT0,
                ownerPid: Double(getpid()),
                sessionFile: good
            )
        )
        fixture.publish(
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

        let stack = try await RemoteStack.make(stateDir: fixture.root)
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/stats", token: token)
        #expect(reply.status == 200)
        let payload = try reply.json(RemoteStatsPayload.self)
        #expect(payload.features.map(\.slug) == ["feature-a"])
        #expect(payload.hiddenPlanFeatures == 1)
        // Le run illisible n'entre dans AUCUNE somme (S-2).
        #expect(payload.features.reduce(0) { $0 + $1.turns } == 2)
    }

    // MARK: - AC-4 : parité avec le tableau publié par la fenêtre macOS

    @Test("ios-statistiques/AC-4 : chaque feature servie égale le tableau de StatsModel, au même instant")
    func parityWithTheMacWindow() async throws {
        let fixture = StoreFixture()
        let repoRoot = try Self.makeRepo(fixture, "depot")
        let sessionPath = joinPath(fixture.root, "session.jsonl")
        try Self.writeSession(sessionPath, lines: Self.sessionLines())
        Self.publishFeature(fixture, seed: 10, repoRoot: repoRoot, worktree: repoRoot, sessionFile: sessionPath)

        let stack = try await RemoteStack.make(stateDir: fixture.root)
        defer { stack.stop() }
        let token = try await stack.pair()

        // Le MÊME magasin, la MÊME horloge injectée : la fenêtre macOS d'un côté,
        // la route de l'autre.
        stack.stats.start()
        let board = try #require(await Self.board(stack.stats))
        let nowMs = stack.clock.nowMs

        let reply = try await stack.call("GET", "/v1/stats", token: token)
        #expect(reply.status == 200)
        let payload = try reply.json(RemoteStatsPayload.self)

        #expect(payload.projectKey == board.project.repoKey)
        #expect(payload.project == board.project.label)
        #expect(payload.hiddenPlanFeatures == board.project.hiddenPlanFeatures)
        #expect(payload.features.map(\.slug) == board.project.features.map(\.slug))
        for feature in payload.features {
            let expected = try #require(board.project.features.first { $0.slug == feature.slug })
            let totals = featureTotals(expected, nowMs: nowMs)
            #expect(feature.input == totals.input)
            #expect(feature.output == totals.output)
            #expect(feature.turns == totals.turns)
            #expect(feature.durationMs == totals.durationMs)
            #expect(feature.liveRuns == featureLiveRuns(expected))
            #expect(feature.model == featureModel(expected))
        }
    }

    // MARK: - Sélection de projet et repli

    @Test("ios-statistiques/AC-1 : `?project=<clé>` choisit le projet, une clé inconnue retombe sur le premier")
    func selectingAProjectFallsBackToTheFirst() async throws {
        let fixture = StoreFixture()
        let repoA = try Self.makeRepo(fixture, "depotA")
        let repoB = try Self.makeRepo(fixture, "depotB")
        let sessionA = joinPath(fixture.root, "a.jsonl")
        let sessionB = joinPath(fixture.root, "b.jsonl")
        try Self.writeSession(sessionA, lines: Self.sessionLines())
        try Self.writeSession(sessionB, lines: Self.sessionLines())
        Self.publishFeature(fixture, seed: 10, repoRoot: repoA, worktree: repoA, sessionFile: sessionA, slug: "feature-a")
        Self.publishFeature(fixture, seed: 20, repoRoot: repoB, worktree: repoB, sessionFile: sessionB, slug: "feature-b")

        let stack = try await RemoteStack.make(stateDir: fixture.root)
        defer { stack.stop() }
        let token = try await stack.pair()
        let keyA = ProjectPaths.key(forRoot: repoA)
        let keyB = ProjectPaths.key(forRoot: repoB)

        // Sans paramètre : le PREMIER projet de l'ordre (`repoRoot` croissant).
        let first = try await stack.call("GET", "/v1/stats", token: token)
        let defaultPayload = try first.json(RemoteStatsPayload.self)
        #expect(defaultPayload.projectKey == keyA)
        #expect(defaultPayload.projects.map(\.key) == [keyA, keyB])

        // Le projet B demandé : c'est lui qui est servi, et TOUS les projets restent
        // annoncés (le sélecteur ne perd pas une option).
        let second = try await stack.call("GET", "/v1/stats?project=\(keyB)", token: token)
        let chosen = try second.json(RemoteStatsPayload.self)
        #expect(chosen.projectKey == keyB)
        #expect(chosen.features.map(\.slug) == ["feature-b"])
        #expect(chosen.projects.map(\.key) == [keyA, keyB])

        // Une clé qui ne désigne plus aucun projet : repli sur le premier, jamais
        // une erreur, et `projectKey` porte la clé RÉELLEMENT servie.
        let unknown = try await stack.call("GET", "/v1/stats?project=inconnue", token: token)
        #expect(unknown.status == 200)
        let fallback = try unknown.json(RemoteStatsPayload.self)
        #expect(fallback.projectKey == keyA)
        #expect(fallback.features.map(\.slug) == ["feature-a"])
    }

    @Test("ios-statistiques/AC-1 : un magasin sans projet sert une charge utile nulle, jamais une erreur")
    func emptyStoreServesAnEmptyPayload() async throws {
        let fixture = StoreFixture()
        let stack = try await RemoteStack.make(stateDir: fixture.root)
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/stats", token: token)
        #expect(reply.status == 200)
        let payload = try reply.json(RemoteStatsPayload.self)
        #expect(payload.projectKey == nil)
        #expect(payload.project == "")
        #expect(payload.projects.isEmpty)
        #expect(payload.features.isEmpty)
        #expect(payload.hiddenPlanFeatures == 0)
    }

    // MARK: - AC-7 : aucun champ monétaire

    @Test("ios-statistiques/AC-7 : la charge utile ne porte aucun champ monétaire")
    func payloadCarriesNoMoney() async throws {
        let fixture = StoreFixture()
        let repoRoot = try Self.makeRepo(fixture, "depot")
        let sessionPath = joinPath(fixture.root, "session.jsonl")
        try Self.writeSession(sessionPath, lines: Self.sessionLines())
        Self.publishFeature(fixture, seed: 10, repoRoot: repoRoot, worktree: repoRoot, sessionFile: sessionPath)

        let stack = try await RemoteStack.make(stateDir: fixture.root)
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/stats", token: token)
        let text = reply.text.lowercased()
        for token in ["cost", "montant", "dollar", "prix", "usd", "€", "$"] {
            #expect(!text.contains(token), "la charge utile porte « \(token) »")
        }
    }
}
