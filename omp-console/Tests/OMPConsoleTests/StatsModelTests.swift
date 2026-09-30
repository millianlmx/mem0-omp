// Preuves de S-6 : mise à jour en direct, veilles et lecteurs.
//
// Le magasin et les sessions sont RÉELS (fixtures sous `NSTemporaryDirectory()`),
// la veille est celle de la production : un ajout d'octets dans la session doit
// faire monter la ligne du run sans geste de l'utilisateur.

import Foundation
import Testing

@testable import OMPConsole

// MARK: - Fixtures

private func sessionFixture(_ name: String) throws -> ViewerSessionFixture {
    let fixture = try ViewerSessionFixture(fileName: name)
    try fixture.write([
        ViewerLines.header(),
        ViewerLines.user("prompt du pipeline"),
    ])
    return fixture
}

/// Publie un projet (une feature), son lot (le worktree) et le run correspondant.
/// Les noms de fichiers sont `<16 hex>.json` : le seul nom qu'un store plat lit.
private func publishShop(
    _ fixture: StoreFixture,
    seed: Int,
    suffix: String,
    repoRoot: String,
    worktree: String,
    sessionFile: String,
    live: Bool
) {
    let key = KanbanRepoKey.key(forRoot: repoRoot)
    fixture.publish(
        .projects,
        "\(fixtureId(seed)).json",
        object: projectObject(
            repoKey: key,
            repoRoot: repoRoot,
            segments: [[
                "name": "Segment",
                "features": [projectFeatureObject(slug: "feature-\(suffix)", status: "launched")],
            ]],
            current: 0
        )
    )
    fixture.publish(
        .lots,
        "\(fixtureId(seed + 1)).json",
        object: lotObject(
            repoRoot: repoRoot,
            features: [lotFeatureObject(slug: "feature-\(suffix)", worktree: worktree)]
        )
    )
    if live {
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
    } else {
        fixture.publish(
            .history,
            "\(fixtureId(seed + 3)).json",
            object: historyObject(
                id: fixtureId(seed + 3),
                cwd: worktree,
                phaseStartedAt: fixtureT0,
                endedAt: fixtureT0,
                sessionFile: sessionFile
            )
        )
    }
}

@MainActor
private func firstRun(_ model: StatsModel) -> RunStats? {
    guard case .board(let board) = model.state else { return nil }
    return board.project.features.first?.runs.first
}

// MARK: - AC-3

@Test("statistiques/AC-3 : les tokens d'un run vivant montent seuls à l'écriture dans la session")
@MainActor
func liveRunTokensRiseWithoutGesture() async throws {
    let fixture = StoreFixture()
    let repo = makeDirectory(fixture, "repo")
    let worktree = makeDirectory(fixture, "wt")
    let session = try sessionFixture("2026-09-30T08-00-00-000Z_live0001.jsonl")
    defer { session.remove() }
    publishShop(fixture, seed: 0x200, suffix: "live", repoRoot: repo, worktree: worktree, sessionFile: session.path, live: true)

    let model = StatsModel(stateDir: fixture.root)
    defer { model.stop() }
    model.start()

    #expect(await awaitViewer { firstRun(model) != nil })
    guard case .measured(let initial)? = firstRun(model)?.metrics else {
        Issue.record("le run doit être mesuré")
        return
    }
    #expect(initial.input == 0)
    #expect(initial.turns == 1)
    // Un run vivant : une veille est armée sur SA session.
    #expect(model.watchedSessionFiles == [session.path])

    // Une entrée assistant avec usage écrite dans la session…
    try session.append([
        ViewerLines.json([
            "type": "message",
            "id": "e9",
            "parentId": NSNull(),
            "timestamp": "2026-09-30T08:00:05.000Z",
            "message": [
                "role": "assistant",
                "model": "opencode-go/deepseek-v4.1-flash",
                "content": [["type": "text", "text": "réponse"]],
                "usage": ["input": 120, "output": 30, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 150],
            ],
        ])
    ])
    // …doit faire monter la ligne SANS geste.
    #expect(await awaitViewer {
        if case .measured(let metrics)? = firstRun(model)?.metrics {
            return metrics.input == 120 && metrics.output == 30
        }
        return false
    })
}

