// Accès git de la visionneuse : la SEULE surface de lecture autorisée (S-8).
//
// Trois pièces séparées, et c'est ce qui rend l'invariant vérifiable :
//  - `GitCommand` construit des `argv` PURS, sans rien exécuter — un test les fige ;
//  - `GitGuard` refuse tout `argv` hors de la liste blanche de S-8, AVANT toute
//    création de `Process` — la liste blanche est REFUSÉE à l'exécution, jamais
//    seulement vérifiée par un test ;
//  - `GitCLI` exécute, en préfixant TOUJOURS `-C <répertoire> -c core.pager=cat`,
//    jamais par un shell, et par l'exécuteur partagé `ProcessRunner`.
//
// Aucune sous-commande d'écriture (`add`, `update-index`, `status`, `checkout`,
// `restore`, `commit`, `stash`, `apply`, `worktree add|remove|prune|repair`, `gc`,
// `fetch`) n'est constructible ici : les constructeurs de `GitCommand` sont la
// liste complète, et la garde d'exécution ferme la porte à tout autre `argv`.

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

/// La garde d'EXÉCUTION (S-4) : le nom de la sous-commande REFUSÉE, ou nil si
/// l'argv est admis. Fonction pure, sans aucune E/S — c'est `GitCLI.run` qui
/// l'appelle en PREMIER geste, avant de configurer le moindre `Process`.
///
/// Deux actions d'écriture se cachent derrière des sous-commandes admises :
/// `worktree add|remove|prune|repair` (seule `list` lit) et `symbolic-ref` en
/// écriture (deux positionnels, ou `-d`/`--delete`/`-m`/`--message`). L'argv reçu
/// ici est celui SANS le préfixe `-C`/`-c` : il commence donc par la sous-commande.
enum GitGuard {
    static func refusedCommand(_ arguments: [String]) -> String? {
        // 1. Aucune sous-commande : rien n'est admis.
        guard let subcommand = arguments.first else { return "" }
        // 2. La sous-commande doit être dans la liste blanche.
        guard gitAllowedSubcommands.contains(subcommand) else { return subcommand }
        // 3. `worktree` n'est admise que sous sa forme de LECTURE, `list`.
        if subcommand == "worktree" {
            guard arguments.count >= 2, arguments[1] == "list" else {
                guard arguments.count >= 2 else { return "worktree" }
                return "worktree " + arguments[1]
            }
            return nil
        }
        // 4. `symbolic-ref` n'est admise qu'en LECTURE : un marqueur d'écriture, ou
        //    un nombre de positionnels (sous-commande exclue) différent de 1, la
        //    refuse.
        if subcommand == "symbolic-ref" {
            let writeMarkers: Set<String> = ["-d", "--delete", "-m", "--message"]
            if arguments.contains(where: { writeMarkers.contains($0) }) { return subcommand }
            let positionals = arguments.dropFirst().filter { !$0.hasPrefix("-") }
            if positionals.count != 1 { return subcommand }
            return nil
        }
        // 5. Sinon admise.
        return nil
    }
}

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
    ///
    /// La garde d'exécution passe EN PREMIER (S-4) : un `argv` refusé échoue ici,
    /// sans qu'aucun process git n'ait été créé.
    func run(_ arguments: [String], in directory: String) async throws -> GitOutput {
        let command = arguments.first ?? ""
        if let refused = GitGuard.refusedCommand(arguments) {
            throw FilesError.gitCommandRefused(command: refused)
        }

        let child = ProcessRunner.child(
            binary: binary,
            arguments: ["-C", directory, "-c", "core.pager=cat"] + arguments,
            cwd: URL(fileURLWithPath: directory),
            environment: Self.environment(),
            input: .nullDevice
        )

        let run: ProcessRun
        do {
            run = try await ProcessRunner.run(child, timeout: timeout)
        } catch ProcessRunnerError.launchFailed(let detail) {
            throw FilesError.commandFailed(command: command, code: -1, detail: detail)
        }

        if run.timedOut {
            throw FilesError.commandTimedOut(command: command, seconds: timeout)
        }
        return GitOutput(code: run.code, stdout: run.stdout, stderr: run.stderr)
    }
}

/// Les erreurs de la visionneuse, chacune avec SON texte (une erreur, un texte) :
/// la vue ne compose jamais un message, elle affiche `userMessage`.
enum FilesError: Error, Equatable, Sendable {
    case gitNotFound(searched: [String], override: String?, path: String)
    case notARepository(path: String)
    case commandFailed(command: String, code: Int32, detail: String)
    case commandTimedOut(command: String, seconds: Double)
    case gitCommandRefused(command: String)
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
        case let .gitCommandRefused(command):
            return "git \(command) n'est pas une commande de lecture autorisée — aucun process n'a été lancé."
        case let .targetGone(path):
            return "\(path) n'existe plus — choisissez une autre cible."
        case let .watchFailed(path):
            return "La veille de \(path) a échoué — actualisez avec ⌘R."
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
