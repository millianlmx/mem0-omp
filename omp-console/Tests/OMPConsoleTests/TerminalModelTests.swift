// Preuves du MODÈLE de la fenêtre « Terminal » (S-1, S-6, S-7, S-8, S-9, S-10) :
// le cycle de vie du process hébergé, le refus du double lancement, les états de
// la fenêtre et la coexistence avec la session RPC.
//
// Les preuves ne dépendent PAS d'`omp` : le binaire est celui de l'échappatoire
// documentée `OMP_CONSOLE_OMP_BINARY` (OmpBinaryResolver), donc un script jetable
// qui fait exactement ce que le test observe — écrire une ligne, servir d'écho,
// signaler un redimensionnement. Le vrai `omp` est prouvé par le harnais réel
// (TerminalSmokeTests, désactivé par défaut).

import AppKit
import Darwin
import Foundation
import Testing
@testable import OMPConsole

// MARK: - Outils

@MainActor
private func makeScratchDirectory() throws -> String {
    let path = canonicalPath(
        (NSTemporaryDirectory() as NSString).appendingPathComponent("omp-terminal-\(UUID().uuidString)")
    )
    try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    return path
}

/// Un binaire de substitution : un script `/bin/sh` exécutable, comme le veut le
/// modèle de process (l'hôte lance UN programme, jamais un shell intermédiaire —
/// le script est ici ce programme).
private func makeScript(_ body: String, in directory: String, named name: String) throws -> URL {
    let path = (directory as NSString).appendingPathComponent(name)
    try Data(("#!/bin/sh\n" + body + "\n").utf8).write(to: URL(fileURLWithPath: path))
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path)
    return URL(fileURLWithPath: path)
}

@MainActor
private func makeTerminalModel(binary: URL, projectRoot: String, host: TerminalHost = TerminalHost()) -> TerminalConsoleModel {
    let suite = UserDefaults(suiteName: "terminal-console-model-\(UUID().uuidString)") ?? .standard
    suite.set(projectRoot, forKey: ProjectRoot.defaultsKey)
    return TerminalConsoleModel(
        host: host,
        defaults: suite,
        environment: [
            OmpBinaryResolver.overrideKey: binary.path,
            "PATH": "/usr/bin:/bin",
        ],
        git: filesGit()
    )
}

private func makeTarget(_ path: String, label: String, isPrimary: Bool = true) -> FilesTarget {
    FilesTarget(path: path, label: label, branch: nil, isPrimary: isPrimary, base: .head)
}

/// Le texte affiché par la grille de l'émulateur : c'est ce que la fenêtre peint.
@MainActor
private func grid(_ model: TerminalConsoleModel) -> String {
    guard let screen = model.emulator?.screen else { return "" }
    return (0..<screen.rows).map { screen.text(row: $0) }.joined(separator: "\n")
}

/// Le parent d'un pid, tel que le noyau le voit : c'est ainsi qu'on prouve qu'`omp`
/// est un enfant DIRECT de l'app (AC-1), sans shell intermédiaire.
private func parentProcess(of pid: Int32) -> Int32? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/ps")
    process.arguments = ["-o", "ppid=", "-p", String(pid)]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return nil }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return Int32(String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
}

/// Le groupe de process entier a disparu : plus aucun descendant, donc aucun
/// orphelin (S-7, S-8).
private func processGroupIsGone(_ pid: Int32) -> Bool {
    errno = 0
    return kill(-pid, 0) == -1 && errno == ESRCH
}

// MARK: - AC-1

@MainActor
@Test("terminal-integre/AC-1 : le programme hébergé est un enfant DIRECT et sa sortie s'affiche")
func hostedProgramIsADirectChildAndItsOutputIsRendered() async throws {
    let directory = try makeScratchDirectory()
    let binary = try makeScript("printf 'OMP-READY\\n'\nexec /bin/cat", in: directory, named: "fake-omp")
    let host = TerminalHost()
    let model = makeTerminalModel(binary: binary, projectRoot: directory, host: host)

    #expect(model.state == .idle)
    #expect(model.emulator == nil)
    model.start(target: makeTarget(directory, label: "socle"))

    guard case let .running(pid) = model.state else {
        Issue.record("l'état attendu après start est running, obtenu \(model.state)")
        return
    }
    #expect(pid > 0)
    #expect(host.isRunning)
    // Enfant DIRECT de l'app : le parent du pid publié est le process de test.
    #expect(parentProcess(of: pid) == getpid())
    // Le PTY porte les octets jusqu'à la grille : l'écran n'est jamais vide.
    #expect(await awaitMainTrue { grid(model).contains("OMP-READY") })
    #expect(model.emulator?.screen.cursorVisible == true)
}

