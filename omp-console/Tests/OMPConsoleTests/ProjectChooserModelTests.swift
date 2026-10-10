// Preuves du sélecteur de projet des états vides (mac-etats-vides-sans-issue,
// lot BR-1) : la liste des projets connus, ses libellés, et l'écriture du choix
// par l'unique écrivain du projet choisi de l'app — relu ensuite par Fichiers,
// Terminal et Mémoire sur les MÊMES préférences.

import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

/// Une racine git minimale (un dossier `.git`) : c'est la règle de
/// `LaunchRepo.isGitRoot`, la seule que la liste applique.
private func makeGitRoot(_ path: String) throws {
    try FileManager.default.createDirectory(atPath: path + "/.git", withIntermediateDirectories: true)
}

/// Préférences jetables dont la clé vise un dossier ABSENT : `ProjectRoot`
/// rend alors `nil` sans replier sur le cwd du process de test.
private func emptyProjectSuite() -> UserDefaults {
    let suite = UserDefaults(suiteName: "project-chooser-\(UUID().uuidString)") ?? .standard
    suite.set("/nowhere/absent-\(UUID().uuidString)", forKey: ProjectRoot.defaultsKey)
    return suite
}

@MainActor
private func makeSession(defaults: UserDefaults) -> SessionConsoleModel {
    SessionConsoleModel(
        host: makeScriptedHostedHost(ScriptedServiceTransport(), sessionFile: "/tmp/project-chooser.jsonl"),
        defaults: defaults
    )
}

/// Le sélecteur branché sur le VRAI calcul des projets connus, lu dans le
/// magasin de la fixture à chaque rafraîchissement (comme l'app le lit dans son
/// `StoreHub`).
@MainActor
private func makeChooser(session: SessionConsoleModel, store: StoreFixture) -> ProjectChooserModel {
    let reader = StoreReader(stateDir: store.root)
    return ProjectChooserModel(session: session, knownRoots: { KnownProjects.roots(in: reader.readAll()) })
}

private func isNoProject(_ state: MemoryModel.State) -> Bool {
    if case .noProject = state { return true }
    return false
}

// MARK: - Projets connus

@Test("mac-etats-vides-sans-issue/AC-2 : les projets connus sont les lots ∪ les projets du magasin, racines git seulement, dédupliqués par realpath, triés")
func knownProjectsAreTheStoreRoots() throws {
    let store = StoreFixture()
    let lotRoot = store.root + "/b-depot"
    let projectRoot = store.root + "/a-depot"
    let plain = store.root + "/hors-git"
    let link = store.root + "/lien-vers-b"
    try makeGitRoot(lotRoot)
    try makeGitRoot(projectRoot)
    try FileManager.default.createDirectory(atPath: plain, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: lotRoot)

    store.publish(.lots, "\(fixtureId(0xA1)).json", object: lotObject(id: fixtureId(0xA1), repoRoot: lotRoot))
    store.publish(.lots, "\(fixtureId(0xA2)).json", object: lotObject(id: fixtureId(0xA2), repoRoot: plain))
    store.publish(.projects, "\(fixtureId(0xB1)).json", object: projectObject(repoKey: fixtureId(0xB1), repoRoot: projectRoot))
    // Le même dépôt atteint par un lien : une seule entrée.
    store.publish(.projects, "\(fixtureId(0xB2)).json", object: projectObject(repoKey: fixtureId(0xB2), repoRoot: link))

    let roots = KnownProjects.roots(in: StoreReader(stateDir: store.root).readAll())
    #expect(roots == [realpathOr(projectRoot), realpathOr(lotRoot)])
}

@Test("mac-etats-vides-sans-issue/AC-5 : un magasin absent donne une liste vide, donc aucune entrée de menu")
func absentStoreHasNoKnownProject() {
    let store = StoreFixture(stores: [])
    let roots = KnownProjects.roots(in: StoreReader(stateDir: store.root).readAll())
    #expect(roots.isEmpty)
    #expect(ProjectChooserModel.entries(for: roots).isEmpty)
}

// MARK: - Libellés

@MainActor
@Test("mac-etats-vides-sans-issue/AC-2 : une entrée par projet, libellée du nom du dossier, dans l'ordre reçu")
func entriesAreNamedByFolder() {
    let entries = ProjectChooserModel.entries(for: ["/Users/a/mem0-omp", "/Users/a/zeta"])
    #expect(entries.map(\.id) == ["/Users/a/mem0-omp", "/Users/a/zeta"])
    #expect(entries.map(\.label) == ["mem0-omp", "zeta"])
}

