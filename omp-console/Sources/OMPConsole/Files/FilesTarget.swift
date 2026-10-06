// Le catalogue des cibles connues d'un projet : le dépôt principal et les
// worktrees de features (S-1), chacun avec la base contre laquelle son diff se
// calcule.
//
// Le principal n'est PAS deviné depuis le chemin du projet : il est obtenu par
// `rev-parse --git-common-dir`, la seule résolution qui vaille depuis n'importe
// quelle cible (depuis un worktree lié, cette commande rend le `.git` du dépôt
// principal ; le principal est son parent).
//
// Toutes les comparaisons de chemins passent par `canonicalPath` : sur macOS,
// `NSTemporaryDirectory()` rend `/var/...` alors que git rend `/private/var/...`
// (mesuré) — sans canonisation, deux chemins du MÊME répertoire ne seraient jamais
// égaux.

import ConsoleCore
import Foundation

enum FilesBase: Sendable, Equatable {
    /// Dépôt principal : le diff se calcule contre `HEAD` (AC-6).
    case head
    /// Sha de la base enregistrée de la feature, ou base de fusion avec la branche
    /// par défaut du principal.
    case commit(String)
    /// Aucune base calculable, avec la raison affichable.
    case unavailable(String)

    /// L'argument passé à `git diff`, ou `nil` quand il n'y a rien à comparer.
    var gitArgument: String? {
        switch self {
        case .head: "HEAD"
        case let .commit(sha): sha
        case .unavailable: nil
        }
    }

    /// Le libellé de l'en-tête du document : « HEAD », « base <sha7> », ou la raison.
    var label: String {
        switch self {
        case .head: "HEAD"
        case let .commit(sha): "base \(sha.prefix(7))"
        case let .unavailable(reason): "base indisponible (\(reason))"
        }
    }
}

struct FilesTarget: Sendable, Equatable, Identifiable {
    /// Chemin ABSOLU canonique du répertoire de la cible.
    var path: String
    /// « <nom> (dépôt principal) » ou le slug de la branche.
    var label: String
    /// « feat/<slug> » pour un worktree, `nil` pour le principal.
    var branch: String?
    var isPrimary: Bool
    var base: FilesBase

    var id: String { path }
}

/// Un enregistrement de `git worktree list --porcelain` : le format est stable
/// entre versions et indifférent à la configuration du poste.
struct GitWorktree: Sendable, Equatable {
    var path: String
    var head: String?
    /// « feat/<slug> » (le préfixe `refs/heads/` est retiré), `nil` en détaché.
    var branch: String?
}

enum TargetCatalog {
    /// Le dépôt principal d'un projet, quel que soit le chemin d'où l'on part : la
    /// SEULE formule (S-1), réemployée par le catalogue ET par la portée mémoire.
    /// Depuis un worktree lié, `--git-common-dir` rend le `.git` du principal, dont
    /// le parent EST le principal.
    static func primaryRoot(git: GitCLI, projectRoot: String) async throws -> String {
        let project = canonicalPath(projectRoot)
        let common = try await git.run(GitCommand.gitCommonDir(), in: project)
        let commonPath = common.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        guard common.code == 0, !commonPath.isEmpty else {
            throw FilesError.notARepository(path: project)
        }
        let gitDir = resolvePath(commonPath, relativeTo: project)
        return canonicalPath((gitDir as NSString).deletingLastPathComponent)
    }

    static func list(git: GitCLI, store: StoreReader, projectRoot: String) async throws -> [FilesTarget] {
        let primary = try await primaryRoot(git: git, projectRoot: projectRoot)

        var targets = [
            FilesTarget(
                path: primary,
                label: "\((primary as NSString).lastPathComponent) (dépôt principal)",
                branch: nil,
                isPrimary: true,
                base: .head
            ),
        ]

        let listed = try await git.run(GitCommand.worktreeList(), in: primary)
        guard listed.code == 0 else {
            throw FilesError.commandFailed(
                command: "worktree list",
                code: listed.code,
                detail: FilesError.lastLine(listed.stderr)
            )
        }

        let defaultBranch = await defaultBranchName(git: git, primary: primary)
        let lots = store.readLots().lots
        let lot = lots.first { canonicalPath($0.repoRoot) == primary }

        for record in parseWorktreeList(listed.stdout) {
            // Seuls les worktrees de feature sont des cibles : un worktree hors
            // `feat/` (branche de travail, détaché) n'en est pas une.
            guard let branch = record.branch, branch.hasPrefix("feat/") else { continue }
            let path = canonicalPath(record.path)
            guard path != primary else { continue }
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue else {
                // `worktree list` ne purge rien : un worktree dont le répertoire a
                // été supprimé reste listé (`prunable`). Jamais une cible morte.
                continue
            }
            let slug = String(branch.dropFirst("feat/".count))
            let base = await resolveBase(
                branch: branch,
                worktree: path,
                lot: lot,
                git: git,
                primary: primary,
                defaultBranch: defaultBranch
            )
            targets.append(FilesTarget(path: path, label: slug, branch: branch, isPrimary: false, base: base))
        }

        // Principal d'abord, puis les worktrees par libellé insensible à la casse,
        // les égalités tranchées par le chemin.
        targets.sort { left, right in
            if left.isPrimary != right.isPrimary { return left.isPrimary }
            if left.label.lowercased() != right.label.lowercased() {
                return left.label.lowercased() < right.label.lowercased()
            }
            return left.path < right.path
        }
        return targets
    }