// MARK: - AC-2

@MainActor
@Test("terminal-integre/AC-2 : redemander l'ouverture ne lance aucun second programme")
func reopeningDoesNotSpawnASecondProcess() async throws {
    let directory = try makeScratchDirectory()
    let other = try makeScratchDirectory()
    let binary = try makeScript("printf 'READY\\n'\nexec /bin/cat", in: directory, named: "fake-omp")
    let host = TerminalHost()
    let model = makeTerminalModel(binary: binary, projectRoot: directory, host: host)

    model.start(target: makeTarget(directory, label: "première"))
    let firstPid = host.pid
    #expect(firstPid != nil)
    #expect(await awaitMainTrue { grid(model).contains("READY") })

    // Un second appel — c'est ce que ferait un second « Ouvrir » — est REFUSÉ sans
    // effet : même pid, même cible, aucun nouveau process.
    #expect(!model.canStart)
    model.start(target: makeTarget(other, label: "seconde"))
    #expect(host.pid == firstPid)
    #expect(model.target?.label == "première")
    if case let .running(pid) = model.state {
        #expect(pid == firstPid)
    } else {
        Issue.record("l'état ne doit pas changer sur un second lancement refusé : \(model.state)")
    }
    await host.kill()
}

// MARK: - AC-3

@MainActor
@Test("terminal-integre/AC-3 : un binaire introuvable affiche l'erreur, sans lancer de process")
func missingBinaryShowsAnExplicitError() async throws {
    let directory = try makeScratchDirectory()
    let missing = (directory as NSString).appendingPathComponent("omp-introuvable")
    let host = TerminalHost()
    let model = makeTerminalModel(binary: URL(fileURLWithPath: missing), projectRoot: directory, host: host)

    model.start(target: makeTarget(directory, label: "socle"))

    let expected = SessionHostError.binaryNotFound(searched: [missing], override: missing).userMessage
    #expect(model.state == .failed(expected))
    // La fenêtre n'est JAMAIS vide (AC-3) : l'état porte le message d'erreur.
    #expect(model.statusText == expected)
    #expect(model.statusText.contains("Binaire `omp` introuvable"))
    #expect(model.emulator == nil)
    #expect(host.pid == nil)
    #expect(!host.isRunning)
}

@MainActor
@Test("terminal-integre/AC-3 : un répertoire disparu refuse le lancement avec son message")
func vanishedDirectoryRefusesTheLaunch() async throws {
    let directory = try makeScratchDirectory()
    let binary = try makeScript("exec /bin/cat", in: directory, named: "fake-omp")
    let model = makeTerminalModel(binary: binary, projectRoot: directory)
    let gone = (directory as NSString).appendingPathComponent("disparu")

    model.start(target: makeTarget(gone, label: "disparu"))

    #expect(model.state == .failed(TerminalViewText.cwdMissing(gone)))
    #expect(model.statusText == "Répertoire introuvable : \(gone).")
    #expect(model.emulator == nil)
}

// MARK: - AC-5 (côté modèle : les octets atteignent le programme)

@MainActor
@Test("terminal-integre/AC-5 : la frappe atteint le programme, Ctrl-C ne tue ni l'app ni le process")
func keyboardBytesReachTheProgram() async throws {
    let directory = try makeScratchDirectory()
    // `cat -v` rend VISIBLE un octet de contrôle : « ^C » prouve que 0x03 a
    // traversé le PTY au lieu d'être transformé en SIGINT par le noyau.
    let binary = try makeScript("exec /bin/cat -v", in: directory, named: "fake-omp")
    let host = TerminalHost()
    let model = makeTerminalModel(binary: binary, projectRoot: directory, host: host)

    model.start(target: makeTarget(directory, label: "socle"))
    #expect(await awaitMainTrue { model.isRunning })

    model.send(keys: TerminalKeys.bytes(characters: "hello", modifiers: [], keyCode: 0) ?? [])
    model.send(keys: TerminalKeys.bytes(characters: "\r", modifiers: [], keyCode: 36) ?? [])
    #expect(await awaitMainTrue { grid(model).contains("hello") })

    model.send(keys: [0x03])
    #expect(await awaitMainTrue { grid(model).contains("^C") })
    // Ni l'app ni le process ne meurent : l'état reste `running`.
    #expect(model.isRunning)
    #expect(host.isRunning)
    await host.kill()
}

// MARK: - AC-7

