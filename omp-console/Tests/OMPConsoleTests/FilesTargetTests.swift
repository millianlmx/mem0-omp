// Le catalogue des cibles (S-1, S-2 réels) : le principal par `rev-parse
// --git-common-dir`, les worktrees de feature par `worktree list --porcelain`, et la
// base de chacun — sha enregistrée de la feature, sinon base de fusion.

import Foundation
import Testing

@testable import OMPConsole
import ConsoleCore

@Test("visionneuse-de-fichiers-et-diffs/AC-2 : le catalogue rend le principal puis le worktree de feature, chacun avec sa base")
func catalogListsPrimaryAndFeatureWorktree() async throws {
    let fixture = try FilesFixture()
    let initial = try fixture.head()
    let worktree = try fixture.makeWorktree(slug: "alpha")
    try fixture.write("only-worktree.txt", "w\n", in: worktree)
    try fixture.write("only-main.txt", "m\n")

    let store = StoreFixture()
    let reader = filesStore(
        store,
        principal: fixture.root,
        features: [("alpha", "feat/alpha", worktree, initial)]
    )
    let targets = try await TargetCatalog.list(git: filesGit(), store: reader, projectRoot: fixture.root)

    #expect(targets.count == 2)
    #expect(targets[0].isPrimary)
    #expect(targets[0].path == fixture.root)
    #expect(targets[0].label == "\((fixture.root as NSString).lastPathComponent) (dépôt principal)")
    #expect(targets[0].branch == nil)
    #expect(targets[0].base == .head)
    #expect(targets[1].isPrimary == false)
    #expect(targets[1].path == worktree)
    #expect(targets[1].label == "alpha")
    #expect(targets[1].branch == "feat/alpha")
    #expect(targets[1].base == .commit(initial))
}

@Test("visionneuse-de-fichiers-et-diffs/AC-2 : l'arbre d'une cible choisie est celui de cette cible et d'elle seule")
func treeBelongsToTheChosenTarget() async throws {
    let fixture = try FilesFixture()
    let initial = try fixture.head()
    let worktree = try fixture.makeWorktree(slug: "beta")
    try fixture.write("only-worktree.txt", "w\n", in: worktree)
    try fixture.write("only-main.txt", "m\n")

    let store = StoreFixture()
    let reader = filesStore(
        store,
        principal: fixture.root,
        features: [("beta", "feat/beta", worktree, initial)]
    )
    let targets = try await TargetCatalog.list(git: filesGit(), store: reader, projectRoot: fixture.root)
    let git = filesGit()

    let fromPrimary = try await tree(of: targets[0], git: git)
    let fromWorktree = try await tree(of: targets[1], git: git)

    #expect(fromPrimary.entries.map(\.path).contains("only-main.txt"))
    #expect(!fromPrimary.entries.map(\.path).contains("only-worktree.txt"))
    #expect(fromWorktree.entries.map(\.path).contains("only-worktree.txt"))
    #expect(!fromWorktree.entries.map(\.path).contains("only-main.txt"))
    // Le contrat de la pipeline est ignoré par git : il n'apparaît dans aucune cible.
    #expect(!fromPrimary.entries.map(\.path).contains(".omp/pipeline/contract.md"))
}

@Test("visionneuse-de-fichiers-et-diffs/AC-2 : un worktree hors `feat/` et un worktree dont le répertoire a disparu ne sont pas des cibles")
func catalogSkipsNonFeatureAndDeadWorktrees() async throws {
    let fixture = try FilesFixture()
    let dead = try fixture.makeWorktree(slug: "disparue")
    let plain = try fixture.makeWorktree(slug: "hors-feature")
    // Le worktree « hors-feature » est renommé sur une branche qui n'est pas une
    // branche de feature — c'est un worktree de travail, pas une cible.
    try fixture.git(["checkout", "-q", "-b", "travail"], in: plain)
    // `worktree list` ne purge RIEN : le répertoire supprimé reste listé (`prunable`).
    try FileManager.default.removeItem(atPath: dead)

    let store = StoreFixture()
    let reader = filesStore(store, principal: fixture.root, features: [])
    let targets = try await TargetCatalog.list(git: filesGit(), store: reader, projectRoot: fixture.root)

    #expect(targets.map(\.label).contains("hors-feature") == false)
    #expect(targets.count == 1)
    #expect(targets[0].isPrimary)

    let listed = try fixture.git(["worktree", "list", "--porcelain"])
    #expect(listed.contains(dead), "git liste toujours le worktree mort : le filtre est bien celui du catalogue")
}

