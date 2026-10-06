// La portée mémoire du projet (S-4, BR-1) : le MÊME algorithme que `projectId` du
// plugin, sur de VRAIS dépôts git jetables — un mock ne prouverait ni la résolution
// du worktree lié ni l'ordre des manifestes.
//
// C'est cette portée qui rend AC-4 et AC-5 vrais : `agent_id` vaut toujours le
// projet courant, jamais `_global`.

import Foundation
import Testing

@testable import OMPConsole
import ConsoleCore

@Test("memoire-mem0/AC-4 : sans manifeste, la portée est le nom du répertoire du dépôt principal")
func ac4ScopeFallsBackToTheRepositoryBasename() async throws {
    let fixture = try FilesFixture()
    let scope = await MemoryScope.scope(projectRoot: fixture.root, environment: [:], git: filesGit())
    #expect(scope == (fixture.root as NSString).lastPathComponent)
}

@Test("memoire-mem0/AC-4 : la portée vient du manifeste, dans l'ordre package.json, pyproject.toml, Cargo.toml, Package.swift")
func ac4ScopeReadsManifestsInOrder() async throws {
    let fixture = try FilesFixture()
    try fixture.write("Cargo.toml", "[package]\nname = \"cargo-name\"\n")
    try fixture.write("Package.swift", "let package = Package(name: \"swift-name\")\n")
    // Seuls Cargo.toml et Package.swift portent un nom : Cargo.toml est plus haut
    // dans la table, il gagne.
    #expect(await MemoryScope.scope(projectRoot: fixture.root, environment: [:], git: filesGit()) == "cargo-name")

    try fixture.remove("Cargo.toml")
    #expect(await MemoryScope.scope(projectRoot: fixture.root, environment: [:], git: filesGit()) == "swift-name")

    // pyproject.toml passe avant Package.swift.
    try fixture.write("pyproject.toml", "[project]\nname = \"pyproject-name\"\n")
    #expect(await MemoryScope.scope(projectRoot: fixture.root, environment: [:], git: filesGit()) == "pyproject-name")

    // package.json passe avant tout le reste.
    try fixture.write("package.json", "{\"name\": \"package-name\"}")
    #expect(await MemoryScope.scope(projectRoot: fixture.root, environment: [:], git: filesGit()) == "package-name")
}

@Test("memoire-mem0/AC-4 : un nom de manifeste vide ne gagne pas, et un manifeste illisible non plus")
func ac4ScopeIgnoresEmptyAndBrokenManifests() async throws {
    let fixture = try FilesFixture()
    try fixture.write("package.json", "{\"name\": \"\"}")
    try fixture.write("pyproject.toml", "[project]\nname = \"toml-name\"\n")
    #expect(await MemoryScope.scope(projectRoot: fixture.root, environment: [:], git: filesGit()) == "toml-name")

    try fixture.write("package.json", "pas du json")
    #expect(await MemoryScope.scope(projectRoot: fixture.root, environment: [:], git: filesGit()) == "toml-name")
}

@Test("memoire-mem0/AC-4 : à défaut de manifeste, le premier *.xcodeproj donne son nom, et le manifeste gagne sur lui")
func ac4ScopeFallsBackToTheXcodeProject() async throws {
    let fixture = try FilesFixture()
    try FileManager.default.createDirectory(
        atPath: joinPath(fixture.root, "Bar.xcodeproj"),
        withIntermediateDirectories: true
    )
    #expect(await MemoryScope.scope(projectRoot: fixture.root, environment: [:], git: filesGit()) == "Bar")

    // Un manifeste et un xcodeproj coexistent : le manifeste gagne (state.ts:73-89).
    try fixture.write("Package.swift", "let package = Package(name: \"swift-name\")\n")
    #expect(await MemoryScope.scope(projectRoot: fixture.root, environment: [:], git: filesGit()) == "swift-name")
}

@Test("memoire-mem0/AC-4 : MEM0_PROJECT_ID non vide impose la portée ; posée mais vide, elle est ignorée")
func ac4ScopeHonoursTheProjectIdOverride() async throws {
    let fixture = try FilesFixture()
    try fixture.write("package.json", "{\"name\": \"package-name\"}")

    let forced = await MemoryScope.scope(
        projectRoot: fixture.root,
        environment: ["MEM0_PROJECT_ID": "force"],
        git: filesGit()
    )
    #expect(forced == "force")

    let empty = await MemoryScope.scope(
        projectRoot: fixture.root,
        environment: ["MEM0_PROJECT_ID": ""],
        git: filesGit()
    )
    #expect(empty == "package-name")
}

@Test("memoire-mem0/AC-4 : depuis un worktree de feature, la portée est celle du dépôt PRINCIPAL")
func ac4ScopeOfAWorktreeIsThePrimaryRepository() async throws {
    let fixture = try FilesFixture()
    try fixture.write("package.json", "{\"name\": \"principal-name\"}")
    try fixture.git(["add", "."])
    try fixture.git(["commit", "-qm", "manifeste"])
    let worktree = try fixture.makeWorktree(slug: "memoire")

    let fromWorktree = await MemoryScope.scope(projectRoot: worktree, environment: [:], git: filesGit())
    let fromPrimary = await MemoryScope.scope(projectRoot: fixture.root, environment: [:], git: filesGit())
    #expect(fromWorktree == "principal-name")
    #expect(fromWorktree == fromPrimary)
}

@Test("memoire-mem0/AC-4 : sans dépôt git, la portée n'est pas calculable — nil, donc aucun appel réseau")
func ac4ScopeIsNilWithoutARepository() async throws {
    let directory = canonicalPath(
        (NSTemporaryDirectory() as NSString).appendingPathComponent("memoire-hors-depot-\(UUID().uuidString)")
    )
    try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: directory) }

    let scope = await MemoryScope.scope(projectRoot: directory, environment: [:], git: filesGit())
    #expect(scope == nil)
}
