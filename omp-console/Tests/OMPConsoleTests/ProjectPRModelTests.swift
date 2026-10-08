// Preuves du suivi des PR (BR-2) : AC-1 … AC-7, sur un modèle vivant et un magasin
// de fixtures réel. Chaque critère porte son identifiant dans le TITRE affiché.
//
// Déterminisme : la publication du projet déclenche un rafraîchissement AUTOMATIQUE
// (S-3, changement de liste). Les preuves attendent donc la fin de tout
// rafraîchissement en cours (`settle`) avant de scripter la doublure, puis pilotent
// leur propre rafraîchissement (`refreshAndSettle`).

import Foundation
import Testing

@testable import OMPConsole
import ConsoleCore

// MARK: - Outillage

private let pullURL = "https://exemple.test/pull/45"

/// Un snapshot dont les trois statuts requis prennent les états donnés (ordre de S-1).
private func prSnapshot(
    title: String = "Ma PR",
    headOid: String = "abc123",
    body: String = "Le corps de la PR",
    states: [PRCheckState],
    links: [String?]? = nil
) -> PRSnapshot {
    let checks = RequiredCheck.allCases.enumerated().map { index, required in
        PRCheckReading(
            name: required.name,
            state: states[index],
            link: links?[index] ?? nil
        )
    }
    return PRSnapshot(title: title, headOid: headOid, body: body, checks: checks)
}

private func prFeature(_ slug: String, url: String = pullURL, status: String = "pr") -> [String: Any] {
    projectFeatureObject(slug: slug, status: status, prUrl: url)
}

/// Attend qu'aucun rafraîchissement ne soit en cours.
@MainActor
private func settle(_ model: ProjectConsoleModel) async {
    _ = await awaitProject { model.isRefreshingPRs == false }
}

/// Pilote UN rafraîchissement déterministe : attend la fin d'un éventuel
/// rafraîchissement automatique, déclenche le sien, puis attend sa fin.
@MainActor
private func refreshAndSettle(_ model: ProjectConsoleModel) async {
    await settle(model)
    await model.refreshPRs()
    await settle(model)
}

@MainActor
private func makePRModel(
    fixture: StoreFixture,
    repo: URL,
    stub: any PRServicing,
    opener: RecordingURLOpener,
    interval: Duration = .milliseconds(20),
    features: [[String: Any]]
) async throws -> ProjectConsoleModel {
    let transport = ScriptedServiceTransport()
    keepProjectAlive(transport)
    stubProjectConduite(transport, repo: repo.path)
    let host = makeScriptedProjectHost(transport)
    let model = makeProjectModel(
        host: host,
        stateDir: fixture.root,
        prService: stub,
        urlOpener: opener,
        prRefreshInterval: interval,
        environment: [:]
    )
    model.start()
    await model.startConduite(repoRoot: repo, name: "PR")

    let key = ProjectPaths.key(forRoot: repo.path)
    fixture.publish(
        .projects,
        "\(key).json",
        object: projectObject(
            repoKey: key,
            segments: [["name": "Lire le réel", "features": features]],
            current: 0,
            hostSession: NSNull()
        )
    )
    #expect(await awaitProject { model.project?.repoKey == key })
    return model
}

// MARK: - AC-1

@MainActor
@Test("suivi-pr-ci/AC-1 : la vue affiche les trois statuts requis, dans l'ordre du plan, avec le lien du run rouge")
func prRowsShowThreeChecks() async throws {
    let repo = try makeGitRepository()
    let fixture = StoreFixture()
    let stub = StubPRService()
    let opener = RecordingURLOpener()
    let model = try await makePRModel(
        fixture: fixture,
        repo: repo,
        stub: stub,
        opener: opener,
        features: [
            prFeature("premiere", url: "https://exemple.test/pull/43"),
            prFeature("seconde"),
        ]
    )
    await settle(model)
    stub.script(
        "https://exemple.test/pull/43",
        prSnapshot(title: "Première", states: [.green, .green, .green])
    )
    stub.script(
        pullURL,
        prSnapshot(
            title: "Seconde",
            states: [.pending, .red, .green],
            links: [nil, "https://exemple.test/actions/runs/36/job/109789011950", nil]
        )
    )
    await refreshAndSettle(model)

    #expect(model.prRows.map(\.slug) == ["premiere", "seconde"])
    #expect(model.prRows.map(\.number) == [43, 45])
    let row = try #require(model.prRows.last)
    #expect(row.checks.map(\.required) == [.ubuntu, .macos, .releaseSimulation])
    #expect(row.checks.map(\.state) == [.pending, .red, .green])
    #expect(row.headline == "PR #45 — Seconde")
    // Le statut rouge porte le lien ET l'identifiant de son run.
    #expect(runIdentifier(of: row.checks[1].link) == "109789011950")
    #expect(row.isMergeAvailable == false)
    model.stop()
}