@MainActor
@Test("mac-etats-vides-sans-issue/AC-2 : deux projets de même nom sont distingués par leur dossier parent, sans chemin complet")
func homonymsNameTheirParent() {
    let entries = ProjectChooserModel.entries(for: ["/Users/a/clients/app", "/Users/a/perso/app", "/Users/a/outil"])
    #expect(entries.map(\.label) == ["app — clients", "app — perso", "outil"])
    #expect(entries.allSatisfy { !$0.label.contains("/") })
}

// MARK: - Le choix devient celui de l'app

@MainActor
@Test("mac-etats-vides-sans-issue/AC-4 : un projet choisi depuis l'état vide devient celui de Session OMP, Fichiers, Terminal et Mémoire")
func chosenProjectIsTheAppProject() async throws {
    let repo = try FilesFixture()
    let store = StoreFixture()
    store.publish(.lots, "\(fixtureId(0xC1)).json", object: lotObject(id: fixtureId(0xC1), repoRoot: repo.root))
    let suite = emptyProjectSuite()
    let session = makeSession(defaults: suite)
    #expect(session.projectRoot == nil)

    // La liste parle en `realpath` (`/private/var/…`), la fixture en `/var/…`.
    let chosen = realpathOr(repo.root)
    let chooser = makeChooser(session: session, store: store)
    chooser.refresh()
    let entry = try #require(chooser.entries.first { $0.id == chosen })
    #expect(chooser.choose(entry))

    // Session OMP : la section publiée ET la préférence partagée.
    #expect(session.projectRoot?.path == chosen)
    #expect(suite.string(forKey: ProjectRoot.defaultsKey) == chosen)

    // Fichiers, sur les mêmes préférences, au rafraîchissement d'apparition.
    let files = FilesModel(
        projectRoot: nil,
        git: filesGit(),
        store: StoreReader(stateDir: store.root),
        defaults: suite,
        fileManager: .default,
        environment: ["PATH": "/usr/bin:/bin"]
    )
    await files.refresh()
    #expect(files.projectRoot?.path == chosen)
    #expect(files.errorMessage == nil)

    // Terminal : sur les mêmes préférences, il nomme ce projet (construction et
    // apparition relisent la préférence par `followProjectRoot()`).
    let terminal = TerminalConsoleModel(
        defaults: suite,
        environment: ["PATH": "/usr/bin:/bin"],
        store: StoreReader(stateDir: store.root),
        git: filesGit()
    )
    terminal.followProjectRoot()
    #expect(terminal.projectRoot?.path == chosen)
    #expect(terminal.projectPath == chosen)

    // Mémoire : la portée suit le projet, l'écran quitte « Aucun projet ouvert ».
    let memory = MemoryModel(
        service: ScriptedMemoryService(),
        environment: ["PATH": "/usr/bin:/bin"],
        defaults: suite,
        paths: AppPaths(supportRoot: URL(fileURLWithPath: "/nonexistent-omp-console-support", isDirectory: true)),
        omlxSession: StubURLProtocol.session()
    )
    await memory.refresh()
    #expect(!isNoProject(memory.state))
}

@MainActor
@Test("mac-etats-vides-sans-issue/AC-4 : le Terminal déjà construit suit un projet choisi ailleurs dès qu'il relit la préférence")
func terminalFollowsTheAppProject() throws {
    let repo = try FilesFixture()
    let suite = emptyProjectSuite()
    let terminal = TerminalConsoleModel(
        defaults: suite,
        environment: ["PATH": "/usr/bin:/bin"],
        store: StoreReader(stateDir: NSTemporaryDirectory()),
        git: filesGit()
    )
    #expect(terminal.projectRoot == nil)
    #expect(terminal.projectPath == nil)

    makeSession(defaults: suite).select(projectRoot: URL(fileURLWithPath: repo.root, isDirectory: true))
    #expect(terminal.projectRoot == nil, "la préférence n'émet rien : il faut la relire")
    terminal.followProjectRoot()
    #expect(terminal.projectRoot?.path == repo.root)
    #expect(terminal.projectPath == repo.root)
}

@MainActor
@Test("mac-etats-vides-sans-issue/AC-2 : une entrée dont le dossier a disparu n'écrit rien et sort du menu")
func vanishedEntryWritesNothing() throws {
    let store = StoreFixture()
    let gone = store.root + "/disparu"
    try makeGitRoot(gone)
    store.publish(.lots, "\(fixtureId(0xD1)).json", object: lotObject(id: fixtureId(0xD1), repoRoot: gone))
    let suite = emptyProjectSuite()
    let before = suite.string(forKey: ProjectRoot.defaultsKey)
    let session = makeSession(defaults: suite)
    let chooser = makeChooser(session: session, store: store)
    chooser.refresh()
    let entry = try #require(chooser.entries.first { $0.id == realpathOr(gone) })

    try FileManager.default.removeItem(atPath: gone)
    #expect(!chooser.choose(entry))
    #expect(session.projectRoot == nil)
    #expect(suite.string(forKey: ProjectRoot.defaultsKey) == before)
    #expect(!chooser.entries.contains(entry))
}

