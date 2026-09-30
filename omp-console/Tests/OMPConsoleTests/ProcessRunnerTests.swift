// Preuves de S-3 (AC-3, AC-4) et du socle S-1 (AC-2) : l'escalade SIGTERM →
// `ProcessRunner.killGrace` → SIGKILL, la mort EFFECTIVE de l'enfant au retour, la
// borne de l'attente, le mappage des erreurs d'échéance et de lancement, et la
// découpe en lignes partagée.
//
// Tout est prouvé sans `omp` ni appel modèle : la doublure est un script `sh`
// jetable et exécutable, écrit dans le répertoire temporaire. `trap '' TERM` suivi
// d'un `exec` (indispensable : sans lui le signal frapperait le shell et laisserait
// le `sleep` orphelin) rend un enfant qui refuse la grâce de façon déterministe.

import Darwin
import Foundation
import Testing

@testable import OMPConsole

// MARK: - Outils

private func makeRunnerDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("process-runner-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

/// Un enfant qui IGNORE SIGTERM : le `trap` pose avant l'`exec` survit à celui-ci,
/// donc `sleep 30` refuse la grâce jusqu'au SIGKILL.
private func makeIgnoringTermBinary() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("runner-fake-\(UUID().uuidString)")
    try "#!/bin/sh\ntrap '' TERM\nexec sleep 30\n".write(to: url, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    return url
}

/// Le pid n'est lisible qu'APRÈS `run()` (`processIdentifier` vaut 0 avant) : on
/// sonde donc le `Process` partagé jusqu'à ce que Foundation l'ait lancé.
private func waitForPID(_ process: Process, timeout: Duration = .seconds(3)) async -> Int32? {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        let pid = process.processIdentifier
        if pid > 0 { return pid }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return process.processIdentifier > 0 ? process.processIdentifier : nil
}

/// Les lignes reçues par `pumpLines`, gardées comme le dépôt le fait entre fils.
private final class LineBox: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []

    func append(_ line: String) {
        lock.lock()
        lines.append(line)
        lock.unlock()
    }

    var value: [String] {
        lock.lock()
        defer { lock.unlock() }
        return lines
    }
}

// MARK: - S-3 : escalade bornée, mort effective

@Test("runner-de-process-swift-duplique/AC-3 : un enfant qui ignore SIGTERM est tué par SIGKILL, récolté au retour")
func escalationKillsAndReapsAnIgnoringChild() async throws {
    let directory = try makeRunnerDirectory()
    let binary = try makeIgnoringTermBinary()
    let child = ProcessRunner.child(
        binary: binary,
        arguments: [],
        cwd: directory,
        environment: ["PATH": "/usr/bin:/bin"],
        input: .nullDevice
    )

    let started = ContinuousClock.now
    let running = Task { try await ProcessRunner.run(child, timeout: 0.5) }
    guard let pid = await waitForPID(child.process) else {
        Issue.record("le process lancé n'a jamais exposé de pid")
        return
    }
    let run = try await running.value
    let elapsed = ContinuousClock.now - started

    #expect(run.timedOut, "l'échéance dépassée doit être rendue, même quand l'enfant a obéi au SIGTERM")
    let probe = kill(pid, 0)
    let probeErrno = errno
    #expect(probe == -1, "l'enfant doit être mort ET récolté au retour")
    #expect(probeErrno == ESRCH)
    #expect(run.code == SIGKILL, "l'enfant doit être mort du SIGKILL, pas d'un code de sortie")
    // AC-4 : la borne est délai + grâce, et la grâce vaut bien 2 s — un SIGKILL
    // prématuré (grâce de 0,1 s) ferait échouer la borne basse.
    #expect(elapsed >= .milliseconds(2_400), "la grâce accordée avant SIGKILL est plus courte que 2 s")
    #expect(elapsed <= .milliseconds(3_000), "l'attente dépasse délai + grâce + marge")
}

// MARK: - S-2 : le mappage des échecs par les deux appelants collectés

