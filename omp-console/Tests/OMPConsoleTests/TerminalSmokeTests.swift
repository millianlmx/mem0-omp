// Le harnais RÉEL de la fenêtre « Terminal » : il lance le VRAI shell de connexion
// du poste dans un PTY (`TerminalShell.command`, S-18 R6), y TAPE `omp` comme le
// fait « Lancer omp », et fait passer les octets dans l'émulateur. C'est la seule
// preuve qui exerce l'aller-retour modèle (AC-6), la vraie TUI plein écran (AC-1,
// AC-5, AC-7) et la fermeture sans orphelin de la chaîne app → shell → omp.
//
// Il est DÉSACTIVÉ par défaut (`MEM0_TERMINAL_RECIPE`) : aucun script de CI ne pose
// cette variable, donc la suite reste déterministe et sans appel modèle. Recette
// manuelle :
//
//   cd omp-console && MEM0_TERMINAL_RECIPE=1 swift test --scratch-path .build-tests --no-parallel \
//     --filter realOmp -Xswiftc -plugin-path \
//     -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing"
//
// Variable posée sans `omp` résoluble (`OmpBinaryResolver`) ⇒ chaque test échoue
// explicitement, jamais un faux succès.
//
// Trois pièges mesurés sur ce harnais, tous corrigés ici :
//   — omp peint son premier cadre AVANT d'émettre ses sondes (DA1/OSC 11/CPR) : une
//     assertion sur les réponses lue trop tôt échoue sans que rien ne soit cassé ;
//   — la TUI ANIME (spinner, compteur de jetons), donc aucun état d'écran n'est
//     « stable » : les preuves portent sur des contenus qui ne peuvent pas venir
//     d'une animation (texte de conversation, nombre de caractères peints) ;
//   — omp peint son premier cadre APRÈS ~7 Kio mais finit son amorçage à ~163 Kio :
//     un prompt envoyé trop tôt reste dans la barre de saisie, sans être soumis, et
//     la TUI reste ensuite inerte (le flux d'octets ne repart jamais). La preuve
//     d'AC-6 attend donc le REPOS du flux (`waitForRest`) avant d'envoyer.

import AppKit
import Foundation
import Testing
@testable import OMPConsole

private var recipeEnabled: Bool {
    ProcessInfo.processInfo.environment["MEM0_TERMINAL_RECIPE"] != nil
}

private enum RecipeError: Error, CustomStringConvertible {
    case ompMissing

    var description: String {
        "MEM0_TERMINAL_RECIPE est posée mais `omp` est introuvable : posez \(OmpBinaryResolver.overrideKey) sur un `omp` exécutable, ou retirez MEM0_TERMINAL_RECIPE."
    }
}

/// Le process vit-il encore ? (`ESRCH` = disparu ; un zombie compte comme vivant
/// tant qu'il n'est pas récolté, d'où l'attente bornée des appelants.)
private func processExists(_ pid: Int32) -> Bool {
    errno = 0
    return kill(pid, 0) == 0 || errno == EPERM
}

/// Les caractères de cadre que seule une TUI dessine : un terminal qui afficherait
/// la sortie d'une commande n'en contiendrait aucun.
private let boxDrawing = Set("─│╭╮╰╯├┤┴┬┼┌┐└┘")

@MainActor
private final class RealTerminal {
    let host = TerminalHost()
    let emulator: TerminalEmulator
    private(set) var replies: [[UInt8]] = []
    private(set) var totalBytes = 0
    private(set) var lastByteAt = Date()

    init(columns: Int = 80, rows: Int = 24) {
        emulator = TerminalEmulator(columns: columns, rows: rows, palette: TerminalPalette.live())
        host.onOutput = { [weak self] bytes in
            guard let self else { return }
            self.totalBytes += bytes.count
            self.lastByteAt = Date()
            self.emulator.feed(bytes)
        }
        emulator.onReply = { [weak self] bytes in
            guard let self else { return }
            self.replies.append(bytes)
            try? self.host.write(bytes)
        }
    }

    /// Le shell de connexion du poste, puis `omp` tapé dedans (les octets mêmes de
    /// « Lancer omp »). `omp` doit être résoluble : c'est le prérequis de la recette.
    func launch() throws {
        guard case .success = OmpBinaryResolver.resolve(environment: ProcessInfo.processInfo.environment) else {
            throw RecipeError.ompMissing
        }
        let shell = TerminalShell.command(environment: ProcessInfo.processInfo.environment, fileManager: .default)
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        try host.start(
            executable: shell.executable,
            arguments: shell.arguments,
            cwd: cwd,
            columns: emulator.screen.columns,
            rows: emulator.screen.rows
        )
        try host.write(TerminalShell.launchOmpKeys)
    }

