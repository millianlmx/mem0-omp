// Accès git de la visionneuse : la SEULE surface de lecture autorisée (S-8).
//
// Deux pièces séparées, et c'est ce qui rend l'invariant vérifiable :
//  - `GitCommand` construit des `argv` PURS, sans rien exécuter — un test les fige
//    et un autre refuse toute sous-commande hors de la liste blanche de S-8 ;
//  - `GitCLI` exécute, en préfixant TOUJOURS `-C <répertoire> -c core.pager=cat`,
//    jamais par un shell.
//
// Aucune sous-commande d'écriture (`add`, `update-index`, `status`, `checkout`,
// `restore`, `commit`, `stash`, `apply`, `worktree add|remove|prune|repair`, `gc`,
// `fetch`) n'est constructible ici : les constructeurs de `GitCommand` sont la
// liste complète, et un test la confronte à la liste blanche de S-8.

import Foundation

/// Résolution du binaire `git`, même ordre et même échappatoire que
/// `OmpBinaryResolver` : l'override seul, sinon `PATH`, sinon les emplacements
/// d'installation connus. Une app lancée par le Finder hérite du `PATH` de launchd
/// (`/usr/bin:/bin:/usr/sbin:/sbin`) — `/usr/bin/git`, la doublure de git des
/// Command Line Tools, est donc un candidat de plein droit.
enum GitBinary {
    static let overrideKey = "OMP_CONSOLE_GIT_BINARY"

    static func candidates(environment: [String: String]) -> [String] {
        if let override = environment[overrideKey], !override.isEmpty {
            return [override]
        }
        var candidates: [String] = []
        if let path = environment["PATH"] {
            for entry in path.split(separator: ":", omittingEmptySubsequences: true) {
                candidates.append("\(entry)/git")
            }
        }
        candidates.append("/usr/bin/git")
        candidates.append("/opt/homebrew/bin/git")
        candidates.append("/usr/local/bin/git")
        return candidates
    }

    /// Le premier candidat EXÉCUTABLE gagne ; l'override, s'il est posé et non vide,
    /// est le SEUL candidat (un chemin explicite ne doit jamais être contourné).
    /// `path` n'est là que pour le message : l'appelant sait QUEL projet n'a pas pu
    /// être lu, le résolveur ne le devine pas.
    static func resolve(
        environment: [String: String],
        path: String = "",
        fileManager: FileManager = .default
    ) -> Result<URL, FilesError> {
        let searched = candidates(environment: environment)
        for candidate in searched where fileManager.isExecutableFile(atPath: candidate) {
            return .success(URL(fileURLWithPath: candidate))
        }
        let override = environment[overrideKey].flatMap { $0.isEmpty ? nil : $0 }
        return .failure(.gitNotFound(searched: searched, override: override, path: path))
    }
}

/// Les `argv` de la fonctionnalité, et RIEN d'autre (S-8). Chaque constructeur rend
/// la sous-commande et ses options ; `GitCLI.run` ajoute le préfixe `-C`/`-c`.
enum GitCommand {
    static func lsTracked() -> [String] {
        ["ls-files", "-z", "--cached"]
    }

    static func lsUntracked() -> [String] {
        ["ls-files", "-z", "--others", "--exclude-standard"]
    }

    /// L'écart entre l'arbre de travail et `base` pour UN chemin : commits de la
    /// branche ET modifications non commitées compris (S-3). `--no-color` et
    /// `--no-ext-diff` neutralisent un `color.ui=always` et un `diff.external` de la
    /// configuration de l'utilisateur.
    static func diffTracked(base: String, path: String) -> [String] {
        ["diff", "--no-color", "--no-ext-diff", base, "--", path]
    }

    /// Le contenu d'un fichier NON SUIVI comme un ajout, sans jamais toucher
    /// l'index. Cette forme implique `--exit-code` : le code 1 est un SUCCÈS.
    static func diffUntracked(path: String) -> [String] {
        ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", path]
    }

    static func worktreeList() -> [String] {
        ["worktree", "list", "--porcelain"]
    }

    static func gitCommonDir() -> [String] {
        ["rev-parse", "--git-common-dir"]
    }

