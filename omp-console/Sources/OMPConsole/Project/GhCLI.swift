// Accès GitHub du suivi de PR (BR-1, S-2) : la SEULE surface extérieure de cette
// feature.
//
// Deux pièces séparées, comme `GitCLI` :
//  - `GhCommand` construit des `argv` PURS, sans rien exécuter — un test les fige ;
//  - `GhCLI` exécute, jamais par un shell, avec un environnement restreint.
//
// L'app est lancée par le Finder : son `PATH` est celui de launchd, où `gh`
// (Homebrew) n'est pas — d'où les candidats d'installation connus, comme
// `OmpBinaryResolver` le fait pour `omp`.
//
// Avec `--json`, `gh pr checks` sort 0 même quand des statuts sont en échec ou en
// attente (docs §3) : un code non nul signale donc un VRAI échec de lecture, jamais
// trois statuts rouges.

import Foundation

/// Résolution du binaire `gh` (S-2) : l'override seul, sinon chaque entrée de `PATH`
/// puis `/gh`, puis les emplacements d'installation connus.
enum GhBinary {
    static let overrideKey = "OMP_CONSOLE_GH_BINARY"

    static func candidates(environment: [String: String]) -> [String] {
        if let override = environment[overrideKey], !override.isEmpty {
            return [override]
        }
        var candidates: [String] = []
        if let path = environment["PATH"] {
            for entry in path.split(separator: ":", omittingEmptySubsequences: true) {
                candidates.append("\(entry)/gh")
            }
        }
        candidates.append("/opt/homebrew/bin/gh")
        candidates.append("/usr/local/bin/gh")
        candidates.append("/usr/bin/gh")
        return candidates
    }

    /// Le premier candidat EXÉCUTABLE gagne ; l'override, s'il est posé et non vide,
    /// est le SEUL candidat (un chemin explicite n'est jamais contourné).
    static func resolve(environment: [String: String], fileManager: FileManager = .default) -> Result<URL, GhError> {
        let searched = candidates(environment: environment)
        for candidate in searched where fileManager.isExecutableFile(atPath: candidate) {
            return .success(URL(fileURLWithPath: candidate))
        }
        let override = environment[overrideKey].flatMap { $0.isEmpty ? nil : $0 }
        return .failure(.ghNotFound(searched: searched, override: override))
    }
}

/// Les trois `argv` de la fonctionnalité, et RIEN d'autre : la sous-commande est
/// TOUJOURS `pr`, ses seconds mots sont exactement `view`, `checks`, `merge`.
enum GhCommand {
    static func prView(url: String) -> [String] {
        ["pr", "view", url, "--json", "title,headRefOid,body"]
    }

    static func prChecks(url: String) -> [String] {
        ["pr", "checks", url, "--json", "name,bucket,link"]
    }

    /// La SEULE écriture distante de la feature : un squash, borné à la tête lue
    /// (`--match-head-commit`). Jamais `--merge`/`--rebase`, jamais
    /// `--delete-branch`/`--auto`/`--admin` (S-6).
    static func prMerge(url: String, title: String, body: String, headOid: String) -> [String] {
        ["pr", "merge", url, "--squash", "--subject", title, "--body", body, "--match-head-commit", headOid]
    }
}

struct GhOutput: Sendable, Equatable {
    var code: Int32
    var stdout: String
    var stderr: String
}

struct GhCLI: Sendable {
    let binary: URL
    let timeout: Double

    init(binary: URL, timeout: Double = 60) {
        self.binary = binary
        self.timeout = timeout
    }

