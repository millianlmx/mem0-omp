// Preuves de BR-1 (AC-1, AC-3, AC-7, AC-8, AC-9) : le PTY et le cycle de vie du
// process, sans `omp` et sans fenêtre.
//
// Les enfants de substitution sont des SCRIPTS ÉCRITS PAR LE TEST. Ce n'est pas un
// détail : l'hôte ne compose AUCUN argument (le modèle de process du terminal est un
// seul programme, jamais un shell), donc le programme à exécuter doit être porté par
// le chemin passé à `start` — un `sh -c …` n'aurait nulle part où aller.
//
// Rien ici ne dépend d'`omp` ni du poste : tout naît d'un enfant `/bin/sh` et d'une
// taille de PTY choisie par le test.

import Darwin
import Foundation
import Testing
@testable import OMPConsole

// MARK: - Outils

/// Accumulateur des rappels du host : ils arrivent sur le MainActor, où vivent aussi
/// les épreuves, donc aucune synchronisation n'est nécessaire.
@MainActor
private final class TerminalRecorder {
    private(set) var bytes: [UInt8] = []
    private(set) var exits: [TerminalExit] = []

    func append(_ chunk: [UInt8]) { bytes.append(contentsOf: chunk) }
    func record(_ exit: TerminalExit) { exits.append(exit) }

    var text: String { String(decoding: bytes, as: UTF8.self) }
}

/// Écrit un exécutable `#!/bin/sh` dans un dossier temporaire propre au test.
private func makeChildScript(_ body: String) throws -> URL {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("terminal-host-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let script = directory.appendingPathComponent("child")
    try Data("#!/bin/sh\n\(body)\n".utf8).write(to: script)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
    return script
}

private func makeTemporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("terminal-cwd-\(UUID().uuidString)")
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

/// Le groupe de process a-t-il disparu ? Le noyau peut garder un zombie quelques
/// millisecondes (l'orphelin d'un enfant mort n'est récolté qu'après reparentage),
/// donc la vérification est bornée au lieu d'être instantanée.
@MainActor
private func waitUntilGroupIsGone(_ pid: Int32, timeout: Double = 5) async -> Bool {
    await waitUntil(timeout: timeout) {
        errno = 0
        return kill(-pid, 0) == -1 && errno == ESRCH
    }
}

// MARK: - AC-1 : le process lancé

@Test("terminal-integre/AC-1 : le pid publié est un enfant direct de l'app et la taille passée à start est celle lue par l'enfant")
@MainActor
func publishedPIDIsDirectChildAndReadsTheSizePassedToStart() async throws {
    // L'enfant rend sa taille RÉPLIQUE et le pid de son père : c'est exactement ce
    // que AC-1 demande de vérifier, sans lancer `omp`.
    let script = try makeChildScript("stty size; echo ppid=$PPID")
    let recorder = TerminalRecorder()
    let host = TerminalHost()
    host.onOutput = { recorder.append($0) }
    host.onExit = { recorder.record($0) }

    try host.start(
        executable: script,
        cwd: try makeTemporaryDirectory(),
        columns: 111,
        rows: 37
    )
    #expect(host.pid != nil)
    #expect(host.isRunning)

    let read = await waitUntil { recorder.text.contains("ppid=") }
    #expect(read)
    // « Enfant DIRECT » : le père du fils de `forkpty` est le process de l'app — ce
    // process de test. Aucun shell intermédiaire ne s'est intercalé.
    #expect(recorder.text.contains("ppid=\(getpid())"))
    // La taille passée à `start` est celle de la réplique AVANT que l'enfant ne
    // s'exécute (`termp`/`winp` de `forkpty`, Doc-3).
    #expect(recorder.text.contains("37 111"))

    _ = await waitUntil { !recorder.exits.isEmpty }
    #expect(recorder.exits.first == TerminalExit(status: 0, reason: .exited))
    // Récolté : plus de pid, plus de process vivant.
    #expect(host.pid == nil)
    #expect(host.isRunning == false)
}

// MARK: - AC-3 : le binaire introuvable

@Test("terminal-integre/AC-3 : un chemin absent ou non exécutable lève binaryNotFound avec le message de SessionHostError")
@MainActor
func missingBinaryRaisesBinaryNotFoundWithSessionHostMessage() async throws {
    let directory = try makeTemporaryDirectory()
    // Présent mais NON exécutable : `isExecutableFile` tranche, jamais `fileExists`
    // (même règle que `OmpBinaryResolver`).
    let notExecutable = directory.appendingPathComponent("omp")
    try Data("#!/bin/sh\nexit 0\n".utf8).write(to: notExecutable)
    let absent = directory.appendingPathComponent("absent-\(UUID().uuidString)")

    let host = TerminalHost()
    for path in [absent, notExecutable] {
        do {
            try host.start(
                executable: path,
                cwd: try makeTemporaryDirectory(),
                columns: 80,
                rows: 24
            )
            Issue.record("aucune erreur levée pour \(path.path)")
        } catch let error as TerminalHostError {
            guard case .binaryNotFound(let searched, let override) = error else {
                Issue.record("erreur inattendue pour \(path.path) : \(error)")
                continue
            }
            #expect(searched == [path.path])
            #expect(override == nil)
            // Une SEULE table de texte : celle de `SessionHostError`.
            #expect(
                error.userMessage
                    == SessionHostError.binaryNotFound(searched: [path.path], override: nil).userMessage
            )
        }
        // Aucun process n'a été lancé.
        #expect(host.pid == nil)
        #expect(host.isRunning == false)
    }
}