    static func originHead() -> [String] {
        ["symbolic-ref", "--short", "--quiet", "refs/remotes/origin/HEAD"]
    }

    static func mergeBase(a: String, b: String) -> [String] {
        ["merge-base", a, b]
    }

    static func abbrevRefHead() -> [String] {
        ["rev-parse", "--abbrev-ref", "HEAD"]
    }

    /// Réservé aux TESTS (S-8) : le chemin du fichier d'index, pour comparer son
    /// empreinte avant et après le parcours complet.
    static func gitPath(_ name: String) -> [String] {
        ["rev-parse", "--git-path", name]
    }
}

/// Les sous-commandes admises (S-8). Ni `-C` ni `-c` n'y figurent : ce sont le
/// préfixe imposé par `GitCLI.run`, pas des commandes de la fonctionnalité.
let gitAllowedSubcommands: Set<String> = [
    "ls-files",
    "diff",
    "worktree",
    "rev-parse",
    "symbolic-ref",
    "merge-base",
]

struct GitOutput: Sendable, Equatable {
    var code: Int32
    var stdout: String
    var stderr: String
}

struct GitCLI: Sendable {
    let binary: URL
    let timeout: Double

    init(binary: URL, timeout: Double = 10) {
        self.binary = binary
        self.timeout = timeout
    }

    /// L'environnement du process git est LIMITÉ (S-8) : ni `GIT_DIR` ni
    /// `GIT_WORK_TREE` hérités ne peuvent rediriger la lecture, et `LANG=C` fige la
    /// langue des messages de git.
    static func environment(_ source: [String: String] = ProcessInfo.processInfo.environment) -> [String: String] {
        var environment: [String: String] = ["LANG": "C"]
        environment["PATH"] = source["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        if let home = source["HOME"], !home.isEmpty {
            environment["HOME"] = home
        }
        return environment
    }

    /// Exécute une commande de S-8 dans `directory` (même répertoire de travail que
    /// `-C`, pour que `git ls-files` rende des chemins RELATIFS à la cible).
    func run(_ arguments: [String], in directory: String) async throws -> GitOutput {
        let command = arguments.first ?? ""
        let process = Process()
        process.executableURL = binary
        process.arguments = ["-C", directory, "-c", "core.pager=cat"] + arguments
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
            throw FilesError.commandFailed(command: command, code: -1, detail: error.localizedDescription)
        }

        // Les deux tubes sont drainés EN PARALLÈLE, dans des fils détachés (patron
        // `ProcessTransport.pump`) : lire un tube après l'autre bloquerait dès que
        // le premier se remplit, le process attendant alors d'écrire sur le second.
        Self.pump(outPipe.fileHandleForReading, into: drain, stderr: false)
        Self.pump(errPipe.fileHandleForReading, into: drain, stderr: true)

        // L'échéance : un process git qui ne rend pas la main est terminé, et
        // l'appel le dit au lieu de laisser la vue bloquée.
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [control] in
            guard control.isRunning else { return }
            control.markTimedOut()
            control.terminate()
        }

        let code = await exit.wait()
        await drain.awaitEnd()
        let output = drain.output

        if control.timedOut {
            throw FilesError.commandTimedOut(command: command, seconds: timeout)
        }
        return GitOutput(code: code, stdout: output.stdout, stderr: output.stderr)
    }

    /// Découpe un tube jusqu'à EOF dans un fil détaché, puis signale sa fin.
    /// `availableData` rend 0 octet à la fin du flux : c'est la seule condition de
    /// sortie, et elle n'est atteinte que lorsque le process a fermé ses tubes.
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

// MARK: - Ce que `run` partage avec ses fils

/// Les deux tampons de sortie, gardés par un verrou : les fils de drain écrivent,
/// le fil appelant lit, et personne d'autre n'y touche.
final class Drain: @unchecked Sendable {
    private let lock = NSLock()
    private var stdoutData = Data()
    private var stderrData = Data()
    private var pending = 2
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func append(_ data: Data, stderr: Bool) {
        lock.lock()
        if stderr { stderrData.append(data) } else { stdoutData.append(data) }
        lock.unlock()
    }

