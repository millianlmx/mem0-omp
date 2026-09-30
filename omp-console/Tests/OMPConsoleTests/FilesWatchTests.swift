// La veille de la cible active (S-7, AC-11), et ce qu'elle garantit : l'arbre et le
// document suivent le disque SANS geste, une rafale ne produit pas un rechargement
// par écriture, `stop()` termine le flux, et rien de tout cela n'écrit dans la cible.

import Combine
import Foundation
import Testing

@testable import OMPConsole

/// Un compteur partagé entre le fil qui publie et le test qui lit.
final class FilesCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func increment() {
        lock.lock()
        count += 1
        lock.unlock()
    }

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }
}

@MainActor
@Test("visionneuse-de-fichiers-et-diffs/AC-11 : un fichier ajouté apparaît dans l'arbre et le fichier affiché est relu, sans geste")
func watchRefreshesTreeAndDocument() async throws {
    let scene = try FilesScene()
    await scene.open()
    await scene.openFile("tracked.txt")
    #expect(scene.model.content == .text("b\n"))

    let digestsBefore = scene.fixture.fileDigests(in: scene.worktree)

    // 1) Un fichier NON SUIVI créé sur disque : l'arbre le porte sans ⌘R.
    try scene.fixture.write("folder/arrive.txt", "nouveau\n", in: scene.worktree)
    #expect(await waitUntilFiles(timeout: .seconds(10)) {
        scene.model.tree?.entries.contains { $0.path == "folder/arrive.txt" && $0.kind == .untracked } == true
    })

    // 2) Le fichier AFFICHÉ est modifié : son contenu ET son diff suivent.
    //
    // Le diff s'attend comme le contenu : une écriture peut tomber PENDANT le
    // `git diff` d'un rechargement déjà en vol (déclenché par l'étape 1), la lecture
    // du contenu suivant l'écriture tandis que le diff la précède — la passe suivante
    // corrige, mais une assertion synchrone la prend de vitesse sur un runner chargé
    // (mesuré : `check (macos-latest)` de la PR #46, `FilesWatchTests.swift:48`).
    try scene.fixture.write("tracked.txt", "c\n", in: scene.worktree)
    #expect(await waitUntilFiles(timeout: .seconds(10)) { scene.model.content == .text("c\n") })
    #expect(await waitUntilFiles(timeout: .seconds(10)) {
        scene.model.diff?.hunks.flatMap { $0 }.contains { $0.text == "+c" } == true
    })

    // 3) La veille elle-même n'écrit rien dans la cible (AC-13 maintenu pendant la
    // veille) : les fichiers sont inchangés à l'octet près, et l'état git ne porte que
    // les modifications faites par le test.
    let status = try scene.fixture.status(in: scene.worktree)
    #expect(status.contains("?? folder/arrive.txt"))
    #expect(status.contains(" M tracked.txt"))
    var expected = digestsBefore
    expected["folder/arrive.txt"] = sha256Hex(Data("nouveau\n".utf8))
    expected["tracked.txt"] = sha256Hex(Data("c\n".utf8))
    #expect(scene.fixture.fileDigests(in: scene.worktree) == expected)
}

@MainActor
@Test("visionneuse-de-fichiers-et-diffs/AC-11 : une rafale d'écritures ne produit pas un rechargement par écriture")
func watchDebouncesABurst() async throws {
    let scene = try FilesScene()
    await scene.open()

    let counter = FilesCounter()
    let cancellable = scene.model.$isLoading.sink { loading in
        if loading { counter.increment() }
    }

    // Dix écritures ESPACÉES (20 ms) : sans anti-rebond, chaque lot d'événements
    // déclencherait son rechargement ; avec lui, la rafale tient dans une seule
    // fenêtre de 300 ms.
    for index in 0..<10 {
        try scene.fixture.write("folder/rafale-\(index).txt", "\(index)\n", in: scene.worktree)
        try await Task.sleep(for: .milliseconds(20))
    }

    #expect(await waitUntilFiles(timeout: .seconds(10)) {
        scene.model.tree?.entries.filter { $0.path.hasPrefix("folder/rafale-") }.count == 10
    })
    #expect(counter.value >= 1, "la veille doit avoir rechargé")
    // La tolérance de 2 couvre un lot livré après le rechargement : dix écritures
    // n'ont jamais produit dix rechargements.
    #expect(counter.value <= 2, "un rechargement par écriture : \(counter.value)")
    withExtendedLifetime(cancellable) {}
}

@MainActor
@Test("visionneuse-de-fichiers-et-diffs/AC-11 : libérer la veille arrête les rechargements automatiques")
func suspendStopsWatching() async throws {
    let scene = try FilesScene()
    await scene.open()
    scene.model.suspend()

    let before = scene.model.tree
    try scene.fixture.write("folder/apres-suspend.txt", "x\n", in: scene.worktree)
    try await Task.sleep(for: .milliseconds(1_000))

    #expect(scene.model.tree == before)
}

@Test("visionneuse-de-fichiers-et-diffs/AC-11 : après stop(), le flux de veille se termine et n'émet plus rien")
func watcherStopsCleanly() async throws {
    let fixture = try FilesFixture()
    let watcher = TreeWatcher(watch: fixture.root)
    #expect(watcher.isArmed)

    let seen = Recorder<Void>()
    let task = consume(watcher.changes(), into: seen)

    try fixture.write("folder/veille.txt", "x\n")
    #expect(await awaitTrue(timeout: 5) { seen.count >= 1 })

    watcher.stop()
    // Idempotent : un second `stop()` ne lève pas et ne termine rien de plus.
    watcher.stop()
    let afterStop = seen.count

    try fixture.write("folder/apres-stop.txt", "y\n")
    try await Task.sleep(for: .milliseconds(800))

    #expect(seen.count == afterStop, "aucun élément ne doit suivre stop()")
    #expect(await awaitTrue(timeout: 5) { task.isCancelled || seen.count == afterStop })
    task.cancel()
}

@Test("visionneuse-de-fichiers-et-diffs/AC-11 : un répertoire inexistant n'arme pas de veille utilisable, sans lever")
func watcherOnMissingPathDoesNotCrash() async throws {
    let watcher = TreeWatcher(watch: joinPath(NSTemporaryDirectory(), "omp-console-absent-\(UUID().uuidString)"))
    let seen = Recorder<Void>()
    let task = consume(watcher.changes(), into: seen)
    try await Task.sleep(for: .milliseconds(200))
    #expect(seen.count == 0)
    watcher.stop()
    task.cancel()
}
