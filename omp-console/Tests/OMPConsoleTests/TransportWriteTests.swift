// Preuves de BR-1 (AC-1, AC-2) : l'écriture bornée et sans SIGPIPE sur le tube
// d'entrée du transport RPC, avec des process RÉELS et sans `omp`.
//
// Les enfants sont des scripts écrits par le test, à la manière de
// `TerminalHostTests.makeChildScript` : `ProcessTransport.start` ne compose aucun
// argument, donc le programme à exécuter doit être porté par le chemin passé à
// `start`. Aucune épreuve ne dépend d'`omp` ni d'un appel modèle, donc aucune n'est
// gatée par une variable `MEM0_*_RECIPE`.

import Darwin
import Foundation
import Testing
@testable import OMPConsole

// MARK: - Outils

/// Écrit un exécutable `#!/bin/sh` dans un dossier temporaire propre au test.
private func makeTransportChildScript(_ body: String) throws -> URL {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("transport-write-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let script = directory.appendingPathComponent("child")
    try Data("#!/bin/sh\n\(body)\n".utf8).write(to: script)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
    return script
}

private func makeTransportWorkingDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("transport-write-cwd-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

/// Sondage borné : aucune preuve n'attend indéfiniment la sortie d'un process.
@MainActor
private func waitUntil(timeout: Duration = .seconds(5), _ condition: () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
}

// MARK: - BR-1 : une écriture bornée, jamais meurtrière

@MainActor
@Test("transport-rpc-bloquant-sans-sigpipe/AC-2 : un enfant qui a fermé son stdin rend EPIPE et le processus de test survit")
func writeWithoutReaderRaisesEPIPEWithoutSIGPIPE() async throws {
    // Recette de Doc-4 : l'enfant ferme EXPLICITEMENT son stdin (`exec 0<&-`), sans
    // sortir du process. C'est la seule forme où EPIPE est atteint alors que le
    // transport voit encore un process vivant (après une sortie réelle, le host
    // lève `.notRunning` avant d'écrire).
    let script = try makeTransportChildScript("exec 0<&-\necho stdin-closed\nexec sleep 5")
    let transport = ProcessTransport()
    var lines: [String] = []
    transport.onLine = { lines.append($0) }

    try transport.start(binary: script, arguments: [], cwd: try makeTransportWorkingDirectory())
    #expect(transport.isRunning)

    // La sentinelle n'est émise qu'APRÈS `exec 0<&-` : sa réception prouve que le
    // tube n'a plus de lecteur, sans course avec le lancement.
    let sawSentinel = await waitUntil { lines.contains("stdin-closed") }
    #expect(sawSentinel)

    do {
        try transport.write("bonjour\n")
        Issue.record("une écriture sans lecteur doit échouer")
    } catch let failure as TransportFailure {
        #expect(failure == .writeFailed(32))
    }

    // Le processus de test est VIVANT (aucun SIGPIPE) : sans le drapeau
    // `F_SETNOSIGPIPE`, la première écriture l'aurait tué. Une SECONDE écriture
    // rend encore EPIPE, preuve directe de l'absence de signal.
    do {
        try transport.write("encore\n")
        Issue.record("la seconde écriture doit aussi échouer")
    } catch let failure as TransportFailure {
        #expect(failure == .writeFailed(32))
    }

    transport.signal(SIGKILL)
}

@MainActor
@Test("transport-rpc-bloquant-sans-sigpipe/AC-1 : un enfant qui ne lit jamais borne l'écriture par l'échéance")
func writeTimeoutIsBounded() async throws {
    // Recette de Doc-4 : un `sleep` exécuté par `exec` ne lit JAMAIS son stdin.
    let script = try makeTransportChildScript("exec sleep 30")
    let transport = ProcessTransport()
    try transport.start(binary: script, arguments: [], cwd: try makeTransportWorkingDirectory())

    let payload = String(repeating: "x", count: 256 * 1024)
    let clock = ContinuousClock()
    let began = clock.now
    do {
        try transport.write(payload)
        Issue.record("une écriture que le process n'absorbe pas doit expirer")
    } catch let failure as TransportFailure {
        #expect(failure == .writeTimedOut(milliseconds: 500))
    }
    // « Sans geler le MainActor » : l'écriture est synchrone, donc c'est sa DURÉE
    // qui est observable — bornée par l'échéance de 500 ms (+ une marge de `poll`).
    #expect(clock.now - began < .seconds(2))

    transport.signal(SIGKILL)
}

@MainActor
@Test("transport-rpc-bloquant-sans-sigpipe/AC-1 : deux écritures atteignent l'enfant dans l'ordre des octets")
func writesReachChildInOrder() async throws {
    let script = try makeTransportChildScript("exec cat")
    let transport = ProcessTransport()
    var lines: [String] = []
    transport.onLine = { lines.append($0) }

    try transport.start(binary: script, arguments: [], cwd: try makeTransportWorkingDirectory())
    try transport.write("un\n")
    try transport.write("deux\n")

    #expect(await waitUntil { lines == ["un", "deux"] })
    transport.closeStdin()
}
