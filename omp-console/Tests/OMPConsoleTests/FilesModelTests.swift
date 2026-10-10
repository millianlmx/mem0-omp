// Les transitions du modèle de la section « Fichiers » (S-1 à S-6), prouvées sur un
// dépôt réel : c'est le niveau où les gestes de l'utilisateur (choisir une cible,
// ouvrir un fichier, ouvrir le contrat) deviennent des documents publiés.

import Foundation
import Testing

@testable import OMPConsole

@MainActor
@Test("visionneuse-de-fichiers-et-diffs/AC-2 : à l'ouverture, la cible active est celle du projet ouvert, et la changer recharge l'arbre")
func defaultTargetFollowsTheOpenProject() async throws {
    let scene = try FilesScene()
    await scene.open()

    #expect(scene.model.targets.count == 2)
    #expect(scene.model.target?.path == scene.worktree)
    #expect(scene.model.target?.isPrimary == false)
    #expect(scene.model.nodes.isEmpty == false)

    // L'arbre est celui du worktree : son fichier non suivi y est, celui du principal
    // n'y est pas.
    let paths = scene.model.tree?.entries.map(\.path) ?? []
    #expect(paths.contains("folder/new.txt"))
    #expect(paths.contains(FilesModel.projectDocumentRelativePath) == false)

    // Changer de cible : le principal, et SON arbre.
    try scene.fixture.write("only-main.txt", "m\n")
    guard let primary = scene.model.targets.first(where: \.isPrimary) else {
        Issue.record("le principal doit être une cible")
        return
    }
    scene.model.select(target: primary)
    #expect(await waitUntilFiles { scene.model.target?.path == primary.path && scene.model.tree != nil })
    #expect(await waitUntilFiles { scene.model.tree?.entries.map(\.path).contains("only-main.txt") == true })
    #expect(scene.model.tree?.entries.map(\.path).contains("folder/new.txt") == false)
}

@MainActor
@Test("visionneuse-de-fichiers-et-diffs/AC-3 : le modèle publie le diff d'un fichier suivi, identique à `git diff <base> -- <fichier>`")
func trackedDiffIsPublished() async throws {
    let scene = try FilesScene()
    await scene.open()
    await scene.openFile("tracked.txt")

    #expect(scene.model.diffBase == .commit(scene.base))
    let expected = try scene.fixture.git(
        ["diff", "--no-color", "--no-ext-diff", scene.base, "--", "tracked.txt"],
        in: scene.worktree
    )
    let diff = try #require(scene.model.diff)
    #expect(!diff.isEmpty)
    #expect(diff.lines.map(\.text) == lines(of: expected))
    #expect(diff.hunks.flatMap { $0 }.contains { $0.kind == .removal && $0.text == "-a" })
    #expect(scene.model.diffFailure == nil)
}

@MainActor
@Test("visionneuse-de-fichiers-et-diffs/AC-4 : un fichier modifié par un commit de la branche seule rend un diff non vide dans le modèle")
func branchCommitDiffIsPublished() async throws {
    let scene = try FilesScene()
    await scene.open()
    await scene.openFile("folder/inner.txt")

    let diff = try #require(scene.model.diff)
    #expect(!diff.isEmpty)
    #expect(diff.hunks.flatMap { $0 }.contains { $0.text == "+f2" })
}

@MainActor
@Test("visionneuse-de-fichiers-et-diffs/AC-5 : le diff d'un fichier non suivi est publié comme un ajout, et le code 1 est accepté")
func untrackedDiffIsPublished() async throws {
    let scene = try FilesScene()
    await scene.open()
    await scene.openFile("folder/new.txt")

    // Le code de sortie de `--no-index` vaut 1 « il y a des différences » : s'il était
    // traité comme une erreur, `diffFailure` porterait un message au lieu du diff.
    #expect(scene.model.diffFailure == nil)
    let diff = try #require(scene.model.diff)
    #expect(diff.header.contains { $0.text == "--- /dev/null" })
    #expect(diff.hunks.flatMap { $0 }.filter { $0.kind == .addition }.map(\.text) == ["+x", "+y"])
    #expect(scene.model.content == .text("x\ny\n"))
}