    /// Les enfants du shell (`pgrep -P`) : `omp` lancé depuis le shell en est un —
    /// c'est un job du shell, pas un enfant de l'app.
    func shellChildren() -> [Int32] {
        guard let shell = host.pid else { return [] }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        process.arguments = ["-P", String(shell)]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return [] }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(decoding: data, as: UTF8.self).split(separator: "\n").compactMap { Int32($0) }
    }

    /// Le texte de toute la grille : ce que la fenêtre peint.
    var text: String {
        (0..<emulator.screen.rows).map { emulator.screen.text(row: $0) }.joined(separator: "\n")
    }

    var nonBlankRows: Int {
        (0..<emulator.screen.rows)
            .filter { !emulator.screen.text(row: $0).trimmingCharacters(in: .whitespaces).isEmpty }
            .count
    }

    /// Le nombre de caractères RÉELLEMENT peints : une animation n'en ajoute que
    /// quelques-uns, une réponse de modèle en ajoute des dizaines.
    var paintedCharacters: Int {
        text.filter { !$0.isWhitespace }.count
    }

    var hasBoxDrawing: Bool {
        text.contains { boxDrawing.contains($0) }
    }

    /// La réponse du modèle est peinte SOUS le message utilisateur, et elle n'est pas
    /// l'écho de ce message.
    ///
    /// Deux mesures, dans cet ordre :
    /// 1. une ligne porte le message tel qu'il a été TAPÉ (il est donc dans la
    ///    conversation : omp l'a soumis, il n'est pas resté dans la barre de saisie) ;
    /// 2. une ligne SOUS celle-là porte le marqueur SANS porter le message : c'est du
    ///    contenu qu'omp a peint après avoir reçu la réponse, il ne peut venir ni de
    ///    la frappe ni de son écho.
    ///
    /// Le comptage d'occurrences ne pouvait pas faire cette distinction (mesuré : le
    /// marqueur tapé et son écho donnent déjà deux occurrences, et une réponse
    /// bavarde en donne autant que le viewport en montre — B-3 exclut le scrollback).
    func answers(prompt: String, marker: String) -> Bool {
        let rows = (0..<emulator.screen.rows).map { emulator.screen.text(row: $0) }
        guard let echo = rows.firstIndex(where: { $0.contains(prompt) && $0.contains(marker) }) else {
            return false
        }
        return rows[(echo + 1)...].contains { $0.contains(marker) && !$0.contains(prompt) }
    }

    /// Attend que le flux d'octets se TAISE : omp a fini son amorçage et sa boucle
    /// d'entrée attend la frappe.
    ///
    /// Mesuré : omp peint son premier cadre après ~7 Kio puis émet ~163 Kio en moins
    /// de 4 s, et ne dit plus rien tant que rien n'est tapé. Un prompt envoyé pendant
    /// l'amorçage (au premier cadre) reste dans la barre de saisie, sans être soumis,
    /// et la TUI reste ensuite inerte : le seuil d'octets écarte ce faux repos.
    func waitForRest(quiet: Double = 2, minimumBytes: Int = 60_000, timeout: Double = 60) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        func atRest() -> Bool {
            totalBytes >= minimumBytes && Date().timeIntervalSince(lastByteAt) >= quiet
        }
        while Date() < deadline {
            if atRest() { return true }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return atRest()
    }

    /// La plus longue suite ininterrompue d'un caractère donné : une règle de cadre
    /// pleine largeur. C'est la seule mesure qui distingue un écran repeint à la
    /// NOUVELLE largeur d'un ancien écran simplement réancré (S-6 : `resize` ne
    /// réécrit pas les cellules, il les vide à droite).
    func longestRun(of character: Character) -> Int {
        var longest = 0
        var current = 0
        for scalar in text {
            if scalar == character {
                current += 1
                longest = max(longest, current)
            } else {
                current = 0
            }
        }
        return longest
    }

    func send(_ text: String) {
        try? host.write(Array(text.utf8))
    }

    func send(bytes: [UInt8]) {
        try? host.write(bytes)
    }

    /// Attend qu'une condition devienne vraie, sans bloquer le fil principal.
    func poll(timeout: Double, _ condition: @MainActor () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(50))
        }
        return condition()
    }
}

@MainActor
@Test("terminal-integre/AC-1 : un vrai omp peint sa TUI dans la fenêtre", .enabled(if: recipeEnabled))
func realOmpPaintsItsTUI() async throws {
    let terminal = RealTerminal()
    try terminal.launch()

    // Une TUI : plusieurs rangées peintes, un cadre, et les sondes d'omp ont reçu
    // leur réponse (DA1 au minimum) — donc le démarrage est déterministe.
    #expect(await terminal.poll(timeout: 30) { terminal.nonBlankRows >= 5 && terminal.hasBoxDrawing })
    #expect(await terminal.poll(timeout: 10) { !terminal.replies.isEmpty })
    #expect(terminal.host.isRunning)
    #expect(terminal.paintedCharacters > 200)

    // `omp` est un job du SHELL (S-18 R6) : un seul enfant de l'app (le shell), et
    // fermer le terminal ne laisse aucun orphelin de la chaîne app → shell → omp.
    let jobs = terminal.shellChildren()
    #expect(!jobs.isEmpty, "omp doit tourner comme enfant du shell")
    await terminal.host.kill()
    #expect(!terminal.host.isRunning)
    for job in jobs {
        #expect(await terminal.poll(timeout: 5) { !processExists(job) }, "le job \(job) du shell survit à la fermeture")
    }
}