    /// La base d'un worktree : le sha enregistré de la feature s'il existe, sinon la
    /// base de fusion avec la branche par défaut du principal.
    private static func resolveBase(
        branch: String,
        worktree: String,
        lot: Lot?,
        git: GitCLI,
        primary: String,
        defaultBranch: String?
    ) async -> FilesBase {
        if let feature = lot?.features.first(where: { $0.branch == branch }),
           let recorded = feature.base,
           isHexSha(recorded) {
            return .commit(recorded)
        }
        guard let defaultBranch else {
            return .unavailable("branche par défaut introuvable dans \(primary)")
        }
        guard let merged = try? await git.run(GitCommand.mergeBase(a: "HEAD", b: defaultBranch), in: worktree),
              merged.code == 0 else {
            return .unavailable("pas de base de fusion avec \(defaultBranch)")
        }
        let sha = merged.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isHexSha(sha) else {
            return .unavailable("pas de base de fusion avec \(defaultBranch)")
        }
        return .commit(sha)
    }

    /// La branche par défaut du principal : `origin/HEAD` d'abord (le distant fait
    /// autorité), sinon la branche courante du principal.
    private static func defaultBranchName(git: GitCLI, primary: String) async -> String? {
        if let origin = try? await git.run(GitCommand.originHead(), in: primary), origin.code == 0 {
            let name = origin.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            if let slash = name.firstIndex(of: "/") {
                return String(name[name.index(after: slash)...])
            }
            if !name.isEmpty { return name }
        }
        if let head = try? await git.run(GitCommand.abbrevRefHead(), in: primary), head.code == 0 {
            let name = head.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            if !name.isEmpty, name != "HEAD" { return name }
        }
        return nil
    }
}

/// Le format porcelain : une ligne par attribut, une ligne VIDE entre les
/// enregistrements (`bare`, `detached`, `locked`, `prunable` ne sont présents que
/// s'ils sont vrais — ils ne nous intéressent pas, mais ne doivent pas casser la
/// lecture).
func parseWorktreeList(_ text: String) -> [GitWorktree] {
    var records: [GitWorktree] = []
    var current: GitWorktree?

    for line in text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
        if line.isEmpty {
            if let current { records.append(current) }
            current = nil
            continue
        }
        let parts = line.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2 else { continue }
        let key = String(parts[0])
        let value = String(parts[1])
        switch key {
        case "worktree":
            if let current { records.append(current) }
            current = GitWorktree(path: value, head: nil, branch: nil)
        case "HEAD":
            current?.head = value
        case "branch":
            let prefix = "refs/heads/"
            current?.branch = value.hasPrefix(prefix) ? String(value.dropFirst(prefix.count)) : value
        default:
            break
        }
    }
    if let current { records.append(current) }
    return records
}

/// Un chemin ABSOLU et canonique : `..` résolus, liens symboliques suivis. C'est ce
/// qui rend comparables un chemin rendu par git et un chemin rendu par le système.
func canonicalPath(_ path: String) -> String {
    if path.isEmpty { return path }
    return URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
}

/// `rev-parse --git-common-dir` peut rendre un chemin RELATIF (`.git` depuis la
/// racine du dépôt principal — mesuré) : il se résout alors contre le répertoire de
/// l'appel.
private func resolvePath(_ path: String, relativeTo directory: String) -> String {
    if path.hasPrefix("/") { return path }
    return (directory as NSString).appendingPathComponent(path)
}

/// Un sha hexadécimal, et rien d'autre : une sortie vide ou un message d'erreur de
/// git ne doit jamais être pris pour une base.
func isHexSha(_ text: String) -> Bool {
    guard text.count >= 7, text.count <= 64 else { return false }
    return text.allSatisfy { $0.isHexDigit }
}