@Test("statistiques/AC-3 : un run clos n'ouvre aucune veille, mais reste mesuré")
@MainActor
func closedRunOpensNoWatch() async throws {
    let fixture = StoreFixture()
    let repo = makeDirectory(fixture, "repo")
    let worktree = makeDirectory(fixture, "wt")
    let session = try sessionFixture("2026-09-30T08-00-00-000Z_closed01.jsonl")
    defer { session.remove() }
    publishShop(fixture, seed: 0x210, suffix: "closed", repoRoot: repo, worktree: worktree, sessionFile: session.path, live: false)

    let model = StatsModel(stateDir: fixture.root)
    defer { model.stop() }
    model.start()

    #expect(await awaitViewer { firstRun(model) != nil })
    #expect(firstRun(model)?.isLive == false)
    #expect(model.activeWatchCount == 0)
}

@Test("statistiques/AC-3 : changer de projet libère les veilles de l'ancien")
@MainActor
func switchingProjectReleasesTheOldWatches() async throws {
    let fixture = StoreFixture()
    let firstRepo = makeDirectory(fixture, "repo-a")
    let secondRepo = makeDirectory(fixture, "repo-b")
    let firstTree = makeDirectory(fixture, "wt-a")
    let secondTree = makeDirectory(fixture, "wt-b")
    let firstSession = try sessionFixture("2026-09-30T08-00-00-000Z_first001.jsonl")
    let secondSession = try sessionFixture("2026-09-30T08-00-00-000Z_second01.jsonl")
    defer {
        firstSession.remove()
        secondSession.remove()
    }
    publishShop(fixture, seed: 0x220, suffix: "a", repoRoot: firstRepo, worktree: firstTree, sessionFile: firstSession.path, live: true)
    publishShop(fixture, seed: 0x230, suffix: "b", repoRoot: secondRepo, worktree: secondTree, sessionFile: secondSession.path, live: true)

    let model = StatsModel(stateDir: fixture.root)
    defer { model.stop() }
    model.start()

    #expect(await awaitViewer { model.activeWatchCount == 1 })
    // `projectOrder` : `repo-a` avant `repo-b`.
    #expect(model.watchedSessionFiles == [firstSession.path])

    model.selectProject(KanbanRepoKey.key(forRoot: secondRepo))
    #expect(await awaitViewer { model.watchedSessionFiles == [secondSession.path] })
    #expect(model.activeWatchCount == 1)
}

@Test("statistiques/AC-3 : `stop()` arrête le hub, les veilles et les tâches")
@MainActor
func stopReleasesEverything() async throws {
    let fixture = StoreFixture()
    let repo = makeDirectory(fixture, "repo")
    let worktree = makeDirectory(fixture, "wt")
    let session = try sessionFixture("2026-09-30T08-00-00-000Z_stop0001.jsonl")
    defer { session.remove() }
    publishShop(fixture, seed: 0x240, suffix: "stop", repoRoot: repo, worktree: worktree, sessionFile: session.path, live: true)

    let model = StatsModel(stateDir: fixture.root)
    model.start()
    #expect(await awaitViewer { model.activeWatchCount == 1 })
    model.stop()
    #expect(model.activeWatchCount == 0)
    #expect(model.watchedSessionFiles.isEmpty)
}

// MARK: - AC-2

@Test("statistiques/AC-2 : l'agrégat d'un run vivant avance de 1000 ms quand `nowMs` avance de 1000 ms")
@MainActor
func liveAggregateAdvancesWithTime() async throws {
    let fixture = StoreFixture()
    let repo = makeDirectory(fixture, "repo")
    let worktree = makeDirectory(fixture, "wt")
    let session = try sessionFixture("2026-09-30T08-00-00-000Z_time0001.jsonl")
    defer { session.remove() }
    publishShop(fixture, seed: 0x250, suffix: "time", repoRoot: repo, worktree: worktree, sessionFile: session.path, live: true)

    let model = StatsModel(stateDir: fixture.root)
    defer { model.stop() }
    model.start()
    #expect(await awaitViewer { firstRun(model) != nil })
    guard case .board(let board) = model.state, let run = firstRun(model) else {
        Issue.record("le tableau doit être publié")
        return
    }
    guard case .measured(let metrics) = run.metrics, let first = metrics.firstMs else {
        Issue.record("le run doit porter un horodatage")
        return
    }

    let before = projectTotals(board.project, nowMs: first + 1_000).durationMs
    let after = projectTotals(board.project, nowMs: first + 2_000).durationMs
    #expect(after - before == 1_000)
}