// MARK: - Les états vides (lot BR-2)
//
// SwiftUI ne s'inspecte pas depuis la suite (aucun arbre AX hors d'un client
// réel) : ce qui décide de l'écran vit dans `NoProjectState`,
// `ProjectChooserForm` et `TerminalPlaceholder`, que ces tests confrontent aux
// états RÉELS des trois modèles sans projet.

@MainActor
private func makeTerminal(defaults: UserDefaults, store: String = NSTemporaryDirectory()) -> TerminalConsoleModel {
    TerminalConsoleModel(
        defaults: defaults,
        environment: ["PATH": "/usr/bin:/bin"],
        store: StoreReader(stateDir: store),
        git: filesGit()
    )
}

@MainActor
private func makeMemory(defaults: UserDefaults) -> MemoryModel {
    MemoryModel(
        service: ScriptedMemoryService(),
        environment: ["PATH": "/usr/bin:/bin"],
        defaults: defaults,
        paths: AppPaths(supportRoot: URL(fileURLWithPath: "/nonexistent-omp-console-support", isDirectory: true)),
        omlxSession: StubURLProtocol.session()
    )
}

@MainActor
private func makeFiles(defaults: UserDefaults, store: String) -> FilesModel {
    FilesModel(
        projectRoot: nil,
        git: filesGit(),
        store: StoreReader(stateDir: store),
        defaults: defaults,
        fileManager: .default,
        environment: ["PATH": "/usr/bin:/bin"]
    )
}

@MainActor
@Test("mac-etats-vides-sans-issue/AC-1 : sans projet choisi, Mémoire, Fichiers et Terminal montrent « Aucun projet ouvert », leur phrase et le bouton « Choisir un projet… »")
func threeEmptyStatesCarryTheChooser() async {
    let suite = emptyProjectSuite()

    // Les trois modèles, dans l'état réel « sans projet » qui rend l'état vide.
    let memory = makeMemory(defaults: suite)
    await memory.refresh()
    #expect(isNoProject(memory.state))
    let files = makeFiles(defaults: suite, store: NSTemporaryDirectory())
    await files.refresh()
    #expect(files.projectRoot == nil)
    #expect(files.errorMessage == nil)
    let terminal = makeTerminal(defaults: suite)
    #expect(TerminalPlaceholder.of(terminal) == .noProject)

    // Ce que chacun de ces états montre.
    #expect(NoProjectState.memory == NoProjectState(
        title: "Aucun projet ouvert",
        description: "Choisissez le projet dont vous voulez consulter la mémoire.",
        chooserIdentifier: "memory.chooseProject"
    ))
    #expect(NoProjectState.files == NoProjectState(
        title: "Aucun projet ouvert",
        description: "Choisissez le projet dont vous voulez parcourir les fichiers.",
        chooserIdentifier: "files.chooseProject"
    ))
    #expect(NoProjectState.terminal == NoProjectState(
        title: "Aucun projet ouvert",
        description: "Choisissez le projet dans lequel ouvrir un terminal.",
        chooserIdentifier: "terminal.chooseProject"
    ))
    #expect(NoProjectState.systemImage == "folder.badge.questionmark")
    #expect(ProjectChooserText.choose == "Choisir un projet\u{2026}")
}

@MainActor
@Test("mac-etats-vides-sans-issue/AC-1 : le Terminal ne montre l'état vide que sans shell, hors chargement et sans projet ; avec projet, il nomme le projet")
func terminalPlaceholderFollowsTheProject() throws {
    let repo = try FilesFixture()
    let suite = emptyProjectSuite()
    let terminal = makeTerminal(defaults: suite)
    #expect(TerminalPlaceholder.of(terminal) == .noProject)

    makeSession(defaults: suite).select(projectRoot: URL(fileURLWithPath: repo.root, isDirectory: true))
    terminal.followProjectRoot()
    let name = (repo.root as NSString).lastPathComponent
    #expect(TerminalPlaceholder.of(terminal) == .waiting(projectName: name))
    #expect(terminal.statusText == "Choisissez un répertoire…")
    #expect(TerminalViewText.projectNamed(name) == "Projet « \(name) »")
}