// MARK: - AC-7 : la taille

@Test("terminal-integre/AC-7 : resize livre SIGWINCH et l'enfant lit la nouvelle taille")
@MainActor
func resizeDeliversSIGWINCHToTheChild() async throws {
    let journal = FileManager.default.temporaryDirectory
        .appendingPathComponent("terminal-winch-\(UUID().uuidString).log")
    // L'enfant journalise sa taille À CHAQUE SIGWINCH : c'est la seule preuve que le
    // signal est bien parti du noyau et pas d'un `kill` de l'app.
    let script = try makeChildScript("""
    trap 'stty size >> \(journal.path)' WINCH
    stty size >> \(journal.path)
    while :; do sleep 0.1; done
    """)

    let host = TerminalHost()
    try host.start(
        executable: script,
        cwd: try makeTemporaryDirectory(),
        columns: 80,
        rows: 24
    )

    func lines() -> String {
        (try? String(contentsOfFile: journal.path, encoding: .utf8)) ?? ""
    }

    let initial = await waitUntil { lines().contains("24 80") }
    #expect(initial)

    // Doc-3 : `TIOCSWINSZ` sur le maître met à jour la réplique ET fait délivrer
    // `SIGWINCH` au groupe au premier plan — aucun signal n'est envoyé à la main.
    host.resize(columns: 120, rows: 40)
    let resized = await waitUntil { lines().contains("40 120") }
    #expect(resized)

    // Le redimensionnement ne tue pas : le process vit encore après le `ioctl`.
    #expect(host.isRunning)
    await host.kill()
    #expect(host.isRunning == false)
}

@Test("terminal-integre/AC-7 : une taille mémorisée hors exécution s'applique au prochain start")
@MainActor
func resizeWhileStoppedAppliesToNextStart() async throws {
    let script = try makeChildScript("stty size; sleep 5")
    let recorder = TerminalRecorder()
    let host = TerminalHost()
    host.onOutput = { recorder.append($0) }

    // « Redimensionnement après la mort du process ⇒ mémorisé, appliqué au prochain
    // start » (S-6) : c'est le cas d'une fenêtre mesurée avant que le process n'existe.
    host.resize(columns: 133, rows: 41)
    #expect(host.pid == nil)

    try host.start(
        executable: script,
        cwd: try makeTemporaryDirectory(),
        columns: 80,
        rows: 24
    )
    let read = await waitUntil { recorder.text.contains("41 133") }
    #expect(read)
    await host.kill()
}

