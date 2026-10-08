// Preuves du MODÈLE de la fenêtre « Terminal » (S-1, S-6, S-7, S-8, S-9, S-10 ;
// S-18 R6) : le cycle de vie du shell hébergé, le refus du double lancement, les
// états de la fenêtre, « Lancer omp » et la coexistence avec la session servie par
// l'API (aucun process `omp` côté app).
//
// Les preuves ne dépendent PAS d'`omp` ni du shell du poste : le shell est celui
// que désigne `$SHELL` (`TerminalShell.command`), donc un script jetable qui fait
// exactement ce que le test observe — écrire une ligne, servir d'écho, signaler un
// redimensionnement. Le vrai shell et le vrai `omp` sont prouvés par le harnais
// réel (TerminalSmokeTests, désactivé par défaut).

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
private func makeTerminalModel(
    shell: URL,
    projectRoot: String,
    host: TerminalHost = TerminalHost(),
    environment: [String: String] = ["PATH": "/usr/bin:/bin"]
) -> TerminalConsoleModel {
    let suite = UserDefaults(suiteName: "terminal-console-model-\(UUID().uuidString)") ?? .standard
    suite.set(projectRoot, forKey: ProjectRoot.defaultsKey)
    var environment = environment
    environment["SHELL"] = shell.path
    return TerminalConsoleModel(
        host: host,
        defaults: suite,
        environment: environment,
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

/// Le parent d'un pid, tel que le noyau le voit : c'est ainsi qu'on prouve que le
/// shell est un enfant DIRECT de l'app (AC-1), sans intermédiaire.
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
    // Le shell de substitution imprime ses arguments : `-l` prouve le shell de
    // CONNEXION de S-18 R6, de bout en bout jusqu'à la grille.
    let shell = try makeScript("printf 'SHELL-READY args=%s\\n' \"$*\"\nexec /bin/cat", in: directory, named: "fake-shell")
    let host = TerminalHost()
    let model = makeTerminalModel(shell: shell, projectRoot: directory, host: host)

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
    #expect(await awaitMainTrue { grid(model).contains("SHELL-READY args=-l") })
    #expect(model.emulator?.screen.cursorVisible == true)
    await host.kill()
}

// MARK: - AC-2

@MainActor
@Test("terminal-integre/AC-2 : redemander l'ouverture ne lance aucun second programme")
func reopeningDoesNotSpawnASecondProcess() async throws {
    let directory = try makeScratchDirectory()
    let other = try makeScratchDirectory()
    let shell = try makeScript("printf 'READY\\n'\nexec /bin/cat", in: directory, named: "fake-shell")
    let host = TerminalHost()
    let model = makeTerminalModel(shell: shell, projectRoot: directory, host: host)

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

// MARK: - AC-3 et S-18 R6 : `omp` n'est pas un prérequis du terminal

@MainActor
@Test("omp-console-redesign/S-18 : sans omp résoluble, le terminal lance quand même le shell")
func missingOmpDoesNotPreventTheShell() async throws {
    let directory = try makeScratchDirectory()
    let shell = try makeScript("printf 'READY\\n'\nexec /bin/cat", in: directory, named: "fake-shell")
    let host = TerminalHost()
    // Aucun `omp` nulle part : l'échappatoire pointe dans le vide, et ni `PATH` ni
    // `HOME` ne mènent à un binaire.
    let model = makeTerminalModel(
        shell: shell,
        projectRoot: directory,
        host: host,
        environment: [
            OmpBinaryResolver.overrideKey: "/nonexistent/omp",
            "PATH": "/nonexistent",
            "HOME": "/nonexistent",
        ]
    )

    model.start(target: makeTarget(directory, label: "socle"))

    #expect(model.isRunning)
    #expect(await awaitMainTrue { grid(model).contains("READY") })
    await host.kill()
}

@MainActor
@Test("omp-console-redesign/S-18 : « Lancer omp » tape omp dans le shell vivant, et seulement là")
func launchOmpTypesTheCommandIntoTheLiveShell() async throws {
    let directory = try makeScratchDirectory()
    // Le shell de substitution lit UNE ligne et la rend préfixée : « lu:omp » ne
    // peut venir que d'une ligne LUE (l'écho du PTY n'a pas de préfixe), donc la
    // commande a été soumise par son Retour.
    let shell = try makeScript("read line\nprintf 'lu:%s\\n' \"$line\"\nexec /bin/cat", in: directory, named: "fake-shell")
    let host = TerminalHost()
    let model = makeTerminalModel(shell: shell, projectRoot: directory, host: host)

    // Aucun shell : le bouton est inactif et l'appel ne fait rien.
    #expect(!model.canLaunchOmp)
    model.launchOmp()
    #expect(host.pid == nil)

    model.start(target: makeTarget(directory, label: "socle"))
    #expect(model.canLaunchOmp)
    model.launchOmp()
    #expect(await awaitMainTrue { grid(model).contains("lu:omp") })
    #expect(model.windowSubtitle.hasPrefix(TerminalViewText.ompKind))
    // Taper `omp` ne lance aucun second enfant de l'app : le shell reste LE process.
    #expect(model.isRunning)

    // Shell mort : plus rien à qui taper.
    await host.kill()
    #expect(await awaitMainTrue { !model.isRunning })
    #expect(!model.canLaunchOmp)
}

@MainActor
@Test("terminal-integre/AC-3 : un répertoire disparu refuse le lancement avec son message")
func vanishedDirectoryRefusesTheLaunch() async throws {
    let directory = try makeScratchDirectory()
    let shell = try makeScript("exec /bin/cat", in: directory, named: "fake-shell")
    let model = makeTerminalModel(shell: shell, projectRoot: directory)
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
    // Le shell de substitution se comporte comme un shell interactif : il lit des
    // lignes et les rend préfixées (« lu:hello » ne peut venir que d'une ligne LUE,
    // pas de l'écho du PTY), et il SURVIT à Ctrl-C en le traitant. Le PTY naît dans
    // les réglages par défaut du noyau (S-18) : 0x03 y devient `SIGINT` pour le
    // groupe au premier plan, que le piège rend visible.
    let shell = try makeScript(
        "trap 'echo INTERROMPU' INT\nwhile :; do\n  if read line; then printf 'lu:%s\\n' \"$line\"; fi\ndone",
        in: directory,
        named: "fake-shell"
    )
    let host = TerminalHost()
    let model = makeTerminalModel(shell: shell, projectRoot: directory, host: host)

    model.start(target: makeTarget(directory, label: "socle"))
    #expect(await awaitMainTrue { model.isRunning })

    model.send(keys: TerminalKeys.bytes(characters: "hello", modifiers: [], keyCode: 0) ?? [])
    model.send(keys: TerminalKeys.bytes(characters: "\r", modifiers: [], keyCode: 36) ?? [])
    #expect(await awaitMainTrue { grid(model).contains("lu:hello") })

    model.send(keys: [0x03])
    #expect(await awaitMainTrue { grid(model).contains("INTERROMPU") })
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
    let shell = try makeScript(
        "trap 'stty size' WINCH\nstty size\nwhile :; do sleep 0.05; done",
        in: directory,
        named: "fake-shell"
    )
    let host = TerminalHost()
    let model = makeTerminalModel(shell: shell, projectRoot: directory, host: host)

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
    let shell = try makeScript("sleep 300 & wait", in: directory, named: "fake-shell")
    let host = TerminalHost()
    let model = makeTerminalModel(shell: shell, projectRoot: directory, host: host)

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
    let shell = try makeScript("sleep 300 & wait", in: directory, named: "fake-shell")
    let host = TerminalHost()
    let model = makeTerminalModel(shell: shell, projectRoot: directory, host: host)

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
@Test("terminal-integre/AC-10 : un terminal et la session servie vivent et meurent indépendamment")
func terminalAndServiceSessionAreIndependent() async throws {
    let directory = try makeScratchDirectory()
    let shell = try makeScript("exec /bin/cat -v", in: directory, named: "fake-shell")
    let terminalHost = TerminalHost()
    let terminal = makeTerminalModel(shell: shell, projectRoot: directory, host: terminalHost)

    // 1) Le terminal vit D'ABORD.
    terminal.start(target: makeTarget(directory, label: "socle"))
    #expect(await awaitMainTrue { terminal.isRunning })

    // 2) La session servie démarre PENDANT : l'app ne lance AUCUN process pour
    //    elle — c'est le service qui la porte — et son état est indépendant du PTY.
    let transport = ScriptedServiceTransport()
    transport.stubJSON("POST", "/v1/sessions", [
        "id": "session-abcdef12", "cwd": directory, "purpose": "session", "state": "running",
    ])
    transport.stubJSON("POST", "/prompt", ["accepted": true])
    transport.stubJSON("DELETE", "/v1/sessions/session-abcdef12", ["closed": true])
    // Le flux scripté, puis des flux de queue : à court de flux, le double lève
    // « service arrêté » et la session passerait `dead` (chaque réouverture coûte
    // le `retryDelay` de 25 ms).
    transport.scriptStream(serviceFrame("state", ["state": "running"]))
    for _ in 0..<20 { transport.scriptStream(serviceFrame("state", ["state": "running"])) }
    let host = ServiceSessionModel(
        purpose: "session",
        makeClient: { scriptedClient(transport) },
        maxAttempts: 5,
        retryDelay: { _ in .milliseconds(25) }
    )
    let suite = UserDefaults(suiteName: "terminal-ac10-\(UUID().uuidString)") ?? .standard
    suite.set(directory, forKey: ProjectRoot.defaultsKey)
    let session = SessionConsoleModel(host: host, defaults: suite)
    session.launch()

    #expect(await awaitMainTrue(timeout: 4) { host.state == .running })
    // Les deux vivent, indépendamment : la session est celle du service (pid 4242,
    // l'endpoint scripté), jamais un enfant de l'app comme le shell du terminal.
    #expect(terminal.isRunning)
    #expect(host.sessionId == "session-abcdef12")
    #expect(host.pid == 4_242)
    #expect(host.pid != terminalHost.pid)

    // La session servie répond encore, terminal vivant.
    session.prompt = "ping"
    session.sendPrompt()
    let prompted = await awaitMainTrue {
        transport.requests.contains { $0.method == "POST" && $0.path.hasSuffix("/prompt") }
    }
    #expect(prompted)

    // Le terminal vit toujours et son PTY porte encore les octets.
    terminal.send(keys: Array("ok".utf8))
    #expect(await awaitMainTrue { grid(terminal).contains("ok") })

    // Réciproquement : arrêter la session servie ne perturbe pas le terminal.
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
    let shell = try makeScript("printf 'READY\\n'\nexec /bin/cat", in: directory, named: "fake-shell")
    let host = TerminalHost()
    let model = makeTerminalModel(shell: shell, projectRoot: directory, host: host)

    #expect(model.statusText == TerminalViewText.chooseHint)
    #expect(model.windowTitle == TerminalViewText.windowTitle)
    #expect(model.windowSubtitle.isEmpty)

    model.openPicker()
    #expect(model.statusText == TerminalViewText.listing || model.statusText == TerminalViewText.chooseHint)

    model.start(target: makeTarget(directory, label: "socle"))
    guard case let .running(pid) = model.state else {
        Issue.record("état attendu running, obtenu \(model.state)")
        return
    }
    // La fenêtre porte le nom du répertoire, jamais le pid du shell.
    #expect(model.windowTitle == (directory as NSString).lastPathComponent)
    #expect(!model.statusText.contains(String(pid)))
    #expect(!model.windowSubtitle.contains(String(pid)))
    #expect(model.windowSubtitle.hasPrefix(TerminalViewText.shellKind))

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