    /// L'environnement du process `gh` est RESTREINT (S-2) : `LANG=C` fige la langue,
    /// les invites sont coupées, la couleur et le vérificateur de mise à jour aussi ;
    /// le jeton et le dossier de configuration ne sont transmis que s'ils portent une
    /// valeur. Ni `GIT_DIR` ni `GIT_WORK_TREE` ne sont transmis.
    static func environment(_ source: [String: String] = ProcessInfo.processInfo.environment) -> [String: String] {
        var environment: [String: String] = [
            "LANG": "C",
            "PATH": source["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin",
            "GH_PROMPT_DISABLED": "1",
            "NO_COLOR": "1",
            "GH_NO_UPDATE_NOTIFIER": "1",
        ]
        for key in ["HOME", "GH_TOKEN", "GH_CONFIG_DIR"] {
            if let value = source[key], !value.isEmpty {
                environment[key] = value
            }
        }
        return environment
    }

    /// Exécute un `argv` de `GhCommand` dans `directory` (le répertoire de travail
    /// du contrat : la racine du projet conduit). Le nom employé dans les erreurs est
    /// la sous-commande (`pr view`, …).
    func run(_ arguments: [String], in directory: String) async throws -> GhOutput {
        let command = arguments.prefix(2).joined(separator: " ")
        let process = Process()
        process.executableURL = binary
        process.arguments = arguments
        process.currentDirectoryURL = URL(fileURLWithPath: directory)
        process.environment = Self.environment()
        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe
        process.standardInput = FileHandle.nullDevice

        let drain = Drain()
        let exit = Exit()
        let control = Control(process: process)
        process.terminationHandler = { finished in
            exit.finish(code: finished.terminationStatus)
        }

        do {
            try process.run()
        } catch {
            throw GhError.commandFailed(command: command, code: -1, detail: error.localizedDescription)
        }

        // Les deux tubes sont drainés EN PARALLÈLE (patron `GitCLI`), dans des fils
        // détachés.
        Self.pump(outPipe.fileHandleForReading, into: drain, stderr: false)
        Self.pump(errPipe.fileHandleForReading, into: drain, stderr: true)

        // L'échéance : un `gh` qui ne rend pas la main est terminé, et la lecture
        // échoue au lieu de laisser la vue bloquée 60 s.
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [control] in
            guard control.isRunning else { return }
            control.markTimedOut()
            control.terminate()
        }

        let code = await exit.wait()
        await drain.awaitEnd()
        let output = drain.output

        if control.timedOut {
            throw GhError.commandTimedOut(command: command, seconds: timeout)
        }
        return GhOutput(code: code, stdout: output.stdout, stderr: output.stderr)
    }

    /// Découpe un tube jusqu'à EOF dans un fil détaché, puis signale sa fin.
    private static func pump(_ handle: FileHandle, into drain: Drain, stderr: Bool) {
        Thread.detachNewThread {
            while true {
                let chunk = handle.availableData
                if chunk.isEmpty { break }
                drain.append(chunk, stderr: stderr)
            }
            drain.end()
        }
    }
}

/// Les erreurs de la couche PR, chacune avec SON texte (une erreur, un texte) : la
/// vue affiche `userMessage`, elle ne compose jamais un message.
enum GhError: Error, Equatable, Sendable {
    case ghNotFound(searched: [String], override: String?)
    case commandFailed(command: String, code: Int32, detail: String)
    case commandTimedOut(command: String, seconds: Double)
    case unreadableOutput(command: String, detail: String)

    var userMessage: String {
        switch self {
        case let .ghNotFound(searched, override):
            let detail = override.map { "chemin imposé par \(GhBinary.overrideKey) : \($0)" }
                ?? searched.joined(separator: ", ")
            return "gh est introuvable (cherché : \(detail)) — les statuts de PR ne peuvent pas être lus."
        case let .commandFailed(command, code, detail):
            return "gh \(command) a échoué (code \(code)) : \(detail)"
        case let .commandTimedOut(command, seconds):
            return "gh \(command) n'a pas rendu la main en \(Int(seconds)) s — lecture abandonnée."
        case let .unreadableOutput(command, detail):
            return "la sortie de gh \(command) est illisible : \(detail)"
        }
    }

    /// Le motif d'un `commandFailed` (la dernière ligne de `stderr`), ou le message
    /// complet pour toute autre forme — c'est ce que la vue ajoute après « Fusion
    /// refusée par GitHub : ».
    var failureDetail: String {
        if case let .commandFailed(_, _, detail) = self, !detail.isEmpty { return detail }
        return userMessage
    }

    /// Le message d'une erreur quelconque, sans jamais exposer un `NSError` brut.
    static func message(for error: Error) -> String {
        (error as? GhError)?.userMessage ?? error.localizedDescription
    }

    /// Traduit une erreur remontée par un service en `GhError`, en nommant la
    /// sous-commande qui l'a produite quand elle n'en porte pas déjà une.
    static func from(_ error: Error, command: String) -> GhError {
        (error as? GhError) ?? .unreadableOutput(command: command, detail: error.localizedDescription)
    }
}