    /// Appelée par chaque fil de drain ; le second réveille les attentes.
    func end() {
        lock.lock()
        pending -= 1
        let done = pending <= 0
        let waiting = done ? waiters : []
        if done { waiters = [] }
        lock.unlock()
        for waiter in waiting { waiter.resume() }
    }

    /// Attend que les DEUX tubes aient atteint EOF : sans cela, une sortie encore
    /// en vol serait tronquée au moment où le process rend la main.
    func awaitEnd() async {
        await withCheckedContinuation { continuation in
            lock.lock()
            if pending <= 0 {
                lock.unlock()
                continuation.resume()
                return
            }
            waiters.append(continuation)
            lock.unlock()
        }
    }

    var output: (stdout: String, stderr: String) {
        lock.lock()
        defer { lock.unlock() }
        return (String(decoding: stdoutData, as: UTF8.self), String(decoding: stderrData, as: UTF8.self))
    }
}

/// La fin du process, en attente asynchrone.
final class Exit: @unchecked Sendable {
    private let lock = NSLock()
    private var code: Int32?
    private var waiter: CheckedContinuation<Int32, Never>?

    func finish(code: Int32) {
        lock.lock()
        self.code = code
        let waiter = self.waiter
        self.waiter = nil
        lock.unlock()
        waiter?.resume(returning: code)
    }

    func wait() async -> Int32 {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let code {
                lock.unlock()
                continuation.resume(returning: code)
                return
            }
            waiter = continuation
            lock.unlock()
        }
    }
}

/// Le process, vu du watchdog. `Process` n'est pas `Sendable`, mais `isRunning` et
/// `terminate` sont les deux seules opérations employées, et elles sont sûres
/// depuis n'importe quelle file.
final class Control: @unchecked Sendable {
    private let lock = NSLock()
    private let process: Process
    private var timedOutFlag = false

    init(process: Process) {
        self.process = process
    }

    func markTimedOut() {
        lock.lock()
        timedOutFlag = true
        lock.unlock()
    }

    var timedOut: Bool {
        lock.lock()
        defer { lock.unlock() }
        return timedOutFlag
    }

    var isRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return process.isRunning
    }

    func terminate() {
        lock.lock()
        let process = self.process
        lock.unlock()
        process.terminate()
    }
}

/// Les erreurs de la visionneuse, chacune avec SON texte (une erreur, un texte) :
/// la vue ne compose jamais un message, elle affiche `userMessage`.
enum FilesError: Error, Equatable, Sendable {
    case gitNotFound(searched: [String], override: String?, path: String)
    case notARepository(path: String)
    case commandFailed(command: String, code: Int32, detail: String)
    case commandTimedOut(command: String, seconds: Double)
    case targetGone(path: String)
    case watchFailed(path: String)

    var userMessage: String {
        switch self {
        case let .gitNotFound(searched, override, path):
            let detail: String
            if let override {
                detail = "chemin imposé par \(GitBinary.overrideKey) : \(override)"
            } else {
                detail = searched.joined(separator: ", ")
            }
            return "git est introuvable (cherché : \(detail)) — la visionneuse ne peut pas lire \(path)."
        case let .notARepository(path):
            return "\(path) n'est pas un dépôt git."
        case let .commandFailed(command, code, detail):
            return "git \(command) a échoué (code \(code)) : \(detail)"
        case let .commandTimedOut(command, seconds):
            return "git \(command) n'a pas rendu la main en \(Int(seconds)) s — lecture abandonnée."
        case let .targetGone(path):
            return "\(path) n'existe plus — choisis une autre cible."
        case let .watchFailed(path):
            return "La veille de \(path) a échoué — rafraîchis avec ⌘R."
        }
    }

    /// Le message d'une erreur quelconque, sans jamais exposer un `NSError` brut.
    static func message(for error: Error) -> String {
        (error as? FilesError)?.userMessage ?? error.localizedDescription
    }

    /// La DERNIÈRE ligne non vide de `stderr` : c'est celle qui nomme la cause dans
    /// les messages de git, et la plus courte à l'écran.
    static func lastLine(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: true)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .last(where: { !$0.isEmpty }) ?? ""
    }
}