@Test("runner-de-process-swift-duplique/AC-3 : GitCLI rend FilesError.commandTimedOut sur un enfant qui ignore SIGTERM")
func gitCLITimesOut() async throws {
    let directory = try makeRunnerDirectory()
    let binary = try makeIgnoringTermBinary()
    let cli = GitCLI(binary: binary, timeout: 0.5)

    do {
        _ = try await cli.run(GitCommand.lsTracked(), in: directory.path)
        Issue.record("une commande expirée doit échouer")
    } catch let error as FilesError {
        #expect(error == .commandTimedOut(command: "ls-files", seconds: 0.5))
    }
}

@Test("runner-de-process-swift-duplique/AC-3 : GhCLI rend GhError.commandTimedOut sur un enfant qui ignore SIGTERM")
func ghCLITimesOut() async throws {
    let directory = try makeRunnerDirectory()
    let binary = try makeIgnoringTermBinary()
    let cli = GhCLI(binary: binary, timeout: 0.5)

    do {
        _ = try await cli.run(GhCommand.prView(url: "https://exemple.test/pull/45"), in: directory.path)
        Issue.record("une commande expirée doit échouer")
    } catch let error as GhError {
        #expect(error == .commandTimedOut(command: "pr view", seconds: 0.5))
    }
}

@Test("runner-de-process-swift-duplique/AC-2 : un binaire inexistant échoue au lancement, sans sortie ni échéance")
func launchFailureIsNamed() async throws {
    let directory = try makeRunnerDirectory()
    let missing = directory.appendingPathComponent("absent-git")
    let child = ProcessRunner.child(
        binary: missing,
        arguments: [],
        cwd: directory,
        environment: [:],
        input: .nullDevice
    )

    do {
        _ = try await ProcessRunner.run(child, timeout: 0.5)
        Issue.record("un binaire absent doit échouer")
    } catch let error as ProcessRunnerError {
        guard case let .launchFailed(detail) = error else {
            Issue.record("seul `launchFailed` est attendu, reçu \(error)")
            return
        }
        #expect(!detail.isEmpty)
    }

    do {
        _ = try await GitCLI(binary: missing, timeout: 0.5).run(GitCommand.lsTracked(), in: directory.path)
        Issue.record("un binaire absent doit faire échouer `GitCLI.run`")
    } catch let error as FilesError {
        guard case let .commandFailed(command, code, detail) = error else {
            Issue.record("`FilesError.commandFailed` est attendu, reçu \(error)")
            return
        }
        #expect(command == "ls-files")
        #expect(code == -1)
        #expect(!detail.isEmpty)
    }
}

@Test("runner-de-process-swift-duplique/AC-2 : une commande normale rend son code, sa sortie exacte et aucun signal")
func normalCommandIsCollected() async throws {
    let directory = try makeRunnerDirectory()
    let child = ProcessRunner.child(
        binary: URL(fileURLWithPath: "/bin/echo"),
        arguments: ["bonjour", "à toi"],
        cwd: directory,
        environment: ["PATH": "/usr/bin:/bin"],
        input: .nullDevice
    )

    let run = try await ProcessRunner.run(child, timeout: 5)

    #expect(run.timedOut == false)
    #expect(run.code == 0)
    #expect(run.stdout == "bonjour à toi\n")
    #expect(run.stderr == "")
}

@Test("runner-de-process-swift-duplique/AC-2 : la découpe en lignes garde la dernière partielle et retire le \\r")
func pumpLinesSplitsLikeToday() async throws {
    let pipe = Pipe()
    pipe.fileHandleForWriting.write(Data("a\r\nb\nc".utf8))
    try pipe.fileHandleForWriting.close()
    let box = LineBox()

    await withCheckedContinuation { continuation in
        ProcessRunner.pumpLines(
            pipe.fileHandleForReading,
            yield: { box.append($0) },
            finish: { continuation.resume() }
        )
    }

    #expect(box.value == ["a", "b", "c"])
}