// MARK: - AC-8 et AC-9 : la mort du groupe

@Test("terminal-integre/AC-8 : fermer le terminal tue tout le groupe, sans descendant ni zombie")
@MainActor
func closingKillsTheWholeProcessGroup() async throws {
    // L'enfant met un petit-fils en arrière-plan puis attend : `kill(-pid, …)` doit
    // atteindre les DEUX, sinon un `omp` survivrait à la fermeture de sa fenêtre.
    let script = try makeChildScript("sleep 300 & echo petitfils=$!; wait")
    let recorder = TerminalRecorder()
    let host = TerminalHost()
    host.onOutput = { recorder.append($0) }
    host.onExit = { recorder.record($0) }

    try host.start(
        executable: script,
        cwd: try makeTemporaryDirectory(),
        columns: 80,
        rows: 24
    )
    let started = await waitUntil { recorder.text.contains("petitfils=") }
    #expect(started)

    guard let pid = host.pid else {
        Issue.record("le pid du fils direct doit être publié pendant l'exécution")
        return
    }
    await host.kill()

    // 1) Plus AUCUN process du groupe.
    let groupGone = await waitUntilGroupIsGone(pid)
    #expect(groupGone)
    // 2) Le fils direct a été RÉCOLTÉ : `waitpid` ne le voit plus, donc pas de zombie.
    errno = 0
    let reaped = waitpid(pid, nil, WNOHANG)
    let reapErrno = errno
    #expect(reaped == -1)
    #expect(reapErrno == ECHILD)
    // 3) L'état reflète la mort réelle.
    #expect(host.pid == nil)
    #expect(host.isRunning == false)
    #expect(recorder.exits.count == 1)
}

@Test("terminal-integre/AC-9 : un enfant qui ignore SIGTERM est tué par l'escalade SIGKILL, sans orphelin")
@MainActor
func quittingEscalatesToSIGKILL() async throws {
    // `trap '' TERM` rend l'escalade NÉCESSAIRE : le SIGTERM de groupe part, ne tue
    // rien, et c'est le SIGKILL qui fait le travail. Sans escalade, cet enfant
    // survivrait à ⌘Q.
    let script = try makeChildScript("""
    trap '' TERM
    echo arme
    while :; do sleep 0.1; done
    """)
    let recorder = TerminalRecorder()
    let host = TerminalHost()
    host.onOutput = { recorder.append($0) }
    try host.start(
        executable: script,
        cwd: try makeTemporaryDirectory(),
        columns: 80,
        rows: 24
    )
    // On attend que le piège soit POSÉ : l'ignorer n'a de sens que si `trap` a déjà
    // été exécuté, sinon le SIGTERM tuerait un enfant qui n'a rien voulu ignorer.
    let armed = await waitUntil { recorder.text.contains("arme") }
    #expect(armed)
    guard let pid = host.pid else {
        Issue.record("le pid du fils direct doit être publié pendant l'exécution")
        return
    }

    let start = ContinuousClock.now
    await host.kill()
    let elapsed = ContinuousClock.now - start

    // La grâce avant `SIGKILL` a bien été observée : sans elle, `kill()` n'aurait pas
    // laissé à l'enfant le temps de rendre la main sur le `SIGTERM`.
    #expect(elapsed >= .seconds(1.5))
    let groupGone = await waitUntilGroupIsGone(pid)
    #expect(groupGone)
    #expect(host.pid == nil)

    // Rejouable : un second appel ne relance rien et ne lève rien.
    await host.kill()
    #expect(host.isRunning == false)
    let stillGone = await waitUntilGroupIsGone(pid)
    #expect(stillGone)
}

// MARK: - BR-1 étape 3 : l'écriture

