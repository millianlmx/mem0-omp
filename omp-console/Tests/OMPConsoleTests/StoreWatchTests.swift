// Preuves de S-9 (veille par notification, flux d'instantanés) : AC-12 et AC-13.
//
// Le consommateur est UNIQUE et de longue durée (doc §5) : une `Task` avec `for await`
// par flux. Une suite d'appels à échéance sur un même flux tuerait le flux à la
// première annulation, et une scrutation du test ne prouverait pas la poussée.

import Foundation
import Testing
@testable import OMPConsole

/// La veille du store `running` sur une fixture, horloge fixe.
private func runningWatcher(_ fixture: StoreFixture) -> StoreWatcher<RunningEnvelope> {
    StoreWatcher(store: .running, stateDir: fixture.root, nowMs: { fixtureT0 }) { dir, clock in
        StoreReader(stateDir: dir, clock: clock).readRunning()
    }
}

/// Une entrée `running` valide sur une fixture (pid vivant, battement frais).
private func publishRunning(_ fixture: StoreFixture, id: String, cwd: String) {
    fixture.publish(
        .running,
        "\(id).json",
        object: runningObject(
            id: id,
            cwd: cwd,
            phaseStartedAt: fixtureT0 - 5_000,
            updatedAt: fixtureT0 - 1_000,
            ownerPid: Double(getpid())
        )
    )
}

@Test("client-magasin-etat/AC-12 : publication et suppression sont poussées au flux du store ET au flux global")
func watchPushesChanges() async {
    let fixture = StoreFixture()
    let kept = fixtureId(0x12)
    let removed = fixtureId(0x13)
    let published = fixtureId(0x14)
    publishRunning(fixture, id: kept, cwd: "/tmp/kept")
    publishRunning(fixture, id: removed, cwd: "/tmp/removed")

    let watcher = runningWatcher(fixture)
    let hub = StoreHub(stateDir: fixture.root, nowMs: { fixtureT0 })
    let storeSeen = Recorder<RunningEnvelope>()
    let hubSeen = Recorder<StoreSnapshot>()
    let storeTask = consume(watcher.snapshots(), into: storeSeen)
    let hubTask = consume(hub.snapshots(), into: hubSeen)
    defer {
        storeTask.cancel()
        hubTask.cancel()
        watcher.stop()
        hub.stop()
    }

    // Le PREMIER élément d'un abonnement est l'instantané courant : un abonné neuf
    // n'attend pas un changement pour voir l'état.
    #expect(await awaitTrue { storeSeen.count >= 1 && hubSeen.count >= 1 })
    #expect(storeSeen.last?.entries.map(\.id) == [kept, removed])
    #expect(hubSeen.last?.running.entries.map(\.id) == [kept, removed])

    // Une entrée publiée par écriture atomique, une autre supprimée.
    publishRunning(fixture, id: published, cwd: "/tmp/brand-new")
    fixture.remove(.running, "\(removed).json")

    #expect(await awaitTrue(timeout: 2.0) {
        guard let last = storeSeen.last else { return false }
        return last.entries.map(\.id) == [published, kept]
    })
    #expect(await awaitTrue(timeout: 2.0) {
        guard let last = hubSeen.last else { return false }
        return last.running.entries.map(\.id) == [published, kept]
    })
    // Le flux global agrège les SIX stores : le reste de l'agrégat est là aussi.
    #expect(hubSeen.last?.history.availability == .present)
    #expect(hubSeen.last?.audit.availability == .present)
}

@Test("client-magasin-etat/AC-13 : une publication atomique est observée en ≤ 1 s et n'émet QU'UNE fois")
func atomicPublicationEmitsExactlyOnce() async {
    let fixture = StoreFixture()
    let id = fixtureId(0x15)
    let watcher = runningWatcher(fixture)
    let seen = Recorder<RunningEnvelope>()
    let task = consume(watcher.snapshots(), into: seen)
    defer {
        task.cancel()
        watcher.stop()
    }

    // L'instantané courant : magasin vide.
    #expect(await awaitTrue { seen.count == 1 })
    #expect(seen.last?.entries.isEmpty == true)

    let started = Date()
    publishRunning(fixture, id: id, cwd: "/tmp/publication-atomique")
    #expect(await awaitTrue(timeout: 1.0) { seen.count == 2 })
    #expect(Date().timeIntervalSince(started) <= 1.0)
    #expect(seen.last?.entries.map(\.id) == [id])

    // Le fichier temporaire n'émet RIEN et il n'y a pas de seconde émission : après
    // la fenêtre d'observation, le compte n'a pas bougé.
    try? await Task.sleep(for: .milliseconds(400))
    #expect(seen.count == 2)
}

@Test("client-magasin-etat/AC-13 : un store absent émet une fois quand son répertoire apparaît")
func absentStoreEmitsWhenItAppears() async {
    // `lots/` n'existe pas : la veille porte sur l'ancêtre existant le plus proche
    // (`open` d'un chemin absent échoue), et la création de l'enfant est vue.
    let fixture = StoreFixture(stores: [.running])
    let watcher = StoreWatcher(store: .lots, stateDir: fixture.root, nowMs: { fixtureT0 }) { dir, clock in
        StoreReader(stateDir: dir, clock: clock).readLots()
    }
    let seen = Recorder<LotEnvelope>()
    let task = consume(watcher.snapshots(), into: seen)
    defer {
        task.cancel()
        watcher.stop()
    }

    #expect(await awaitTrue { seen.count == 1 })
    #expect(seen.last?.availability == .absent)

    // Le répertoire apparaît, puis son premier lot est publié : la veille se réarme
    // sur l'enfant (sans quoi les publications internes resteraient invisibles).
    try? FileManager.default.createDirectory(atPath: fixture.directory(.lots), withIntermediateDirectories: true)
    #expect(await awaitTrue(timeout: 1.0) { seen.last?.availability == .present })

    let id = fixtureId(0x16)
    fixture.publish(
        .lots,
        "\(id).json",
        object: lotObject(id: id, ownerPid: Double(getpid()), heartbeatAt: fixtureT0 - 1_000)
    )
    #expect(await awaitTrue(timeout: 1.0) { seen.last?.lots.map(\.id) == [id] })
}
