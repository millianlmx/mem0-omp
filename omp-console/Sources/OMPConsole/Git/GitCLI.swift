// L'accès git de la Mémoire : une seule lecture, la racine du dépôt PRINCIPAL d'un projet,
// qui fixe la portée mem0 (`MemoryScope`). `GitCLI` exécute toujours
// `git -C <répertoire> -c core.pager=cat rev-parse --git-common-dir`, jamais par un shell,
// par l'exécuteur partagé `ProcessRunner`, dans un environnement limité.

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
    static func resolve(environment: [String: String], fileManager: FileManager = .default) -> URL? {
        candidates(environment: environment).first { fileManager.isExecutableFile(atPath: $0) }.map { URL(fileURLWithPath: $0) }
    }
}

/// Les échecs d'une lecture git : la Mémoire en fait l'état « Aucun projet ouvert ».
enum GitError: Error, Equatable, Sendable {
    case notARepository(path: String)
    case launchFailed(detail: String)
    case timedOut(seconds: Double)
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

    /// L'environnement du process git est LIMITÉ : ni `GIT_DIR` ni `GIT_WORK_TREE`
    /// hérités ne peuvent rediriger la lecture, et `LANG=C` fige la langue des messages.
    static func environment(_ source: [String: String] = ProcessInfo.processInfo.environment) -> [String: String] {
        var environment: [String: String] = ["LANG": "C"]
        environment["PATH"] = source["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        if let home = source["HOME"], !home.isEmpty {
            environment["HOME"] = home
        }
        return environment
    }

    /// Le dépôt principal d'un projet, quel que soit le chemin d'où l'on part. Depuis un
    /// worktree lié, `--git-common-dir` rend le `.git` du principal, dont le parent EST le
    /// principal : un worktree de feature n'ouvre jamais une seconde portée.
    func primaryRoot(of projectRoot: String) async throws -> String {
        let project = canonicalPath(projectRoot)
        let common = try await revParseCommonDir(in: project)
        let commonPath = common.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        guard common.code == 0, !commonPath.isEmpty else {
            throw GitError.notARepository(path: project)
        }
        // Le chemin rendu peut être RELATIF (`.git` depuis la racine du principal).
        let gitDir = commonPath.hasPrefix("/") ? commonPath : (project as NSString).appendingPathComponent(commonPath)
        return canonicalPath((gitDir as NSString).deletingLastPathComponent)
    }

    /// `git rev-parse --git-common-dir` dans `directory`.
    func revParseCommonDir(in directory: String) async throws -> GitOutput {
        let child = ProcessRunner.child(
            binary: binary,
            arguments: ["-C", directory, "-c", "core.pager=cat", "rev-parse", "--git-common-dir"],
            cwd: URL(fileURLWithPath: directory),
            environment: Self.environment(),
            input: .nullDevice
        )
        let run: ProcessRun
        do {
            run = try await ProcessRunner.run(child, timeout: timeout)
        } catch ProcessRunnerError.launchFailed(let detail) {
            throw GitError.launchFailed(detail: detail)
        }
        if run.timedOut {
            throw GitError.timedOut(seconds: timeout)
        }
        return GitOutput(code: run.code, stdout: run.stdout, stderr: run.stderr)
    }
}

/// Un chemin ABSOLU et canonique : `..` résolus, liens symboliques suivis. Sur macOS,
/// `NSTemporaryDirectory()` rend `/var/...` alors que git rend `/private/var/...` :
/// sans canonisation, deux chemins du MÊME répertoire ne seraient jamais égaux.
func canonicalPath(_ path: String) -> String {
    if path.isEmpty { return path }
    return URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
}