// MARK: - AC-2

@MainActor
@Test("suivi-pr-ci/AC-2 : la CI devient verte et l'app l'affiche sans aucun geste")
func prWatchRefreshesWithoutGesture() async throws {
    let repo = try makeGitRepository()
    let fixture = StoreFixture()
    let stub = StubPRService()
    let opener = RecordingURLOpener()
    let model = try await makePRModel(
        fixture: fixture,
        repo: repo,
        stub: stub,
        opener: opener,
        features: [prFeature("suivie")]
    )
    await settle(model)
    stub.script(pullURL, prSnapshot(states: [.pending, .pending, .pending]))
    await refreshAndSettle(model)
    #expect(model.prRows.first?.checks.allSatisfy { $0.state == .green } == false)

    // La CI devient verte : AUCUN geste de l'utilisateur, seule la boucle relit.
    stub.script(pullURL, prSnapshot(states: [.green, .green, .green]))
    model.attachPRWatch()
    #expect(await awaitProject(10) { model.prRows.first?.checks.allSatisfy { $0.state == .green } == true })
    #expect(model.prRows.first?.isMergeAvailable == true)
    model.detachPRWatch()
    model.stop()
}

// MARK: - AC-3

@MainActor
@Test("suivi-pr-ci/AC-3 : « Ouvrir la PR » ouvre EXACTEMENT l'URL de la ligne")
func openPROpensExactURL() async throws {
    let repo = try makeGitRepository()
    let fixture = StoreFixture()
    let stub = StubPRService()
    let opener = RecordingURLOpener()
    let model = try await makePRModel(
        fixture: fixture,
        repo: repo,
        stub: stub,
        opener: opener,
        features: [prFeature("suivie")]
    )
    await settle(model)
    stub.script(pullURL, prSnapshot(states: [.green, .green, .green]))
    await refreshAndSettle(model)

    model.openPR(slug: "suivie")

    #expect(opener.opened.map(\.absoluteString) == [pullURL])
    #expect(model.prActionFailure == nil)
    model.stop()
}

@MainActor
@Test("une URL non http(s) n'ouvre rien et pose le message d'action")
func openPRRefusesNonHTTP() async throws {
    let repo = try makeGitRepository()
    let fixture = StoreFixture()
    let stub = StubPRService()
    let opener = RecordingURLOpener()
    let model = try await makePRModel(
        fixture: fixture,
        repo: repo,
        stub: stub,
        opener: opener,
        features: [prFeature("suivie", url: "issoir-1 pane")]
    )
    await settle(model)
    stub.script("issoir-1 pane", prSnapshot(states: [.red, .red, .red]))
    await refreshAndSettle(model)

    model.openPR(slug: "suivie")

    #expect(opener.openCount == 0)
    #expect(model.prActionFailure == ProjectViewText.prNotOpenable(url: "issoir-1 pane"))
    model.stop()
}

// MARK: - AC-4

@MainActor
@Test("suivi-pr-ci/AC-4 : la confirmation fusionne avec l'URL, le titre, le corps et le sha relus")
func confirmMergeUsesFreshRead() async throws {
    let repo = try makeGitRepository()
    let fixture = StoreFixture()
    let stub = StubPRService()
    let opener = RecordingURLOpener()
    let model = try await makePRModel(
        fixture: fixture,
        repo: repo,
        stub: stub,
        opener: opener,
        features: [prFeature("suivie")]
    )
    await settle(model)
    stub.script(pullURL, prSnapshot(
        title: "Titre relu",
        headOid: "sha-relu",
        body: "Corps relu",
        states: [.green, .green, .green]
    ))
    await refreshAndSettle(model)

    await model.beginMerge(slug: "suivie")
    #expect(model.pendingMerge?.headOid == "sha-relu")
    #expect(model.pendingMerge?.number == 45)
    #expect(model.pendingMerge?.title == "Titre relu")

    await model.confirmMerge()

    #expect(model.pendingMerge == nil)
    #expect(model.prActionFailure == nil)
    #expect(stub.merged == [StubPRService.MergeCall(
        prUrl: pullURL,
        title: "Titre relu",
        body: "Corps relu",
        headOid: "sha-relu"
    )])
    model.stop()
}

