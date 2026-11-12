// Preuves du sélecteur de projet de l'état vide de la Mémoire (mac-etats-vides-sans-issue,
// lot BR-1) : la liste des projets déjà choisis, ses libellés, et l'écriture du
// choix par l'unique écrivain du projet choisi de l'app — relu ensuite par la
// Mémoire sur les MÊMES préférences.

import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

/// Une racine git minimale (un dossier `.git`) : c'est la seule règle que la
/// liste applique.
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

/// Un dossier jetable, pour y créer des racines.
private func scratchDirectory() throws -> String {
    let dir = (NSTemporaryDirectory() as NSString).appendingPathComponent("project-chooser-\(UUID().uuidString)")
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    return dir
}

/// Le chemin tel que le sélecteur l'écrit.
private func standardized(_ path: String) -> String {
    URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL.path
}

private func isNoProject(_ state: MemoryModel.State) -> Bool {
    if case .noProject = state { return true }
    return false
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

// MARK: - Projets connus

@MainActor
@Test("mac-etats-vides-sans-issue/AC-2 : les projets connus sont les derniers choisis, du plus récent au plus ancien, racines git seulement")
func knownProjectsAreTheRecentChoices() throws {
    let dir = try scratchDirectory()
    let alpha = dir + "/alpha"
    let beta = dir + "/beta"
    let plain = dir + "/hors-git"
    try makeGitRoot(alpha)
    try makeGitRoot(beta)
    try FileManager.default.createDirectory(atPath: plain, withIntermediateDirectories: true)

    let suite = emptyProjectSuite()
    let chooser = ProjectChooserModel(defaults: suite)
    chooser.select(projectRoot: URL(fileURLWithPath: alpha, isDirectory: true))
    chooser.select(projectRoot: URL(fileURLWithPath: plain, isDirectory: true))
    chooser.select(projectRoot: URL(fileURLWithPath: beta, isDirectory: true))
    // Re-choisir un projet le remonte en tête, sans doublon.
    chooser.select(projectRoot: URL(fileURLWithPath: alpha, isDirectory: true))

    #expect(chooser.knownRoots == [standardized(alpha), standardized(beta)])
    #expect(chooser.entries.map(\.label) == ["alpha", "beta"])
}

@MainActor
@Test("mac-etats-vides-sans-issue/AC-5 : sans projet déjà choisi, la liste est vide, donc aucune entrée de menu")
func noRecentChoiceHasNoKnownProject() {
    let chooser = ProjectChooserModel(defaults: emptyProjectSuite())
    chooser.refresh()
    #expect(chooser.knownRoots.isEmpty)
    #expect(chooser.entries.isEmpty)
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
@Test("mac-etats-vides-sans-issue/AC-4 : un projet choisi depuis l'état vide devient celui de la Mémoire")
func chosenProjectIsTheAppProject() async throws {
    let repo = try GitFixture()
    let suite = emptyProjectSuite()
    let chooser = ProjectChooserModel(defaults: suite)
    chooser.select(projectRoot: URL(fileURLWithPath: repo.root, isDirectory: true))
    #expect(suite.string(forKey: ProjectRoot.defaultsKey) == standardized(repo.root))

    // Mémoire : la portée suit le projet, l'écran quitte « Aucun projet ouvert ».
    let memory = makeMemory(defaults: suite)
    await memory.refresh()
    #expect(!isNoProject(memory.state))
}

@MainActor
@Test("mac-etats-vides-sans-issue/AC-2 : une entrée dont le dossier a disparu n'écrit rien et sort du menu")
func vanishedEntryWritesNothing() throws {
    let dir = try scratchDirectory()
    let kept = dir + "/garde"
    let gone = dir + "/disparu"
    try makeGitRoot(kept)
    try makeGitRoot(gone)
    let suite = emptyProjectSuite()
    let chooser = ProjectChooserModel(defaults: suite)
    chooser.select(projectRoot: URL(fileURLWithPath: gone, isDirectory: true))
    chooser.select(projectRoot: URL(fileURLWithPath: kept, isDirectory: true))
    let before = suite.string(forKey: ProjectRoot.defaultsKey)
    let entry = try #require(chooser.entries.first { $0.id == standardized(gone) })

    try FileManager.default.removeItem(atPath: gone)
    #expect(!chooser.choose(entry))
    #expect(suite.string(forKey: ProjectRoot.defaultsKey) == before)
    #expect(!chooser.entries.contains(entry))
}

// MARK: - L'état vide (lot BR-2)
//
// SwiftUI ne s'inspecte pas depuis la suite (aucun arbre AX hors d'un client
// réel) : ce qui décide de l'écran vit dans `NoProjectState` et
// `ProjectChooserForm`, que ces tests confrontent à l'état RÉEL du modèle sans projet.

@MainActor
@Test("mac-etats-vides-sans-issue/AC-1 : sans projet choisi, la Mémoire montre « Aucun projet ouvert », sa phrase et le bouton « Choisir un projet… »")
func memoryEmptyStateCarriesTheChooser() async {
    let memory = makeMemory(defaults: emptyProjectSuite())
    await memory.refresh()
    #expect(isNoProject(memory.state))
    #expect(NoProjectState.memory == NoProjectState(
        title: "Aucun projet ouvert",
        description: "Choisissez le projet dont vous voulez consulter la mémoire.",
        chooserIdentifier: "memory.chooseProject"
    ))
    #expect(NoProjectState.systemImage == "folder.badge.questionmark")
    #expect(ProjectChooserText.choose == "Choisir un projet\u{2026}")
}