@MainActor
@Test("visionneuse-de-fichiers-et-diffs/AC-6 : dans le principal, le modèle diffuse contre HEAD")
func primaryDiffUsesHeadInTheModel() async throws {
    let scene = try FilesScene()
    await scene.open()
    guard let primary = scene.model.targets.first(where: \.isPrimary) else {
        Issue.record("le principal doit être une cible")
        return
    }
    scene.model.select(target: primary)
    #expect(await waitUntilFiles { scene.model.target?.isPrimary == true && scene.model.tree != nil })
    await scene.openFile("tracked.txt")

    #expect(scene.model.diffBase == .head)
    let expected = try scene.fixture.git(["diff", "--no-color", "--no-ext-diff", "HEAD", "--", "tracked.txt"])
    let diff = try #require(scene.model.diff)
    #expect(!diff.isEmpty)
    #expect(diff.lines.map(\.text) == lines(of: expected))
    #expect(diff.hunks.flatMap { $0 }.contains { $0.kind == .addition && $0.text == "+z" })
}

@MainActor
@Test("visionneuse-de-fichiers-et-diffs/AC-7 : ouvrir un fichier publie son contenu, à l'identique du disque")
func contentIsPublishedByteExact() async throws {
    let scene = try FilesScene(contract: "ligne accentuée : éàü ✓\n")
    await scene.open()
    await scene.openFile("tracked.txt")
    #expect(scene.model.content == .text("b\n"))

    // Un fichier modifié par un commit de la branche aussi : la visionneuse n'est pas
    // un lecteur de diffs non commités.
    await scene.openFile("folder/inner.txt")
    #expect(scene.model.content == .text("f2\n"))

    let onDisk = try #require(scene.fixture.read(".gitignore", in: scene.worktree))
    await scene.openFile(".gitignore")
    #expect(scene.model.content == .text(onDisk))
}

@MainActor
@Test("visionneuse-de-fichiers-et-diffs/AC-8 : l'accès dédié au contrat publie le contrat de la CIBLE ACTIVE, et désélectionne l'arbre")
func contractOfActiveTargetIsPublished() async throws {
    let scene = try FilesScene(contract: "# contrat du worktree\n")
    await scene.open()
    await scene.openFile("tracked.txt")
    #expect(scene.model.highlight == "tracked.txt")

    scene.model.openContract()
    #expect(await waitUntilFiles { scene.model.content == .text("# contrat du worktree\n") })
    #expect(scene.model.pane == .contract)
    #expect(scene.model.highlight == nil)
    #expect(scene.model.target?.path == scene.worktree)
    // Le contrat n'est PAS une entrée d'arbre : git l'ignore.
    #expect(scene.model.tree?.entries.map(\.path).contains(FilesModel.contractRelativePath) == false)
    // Aucun diff n'est calculé pour un document dédié.
    #expect(scene.model.diff == nil)
}

@MainActor
@Test("visionneuse-de-fichiers-et-diffs/AC-9 : sans contrat, l'accès dédié rend « missing » et le texte d'absence, jamais un autre contenu")
func missingContractIsReported() async throws {
    let scene = try FilesScene(contract: nil)
    await scene.open()

    scene.model.openContract()
    #expect(await waitUntilFiles { scene.model.content == .missing })
    #expect(scene.model.pane == .contract)
    #expect(FilesText.missingDedicatedDocument(FilesModel.contractRelativePath) == FilesText.noContract)
    #expect(FilesText.noContract == "Aucun contrat dans ce dossier.")
    // Le texte affiché est bien celui de l'ABSENCE, pas celui d'un fichier disparu.
    #expect(scene.model.content?.message(dedicated: FilesModel.contractRelativePath) == FilesText.noContract)
}

@MainActor
@Test("visionneuse-de-fichiers-et-diffs/AC-8 : après un changement de cible, l'accès dédié relit le contrat de la NOUVELLE cible")
func contractFollowsTheTargetChange() async throws {
    let scene = try FilesScene(contract: "# contrat du worktree\n")
    try scene.fixture.write(FilesModel.contractRelativePath, "# contrat du principal\n")
    await scene.open()

    scene.model.openContract()
    #expect(await waitUntilFiles { scene.model.content == .text("# contrat du worktree\n") })

    guard let primary = scene.model.targets.first(where: \.isPrimary) else {
        Issue.record("le principal doit être une cible")
        return
    }
    scene.model.select(target: primary)
    #expect(await waitUntilFiles { scene.model.target?.isPrimary == true && scene.model.tree != nil })

    // Le document affiché est celui de la cible COURANTE : jamais le contenu laissé
    // par la cible précédente.
    #expect(await waitUntilFiles { scene.model.content == .text("# contrat du principal\n") })
    #expect(scene.model.pane == .contract)
}

