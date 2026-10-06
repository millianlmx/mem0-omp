// Preuve de S-10 (lecture seule) : AC-14 — la lecture des six stores ET une veille
// active ne créent, ne modifient ni ne suppriment AUCUN fichier du magasin.
//
// Le relevé avant/après porte sur les noms, la taille et la date de modification
// (doc §9) : c'est la seule mesure qui puisse contredire « aucune écriture ».

import Foundation
import Testing
@testable import OMPConsole
import ConsoleCore

@Test("client-magasin-etat/AC-14 : propriétaire mort et fichier tronqué — lecture et veille n'écrivent rien")
func readingAndWatchingNeverWriteToTheStore() async {
    // Trois stores existent, `audit/` est ABSENT : il doit le rester.
    let fixture = StoreFixture(stores: [.running, .history, .lots])
    let staleId = fixtureId(0x91)
    let truncatedId = fixtureId(0x92)
    fixture.publish(
        .running,
        "\(staleId).json",
        object: runningObject(
            id: staleId,
            cwd: "/tmp/worktree-mort",
            phaseStartedAt: fixtureT0 - 5_000,
            updatedAt: fixtureT0 - 1_000,
            ownerPid: Double(deadPid())
        )
    )
    fixture.put(.running, "\(truncatedId).json", text: "{\"version\":1,\"id\":\"tronq")
    let before = fixture.listing()
    let beforeAudit = FileManager.default.fileExists(atPath: fixture.directory(.audit))

    // Le magasin de référence : un propriétaire mort (jamais réconcilié) et un
    // fichier illisible (jamais « réparé »).
    let snapshot = StoreReader(stateDir: fixture.root, clock: fixtureClock).readAll()
    #expect(snapshot.running.entries.map(\.id) == [staleId])
    #expect(snapshot.running.entries.first?.isStale == true)
    #expect(snapshot.running.discarded == 1)
    #expect(snapshot.history.entries.isEmpty)
    #expect(snapshot.audit.availability == .absent)

    // La veille tourne pendant une publication et une suppression.
    let hub = StoreHub(stateDir: fixture.root, nowMs: { fixtureT0 })
    let seen = Recorder<StoreSnapshot>()
    let task = consume(hub.snapshots(), into: seen)
    defer {
        task.cancel()
        hub.stop()
    }
    #expect(await awaitTrue { seen.count >= 1 })

    let transientId = fixtureId(0x93)
    fixture.publish(
        .running,
        "\(transientId).json",
        object: runningObject(
            id: transientId,
            cwd: "/tmp/worktree-transitoire",
            phaseStartedAt: fixtureT0 - 4_000,
            updatedAt: fixtureT0 - 1_000,
            ownerPid: Double(getpid())
        )
    )
    #expect(await awaitTrue(timeout: 2.0) {
        seen.last?.running.entries.contains { $0.id == transientId } == true
    })
    fixture.remove(.running, "\(transientId).json")
    #expect(await awaitTrue(timeout: 2.0) {
        seen.last?.running.entries.contains { $0.id == transientId } == false
    })
    hub.stop()
    try? await Task.sleep(for: .milliseconds(50))

    // Liste ET dates inchangées : la couche n'a rien écrit.
    #expect(fixture.listing() == before)
    // Un magasin absent reste absent : aucun répertoire n'est créé.
    #expect(FileManager.default.fileExists(atPath: fixture.directory(.audit)) == beforeAudit)
    #expect(beforeAudit == false)
    // Le contenu illisible est resté illisible, l'entrée périmée est restée en place.
    #expect(fixture.contents(.running, "\(truncatedId).json") == "{\"version\":1,\"id\":\"tronq")
    #expect(fixture.names(.running) == ["\(staleId).json", "\(truncatedId).json"])
    #expect(fixture.names(.history).isEmpty)

    // Aucune API d'écriture n'existe dans la couche : la seule surface publique est
    // en lecture (`StoreReader`), plus la veille et ses flux.
    let second = StoreReader(stateDir: fixture.root, clock: fixtureClock).readAll()
    #expect(second == snapshot)
    #expect(fixture.listing() == before)
}