// MARK: - AC-5

@MainActor
@Test("suivi-pr-ci/AC-5 : un statut requis non vert rend la fusion indisponible et la refuse")
func mergeUnavailableWhenNotAllGreen() async throws {
    let repo = try makeGitRepository()
    let fixture = StoreFixture()
    let stub = StubPRService()
    let opener = RecordingURLOpener()
    let model = try await makePRModel(
        fixture: fixture,
        repo: repo,
        stub: stub,
        opener: opener,
        features: [prFeature("suivie")]
    )
    await settle(model)
    stub.script(pullURL, prSnapshot(states: [.green, .pending, .green]))
    await refreshAndSettle(model)

    #expect(model.prRows.first?.isMergeAvailable == false)
    await model.beginMerge(slug: "suivie")
    #expect(model.pendingMerge == nil)
    #expect(model.prActionFailure == ProjectViewText.prMergeRefused(number: 45))
    #expect(stub.merged.isEmpty)
    model.stop()
}

// MARK: - AC-6

@MainActor
@Test("suivi-pr-ci/AC-6 : une lecture en échec marque la ligne périmée et le message disparaît à la lecture suivante")
func readFailureMarksStaleThenClears() async throws {
    let repo = try makeGitRepository()
    let fixture = StoreFixture()
    let stub = StubPRService()
    let opener = RecordingURLOpener()
    let model = try await makePRModel(
        fixture: fixture,
        repo: repo,
        stub: stub,
        opener: opener,
        features: [prFeature("suivie")]
    )
    let failure = GhError.commandFailed(
        command: "pr checks",
        code: 1,
        detail: "aucun statut rapporté sur la branche"
    )

    await settle(model)
    stub.script(pullURL, prSnapshot(states: [.pending, .pending, .pending]))
    await refreshAndSettle(model)
    #expect(model.prRows.first?.freshness == .fresh)
    #expect(model.prFailure == nil)

    stub.script(pullURL, [Result<PRSnapshot, GhError>.failure(failure)])
    await refreshAndSettle(model)
    #expect(model.prRows.count == 1)
    #expect(model.prRows.first?.freshness == .stale)
    #expect(model.prRows.first?.checks.map(\.state) == [.pending, .pending, .pending])
    #expect(model.prFailure == failure.userMessage)

    stub.script(pullURL, prSnapshot(states: [.green, .green, .green]))
    await refreshAndSettle(model)
    #expect(model.prRows.first?.freshness == .fresh)
    #expect(model.prRows.first?.checks.allSatisfy { $0.state == .green } == true)
    #expect(model.prFailure == nil)
    model.stop()
}

// MARK: - Adresse refusée (AC-4)

@MainActor
@Test("chemins-du-magasin-non-confines/AC-4 : une prUrl non conforme pose le message d'échec PR sans lancer gh")
func invalidPRURLShowsFailureWithoutRunningGH() async throws {
    let repo = try makeGitRepository()
    let fixture = StoreFixture()
    let gh = try GhStub(viewJSON: "{}", checksJSON: "[]")
    let opener = RecordingURLOpener()
    let model = try await makePRModel(
        fixture: fixture,
        repo: repo,
        stub: GhPRService(cli: GhCLI(binary: gh.script)),
        opener: opener,
        features: [prFeature("suivie", url: "https://gitlab.com/o/r/pull/1")]
    )
    await refreshAndSettle(model)

    #expect(model.prRows.count == 1, "une lecture en échec ne fait jamais disparaître la ligne")
    let failure = try #require(model.prFailure, "le refus devient le message d'échec PR")
    #expect(failure.contains("l'adresse de PR est refusée"))
    #expect(failure.contains("https://gitlab.com/o/r/pull/1"))
    #expect(model.prRows.first?.freshness == .unknown, "jamais lue, jamais fraîche")
    #expect(gh.logged().isEmpty, "gh n'est jamais lancé pour une adresse refusée")

    // Le geste de fusion retombe sur le MÊME chemin d'échec, sans aucun `gh`.
    await model.beginMerge(slug: "suivie")
    #expect(model.pendingMerge == nil)
    #expect(model.prFailure?.contains("l'adresse de PR est refusée") == true)
    #expect(gh.logged().isEmpty)
    model.stop()
}

// MARK: - AC-7

