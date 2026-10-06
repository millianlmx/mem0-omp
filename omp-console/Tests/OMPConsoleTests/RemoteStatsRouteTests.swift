// Les preuves de la route des STATISTIQUES (S-8) : l'état publié du modèle de la
// section, rien d'autre. L'API ne recalcule rien et ne relit aucun fichier.
//
// Le magasin et les sessions sont RÉELS (fixtures sous `NSTemporaryDirectory()`),
// le modèle est celui de la production et c'est son état publié que l'on compare.

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
    /// apparié : c'est la forme que `StatsModel` attend pour dresser un tableau.
    private static func publishRun(
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

    private static func makeRepo(_ fixture: StoreFixture) throws -> String {
        let root = joinPath(fixture.root, "depot")
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
        return root
    }

    /// Attend que le modèle publie un TABLEAU (le magasin est lu à `start()`).
    private static func board(_ model: StatsModel) async -> StatsBoard? {
        let ready = await awaitMainTrue {
            if case .board = model.state { return true }
            return false
        }
        guard ready, case .board(let board) = model.state else { return nil }
        return board
    }

    // MARK: - AC-7

    @Test("api-distante-du-console/AC-7 : l'appareil appairé obtient les statistiques de la coque")
    func statisticsOfTheConsole() async throws {
        let fixture = StoreFixture()
        let repoRoot = try Self.makeRepo(fixture)
        let sessionPath = joinPath(fixture.root, "session.jsonl")
        try Self.writeSession(sessionPath, lines: Self.sessionLines())
        Self.publishRun(fixture, seed: 10, repoRoot: repoRoot, worktree: repoRoot, sessionFile: sessionPath)

        let stack = try await RemoteStack.make(stateDir: fixture.root)
        defer { stack.stop() }
        let token = try await stack.pair()

        stack.stats.start()
        let board = try #require(await Self.board(stack.stats))

        let reply = try await stack.call("GET", "/v1/stats", token: token)
        #expect(reply.status == 200)
        let payload = try reply.json(RemoteStatsPayload.self)

        // Le MÊME libellé de projet que la coque (et celui du dépôt de la fixture).
        #expect(payload.project == board.project.label)
        #expect(payload.project == (repoRoot as NSString).lastPathComponent)

        // Les MÊMES lignes, mesurées sur la session réellement écrite.
        let expected = StatsPresentation.rows(board.project, nowMs: stack.clock.nowMs)
        #expect(payload.rows.map(\.id) == expected.map(\.id))
        let row = try #require(payload.rows.first { $0.id == sessionPath })
        #expect(row.turns == 2)
        #expect(row.tokens == 240)
        #expect(row.unreadableReason == nil)

        // `totals` = la somme des lignes rendues.
        #expect(payload.totals.turns == payload.rows.reduce(0) { $0 + $1.turns })
        #expect(payload.totals.input + payload.totals.output == payload.rows.reduce(0) { $0 + $1.tokens })
        #expect(payload.totals.turns == 2)
        #expect(payload.totals.durationMs >= 0)
        #expect(payload.truncated == false)
    }

    // MARK: - Complémentaires

    @Test func testLoadingIsUnavailable() async throws {
        let fixture = StoreFixture()
        let stack = try await RemoteStack.make(stateDir: fixture.root)
        defer { stack.stop() }
        let token = try await stack.pair()

        // Le modèle n'a JAMAIS été démarré : son état publié est `.loading`.
        let reply = try await stack.call("GET", "/v1/stats", token: token)
        #expect(reply.status == 503)
        #expect(reply.errorCode == "unavailable")
        #expect(reply.errorMessage == "les statistiques ne sont pas encore prêtes")
    }

    @Test func testNoProjectServesAnEmptyTable() async throws {
        let fixture = StoreFixture()
        let stack = try await RemoteStack.make(stateDir: fixture.root)
        defer { stack.stop() }
        let token = try await stack.pair()

        stack.stats.start()
        let noProject = await awaitMainTrue {
            if case .noProject = stack.stats.state { return true }
            return false
        }
        #expect(noProject)

        let reply = try await stack.call("GET", "/v1/stats", token: token)
        #expect(reply.status == 200)
        let payload = try reply.json(RemoteStatsPayload.self)
        #expect(payload.project == "")
        #expect(payload.rows.isEmpty)
        #expect(payload.totals.turns == 0)
        #expect(payload.totals.input == 0)
        #expect(payload.totals.output == 0)
    }

    @Test func testUnreadableRunKeepsItsReason() async throws {
        let fixture = StoreFixture()
        let repoRoot = try Self.makeRepo(fixture)
        let missing = joinPath(fixture.root, "sessions/absente.jsonl")
        let good = joinPath(fixture.root, "sessions/bonne.jsonl")
        try Self.writeSession(good, lines: Self.sessionLines())

        Self.publishRun(fixture, seed: 20, repoRoot: repoRoot, worktree: repoRoot, sessionFile: good)
        // Un SECOND run de la même feature, dont la session n'existe pas : sa ligne
        // garde son motif, et la feature reste listée grâce au run lisible.
        fixture.publish(
            .running,
            "\(fixtureId(23)).json",
            object: runningObject(
                id: fixtureId(23),
                cwd: repoRoot,
                phaseStartedAt: fixtureT0,
                updatedAt: fixtureT0,
                ownerPid: Double(getpid()),
                sessionFile: missing
            )
        )

        let stack = try await RemoteStack.make(stateDir: fixture.root)
        defer { stack.stop() }
        let token = try await stack.pair()

        stack.stats.start()
        #expect(await Self.board(stack.stats) != nil)

        let reply = try await stack.call("GET", "/v1/stats", token: token)
        #expect(reply.status == 200)
        let payload = try reply.json(RemoteStatsPayload.self)
        let unreadable = try #require(payload.rows.first { $0.id == missing })
        #expect(unreadable.unreadableReason != nil)
        let readable = try #require(payload.rows.first { $0.id == good })
        #expect(readable.unreadableReason == nil)
        #expect(readable.turns == 2)
    }
}