@MainActor
@Test("visionneuse-de-fichiers-et-diffs/AC-10 : l'accès dédié à PROJECT.md publie le document du dépôt principal")
func projectDocumentIsPublished() async throws {
    let scene = try FilesScene(projectDocument: "# projet de la fixture\n")
    await scene.open()
    guard let primary = scene.model.targets.first(where: \.isPrimary) else {
        Issue.record("le principal doit être une cible")
        return
    }
    scene.model.select(target: primary)
    #expect(await waitUntilFiles { scene.model.target?.isPrimary == true && scene.model.tree != nil })

    scene.model.openProjectDocument()
    #expect(await waitUntilFiles { scene.model.content == .text("# projet de la fixture\n") })
    #expect(scene.model.pane == .projectDocument)
    #expect(scene.model.diff == nil)
}

@MainActor
@Test("visionneuse-de-fichiers-et-diffs/AC-13 : le parcours complet par le MODÈLE ne change ni l'état git ni un fichier de la cible")
func modelWalkIsReadOnly() async throws {
    let scene = try FilesScene()
    await scene.open()

    let statusBefore = try scene.fixture.status(in: scene.worktree)
    let indexBefore = try scene.fixture.indexDigest(in: scene.worktree)
    let filesBefore = scene.fixture.fileDigests(in: scene.worktree)

    for entry in scene.model.tree?.entries ?? [] where entry.kind != .deleted {
        scene.model.select(file: entry)
        _ = await waitUntilFiles { scene.model.highlight == entry.path && scene.model.content != nil }
    }
    scene.model.openContract()
    _ = await waitUntilFiles { scene.model.content != nil }

    #expect(try scene.fixture.status(in: scene.worktree) == statusBefore)
    #expect(try scene.fixture.indexDigest(in: scene.worktree) == indexBefore)
    #expect(scene.fixture.fileDigests(in: scene.worktree) == filesBefore)
}

@MainActor
@Test("visionneuse-de-fichiers-et-diffs/AC-14 : lire un fichier non suivi par le modèle le laisse « ?? »")
func untrackedStaysUntrackedThroughModel() async throws {
    let scene = try FilesScene(contract: nil)
    await scene.open()
    let before = try scene.fixture.status(in: scene.worktree)
    #expect(before.contains("?? folder/new.txt"))

    await scene.openFile("folder/new.txt")

    let after = try scene.fixture.status(in: scene.worktree)
    #expect(after == before)
    #expect(after.contains("?? folder/new.txt"))
}

@MainActor
@Test("visionneuse-de-fichiers-et-diffs/AC-9 : un projet sans git est dit, jamais silencieux")
func missingGitIsReportedInTheModel() async throws {
    // Un `PATH` sans git ET un override qui n'existe pas : la résolution échoue.
    let suite = UserDefaults(suiteName: "omp-console-files-\(UUID().uuidString)") ?? .standard
    let model = FilesModel(
        projectRoot: URL(fileURLWithPath: NSTemporaryDirectory()),
        git: nil,
        store: StoreReader(stateDir: NSTemporaryDirectory()),
        defaults: suite,
        fileManager: .default,
        environment: ["PATH": "/nowhere", "OMP_CONSOLE_GIT_BINARY": "/nowhere/git"]
    )
    #expect(model.errorMessage?.message == FilesText.gitNotFound)
    #expect(model.errorMessage?.diagnostic.contains("git est introuvable") == true)
    #expect(model.errorMessage?.diagnostic.contains("la visionneuse ne peut pas lire") == true)

    await model.refresh()
    #expect(model.errorMessage?.diagnostic.contains("git est introuvable") == true)
    #expect(model.targets.isEmpty)
}

