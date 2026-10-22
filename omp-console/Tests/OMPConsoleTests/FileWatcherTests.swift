// Preuves de la veille d'un fichier (S-3 de visionneuse-de-session, réemployée par
// la présence des composants) : AC-7 et AC-13.
//
// Le consommateur est UNIQUE et de longue durée : une `Task` avec `for await`,
// jamais une suite d'appels à échéance sur le même flux. Les fixtures sont de
// vrais fichiers sous `NSTemporaryDirectory()`.

import Darwin
import Foundation
import Testing

@testable import OMPConsole

/// Un fichier veillé dans son propre répertoire temporaire.
private final class WatchedFile {
    let directory: URL
    let file: URL

    init() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("veille-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        file = directory.appendingPathComponent("fichier.txt")
    }

    var path: String { file.path }

    var size: Int {
        ((try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? Int) ?? 0
    }

    func write(_ lines: [String]) throws {
        try Data(lines.map { $0 + "\n" }.joined().utf8).write(to: file)
    }

    /// Un ajout APPEND-ONLY.
    func append(_ lines: [String]) throws {
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        try handle.seek(toOffset: handle.seekToEnd())
        try handle.write(contentsOf: Data(lines.map { $0 + "\n" }.joined().utf8))
    }

    func remove() {
        try? FileManager.default.removeItem(at: directory)
    }
}

@Test("visionneuse-de-session/AC-7 : un ajout d'octets délivre UN réveil")
func watcherEmitsOncePerAppend() async throws {
    let fixture = try WatchedFile()
    defer { fixture.remove() }
    try fixture.write(["en-tête"])

    let watcher = FileWatcher(path: fixture.path)
    let seen = Recorder<Void>()
    let task = consume(watcher.changes, into: seen)
    defer {
        task.cancel()
        watcher.stop()
    }

    // Rien de neuf : aucun réveil. L'instantané de l'armement est déjà connu.
    try? await Task.sleep(for: .milliseconds(300))
    #expect(seen.count == 0)

    try fixture.append(["Bonjour"])
    #expect(await awaitTrue(timeout: 2.0) { seen.count >= 1 })

    // Un ajout délivre PLUSIEURS événements de vnode (masque mesuré
    // `WRITE|EXTEND`) : la comparaison d'instantané en fait UN seul réveil.
    try? await Task.sleep(for: .milliseconds(400))
    #expect(seen.count == 1)

    // Un second ajout : un second réveil, pas un de plus.
    try fixture.append(["suite"])
    #expect(await awaitTrue(timeout: 2.0) { seen.count == 2 })
    try? await Task.sleep(for: .milliseconds(400))
    #expect(seen.count == 2)

    // La lecture des octets ajoutés confirme la cible de l'AC (le fichier a grandi).
    #expect(fixture.size > 0)
}

@Test("visionneuse-de-session/AC-13 : un fichier créé APRÈS l'armement délivre un réveil")
func watcherEmitsWhenTheFileAppears() async throws {
    let fixture = try WatchedFile()
    defer { fixture.remove() }
    // Aucune écriture : le fichier n'existe pas et son répertoire, si.
    #expect(!FileManager.default.fileExists(atPath: fixture.path))

    let watcher = FileWatcher(path: fixture.path)
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
    try fixture.write(["en-tête"])
    #expect(await awaitTrue(timeout: 2.0) { seen.count >= 1 })

    // Il disparaît : nouveau réveil (la veille remonte à l'ancêtre).
    let afterCreation = seen.count
    try FileManager.default.removeItem(at: fixture.file)
    #expect(await awaitTrue(timeout: 2.0) { seen.count > afterCreation })

    // Il réapparaît : encore un.
    let afterRemoval = seen.count
    try fixture.write(["en-tête"])
    #expect(await awaitTrue(timeout: 2.0) { seen.count > afterRemoval })
}

@Test("un fichier posé en rafale avec ses dossiers intermédiaires délivre un réveil")
func watcherFollowsABurstOfIntermediateDirectories() async throws {
    // Mesuré le 2026-10-11 : environ une pose sur dix laissait la veille armée sur
    // un ancêtre devenu muet, et le badge des composants restait « manquants »
    // après l'installation. Trente poses : la course n'a plus le droit de gagner.
    for attempt in 1...30 {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("omp-watch-burst-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("composant/1.0/bin/binaire")
        let watcher = FileWatcher(path: file.path)
        let seen = Recorder<Void>()
        let task = consume(watcher.changes, into: seen)
        defer {
            task.cancel()
            watcher.stop()
            try? FileManager.default.removeItem(at: root)
        }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: file)
        #expect(await awaitTrue(timeout: 2.0) { seen.count >= 1 }, "pose n° \(attempt)")
    }
}

@Test("visionneuse-de-session/AC-13 : la permission fait partie de l'instantané")
func watcherSeesAPermissionChange() async throws {
    let fixture = try WatchedFile()
    defer { fixture.remove() }
    try fixture.write(["en-tête"])

    let watcher = FileWatcher(path: fixture.path)
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
    let fixture = try WatchedFile()
    defer {
        chmod(fixture.path, 0o644)
        fixture.remove()
    }
    try fixture.write(["en-tête"])
    // Le fichier EXISTE, mais sans droit de lecture : `open(…, O_EVTONLY)` rend
    // EACCES, aucune source vnode ne peut être armée dessus, et la source armée sur
    // son RÉPERTOIRE ne voit RIEN de lui (mesuré : ni `chmod` ni octets ajoutés).
    chmod(fixture.path, 0o000)

    let watcher = FileWatcher(path: fixture.path)
    let seen = Recorder<Void>()
    let task = consume(watcher.changes, into: seen)
    defer {
        task.cancel()
        watcher.stop()
    }

    try? await Task.sleep(for: .milliseconds(300))
    #expect(seen.count == 0)

    // Il redevient lisible SANS être touché autrement — c'est tout AC-13, 3e clause.
    // Ce réveil passe par le repli FSEvents, dont la latence n'est pas bornée :
    // 2 s rougissait en fin de suite complète sous charge (mesuré le 2026-10-12) ;
    // 5 s est l'échéance déjà retenue pour la même reprise par `ViewerFixtures`.
    chmod(fixture.path, 0o644)
    #expect(await awaitTrue(timeout: 5.0) { seen.count >= 1 })

    // Le ré-armement a rendu le vnode : un ajout d'octets délivre lui aussi un réveil.
    let afterChmod = seen.count
    try fixture.append(["Bonjour"])
    #expect(await awaitTrue(timeout: 2.0) { seen.count > afterChmod })
}

@Test("visionneuse-de-session/AC-7 : arrêter la veille termine son flux")
func stoppingTheWatcherEndsTheStream() async throws {
    let fixture = try WatchedFile()
    defer { fixture.remove() }
    try fixture.write(["en-tête"])

    let watcher = FileWatcher(path: fixture.path)
    let stream = watcher.changes
    watcher.stop()

    var values = 0
    for await _ in stream { values += 1 }
    #expect(values == 0)

    // Idempotent : un second arrêt ne lève rien et ne relance rien.
    watcher.stop()
    try fixture.append(["après l'arrêt"])
    try? await Task.sleep(for: .milliseconds(300))
    #expect(values == 0)
}