@MainActor
@Test("mac-etats-vides-sans-issue/AC-2 : des projets connus ouvrent un menu — une entrée par projet, un séparateur, puis « Choisir un dossier… »")
func knownProjectsOpenAMenu() throws {
    let dir = try scratchDirectory()
    let alpha = dir + "/alpha"
    let beta = dir + "/beta"
    try makeGitRoot(alpha)
    try makeGitRoot(beta)
    let chooser = ProjectChooserModel(defaults: emptyProjectSuite())
    chooser.select(projectRoot: URL(fileURLWithPath: beta, isDirectory: true))
    chooser.select(projectRoot: URL(fileURLWithPath: alpha, isDirectory: true))

    let entries = [
        ProjectChooserModel.Entry(id: standardized(alpha), label: "alpha"),
        ProjectChooserModel.Entry(id: standardized(beta), label: "beta"),
    ]
    #expect(chooser.entries == entries)
    #expect(ProjectChooserForm.of(chooser.entries) == .menu([.project(entries[0]), .project(entries[1]), .separator, .chooseFolder]))
    #expect(ProjectChooserText.chooseFolder == "Choisir un dossier\u{2026}")
}

@MainActor
@Test("mac-etats-vides-sans-issue/AC-5 : aucun projet connu — un bouton simple vers le panneau d'ouverture, jamais un menu vide")
func noKnownProjectIsAPlainButton() {
    let chooser = ProjectChooserModel(defaults: emptyProjectSuite())
    chooser.refresh()
    #expect(chooser.entries.isEmpty)
    #expect(ProjectChooserForm.of(chooser.entries) == .folderButton)
}

@MainActor
@Test("mac-etats-vides-sans-issue/AC-3 : un projet choisi depuis l'état vide remplit l'écran courant — la Mémoire se recharge")
func chosenProjectFillsTheCurrentScreen() async throws {
    let repo = try GitFixture()
    let suite = emptyProjectSuite()
    // Le modèle est construit AVANT le choix, comme dans l'app où il vit à l'échelle de l'app.
    let memory = makeMemory(defaults: suite)
    await memory.refresh()
    #expect(isNoProject(memory.state))

    ProjectChooserModel(defaults: suite).select(projectRoot: URL(fileURLWithPath: repo.root, isDirectory: true))

    // `onChosen` = `refresh()` ; l'écran quitte « Aucun projet ouvert ».
    await memory.refresh()
    #expect(!isNoProject(memory.state))
}

@Test("mac-etats-vides-sans-issue/AC-6 : aucun texte de l'état vide ne cite de raccourci clavier, quelle que soit la disposition")
func emptyStatesNameNoShortcut() {
    let texts = [
        MemoryText.noProjectTitle, MemoryText.noProjectDescription,
        ProjectChooserText.choose,
    ]
    for text in texts {
        for token in ["⌘", "⌥", "⇧", "⌃", "Cmd", "Ctrl"] {
            #expect(!text.contains(token), "« \(text) » cite « \(token) »")
        }
        #expect(!text.contains { $0.isNumber }, "« \(text) » cite un chiffre")
    }
}