@Test("visionneuse-de-fichiers-et-diffs/AC-2 : sans base calculable, la cible porte la raison au lieu d'un sha inventé")
func catalogReportsUnavailableBase() async throws {
    let fixture = try FilesFixture()
    let worktree = try fixture.makeWorktree(slug: "orpheline")
    // Principal DÉTACHÉ : plus aucune branche par défaut à nommer, et aucun lot pour
    // porter un sha de base.
    try fixture.git(["checkout", "-q", "--detach", "HEAD"])

    let store = StoreFixture()
    let reader = filesStore(store, principal: fixture.root, features: [])
    let targets = try await TargetCatalog.list(git: filesGit(), store: reader, projectRoot: fixture.root)

    guard let feature = targets.first(where: { $0.path == worktree }) else {
        Issue.record("le worktree doit rester une cible : \(targets.map(\.label))")
        return
    }
    guard case let .unavailable(reason) = feature.base else {
        Issue.record("base attendue indisponible, obtenue \(feature.base)")
        return
    }
    #expect(reason.contains("branche par défaut introuvable"))
    #expect(feature.base.gitArgument == nil)
    #expect(feature.base.label.contains(reason))
}

@Test("visionneuse-de-fichiers-et-diffs/AC-2 : un projet qui n'est pas dans un dépôt git rend l'erreur nommée, sans commande d'écriture")
func catalogRejectsNonRepository() async throws {
    // Hors du dépôt de fixture : un répertoire À L'INTÉRIEUR de celui-ci appartiendrait
    // au dépôt englobant, et `rev-parse` y répondrait avec succès.
    let plain = canonicalPath(
        (NSTemporaryDirectory() as NSString).appendingPathComponent("omp-console-hors-depot-\(UUID().uuidString)")
    )
    try FileManager.default.createDirectory(atPath: plain, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: plain) }

    let store = StoreFixture()
    let reader = filesStore(store, principal: plain, features: [])
    await #expect(throws: FilesError.notARepository(path: plain)) {
        try await TargetCatalog.list(git: filesGit(), store: reader, projectRoot: plain)
    }
}

@Test("visionneuse-de-fichiers-et-diffs/AC-2 : le format porcelain est lu tel quel, y compris détaché et sans branche")
func porcelainParsing() {
    let text = """
    worktree /Users/millian/Experiments/mem0-omp
    HEAD 1111111111111111111111111111111111111111
    branch refs/heads/main

    worktree /Users/millian/.omp/pipeline-worktrees/mem0-omp-d0ef9a5/visionneuse-de-fichiers-et-diffs
    HEAD 2222222222222222222222222222222222222222
    branch refs/heads/feat/visionneuse-de-fichiers-et-diffs

    worktree /tmp/detache
    HEAD 3333333333333333333333333333333333333333
    detached

    worktree /tmp/mort
    HEAD 4444444444444444444444444444444444444444
    branch refs/heads/feat/morte
    prunable gitdir file points to non-existent location

    """
    let records = parseWorktreeList(text)
    #expect(records.count == 4)
    #expect(records[0].branch == "main")
    #expect(records[1].branch == "feat/visionneuse-de-fichiers-et-diffs")
    #expect(records[2].branch == nil)
    #expect(records[3].path == "/tmp/mort")
    #expect(records[3].branch == "feat/morte")
}

/// L'arbre d'une cible, lu comme le fait le modèle : deux `ls-files`, puis `build`
/// avec l'état du disque de CETTE cible.
func tree(of target: FilesTarget, git: GitCLI) async throws -> FilesTree {
    let tracked = try await git.run(GitCommand.lsTracked(), in: target.path)
    let untracked = try await git.run(GitCommand.lsUntracked(), in: target.path)
    return FilesTree.build(
        tracked: nulSeparated(tracked.stdout),
        untracked: nulSeparated(untracked.stdout),
        disk: { filesDiskState(joinPath(target.path, $0)) }
    )
}
