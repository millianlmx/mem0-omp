// Le découpage d'un diff unifié (S-9, AC-12) et l'égalité du texte publié avec
// celui de git (S-3, S-4 : AC-3, AC-4, AC-5, AC-6).
//
// Les preuves réelles comparent ligne à ligne ce que la fonctionnalité publie à ce
// que `git diff` écrit vraiment, lancé dans la fixtion par un autre chemin
// (`FilesFixture`) : c'est la seule comparaison qui vaille, et elle couvre l'argv,
// le décodage et le classement.

import Foundation
import Testing

@testable import OMPConsole

@Test("visionneuse-de-fichiers-et-diffs/AC-12 : hunks dans l'ordre de git, retraits et ajouts marqués, texte au caractère près")
func parseKeepsOrderAndMarksLines() {
    let output = """
    diff --git a/tracked.txt b/tracked.txt
    index 7898192..422c2b7 100644
    --- a/tracked.txt
    +++ b/tracked.txt
    @@ -1 +1,2 @@
     a
    +b
    @@ -9,2 +9,1 @@
    -old
     kept
    """
    let diff = FilesDiff.parse(output)

    #expect(!diff.isEmpty)
    #expect(diff.header.map(\.kind) == [.header, .header, .header, .header])
    #expect(diff.header.map(\.text).first == "diff --git a/tracked.txt b/tracked.txt")
    #expect(diff.hunks.count == 2)
    #expect(diff.hunks[0].map(\.kind) == [.hunk, .context, .addition])
    #expect(diff.hunks[1].map(\.kind) == [.hunk, .removal, .context])
    #expect(diff.hunks[0][2].text == "+b")
    #expect(diff.hunks[1][1].text == "-old")
    // Le texte est celui de git, au caractère près : une ligne de contexte garde son
    // espace de tête.
    #expect(diff.hunks[1][2].text == " kept")
    #expect(diff.lines.count == diff.header.count + diff.hunks.flatMap { $0 }.count)
}

@Test("visionneuse-de-fichiers-et-diffs/AC-12 : un ajout complet, une note de fin de fichier et un binaire sont classés sans couleur d'ajout")
func parseClassifiesNotes() {
    let addition = """
    diff --git a/sub/new.txt b/sub/new.txt
    new file mode 100644
    index 0000000..b77b4eb
    --- /dev/null
    +++ b/sub/new.txt
    @@ -0,0 +1,2 @@
    +x
    +y
    \\ No newline at end of file
    """
    let diff = FilesDiff.parse(addition)
    #expect(diff.hunks.count == 1)
    #expect(diff.hunks[0].map(\.kind) == [.hunk, .addition, .addition, .note])
    #expect(diff.hunks[0][3].text == "\\ No newline at end of file")

    let binary = """
    diff --git a/logo.png b/logo.png
    index 1111111..2222222 100644
    Binary files a/logo.png and b/logo.png differ
    """
    let binaryDiff = FilesDiff.parse(binary)
    #expect(binaryDiff.hunks.isEmpty)
    #expect(binaryDiff.header.map(\.kind) == [.header, .header, .note])
    #expect(!binaryDiff.isEmpty)

    let empty = FilesDiff.parse("")
    #expect(empty.isEmpty)
    #expect(empty.lines.isEmpty)
    #expect(FilesDiff.parse("\n").isEmpty)
}

@Test("visionneuse-de-fichiers-et-diffs/AC-3 : le diff d'un fichier suivi modifié est identique à `git diff <base> -- <fichier>`, hunk pour hunk")
func trackedDiffMatchesGit() async throws {
    let scene = try await makeDiffScene()
    let target = scene.target

    #expect(target.base == .commit(scene.base))
    let command = GitCommand.diffTracked(base: target.base.gitArgument ?? "", path: "tracked.txt")
    let published = try await scene.git.run(command, in: target.path)
    #expect(published.code == 0)

    let expected = try scene.fixture.git(
        ["diff", "--no-color", "--no-ext-diff", scene.base, "--", "tracked.txt"],
        in: scene.worktree
    )
    let diff = FilesDiff.parse(published.stdout)
    #expect(!diff.isEmpty)
    #expect(diff.lines.map(\.text) == lines(of: expected))
    #expect(diff.hunks.flatMap { $0 }.contains { $0.kind == .removal && $0.text == "-a" })
    #expect(diff.hunks.flatMap { $0 }.contains { $0.kind == .addition && $0.text == "+b" })
}