@MainActor
@Test("suivi-pr-ci/AC-7 : après une fusion réussie, l'app n'écrit rien et n'émet aucune commande")
func mergeWritesNothing() async throws {
    let repo = try makeGitRepository()
    let fixture = StoreFixture()
    let stub = StubPRService()
    let opener = RecordingURLOpener()
    let model = try await makePRModel(
        fixture: fixture,
        repo: repo,
        stub: stub,
        opener: opener,
        features: [prFeature("suivie")]
    )
    await settle(model)
    stub.script(pullURL, prSnapshot(states: [.green, .green, .green]))
    await refreshAndSettle(model)

    let before = fixture.listing()
    await model.beginMerge(slug: "suivie")
    await model.confirmMerge()
    let after = fixture.listing()

    #expect(stub.merged.count == 1)
    #expect(after == before, "aucun fichier du magasin ne doit changer")
    // Le canal de commande du pilote est intact : rien n'y est écrit.
    let commands = (fixture.root as NSString).appendingPathComponent("commands")
    let contents = (try? FileManager.default.contentsOfDirectory(atPath: commands)) ?? []
    #expect(contents.isEmpty)
    model.stop()
}

// MARK: - Bornes (BR-2)

@MainActor
@Test("aucun gh n'est lancé quand la liste suivie est vide")
func noGHWhenNoFollowedPR() async throws {
    let repo = try makeGitRepository()
    let fixture = StoreFixture()
    let stub = StubPRService()
    let opener = RecordingURLOpener()
    let model = try await makePRModel(
        fixture: fixture,
        repo: repo,
        stub: stub,
        opener: opener,
        features: [prFeature("planifiee", status: "planned")]
    )
    await settle(model)

    await model.refreshPRs()

    #expect(model.prRows.isEmpty)
    #expect(model.prFailure == nil)
    #expect(stub.readURLs.isEmpty)
    model.stop()
}

@MainActor
@Test("un rafraîchissement en cours n'est jamais empilé")
func refreshDoesNotStack() async throws {
    let repo = try makeGitRepository()
    let fixture = StoreFixture()
    let stub = StubPRService()
    let opener = RecordingURLOpener()
    let model = try await makePRModel(
        fixture: fixture,
        repo: repo,
        stub: stub,
        opener: opener,
        features: [prFeature("suivie")]
    )
    await settle(model)
    stub.script(pullURL, prSnapshot(states: [.green, .green, .green]))
    stub.readDelay = .milliseconds(80)

    let first = Task { await model.refreshPRs() }
    #expect(await awaitProject { model.isRefreshingPRs })
    await model.refreshPRs()
    await first.value

    #expect(stub.readCount(pullURL) == 1)
    #expect(model.isRefreshingPRs == false)
    model.stop()
}

@MainActor
@Test("le message d'action est vidé au geste suivant")
func actionFailureClearsOnNextGesture() async throws {
    let repo = try makeGitRepository()
    let fixture = StoreFixture()
    let stub = StubPRService()
    let opener = RecordingURLOpener()
    let model = try await makePRModel(
        fixture: fixture,
        repo: repo,
        stub: stub,
        opener: opener,
        features: [prFeature("suivie", url: "issoir-1 pane")]
    )
    await settle(model)
    stub.script("issoir-1 pane", prSnapshot(states: [.green, .green, .green]))
    await refreshAndSettle(model)

    model.openPR(slug: "suivie")
    #expect(model.prActionFailure != nil)
    await model.beginMerge(slug: "suivie")
    #expect(model.prActionFailure == nil)
    model.stop()
}

@MainActor
@Test("une prUrl changée fait oublier l'ancienne connaissance")
func changedURLForgetsKnowledge() async throws {
    let repo = try makeGitRepository()
    let fixture = StoreFixture()
    let stub = StubPRService()
    let opener = RecordingURLOpener()
    let model = try await makePRModel(
        fixture: fixture,
        repo: repo,
        stub: stub,
        opener: opener,
        features: [prFeature("suivie")]
    )
    await settle(model)
    stub.script(pullURL, prSnapshot(title: "Ancienne", states: [.green, .green, .green]))
    await refreshAndSettle(model)
    #expect(model.prRows.first?.title == "Ancienne")

    let key = ProjectPaths.key(forRoot: repo.path)
    fixture.publish(
        .projects,
        "\(key).json",
        object: projectObject(
            repoKey: key,
            segments: [["name": "Lire le réel", "features": [
                prFeature("suivie", url: "https://exemple.test/pull/46"),
            ]]],
            current: 0,
            hostSession: NSNull()
        )
    )
    #expect(await awaitProject { model.prRows.first?.number == 46 })
    #expect(model.prRows.first?.title == nil)
    model.stop()
}