@MainActor
@Test("terminal-integre/AC-7 : redimensionner prévient le programme et la grille suit")
func resizeReachesBothTheProgramAndTheGrid() async throws {
    let directory = try makeScratchDirectory()
    let binary = try makeScript(
        "trap 'stty size' WINCH\nstty size\nwhile :; do sleep 0.05; done",
        in: directory,
        named: "fake-omp"
    )
    let host = TerminalHost()
    let model = makeTerminalModel(binary: binary, projectRoot: directory, host: host)

    model.viewDidMeasure(columns: 80, rows: 24)
    model.start(target: makeTarget(directory, label: "socle"))
    // La taille initiale est celle de la zone d'affichage, posée AVANT le fork.
    #expect(await awaitMainTrue { grid(model).contains("24 80") })

    model.viewDidMeasure(columns: 100, rows: 30)

    // Le programme reçoit SIGWINCH et lit la NOUVELLE taille (Doc-3 : TIOCSWINSZ la
    // délivre au groupe au premier plan, aucun signal à envoyer à la main).
    #expect(await awaitMainTrue(timeout: 5) { grid(model).contains("30 100") })
    // La grille elle-même est réajustée, sans reflow.
    #expect(model.emulator?.screen.columns == 100)
    #expect(model.emulator?.screen.rows == 30)
    await host.kill()
}

// MARK: - AC-8

@MainActor
@Test("terminal-integre/AC-8 : fermer la fenêtre tue le programme ET ses descendants")
func closingTheWindowKillsTheWholeGroup() async throws {
    let directory = try makeScratchDirectory()
    let binary = try makeScript("sleep 300 & wait", in: directory, named: "fake-omp")
    let host = TerminalHost()
    let model = makeTerminalModel(binary: binary, projectRoot: directory, host: host)

    model.start(target: makeTarget(directory, label: "socle"))
    guard case let .running(pid) = model.state else {
        Issue.record("le programme de substitution doit être vivant, état : \(model.state)")
        return
    }

    model.windowWillClose()

    // L'état FINAL est `.idle` : la séquence d'arrêt rend la main au modèle après la
    // récolte du groupe. Attendre `!host.isRunning` ne suffit pas — le process est
    // récolté AVANT que `shutdown()` n'ait fini son escalade, donc l'état serait lu
    // trop tôt (mesuré : `.running(pid:)` encore posé à cet instant).
    #expect(await awaitMainTrue(timeout: 8) { model.state == .idle })
    #expect(!host.isRunning)
    #expect(processGroupIsGone(pid))
    // L'app reste utilisable : la fenêtre peut relancer.
    #expect(model.canStart)
    // Fermer deux fois est idempotent.
    model.windowWillClose()
    #expect(await awaitMainTrue(timeout: 8) { model.state == .idle })
    #expect(model.canStart)
}

// MARK: - AC-9

@MainActor
@Test("terminal-integre/AC-9 : quitter l'app tue les terminaux vivants")
func quittingTheAppKillsLiveTerminals() async throws {
    let directory = try makeScratchDirectory()
    let binary = try makeScript("sleep 300 & wait", in: directory, named: "fake-omp")
    let host = TerminalHost()
    let model = makeTerminalModel(binary: binary, projectRoot: directory, host: host)

    model.start(target: makeTarget(directory, label: "socle"))
    guard case let .running(pid) = model.state else {
        Issue.record("le programme de substitution doit être vivant, état : \(model.state)")
        return
    }
    // C'est l'accroche que `applicationShouldTerminate` attend (S-8).
    #expect(AppDelegate.terminateTerminal != nil)

    await model.terminateForQuit()

    #expect(!host.isRunning)
    #expect(processGroupIsGone(pid))
    #expect(model.state == .idle)
}

// MARK: - AC-10

