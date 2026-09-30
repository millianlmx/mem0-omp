// Preuves de S-1 : la source unique de l'appariement run ↔ `sessionFile`.
//
// Les fixtures sont le VRAI magasin d'état sous `NSTemporaryDirectory()`
// (`StoreFixture`), jamais `~/.omp` : la lecture est celle de la production.

import Foundation
import Testing

@testable import OMPConsole

private let dedupSession =
    "/tmp/sessions/2026-09-28T15-07-55-136Z_01a0e88e-e980-4f5a-9d0d-2b0d2c0e9a11.jsonl"

private func runningEntry(
    _ fixture: StoreFixture,
    id: String,
    cwd: String,
    sessionFile: String?,
    updatedAt: Double = fixtureT0
) {
    fixture.publish(
        .running,
        "\(id).json",
        object: runningObject(
            id: id,
            cwd: cwd,
            phaseStartedAt: fixtureT0,
            updatedAt: updatedAt,
            ownerPid: Double(getpid()),
            sessionFile: sessionFile
        )
    )
}

// MARK: - AC-1

@Test("statistiques/AC-1 : storeRuns dédoublonne par sessionFile, le run vivant l'emporte sur son jumeau")
func storeRunsDeduplicatesBySessionFile() {
    let fixture = StoreFixture()
    let worktree = makeDirectory(fixture, "wt")
    runningEntry(fixture, id: fixtureId(0x11), cwd: worktree, sessionFile: dedupSession)
    fixture.publish(
        .history,
        "\(fixtureId(0x12)).json",
        object: historyObject(
            id: fixtureId(0x12),
            cwd: worktree,
            phaseStartedAt: fixtureT0,
            endedAt: fixtureT0,
            sessionFile: dedupSession
        )
    )

    let snapshot = StoreReader(stateDir: fixture.root, clock: fixtureClock).readAll()
    let runs = storeRuns(of: snapshot)
    #expect(runs.count == 1)
    #expect(runs[0].sessionFile == dedupSession)
    // L'entrée GAGNANTE est la première occurrence : `running/`.
    #expect(runs[0].live != nil)
    #expect(runs[0].finalState == nil)
    #expect(storeRunIsLive(runs[0]))

    // Un run sans `sessionFile` n'existe pas (rien à lire, rien à afficher).
    runningEntry(fixture, id: fixtureId(0x13), cwd: worktree, sessionFile: nil)
    let without = storeRuns(of: StoreReader(stateDir: fixture.root, clock: fixtureClock).readAll())
    #expect(without.count == 1)
}

@Test("statistiques/AC-1 : statsRuns filtre par worktree réel et écarte un worktree vide")
func statsRunsFilterByWorktree() {
    let fixture = StoreFixture()
    let first = makeDirectory(fixture, "wt-a")
    let second = makeDirectory(fixture, "wt-b")
    let firstSession = "/tmp/sessions/2026-09-28T10-00-00-000Z_aaaa1111.jsonl"
    let secondSession = "/tmp/sessions/2026-09-28T11-00-00-000Z_bbbb2222.jsonl"
    runningEntry(fixture, id: fixtureId(0x21), cwd: first, sessionFile: firstSession)
    runningEntry(fixture, id: fixtureId(0x22), cwd: second, sessionFile: secondSession)
    // cwd vide : présent dans `storeRuns`, jamais attribué à une feature.
    runningEntry(fixture, id: fixtureId(0x23), cwd: "", sessionFile: "/tmp/sessions/2026-09-28T12-00-00-000Z_cccc3333.jsonl")

    let snapshot = StoreReader(stateDir: fixture.root, clock: fixtureClock).readAll()
    #expect(storeRuns(of: snapshot).count == 3)
    #expect(statsRuns(of: snapshot, worktree: first).map(\.sessionFile) == [firstSession])
    #expect(statsRuns(of: snapshot, worktree: second).map(\.sessionFile) == [secondSession])
    #expect(statsRuns(of: snapshot, worktree: "").isEmpty)
}

@Test("statistiques/AC-1 : l'ordre des runs d'une feature suit le nom de session, chronologique")
func runOrderFollowsSessionName() {
    let fixture = StoreFixture()
    let worktree = makeDirectory(fixture, "wt")
    let older = "/tmp/sessions/2026-09-28T09-00-00-000Z_11111111.jsonl"
    let newer = "/tmp/sessions/2026-09-28T10-00-00-000Z_22222222.jsonl"
    // Publiés dans l'ordre inverse de leur horodatage.
    runningEntry(fixture, id: fixtureId(0x31), cwd: worktree, sessionFile: newer)
    runningEntry(fixture, id: fixtureId(0x32), cwd: worktree, sessionFile: older)

    let snapshot = StoreReader(stateDir: fixture.root, clock: fixtureClock).readAll()
    #expect(statsRuns(of: snapshot, worktree: worktree).map(\.sessionFile) == [older, newer])
}

// MARK: - AC-3

@Test("statistiques/AC-3 : « vivant » se décide par le pid, jamais par le badge isStale du magasin")
func livenessFollowsPidNotStaleness() {
    let fixture = StoreFixture()
    let worktree = makeDirectory(fixture, "wt")
    // `updatedAt` figé : avec une horloge avancée, l'entrée est marquée PÉRIMÉE…
    runningEntry(fixture, id: fixtureId(0x41), cwd: worktree, sessionFile: dedupSession)
    let clock = StoreClock { fixtureT0 + 1_000_000 }
    let snapshot = StoreReader(stateDir: fixture.root, clock: clock).readAll()
    #expect(snapshot.running.entries[0].isStale)
    // …et pourtant le pid du processus de test VIT : le run est vivant.
    let run = storeRuns(of: snapshot)[0]
    #expect(storeRunIsLive(run))

    // Un pid mort rend le run non vivant, même frais.
    fixture.remove(.running, "\(fixtureId(0x41)).json")
    fixture.publish(
        .running,
        "\(fixtureId(0x42)).json",
        object: runningObject(
            id: fixtureId(0x42),
            cwd: worktree,
            phaseStartedAt: fixtureT0,
            updatedAt: fixtureT0,
            ownerPid: Double(deadPid()),
            sessionFile: dedupSession
        )
    )
    let dead = storeRuns(of: StoreReader(stateDir: fixture.root, clock: fixtureClock).readAll())[0]
    #expect(storeRunIsLive(dead) == false)
}
