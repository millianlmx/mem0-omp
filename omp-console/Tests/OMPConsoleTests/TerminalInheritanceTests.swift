// Preuves de BR-1 (AC-1, AC-2) : l'enfant du PTY ne démarre qu'avec 0, 1 et 2.
//
// La preuve ne peut pas venir de Swift seul : il faut un SECOND processus, lancé par
// `forkpty`, qui relève SA table de descripteurs. La sonde est donc un script
// `#!/bin/sh` écrit par le test (même patron que `makeChildScript`), et elle
// n'emploie que des builtins : `[ -e /dev/fd/N ]` interroge la table du processus
// APPELANT sans ouvrir de descripteur, alors que `ls /dev/fd` en ouvrirait un pour
// lire le répertoire et se compterait lui-même (Doc-6). Aucun `fork`, aucune
// substitution de commande : la mesure ne doit pas créer ce qu'elle mesure.
//
// Les aides de `TerminalHostTests.swift` sont `private` : ce fichier porte ses
// propres copies, sans rien rendre public et sans fusionner les deux fichiers.

import Darwin
import Foundation
import Testing
@testable import OMPConsole

// MARK: - Outils

/// Accumulateur des rappels du host : ils arrivent sur le MainActor, où vivent aussi
/// les épreuves, donc aucune synchronisation n'est nécessaire.
@MainActor
private final class ProbeRecorder {
    private(set) var bytes: [UInt8] = []

    func append(_ chunk: [UInt8]) { bytes.append(contentsOf: chunk) }

    var text: String { String(decoding: bytes, as: UTF8.self) }
}

/// Écrit un exécutable `#!/bin/sh` dans un dossier temporaire propre au test.
///
/// `scanMax` est interpolé, jamais laissé au shell : la borne de balayage est celle
/// que le test a mesurée sur le parent. `highDescriptor`, quand il est fourni, ajoute
/// le verdict sur le descripteur au numéro le plus élevé possible (S-3).
private func makeProbeScript(scanMax: Int, highDescriptor: Int32? = nil) throws -> URL {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("terminal-probe-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let script = directory.appendingPathComponent("probe")

    var lines = [
        "echo PROBE=ok",
        "n=3",
        "while [ $n -lt \(scanMax) ]; do",
        "  [ -e /dev/fd/$n ] && echo \"OPEN=$n\"",
        "  n=$((n+1))",
        "done",
    ]
    if let highDescriptor {
        lines.append("if [ -e /dev/fd/\(highDescriptor) ]; then echo HIGH_OPEN; else echo HIGH_CLOSED; fi")
    }
    lines.append("echo DONE")

    try Data("#!/bin/sh\n\(lines.joined(separator: "\n"))\n".utf8).write(to: script)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
    return script
}

private func makeProbeDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("terminal-probe-cwd-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

/// Sondage borné : aucune preuve n'attend indéfiniment une sortie de process.
@MainActor
private func waitUntil(timeout: Double = 10, _ condition: () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + .seconds(timeout)
    while ContinuousClock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
}

// MARK: - AC-1 : aucun descripteur hérité ≥ 3 dans l'enfant

@Test("descripteurs-herites-par-forkpty/AC-1 : l'enfant du PTY ne voit que 0, 1 et 2")
@MainActor
func inheritedDescriptorsAreClosedInThePTYChild() async throws {
    // Le parent tient RÉELLEMENT au moins un descripteur ≥ 3 pendant tout le test :
    // les deux bouts d'un `pipe` (3 et 4 sur un process de test vierge).
    var pipeFDs: [Int32] = [-1, -1]
    #expect(pipe(&pipeFDs) == 0)
    defer {
        if pipeFDs[0] >= 0 { close(pipeFDs[0]) }
        if pipeFDs[1] >= 0 { close(pipeFDs[1]) }
    }
    // Sans ce descripteur, la sonde ne prouverait rien du tout.
    #expect(pipeFDs[0] >= 3)

    // La plage balayée couvre au moins les descripteurs que le parent tient : rien
    // n'est prouvé si la sonde s'arrête en dessous.
    let scanMax = max(64, Int(pipeFDs[1]) + 1)
    #expect(scanMax > Int(pipeFDs[1]))

    let probe = try makeProbeScript(scanMax: scanMax)
    let recorder = ProbeRecorder()
    let host = TerminalHost()
    host.onOutput = { recorder.append($0) }

    try host.start(
        executable: probe,
        cwd: try makeProbeDirectory(),
        columns: 80,
        rows: 24
    )

    let finished = await waitUntil { recorder.text.contains("DONE") }
    #expect(finished)
    #expect(recorder.text.contains("PROBE=ok"))
    // AC-1 : aucun descripteur du parent n'a franchi le `forkpty`.
    #expect(!recorder.text.contains("OPEN="))

    await host.kill()
}

// MARK: - AC-2 : le numéro le plus élevé possible est fermé

@Test("descripteurs-herites-par-forkpty/AC-2 : un descripteur au numéro le plus élevé possible est fermé")
@MainActor
func highestPossibleDescriptorNumberIsClosed() async throws {
    // `getdtablesize()` est la borne EXACTE : `dup2` accepte `getdtablesize() - 1` et
    // refuse `getdtablesize()` (mesuré, Doc-4). Le test vise donc le plus grand numéro
    // possible — une fermeture bornée trop bas (256, 1024, `rlim_cur` tronqué) le
    // laisserait ouvert et la sonde dirait `HIGH_OPEN`.
    let limit = getdtablesize()
    let target = Int32(limit - 1)
    let devnull = open("/dev/null", O_RDONLY)
    #expect(devnull >= 0)
    #expect(dup2(devnull, target) == target)
    // Le PARENT tient réellement ce descripteur juste avant `start` : sans cette
    // garde, un `dup2` silencieusement raté rendrait le test vacu.
    #expect(fcntl(target, F_GETFD) != -1)
    defer {
        close(target)
        if devnull != target { close(devnull) }
    }

    // La sonde de S-2, plus le verdict sur le numéro élevé. Le balayage reste court :
    // c'est la ligne `HIGH_*` qui porte AC-2, pas lui.
    let probe = try makeProbeScript(scanMax: 64, highDescriptor: target)
    let recorder = ProbeRecorder()
    let host = TerminalHost()
    host.onOutput = { recorder.append($0) }

    try host.start(
        executable: probe,
        cwd: try makeProbeDirectory(),
        columns: 80,
        rows: 24
    )

    let finished = await waitUntil { recorder.text.contains("DONE") }
    #expect(finished)
    #expect(recorder.text.contains("HIGH_CLOSED"))
    #expect(!recorder.text.contains("HIGH_OPEN"))

    await host.kill()
}