@MainActor
@Test("terminal-integre/AC-5 : la frappe part dans omp, Ctrl-C ne tue ni l'app ni omp", .enabled(if: recipeEnabled))
func realOmpReceivesTyping() async throws {
    let terminal = RealTerminal()
    try terminal.launch()
    #expect(await terminal.poll(timeout: 30) { terminal.hasBoxDrawing })
    // omp lancé DEPUIS LE SHELL ne pose son mode brut qu'en cours d'amorçage : avant,
    // le PTY est encore canonique (S-18), la frappe y est ÉCHOÉE par le noyau et
    // Ctrl-C y est un `SIGINT` qui tue omp (mesuré : comme dans tout terminal). La
    // preuve attend donc le REPOS du flux, comme AC-6.
    #expect(await terminal.waitForRest())
    let jobs = terminal.shellChildren()
    #expect(!jobs.isEmpty, "omp doit tourner comme enfant du shell")

    terminal.send("hello-terminal")
    #expect(await terminal.poll(timeout: 15) { terminal.text.contains("hello-terminal") })

    terminal.send(bytes: [0x03])
    try? await Task.sleep(for: .seconds(1))
    // Ni le shell ni omp ne meurent : omp a posé son propre mode brut, Ctrl-C lui
    // est donc arrivé comme un OCTET et non comme un `SIGINT` de la discipline de
    // ligne (que le PTY garde pour les commandes ordinaires du shell, S-18).
    #expect(terminal.host.isRunning)
    for job in jobs {
        #expect(processExists(job), "omp (pid \(job)) est mort sur Ctrl-C")
    }
    await terminal.host.kill()
}

@MainActor
@Test("terminal-integre/AC-6 : un prompt obtient une réponse du modèle dans la TUI", .enabled(if: recipeEnabled))
func realOmpAnswersAPrompt() async throws {
    let terminal = RealTerminal()
    try terminal.launch()
    #expect(await terminal.poll(timeout: 30) { terminal.hasBoxDrawing && terminal.nonBlankRows >= 5 })
    // La TUI est AFFICHÉE et au repos : l'AC commence ici, on n'envoie pas un prompt
    // pendant l'amorçage (mesuré : non soumis, TUI inerte).
    #expect(await terminal.waitForRest())

    let prompt = "Réponds exactement : RECETTE-TERMINAL"
    let marker = "RECETTE-TERMINAL"
    terminal.send(prompt + "\r")

    // La réponse du modèle s'affiche dans la TUI : une ligne SOUS le message
    // utilisateur porte le marqueur sans être cet écho, et cet état RESTE (une
    // réponse de modèle n'est pas une animation de la TUI).
    #expect(await terminal.poll(timeout: 120) { terminal.answers(prompt: prompt, marker: marker) })
    try? await Task.sleep(for: .seconds(3))
    #expect(terminal.answers(prompt: prompt, marker: marker))
    #expect(terminal.host.isRunning)
    await terminal.host.kill()
}

@MainActor
@Test("terminal-integre/AC-7 : un vrai omp redessine après un redimensionnement", .enabled(if: recipeEnabled))
func realOmpRedrawsAfterResize() async throws {
    let terminal = RealTerminal()
    try terminal.launch()
    #expect(await terminal.poll(timeout: 30) { terminal.hasBoxDrawing })

    let before = terminal.nonBlankRows
    let beforeRule = terminal.longestRun(of: "─")
    terminal.host.resize(columns: 120, rows: 40)
    terminal.emulator.resize(columns: 120, rows: 40)

    #expect(terminal.emulator.screen.columns == 120)
    #expect(terminal.emulator.screen.rows == 40)
    // omp reçoit SIGWINCH (TIOCSWINSZ) et REPEINT à la nouvelle largeur : un
    // caractère de cadre PLUS LONG que sur l'ancien écran ne peut venir que d'octets
    // fraîchement peints — le `resize` de la grille, lui, ne fait que vider les
    // cellules à droite, il ne rallonge jamais une suite déjà écrite.
    #expect(await terminal.poll(timeout: 30) { terminal.longestRun(of: "─") > beforeRule })
    #expect(await terminal.poll(timeout: 30) { terminal.hasBoxDrawing && terminal.nonBlankRows >= 5 })
    #expect(terminal.nonBlankRows >= before / 2)
    await terminal.host.kill()
}