@Test("visionneuse-de-fichiers-et-diffs/AC-4 : un fichier modifié par un seul commit de la branche rend un diff non vide")
func branchCommitDiffIsNotEmpty() async throws {
    let scene = try await makeDiffScene()

    let command = GitCommand.diffTracked(base: scene.base, path: "folder/inner.txt")
    let published = try await scene.git.run(command, in: scene.worktree)
    let expected = try scene.fixture.git(
        ["diff", "--no-color", "--no-ext-diff", scene.base, "--", "folder/inner.txt"],
        in: scene.worktree
    )
    let diff = FilesDiff.parse(published.stdout)
    #expect(!diff.isEmpty)
    #expect(diff.lines.map(\.text) == lines(of: expected))

    // La base ENREGISTRÉE est bien celle employée : `main-note.txt` n'existe pas
    // dans le commit de base (il est arrivé après), donc il apparaît en AJOUT — le
    // diff contre la base de fusion (`main`, plus récente) serait vide.
    let mainNote = FilesDiff.parse(
        try await scene.git.run(
            GitCommand.diffTracked(base: scene.base, path: "main-note.txt"),
            in: scene.worktree
        ).stdout
    )
    #expect(!mainNote.isEmpty)
    #expect(mainNote.hunks.flatMap { $0 }.allSatisfy { $0.kind != .removal })
}

@Test("visionneuse-de-fichiers-et-diffs/AC-5 : le diff d'un fichier non suivi est son contenu en ajout, sans passer par l'index")
func untrackedDiffIsAnAddition() async throws {
    let scene = try await makeDiffScene()

    let command = GitCommand.diffUntracked(path: "folder/new.txt")
    let published = try await scene.git.run(command, in: scene.worktree)
    // Cette forme implique `--exit-code` : 1 veut dire « il y a des différences »,
    // et c'est un SUCCÈS.
    #expect(published.code == 1)

    let expected = try scene.fixture.gitResult(
        ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", "folder/new.txt"],
        in: scene.worktree
    )
    #expect(expected.code == 1)

    let diff = FilesDiff.parse(published.stdout)
    #expect(diff.header.contains { $0.text.hasPrefix("new file mode") })
    #expect(diff.header.contains { $0.text == "--- /dev/null" })
    #expect(diff.lines.map(\.text) == lines(of: expected.stdout))
    #expect(diff.hunks.flatMap { $0 }.filter { $0.kind == .addition }.map(\.text) == ["+x", "+y"])

    // Et l'index n'a pas bougé : le fichier est toujours non suivi.
    #expect(try scene.fixture.status(in: scene.worktree).contains("?? folder/new.txt"))
}

@Test("visionneuse-de-fichiers-et-diffs/AC-6 : dans le dépôt principal, le diff se calcule contre HEAD")
func primaryDiffUsesHead() async throws {
    let scene = try await makeDiffScene()

    #expect(scene.primary.base == .head)
    let published = try await scene.git.run(
        GitCommand.diffTracked(base: "HEAD", path: "tracked.txt"),
        in: scene.primary.path
    )
    #expect(published.code == 0)
    let expected = try scene.fixture.git(
        ["diff", "--no-color", "--no-ext-diff", "HEAD", "--", "tracked.txt"]
    )
    let diff = FilesDiff.parse(published.stdout)
    #expect(!diff.isEmpty)
    #expect(diff.lines.map(\.text) == lines(of: expected))
    #expect(diff.hunks.flatMap { $0 }.contains { $0.kind == .addition && $0.text == "+z" })
}

/// Le scénario des AC-3 à AC-6, monté une fois pour toutes : un principal qui a
/// avancé après le commit initial, un worktree de feature dont la base ENREGISTRÉE
/// est le commit initial (donc plus ancienne que la base de fusion), un fichier
/// modifié par un commit de branche, un fichier modifié sans commit, un fichier non
/// suivi.
private struct DiffScene {
    let fixture: FilesFixture
    let worktree: String
    /// Le commit initial : la base enregistrée de la feature.
    let base: String
    let primary: FilesTarget
    let target: FilesTarget
    let git: GitCLI
}

private func makeDiffScene() async throws -> DiffScene {
    let fixture = try FilesFixture()
    let initial = try fixture.head()

    try fixture.write("main-note.txt", "main\n")
    try fixture.git(["add", "."])
    try fixture.git(["commit", "-qm", "main avance"])

    let worktree = try fixture.makeWorktree(slug: "visionneuse")
    try fixture.write("folder/inner.txt", "f2\n", in: worktree)
    try fixture.git(["add", "."], in: worktree)
    try fixture.git(["commit", "-qm", "la branche modifie inner"], in: worktree)

    try fixture.write("tracked.txt", "b\n", in: worktree)          // non commité : retire « a », ajoute « b »
    try fixture.write("folder/new.txt", "x\ny\n", in: worktree)    // non suivi
    try fixture.write("tracked.txt", "a\nz\n")                     // principal, non commité

    let store = StoreFixture()
    let reader = filesStore(
        store,
        principal: fixture.root,
        features: [("visionneuse", "feat/visionneuse", worktree, initial)]
    )
    let git = filesGit()
    let targets = try await TargetCatalog.list(git: git, store: reader, projectRoot: fixture.root)
    guard let primary = targets.first(where: \.isPrimary), let target = targets.first(where: { !$0.isPrimary }) else {
        throw FilesFixtureFailure.git(command: "catalogue", code: 1, stderr: "cible attendue absente : \(targets.map(\.label))")
    }
    return DiffScene(fixture: fixture, worktree: worktree, base: initial, primary: primary, target: target, git: git)
}

/// La sortie de git découpée en lignes, sans le fragment vide final.
func lines(of output: String) -> [String] {
    output.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
}
