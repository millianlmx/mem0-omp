// L'arbre, prouvé PUR (S-2) : `build` ne touche pas au disque, donc l'ordre, le
// badge « supprimé » et le rejet du gitlink se prouvent sur des listes données — et
// la fixture réelle n'est là que pour vérifier que git est bien la source des
// chemins (AC-1).

import Foundation
import Testing

@testable import OMPConsole

@Test("visionneuse-de-fichiers-et-diffs/AC-1 : l'arbre réunit suivis et non suivis, marque le supprimé et écarte le gitlink")
func treeMergesTrackedUntrackedAndDeleted() {
    let disk: [String: FilesDiskState] = [
        "b/tracked.txt": .file,
        "b/new.txt": .file,
        "gone.txt": .absent,
        "module": .directory,
        "vanished.txt": .absent,
    ]
    let tree = FilesTree.build(
        tracked: ["b/tracked.txt", "gone.txt", "module"],
        untracked: ["b/new.txt", "vanished.txt"],
        disk: { disk[$0] ?? .absent }
    )

    #expect(tree.entries == [
        FilesEntry(path: "b/new.txt", kind: .untracked),
        FilesEntry(path: "b/tracked.txt", kind: .tracked),
        FilesEntry(path: "gone.txt", kind: .deleted),
    ])

    // Les répertoires d'abord, puis les fichiers ; les répertoires sont matérialisés
    // depuis les chemins.
    #expect(tree.nodes.map(\.name) == ["b", "gone.txt"])
    #expect(tree.nodes[0].isDirectory)
    #expect(tree.nodes[0].entry == nil)
    #expect(tree.nodes[0].children.map(\.name) == ["new.txt", "tracked.txt"])
    #expect(tree.nodes[0].children[1].entry == FilesEntry(path: "b/tracked.txt", kind: .tracked))
    #expect(tree.nodes[0].children[1].path == "b/tracked.txt")
    #expect(tree.nodes[1].entry?.kind == .deleted)
    #expect(tree.nodes[1].children.isEmpty)
}

@Test("visionneuse-de-fichiers-et-diffs/AC-1 : à chaque niveau, l'ordre est insensible à la casse et stable")
func treeOrderIsCaseInsensitive() {
    let tree = FilesTree.build(
        tracked: ["Zebra.txt", "apple.txt", "Apple2.txt", "readme.md"],
        untracked: ["dFolder/x.txt", "Afolder/y.txt"],
        disk: { _ in .file }
    )
    #expect(tree.nodes.map(\.name) == ["Afolder", "dFolder", "apple.txt", "Apple2.txt", "readme.md", "Zebra.txt"])

    // Égalité insensible à la casse : « apple.txt » avant « Apple2.txt », l'ordre
    // scalaire tranche (« 2 » < « . »).
    #expect(nameOrder("apple.txt", "Apple2.txt"))
    #expect(!nameOrder("Apple2.txt", "apple.txt"))
}

@Test("visionneuse-de-fichiers-et-diffs/AC-1 : un chemin vide ou absolu n'entre jamais dans l'arbre")
func treeRejectsUnusablePaths() {
    let tree = FilesTree.build(
        tracked: ["", "/etc/passwd", "ok.txt"],
        untracked: [""],
        disk: { _ in .file }
    )
    #expect(tree.entries == [FilesEntry(path: "ok.txt", kind: .tracked)])
}

@Test("visionneuse-de-fichiers-et-diffs/AC-1 : l'arbre d'une cible réelle vient de git — suivis et non suivis, jamais l'ignoré")
func realTreeComesFromGit() async throws {
    let fixture = try FilesFixture()
    try fixture.write("tracked.txt", "a\nb\n")           // suivi, modifié
    try fixture.write("folder/new.txt", "x\ny\n")        // non suivi
    try fixture.write("ignored/hidden.txt", "secret\n")  // ignoré par .gitignore
    try fixture.write(".omp/pipeline/contract.md", "# contrat\n")  // ignoré par .gitignore

    let git = filesGit()
    let tracked = try await git.run(GitCommand.lsTracked(), in: fixture.root)
    let untracked = try await git.run(GitCommand.lsUntracked(), in: fixture.root)
    #expect(tracked.code == 0)
    #expect(untracked.code == 0)

    let tree = FilesTree.build(
        tracked: nulSeparated(tracked.stdout),
        untracked: nulSeparated(untracked.stdout),
        disk: { filesDiskState(joinPath(fixture.root, $0)) }
    )

    let paths = tree.entries.map(\.path)
    #expect(paths.contains("tracked.txt"))
    #expect(paths.contains("folder/inner.txt"))
    #expect(paths.contains("folder/new.txt"))
    #expect(paths.contains(".gitignore"))
    #expect(!paths.contains(".omp/pipeline/contract.md"))
    #expect(!paths.contains("ignored/hidden.txt"))
    #expect(tree.entries.first { $0.path == "folder/new.txt" }?.kind == .untracked)
    #expect(tree.entries.first { $0.path == "tracked.txt" }?.kind == .tracked)

    // Un fichier suivi supprimé sur disque reste dans l'arbre, marqué supprimé.
    try fixture.remove("folder/inner.txt")
    let afterDelete = FilesTree.build(
        tracked: nulSeparated(tracked.stdout),
        untracked: nulSeparated(untracked.stdout),
        disk: { filesDiskState(joinPath(fixture.root, $0)) }
    )
    #expect(afterDelete.entries.first { $0.path == "folder/inner.txt" }?.kind == .deleted)
}