@Test("terminal-integre/BR-1 : les octets écrits sur le maître arrivent au fils et sa réponse revient dans l'ordre")
@MainActor
func writeReachesChildAndEchoComesBack() async throws {
    let script = try makeChildScript("exec /bin/cat")
    let recorder = TerminalRecorder()
    let host = TerminalHost()
    host.onOutput = { recorder.append($0) }

    try host.start(
        executable: script,
        cwd: try makeTemporaryDirectory(),
        columns: 80,
        rows: 24
    )

    // Entrée (`0x0D`) : c'est l'octet que la touche Retour envoie (S-5).
    try host.write(Array("bonjour\r".utf8))
    let echoed = await waitUntil { recorder.text.contains("bonjour\r") }
    #expect(echoed)

    // `OPOST|ONLCR` est CONSERVÉ sur la réplique (Doc-3) : le `\n` écrit par le fils
    // revient en `\r\n` sur le maître, sans quoi les lignes de la TUI seraient
    // décalées (elle n'émet aucun `CR` structurel, Doc-1 §2).
    try host.write(Array("ligne\n".utf8))
    let translated = await waitUntil { recorder.text.contains("ligne\r\n") }
    #expect(translated)

    await host.kill()
}

@Test("terminal-integre/BR-1 : écrire sans process vivant est refusé")
@MainActor
func writeWithoutRunningChildIsRefused() async throws {
    let host = TerminalHost()
    #expect(throws: TerminalHostError.notRunning) {
        try host.write([0x0D])
    }
}

// MARK: - BR-1 étape 6 : la mort spontanée

@Test("terminal-integre/BR-1 : la mort spontanée du fils est rapportée avec son code puis son signal")
@MainActor
func spontaneousExitIsReported() async throws {
    // Fin propre : `WIFEXITED`.
    let cleanExit = try makeChildScript("exit 3")
    let cleanRecorder = TerminalRecorder()
    let cleanHost = TerminalHost()
    cleanHost.onExit = { cleanRecorder.record($0) }
    try cleanHost.start(
        executable: cleanExit,
        cwd: try makeTemporaryDirectory(),
        columns: 80,
        rows: 24
    )
    _ = await waitUntil { !cleanRecorder.exits.isEmpty }
    #expect(cleanRecorder.exits.first == TerminalExit(status: 3, reason: .exited))
    #expect(cleanHost.pid == nil)

    // Mort subie : `WIFSIGNALED` — 15 est bien un SIGNAL, pas un code de sortie.
    let signalledExit = try makeChildScript("kill -TERM $$")
    let signalledRecorder = TerminalRecorder()
    let signalledHost = TerminalHost()
    signalledHost.onExit = { signalledRecorder.record($0) }
    try signalledHost.start(
        executable: signalledExit,
        cwd: try makeTemporaryDirectory(),
        columns: 80,
        rows: 24
    )
    _ = await waitUntil { !signalledRecorder.exits.isEmpty }
    #expect(signalledRecorder.exits.first == TerminalExit(status: SIGTERM, reason: .uncaughtSignal))

    // `kill()` après une mort spontanée est sans effet et ne lève rien.
    await signalledHost.kill()
    #expect(signalledHost.isRunning == false)
}

@Test("terminal-integre/BR-1 : un répertoire de travail inexistant fait sortir le fils en 127")
@MainActor
func missingWorkingDirectoryExitsWith127() async throws {
    let script = try makeChildScript("exit 0")
    let recorder = TerminalRecorder()
    let host = TerminalHost()
    host.onExit = { recorder.record($0) }

    // `forkpty` réussit, `chdir` échoue dans le fils : `_exit(127)` (S-1).
    try host.start(
        executable: script,
        cwd: URL(fileURLWithPath: "/nonexistent-\(UUID().uuidString)"),
        columns: 80,
        rows: 24
    )
    _ = await waitUntil { !recorder.exits.isEmpty }
    #expect(recorder.exits.first == TerminalExit(status: 127, reason: .exited))
}