@MainActor
@Test("terminal-integre/AC-10 : un terminal et la session RPC vivent et meurent indépendamment")
func terminalAndRpcSessionAreIndependent() async throws {
    let directory = try makeScratchDirectory()
    let binary = try makeScript("exec /bin/cat -v", in: directory, named: "fake-omp")
    let terminalHost = TerminalHost()
    let terminal = makeTerminalModel(binary: binary, projectRoot: directory, host: terminalHost)

    // 1) Le terminal vit D'ABORD.
    terminal.start(target: makeTarget(directory, label: "socle"))
    #expect(await awaitMainTrue { terminal.isRunning })

    // 2) La session RPC démarre PENDANT : elle a son propre process (scripté ici) et
    //    son propre état.
    let transport = ScriptedRpcTransport()
    transport.readyLine = terminalJSONLine([
        "type": "ready",
        "protocolVersion": 1,
        "supportedProtocolVersions": [1, 2],
        "maxFrameBytes": 1_048_576,
        "maxReassembledFrameBytes": 67_108_864,
    ])
    transport.onWrite = { line in
        guard let object = terminalJSONObject(line),
              let type = object["type"] as? String,
              let id = object["id"] as? String
        else { return }
        if type == "negotiate_protocol" {
            transport.emit(terminalJSONLine([
                "type": "response",
                "id": id,
                "command": "negotiate_protocol",
                "success": true,
                "data": ["protocolVersion": 2],
            ]))
        }
    }
    let host = SessionHost(
        transport: transport,
        resolveBinary: { _ in .success(URL(fileURLWithPath: "/usr/bin/true")) },
        environment: [:],
        requestTimeout: .seconds(1),
        readyTimeout: .seconds(1),
        stopGrace: .milliseconds(80),
        killGrace: .milliseconds(80)
    )
    let suite = UserDefaults(suiteName: "terminal-ac10-\(UUID().uuidString)") ?? .standard
    suite.set(directory, forKey: ProjectRoot.defaultsKey)
    let session = SessionConsoleModel(host: host, defaults: suite)
    session.launch()

    #expect(await awaitMainTrue(timeout: 4) { host.state == .running })
    // Les deux vivent, sur des process distincts : aucune exclusivité.
    #expect(terminal.isRunning)
    #expect(transport.pid != nil)
    #expect(transport.pid != terminalHost.pid)

    // La session RPC répond encore, terminal vivant.
    session.prompt = "ping"
    session.sendPrompt()
    #expect(await awaitMainTrue { !transport.writtenCommands.isEmpty })

    // Le terminal vit toujours et son PTY porte encore les octets.
    terminal.send(keys: Array("ok".utf8))
    #expect(await awaitMainTrue { grid(terminal).contains("ok") })

    // Réciproquement : arrêter la session RPC ne perturbe pas le terminal.
    transport.onCloseStdin = { transport.emitExit(ProcessExit(status: 0, reason: .exited)) }
    session.stop()
    #expect(await awaitMainTrue { host.state == .stopped })
    #expect(terminal.isRunning)
    #expect(await awaitMainTrue { !grid(terminal).isEmpty })

    await terminalHost.kill()
}

// MARK: - S-10 (les textes d'état, un par état)

@MainActor
@Test("terminal-integre/AC-1 : chaque état de la fenêtre porte un texte, jamais un rectangle vide")
func everyStateHasItsText() async throws {
    let directory = try makeScratchDirectory()
    let binary = try makeScript("printf 'READY\\n'\nexec /bin/cat", in: directory, named: "fake-omp")
    let host = TerminalHost()
    let model = makeTerminalModel(binary: binary, projectRoot: directory, host: host)

    #expect(model.statusText == TerminalViewText.chooseHint)
    #expect(model.targetLabel == TerminalViewText.noTarget)

    model.openPicker()
    #expect(model.statusText == TerminalViewText.listing || model.statusText == TerminalViewText.chooseHint)

    model.start(target: makeTarget(directory, label: "socle"))
    guard case let .running(pid) = model.state else {
        Issue.record("état attendu running, obtenu \(model.state)")
        return
    }
    #expect(model.statusText == "omp vivant (pid \(pid)) · socle")

    // Fermer la fenêtre est le chemin de sortie de l'utilisateur : l'état repart à
    // `idle` (S-7), donc au texte d'accueil, et non à une fin « subie ».
    //
    // Le texte s'attend, comme l'état : `statusText` rend « Lecture des worktrees… »
    // tant que la liste des cibles est en cours de chargement (`openPicker()` plus
    // haut), donc l'accueil n'arrive qu'une fois cette lecture terminée — sur un
    // runner chargé elle est encore en vol (mesuré : `check (macos-latest)` de la
    // PR #48, `TerminalModelTests.swift:400`).
    model.windowWillClose()
    #expect(await awaitMainTrue(timeout: 8) { model.state == .idle })
    #expect(await awaitMainTrue(timeout: 8) { model.statusText == TerminalViewText.chooseHint })
    #expect(model.emulator == nil)
}

// MARK: - Trames JSONL (session RPC scriptée)

private func terminalJSONLine(_ object: [String: Any]) -> String {
    guard
        let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
        let text = String(data: data, encoding: .utf8)
    else { return "{}" }
    return text
}

private func terminalJSONObject(_ line: String) -> [String: Any]? {
    guard let data = line.data(using: .utf8), let raw = try? JSONSerialization.jsonObject(with: data) else {
        return nil
    }
    return raw as? [String: Any]
}