@MainActor
@Test("mac-etats-vides-sans-issue/AC-2 : des projets connus ouvrent un menu — une entrée par projet, un séparateur, puis « Choisir un dossier… »")
func knownProjectsOpenAMenu() throws {
    let store = StoreFixture()
    let alpha = store.root + "/alpha"
    let beta = store.root + "/beta"
    try makeGitRoot(alpha)
    try makeGitRoot(beta)
    store.publish(.lots, "\(fixtureId(0xE1)).json", object: lotObject(id: fixtureId(0xE1), repoRoot: alpha))
    store.publish(.lots, "\(fixtureId(0xE2)).json", object: lotObject(id: fixtureId(0xE2), repoRoot: beta))
    let chooser = makeChooser(session: makeSession(defaults: emptyProjectSuite()), store: store)
    chooser.refresh()

    let entries = [
        ProjectChooserModel.Entry(id: realpathOr(alpha), label: "alpha"),
        ProjectChooserModel.Entry(id: realpathOr(beta), label: "beta"),
    ]
    #expect(chooser.entries == entries)
    #expect(ProjectChooserForm.of(chooser.entries) == .menu([.project(entries[0]), .project(entries[1]), .separator, .chooseFolder]))
    #expect(SessionConsoleText.chooseFolder == "Choisir un dossier\u{2026}")
}

@MainActor
@Test("mac-etats-vides-sans-issue/AC-5 : aucun projet connu — un bouton simple vers le panneau de Session OMP, jamais un menu vide")
func noKnownProjectIsAPlainButton() {
    let chooser = ProjectChooserModel(session: makeSession(defaults: emptyProjectSuite()), knownRoots: { [] })
    chooser.refresh()
    #expect(chooser.entries.isEmpty)
    #expect(ProjectChooserForm.of(chooser.entries) == .folderButton)
}

@MainActor
@Test("mac-etats-vides-sans-issue/AC-3 : un projet choisi depuis l'état vide remplit l'écran courant — Mémoire et Fichiers se rechargent, le Terminal ouvre sa feuille sur ce projet")
func chosenProjectFillsTheCurrentScreen() async throws {
    let repo = try FilesFixture()
    let store = StoreFixture()
    store.publish(.lots, "\(fixtureId(0xF1)).json", object: lotObject(id: fixtureId(0xF1), repoRoot: repo.root))
    let suite = emptyProjectSuite()
    let chosen = realpathOr(repo.root)

    // Les trois écrans sont dans leur état vide, modèles construits AVANT le choix
    // (comme dans l'app, où ils vivent à l'échelle de l'app).
    let memory = makeMemory(defaults: suite)
    await memory.refresh()
    #expect(isNoProject(memory.state))
    let files = makeFiles(defaults: suite, store: store.root)
    await files.refresh()
    #expect(files.projectRoot == nil)
    let terminal = makeTerminal(defaults: suite, store: store.root)
    #expect(TerminalPlaceholder.of(terminal) == .noProject)

    let chooser = makeChooser(session: makeSession(defaults: suite), store: store)
    chooser.refresh()
    let entry = try #require(chooser.entries.first { $0.id == chosen })
    #expect(chooser.choose(entry))

    // Mémoire : `onChosen` = `refresh()` ; l'écran quitte « Aucun projet ouvert ».
    await memory.refresh()
    #expect(!isNoProject(memory.state))

    // Fichiers : `onChosen` = `refresh()` ; la cible et l'arbre du projet.
    await files.refresh()
    #expect(files.projectRoot?.path == chosen)
    #expect(files.errorMessage == nil)
    #expect(files.tree != nil)

    // Terminal : `onChosen` = `openPicker()` ; la feuille liste le dépôt du projet.
    terminal.openPicker()
    #expect(terminal.isPickerPresented)
    #expect(terminal.projectRoot?.path == chosen)
    #expect(await awaitMainTrue(timeout: 8) { terminal.targetsState != .loading && !terminal.targets.isEmpty })
    let primary = try #require(terminal.targets.first { $0.isPrimary })
    #expect(realpathOr(primary.path) == chosen)

    // « Annuler » : l'attente nomme le projet, plus d'état vide.
    terminal.dismissPicker()
    #expect(TerminalPlaceholder.of(terminal) == .waiting(projectName: (chosen as NSString).lastPathComponent))
}

@Test("mac-etats-vides-sans-issue/AC-6 : aucun texte des trois états vides ne cite de raccourci clavier, quelle que soit la disposition")
func emptyStatesNameNoShortcut() {
    let texts = [
        MemoryText.noProjectTitle, MemoryText.noProjectDescription,
        FilesText.noProjectTitle, FilesText.noProjectDescription,
        TerminalViewText.noProjectTitle, TerminalViewText.noProjectDescription,
        ProjectChooserText.choose,
    ]
    for text in texts {
        for token in ["⌘", "⌥", "⇧", "⌃", "Cmd", "Ctrl"] {
            #expect(!text.contains(token), "« \(text) » cite « \(token) »")
        }
        #expect(!text.contains { $0.isNumber }, "« \(text) » cite un chiffre")
    }
}
