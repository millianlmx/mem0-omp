// L'invariant de lecture seule, déroulé sur une cible RÉELLE (S-8) : AC-13 et AC-14.
//
// Le scénario emploie les commandes une par une — comme le fait la section quand on
// parcourt l'arbre, qu'on lit un fichier, qu'on affiche un diff et qu'on ouvre le
// contrat — puis compare l'état du dépôt AVANT et APRÈS : `git status --porcelain`,
// l'empreinte de l'index et l'empreinte de chaque fichier de la cible.

import Foundation
import Testing

@testable import OMPConsole
import ConsoleCore

@Test("visionneuse-de-fichiers-et-diffs/AC-13 : parcourir l'arbre, lire, diffuser et ouvrir le contrat ne change ni l'état git ni un fichier")
func fullScenarioIsReadOnly() async throws {
    let scene = try await makeReadOnlyScene()
    let target = scene.target
    let git = scene.git

    let statusBefore = try scene.fixture.status(in: target.path)
    let indexBefore = try scene.fixture.indexDigest(in: target.path)
    let filesBefore = scene.fixture.fileDigests(in: target.path)

    // 1. Le catalogue et l'arbre.
    let tracked = try await git.run(GitCommand.lsTracked(), in: target.path)
    let untracked = try await git.run(GitCommand.lsUntracked(), in: target.path)
    let tree = FilesTree.build(
        tracked: nulSeparated(tracked.stdout),
        untracked: nulSeparated(untracked.stdout),
        disk: { filesDiskState(joinPath(target.path, $0)) }
    )
    #expect(!tree.entries.isEmpty)

    // 2. Le contenu de chaque fichier de l'arbre, en lecture seule.
    for entry in tree.entries where entry.kind != .deleted {
        _ = FilesReader.read(path: joinPath(target.path, entry.path), fileManager: .default)
    }

    // 3. Le diff suivi, puis le diff non suivi.
    let trackedDiff = try await git.run(
        GitCommand.diffTracked(base: target.base.gitArgument ?? "HEAD", path: "tracked.txt"),
        in: target.path
    )
    #expect(trackedDiff.code == 0)
    let untrackedDiff = try await git.run(GitCommand.diffUntracked(path: "folder/new.txt"), in: target.path)
    #expect(untrackedDiff.code == 1)

    // 4. Le contrat dédié (ignoré par git, atteint hors arbre).
    let contract = FilesReader.read(path: joinPath(target.path, ".omp/pipeline/contract.md"), fileManager: .default)
    #expect(contract == .text("# contrat de la fixture\n"))

    let statusAfter = try scene.fixture.status(in: target.path)
    let indexAfter = try scene.fixture.indexDigest(in: target.path)
    let filesAfter = scene.fixture.fileDigests(in: target.path)

    #expect(statusAfter == statusBefore)
    #expect(indexAfter == indexBefore)
    #expect(filesAfter == filesBefore)
    #expect(!statusBefore.isEmpty, "la fixture doit porter des modifications, sinon le test ne prouve rien")
}

@Test("visionneuse-de-fichiers-et-diffs/AC-14 : lire le contenu et le diff d'un fichier non suivi le laisse « ?? » dans l'index")
func untrackedStaysUntracked() async throws {
    let scene = try await makeReadOnlyScene()
    let git = scene.git

    let before = try scene.fixture.status(in: scene.target.path)
    #expect(before.contains("?? folder/new.txt"))
    let indexBefore = try scene.fixture.indexDigest(in: scene.target.path)

    // Le contenu, puis le diff qui « ajoute » le fichier.
    _ = FilesReader.read(path: joinPath(scene.target.path, "folder/new.txt"), fileManager: .default)
    let diff = try await git.run(GitCommand.diffUntracked(path: "folder/new.txt"), in: scene.target.path)
    #expect(diff.code == 1)
    #expect(!FilesDiff.parse(diff.stdout).isEmpty)

    let after = try scene.fixture.status(in: scene.target.path)
    #expect(after == before)
    #expect(after.contains("?? folder/new.txt"))
    #expect(try scene.fixture.indexDigest(in: scene.target.path) == indexBefore)
}

@Test("visionneuse-de-fichiers-et-diffs/AC-13 : aucune commande de la fonctionnalité ne réécrit l'index du dépôt principal non plus")
func primaryStaysReadOnly() async throws {
    let scene = try await makeReadOnlyScene()
    let git = scene.git
    let primary = scene.worktreePrincipal

    let statusBefore = try scene.fixture.status(in: primary)
    let indexBefore = try scene.fixture.indexDigest(in: primary)

    _ = try await git.run(GitCommand.lsTracked(), in: primary)
    _ = try await git.run(GitCommand.lsUntracked(), in: primary)
    _ = try await git.run(GitCommand.worktreeList(), in: primary)
    _ = try await git.run(GitCommand.gitCommonDir(), in: primary)
    _ = try await git.run(GitCommand.originHead(), in: primary)
    _ = try await git.run(GitCommand.abbrevRefHead(), in: primary)
    _ = try await git.run(GitCommand.mergeBase(a: "HEAD", b: "HEAD"), in: primary)
    _ = try await git.run(GitCommand.diffTracked(base: "HEAD", path: "tracked.txt"), in: primary)

    #expect(try scene.fixture.status(in: primary) == statusBefore)
    #expect(try scene.fixture.indexDigest(in: primary) == indexBefore)
}

/// Le scénario de lecture seule : un worktree de feature avec un fichier suivi
/// modifié, un fichier non suivi et un contrat (ignoré par git).
private struct ReadOnlyScene {
    let fixture: FilesFixture
    let target: FilesTarget
    /// Le dépôt principal de la fixture (d'où le worktree a été détaché).
    let worktreePrincipal: String
    let git: GitCLI
}

private func makeReadOnlyScene() async throws -> ReadOnlyScene {
    let fixture = try FilesFixture()
    let initial = try fixture.head()
    let worktree = try fixture.makeWorktree(slug: "lecture-seule")
    try fixture.write("tracked.txt", "a\nb\n", in: worktree)
    try fixture.write("folder/new.txt", "x\ny\n", in: worktree)
    try fixture.write(".omp/pipeline/contract.md", "# contrat de la fixture\n", in: worktree)
    try fixture.write("tracked.txt", "a\nz\n")

    let store = StoreFixture()
    let reader = filesStore(
        store,
        principal: fixture.root,
        features: [("lecture-seule", "feat/lecture-seule", worktree, initial)]
    )
    let git = filesGit()
    let targets = try await TargetCatalog.list(git: git, store: reader, projectRoot: fixture.root)
    guard let target = targets.first(where: { !$0.isPrimary }) else {
        throw FilesFixtureFailure.git(command: "catalogue", code: 1, stderr: "worktree absent : \(targets.map(\.label))")
    }
    return ReadOnlyScene(fixture: fixture, target: target, worktreePrincipal: fixture.root, git: git)
}
