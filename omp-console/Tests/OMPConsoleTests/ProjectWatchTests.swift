// Preuves de la veille du projet (BR-2) : AC-7 — le plan et le document se
// rafraîchissent sans action de l'utilisateur.

import Foundation
import Testing
@testable import OMPConsole

@MainActor
private func makeWatchingModel(
    fixture: StoreFixture,
    repo: URL
) async throws -> (ProjectConsoleModel, ScriptedServiceTransport) {
    let transport = ScriptedServiceTransport()
    keepProjectAlive(transport)
    stubProjectConduite(transport, repo: repo.path)
    let host = makeScriptedProjectHost(transport)
    let model = makeProjectModel(host: host, stateDir: fixture.root)

    // Le dossier `.doc` existe AVANT l'armement : la veille du document porte
    // directement sur `<clé>.doc`, et la création du fichier y délivre un
    // événement.
    let key = ProjectPaths.key(forRoot: repo.path)
    let docDirectory = (ProjectPaths.docFile(stateDir: fixture.root, repoKey: key) as NSString).deletingLastPathComponent
    try FileManager.default.createDirectory(atPath: docDirectory, withIntermediateDirectories: true)

    model.start()
    await model.startConduite(repoRoot: repo, name: "Dépôt")
    return (model, transport)
}

@MainActor
@Test("conduite-de-projet/AC-7 : PROJECT.md réécrit se reflète sans action")
func watchReflectsDocRewrite() async throws {
    let repo = try makeGitRepository()
    let fixture = StoreFixture()
    let key = ProjectPaths.key(forRoot: repo.path)
    let docPath = ProjectPaths.docFile(stateDir: fixture.root, repoKey: key)

    let (model, _) = try await makeWatchingModel(fixture: fixture, repo: repo)

    try Data("# Projet — première version\n".utf8).write(to: URL(fileURLWithPath: docPath))
    #expect(await awaitProject { model.docText?.contains("première version") == true })

    try Data("# Projet — seconde version, plus longue\n".utf8).write(to: URL(fileURLWithPath: docPath))
    #expect(await awaitProject { model.docText?.contains("seconde version") == true })
    model.stop()
}

@MainActor
@Test("conduite-de-projet/AC-7 : une nouvelle version du JSON projet se reflète sans action")
func watchReflectsProjectJSON() async throws {
    let repo = try makeGitRepository()
    let fixture = StoreFixture()
    let key = ProjectPaths.key(forRoot: repo.path)

    let (model, _) = try await makeWatchingModel(fixture: fixture, repo: repo)
    #expect(model.project == nil)

    fixture.publish(.projects, "\(key).json", object: projectObject(repoKey: key, current: 0))
    #expect(await awaitProject { model.project?.repoKey == key })
    model.stop()
}

@MainActor
@Test("le document absent n'affiche pas un volet vide")
func watchMissingDocIsNil() async throws {
    let repo = try makeGitRepository()
    let fixture = StoreFixture()
    let (model, _) = try await makeWatchingModel(fixture: fixture, repo: repo)
    #expect(model.docText == nil)
    model.stop()
}
