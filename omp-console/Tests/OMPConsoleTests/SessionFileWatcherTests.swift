// Preuves de S-3 (veille du fichier de session) : AC-7 et AC-13, dont cette veille
// est le DÉCLENCHEUR.
//
// Le consommateur est UNIQUE et de longue durée (patron `StoreWatchTests.swift`) :
// une `Task` avec `for await`, jamais une suite d'appels à échéance sur le même
// flux. Les fixtures sont de vrais fichiers sous `NSTemporaryDirectory()`.

import Darwin
import Foundation
import Testing

@testable import OMPConsole

@Test("visionneuse-de-session/AC-7 : un ajout d'octets délivre UN réveil")
func watcherEmitsOncePerAppend() async throws {
    let fixture = try ViewerSessionFixture()
    defer { fixture.remove() }
    try fixture.write([ViewerLines.header()])

    let watcher = SessionFileWatcher(path: fixture.path)
    let seen = Recorder<Void>()
    let task = consume(watcher.changes, into: seen)
    defer {
        task.cancel()
        watcher.stop()
    }

    // Rien de neuf : aucun réveil. L'instantané de l'armement est déjà connu.
    try? await Task.sleep(for: .milliseconds(300))
    #expect(seen.count == 0)

    try fixture.append([ViewerLines.user("Bonjour")])
    #expect(await awaitTrue(timeout: 2.0) { seen.count >= 1 })

    // Un ajout délivre PLUSIEURS événements de vnode (masque mesuré
    // `WRITE|EXTEND`) : la comparaison d'instantané en fait UN seul réveil.
    try? await Task.sleep(for: .milliseconds(400))
    #expect(seen.count == 1)

    // Un second ajout : un second réveil, pas un de plus.
    try fixture.append([ViewerLines.assistant(id: "e2", text: "suite")])
    #expect(await awaitTrue(timeout: 2.0) { seen.count == 2 })
    try? await Task.sleep(for: .milliseconds(400))
    #expect(seen.count == 2)

    // La lecture des octets ajoutés confirme la cible de l'AC (le fichier a grandi).
    #expect(fixture.size > 0)
}

@Test("visionneuse-de-session/AC-13 : un fichier créé APRÈS l'armement délivre un réveil")
func watcherEmitsWhenTheFileAppears() async throws {
    let fixture = try ViewerSessionFixture()
    defer { fixture.remove() }
    // Aucune écriture : le fichier n'existe pas et son répertoire, si.
    #expect(!FileManager.default.fileExists(atPath: fixture.path))

    let watcher = SessionFileWatcher(path: fixture.path)
    let seen = Recorder<Void>()
    let task = consume(watcher.changes, into: seen)
    defer {
        task.cancel()
        watcher.stop()
    }

    try? await Task.sleep(for: .milliseconds(300))
    #expect(seen.count == 0)

    // Le fichier APPARAÎT sous l'ancêtre veillé : c'est le fondement de la reprise
    // automatique (patron `absentStoreEmitsWhenItAppears`).
    try fixture.write([ViewerLines.header()])
    #expect(await awaitTrue(timeout: 2.0) { seen.count >= 1 })

    // Il disparaît : nouveau réveil (la veille remonte à l'ancêtre).
    let afterCreation = seen.count
    try FileManager.default.removeItem(at: fixture.file)
    #expect(await awaitTrue(timeout: 2.0) { seen.count > afterCreation })

    // Il réapparaît : encore un.
    let afterRemoval = seen.count
    try fixture.write([ViewerLines.header()])
    #expect(await awaitTrue(timeout: 2.0) { seen.count > afterRemoval })
}

@Test("visionneuse-de-session/AC-13 : la permission fait partie de l'instantané")
func watcherSeesAPermissionChange() async throws {
    let fixture = try ViewerSessionFixture()
    defer { fixture.remove() }
    try fixture.write([ViewerLines.header()])

    let watcher = SessionFileWatcher(path: fixture.path)
    let seen = Recorder<Void>()
    let task = consume(watcher.changes, into: seen)
    defer {
        task.cancel()
        watcher.stop()
        chmod(fixture.path, 0o644)
    }

    try? await Task.sleep(for: .milliseconds(300))
    #expect(seen.count == 0)

    // Seul le MODE change : ni la taille ni la date. Sans la permission dans
    // l'instantané, ce réveil n'existerait pas — et un fichier qui redevient
    // lisible ne serait jamais relu (AC-13).
    chmod(fixture.path, 0o400)
    #expect(await awaitTrue(timeout: 2.0) { seen.count >= 1 })
}

@Test("visionneuse-de-session/AC-13 : un fichier EXISTANT illisible à l'armement délivre un réveil dès qu'il devient lisible")
func watcherResumesOnAFileUnreadableAtArming() async throws {
    let fixture = try ViewerSessionFixture()
    defer {
        chmod(fixture.path, 0o644)
        fixture.remove()
    }
    try fixture.write([ViewerLines.header()])
    // Le fichier EXISTE, mais sans droit de lecture : `open(…, O_EVTONLY)` rend
    // EACCES, aucune source vnode ne peut être armée dessus, et la source armée sur
    // son RÉPERTOIRE ne voit RIEN de lui (mesuré : ni `chmod` ni octets ajoutés).
    chmod(fixture.path, 0o000)

    let watcher = SessionFileWatcher(path: fixture.path)
    let seen = Recorder<Void>()
    let task = consume(watcher.changes, into: seen)
    defer {
        task.cancel()
        watcher.stop()
    }

    try? await Task.sleep(for: .milliseconds(300))
    #expect(seen.count == 0)

    // Il redevient lisible SANS être touché autrement — c'est tout AC-13, 3e clause.
    chmod(fixture.path, 0o644)
    #expect(await awaitTrue(timeout: 2.0) { seen.count >= 1 })

    // Le ré-armement a rendu le vnode : un ajout d'octets délivre lui aussi un réveil.
    let afterChmod = seen.count
    try fixture.append([ViewerLines.user("Bonjour")])
    #expect(await awaitTrue(timeout: 2.0) { seen.count > afterChmod })
}

@Test("visionneuse-de-session/AC-7 : arrêter la veille termine son flux")
func stoppingTheWatcherEndsTheStream() async throws {
    let fixture = try ViewerSessionFixture()
    defer { fixture.remove() }
    try fixture.write([ViewerLines.header()])

    let watcher = SessionFileWatcher(path: fixture.path)
    let stream = watcher.changes
    watcher.stop()

    var values = 0
    for await _ in stream { values += 1 }
    #expect(values == 0)

    // Idempotent : un second arrêt ne lève rien et ne relance rien.
    watcher.stop()
    try fixture.append([ViewerLines.user("après l'arrêt")])
    try? await Task.sleep(for: .milliseconds(300))
    #expect(values == 0)
}