@MainActor
@Test("visionneuse-de-fichiers-et-diffs/AC-2 : sans projet ouvert, le modèle n'annonce aucune erreur et ne lance aucune lecture")
func noProjectIsAnEmptyState() async throws {
    // Clé PRÉSENTE mais invalide : la règle de `ProjectRoot` rend alors `nil` sans
    // replier sur le cwd — c'est le seul moyen de prouver l'état « aucun projet »
    // sans changer le répertoire courant du process de test.
    let suite = UserDefaults(suiteName: "omp-console-files-\(UUID().uuidString)") ?? .standard
    suite.set("/nowhere/absent", forKey: ProjectRoot.defaultsKey)
    let model = FilesModel(
        projectRoot: nil,
        git: filesGit(),
        store: StoreReader(stateDir: NSTemporaryDirectory()),
        defaults: suite,
        fileManager: .default,
        environment: ["PATH": "/usr/bin:/bin"]
    )
    await model.refresh()
    #expect(model.projectRoot == nil)
    #expect(model.errorMessage == nil)
    #expect(model.targets.isEmpty)
    #expect(model.tree == nil)
    #expect(model.pane == .none)
}

@MainActor
@Test("visionneuse-de-fichiers-et-diffs/AC-2 : un projet hors dépôt git est une erreur nommée, pas un catalogue vide muet")
func nonRepositoryIsReported() async throws {
    let plain = canonicalPath(
        (NSTemporaryDirectory() as NSString).appendingPathComponent("omp-console-modele-hors-depot-\(UUID().uuidString)")
    )
    try FileManager.default.createDirectory(atPath: plain, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: plain) }

    let suite = UserDefaults(suiteName: "omp-console-files-\(UUID().uuidString)") ?? .standard
    suite.set(plain, forKey: ProjectRoot.defaultsKey)
    let model = FilesModel(
        projectRoot: URL(fileURLWithPath: plain),
        git: filesGit(),
        store: StoreReader(stateDir: NSTemporaryDirectory()),
        defaults: suite,
        fileManager: .default,
        environment: ["PATH": "/usr/bin:/bin"]
    )
    await model.refresh()
    #expect(model.errorMessage == FilesError.notARepository(path: plain).failure)
    #expect(model.target == nil)
}

@MainActor
@Test("visionneuse-de-fichiers-et-diffs/AC-2 : une cible disparue laisse la liste des cibles affichée, pour en choisir une autre")
func goneTargetKeepsTheCatalog() async throws {
    // Le projet ouvert est le PRINCIPAL : le worktree est une cible, pas la racine du
    // projet — c'est ainsi qu'une cible peut disparaître sans emporter le catalogue.
    let scene = try FilesScene(projectRootIsPrimary: true)
    await scene.open()
    #expect(scene.model.targets.count == 2)
    guard let worktree = scene.model.targets.first(where: { !$0.isPrimary }) else {
        Issue.record("le worktree doit être une cible")
        return
    }
    scene.model.select(target: worktree)
    #expect(await waitUntilFiles { scene.model.target?.path == scene.worktree && scene.model.tree != nil })

    try FileManager.default.removeItem(atPath: scene.worktree)
    await scene.model.refresh()

    #expect(scene.model.notice?.message == FilesText.targetGone)
    #expect(scene.model.notice?.diagnostic.contains("n'existe plus") == true)
    #expect(scene.model.targets.count == 1)
    #expect(scene.model.target?.isPrimary == true)
    #expect(scene.model.tree != nil)
}

@MainActor
@Test("visionneuse-de-fichiers-et-diffs/AC-2 : le projet ouvert disparu rend l'état « aucun projet », jamais un catalogue d'un autre projet")
func goneProjectRootIsReported() async throws {
    let scene = try FilesScene()
    await scene.open()
    try FileManager.default.removeItem(atPath: scene.worktree)

    // La règle de `ProjectRoot` (celle de la fenêtre « Session OMP ») est la même ici :
    // une clé présente qui ne désigne plus un dossier rend `nil`.
    await scene.model.refresh()
    #expect(scene.model.projectRoot == nil)
    #expect(scene.model.errorMessage == nil)
    #expect(scene.model.targets.isEmpty)
    #expect(scene.model.target == nil)
    #expect(scene.model.tree == nil)
}
