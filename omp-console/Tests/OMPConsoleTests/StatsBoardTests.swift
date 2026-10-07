// Preuves de S-3 et S-4 : construction du tableau (plan, features listées, compte
// des features masquées) et totaux (feature, projet).
//
// Les fixtures sont le VRAI magasin d'état sous `NSTemporaryDirectory()` ; la
// lecture des sessions est injectée (doublure), donc aucun `.jsonl` n'est requis.

import Foundation
import Testing

@testable import OMPConsole
@testable import ConsoleCore

// MARK: - Fixtures

private func publishProject(
    _ fixture: StoreFixture,
    seed: Int,
    repoRoot: String,
    segments: [[String: Any]],
    current: Int = 0
) {
    fixture.publish(
        .projects,
        "\(fixtureId(seed)).json",
        object: projectObject(
            repoKey: KanbanRepoKey.key(forRoot: repoRoot),
            repoRoot: repoRoot,
            segments: segments,
            current: current
        )
    )
}

private func publishLot(_ fixture: StoreFixture, seed: Int, repoRoot: String, features: [[String: Any]]) {
    fixture.publish(.lots, "\(fixtureId(seed)).json", object: lotObject(repoRoot: repoRoot, features: features))
}

private func publishRunning(_ fixture: StoreFixture, id: String, cwd: String, sessionFile: String) {
    fixture.publish(
        .running,
        "\(id).json",
        object: runningObject(
            id: id,
            cwd: cwd,
            phaseStartedAt: fixtureT0,
            updatedAt: fixtureT0,
            ownerPid: Double(getpid()),
            sessionFile: sessionFile
        )
    )
}

private func measured(_ input: Int, _ output: Int, _ turns: Int, first: Double = 0, last: Double = 1_000) -> RunMetricsState {
    .measured(SessionMetrics(input: input, output: output, turns: turns, model: "modele", firstMs: first, lastMs: last))
}

// MARK: - AC-1 / AC-6

@Test("statistiques/AC-6 : le tableau suit l'ordre du plan et masque les features sans run lisible")
func boardFollowsThePlanOrder() {
    let fixture = StoreFixture()
    let repo = makeDirectory(fixture, "repo")
    let alphaTree = makeDirectory(fixture, "wt-alpha")
    let betaTree = makeDirectory(fixture, "wt-beta")
    let alphaSession = "/tmp/sessions/2026-09-28T09-00-00-000Z_aaaa0001.jsonl"
    let betaSession = "/tmp/sessions/2026-09-28T10-00-00-000Z_bbbb0002.jsonl"

    publishProject(
        fixture,
        seed: 0xA1,
        repoRoot: repo,
        segments: [[
            "name": "Segment",
            "features": [
                projectFeatureObject(slug: "alpha", status: "merged"),
                projectFeatureObject(slug: "beta", status: "launched"),
                // Retirée : elle apparaît APRÈS les vivantes dans l'ordre du plan.
                projectFeatureObject(slug: "gamma", status: "removed", removedReason: "obsolète"),
            ],
        ]]
    )
    publishLot(
        fixture,
        seed: 0xA2,
        repoRoot: repo,
        features: [
            lotFeatureObject(slug: "alpha", worktree: alphaTree),
            lotFeatureObject(slug: "beta", worktree: betaTree),
        ]
    )
    publishRunning(fixture, id: fixtureId(0x51), cwd: alphaTree, sessionFile: alphaSession)
    publishRunning(fixture, id: fixtureId(0x52), cwd: betaTree, sessionFile: betaSession)

    let snapshot = StoreReader(stateDir: fixture.root, clock: fixtureClock).readAll()
    let board = statsBoard(snapshot: snapshot, selectedKey: nil, read: { file in
        file == alphaSession ? measured(10, 2, 1) : measured(20, 4, 2)
    })
    guard let project = board?.project else {
        Issue.record("le magasin porte un projet : le tableau ne doit pas être nil")
        return
    }
    #expect(project.features.map(\.slug) == ["alpha", "beta"])
    // `gamma` est au plan mais hors lot : masquée et comptée.
    #expect(project.hiddenPlanFeatures == 1)
    #expect(project.features.first?.runs.first?.sessionFile == alphaSession)
}

@Test("statistiques/AC-6 : seul le projet choisi est construit, et lui seul est lu")
func onlyTheSelectedProjectIsBuilt() {
    let fixture = StoreFixture()
    let firstRepo = makeDirectory(fixture, "repo-1")
    let secondRepo = makeDirectory(fixture, "repo-2")
    let firstTree = makeDirectory(fixture, "wt-1")
    let secondTree = makeDirectory(fixture, "wt-2")
    let firstSession = "/tmp/sessions/2026-09-28T09-00-00-000Z_1111aaaa.jsonl"
    let secondSession = "/tmp/sessions/2026-09-28T10-00-00-000Z_2222bbbb.jsonl"

    publishProject(fixture, seed: 0xB1, repoRoot: firstRepo, segments: [[
        "name": "S", "features": [projectFeatureObject(slug: "alpha", status: "merged")],
    ]])
    publishProject(fixture, seed: 0xB2, repoRoot: secondRepo, segments: [[
        "name": "S", "features": [projectFeatureObject(slug: "beta", status: "merged")],
    ]])
    publishLot(fixture, seed: 0xB3, repoRoot: firstRepo, features: [lotFeatureObject(slug: "alpha", worktree: firstTree)])
    publishLot(fixture, seed: 0xB4, repoRoot: secondRepo, features: [lotFeatureObject(slug: "beta", worktree: secondTree)])
    publishRunning(fixture, id: fixtureId(0x61), cwd: firstTree, sessionFile: firstSession)
    publishRunning(fixture, id: fixtureId(0x62), cwd: secondTree, sessionFile: secondSession)

    let snapshot = StoreReader(stateDir: fixture.root, clock: fixtureClock).readAll()
    var readFiles: [String] = []
    let secondKey = KanbanRepoKey.key(forRoot: secondRepo)
    let board = statsBoard(snapshot: snapshot, selectedKey: secondKey, read: { file in
        readFiles.append(file)
        return measured(1, 1, 1)
    })
    #expect(board?.project.repoKey == secondKey)
    #expect(board?.project.features.map(\.slug) == ["beta"])
    // Aucune lecture pour le projet non affiché.
    #expect(readFiles == [secondSession])

    // Clé inconnue : repli sur le PREMIER projet de l'ordre `projectOrder`.
    let firstKey = KanbanRepoKey.key(forRoot: firstRepo)
    let fallback = statsBoard(snapshot: snapshot, selectedKey: "cle-inexistante", read: { _ in measured(1, 1, 1) })
    #expect(fallback?.project.repoKey == firstKey)
    // Magasin sans project : `nil`.
    let empty = StoreFixture()
    #expect(statsBoard(snapshot: StoreReader(stateDir: empty.root, clock: fixtureClock).readAll(), selectedKey: nil, read: { _ in measured(0, 0, 0) }) == nil)
}

@Test("statistiques/AC-1 : une feature dont l'unique run est illisible n'est pas listée")
func unreadableOnlyFeatureIsHidden() {
    let fixture = StoreFixture()
    let repo = makeDirectory(fixture, "repo")
    let tree = makeDirectory(fixture, "wt")
    let session = "/tmp/sessions/2026-09-28T09-00-00-000Z_dead0000.jsonl"
    publishProject(fixture, seed: 0xC1, repoRoot: repo, segments: [[
        "name": "S", "features": [projectFeatureObject(slug: "alpha", status: "merged")],
    ]])
    publishLot(fixture, seed: 0xC2, repoRoot: repo, features: [lotFeatureObject(slug: "alpha", worktree: tree)])
    publishRunning(fixture, id: fixtureId(0x71), cwd: tree, sessionFile: session)

    let snapshot = StoreReader(stateDir: fixture.root, clock: fixtureClock).readAll()
    let board = statsBoard(snapshot: snapshot, selectedKey: nil, read: { _ in .unreadable("session introuvable") })
    #expect(board?.project.features.isEmpty == true)
    #expect(board?.project.hiddenPlanFeatures == 1)
}

@Test("statistiques/AC-1 : les libellés de projet départagent les collisions de basename")
func projectLabelsHandleCollisions() {
    let fixture = StoreFixture()
    // Deux projets DISTINCTS dont le dernier segment est identique : la collision
    // est fabriquée par le nom de dossier.
    let collisionA = makeDirectory(fixture, "dir-a/collision")
    let collisionB = makeDirectory(fixture, "dir-b/collision")
    publishProject(fixture, seed: 0xB1, repoRoot: collisionA, segments: [[
        "name": "S", "features": [projectFeatureObject(slug: "alpha")],
    ]])
    publishProject(fixture, seed: 0xB2, repoRoot: collisionB, segments: [[
        "name": "S", "features": [projectFeatureObject(slug: "beta")],
    ]])

    let snapshot = StoreReader(stateDir: fixture.root, clock: fixtureClock).readAll()
    let options = statsProjectOptions(snapshot)
    #expect(options.count == 2)
    // Le dossier parent départage, jamais la clé (une empreinte) du projet.
    #expect(Set(options.map(\.label)).count == 2)
    for option in options {
        #expect(option.label.hasPrefix("collision ("))
        #expect(!option.label.contains(option.id))
    }
    #expect(options.contains { $0.label.hasSuffix("dir-a)") })
    #expect(options.contains { $0.label.hasSuffix("dir-b)") })
}

// MARK: - AC-4 / AC-5

@Test("statistiques/AC-4 : le total d'une feature est la somme de ses lignes lisibles")
func featureTotalsSumReadableRuns() {
    let feature = FeatureStats(
        id: "alpha",
        slug: "alpha",
        runs: [
            RunStats(id: "a", sessionFile: "a", phase: .impl, isLive: false, metrics: measured(10, 2, 1, first: 0, last: 1_000)),
            // Un run illisible intercalé : il ne contribue à RIEN.
            RunStats(id: "b", sessionFile: "b", phase: .impl, isLive: false, metrics: .unreadable("session introuvable")),
            RunStats(id: "c", sessionFile: "c", phase: .impl, isLive: false, metrics: measured(5, 7, 3, first: 0, last: 2_000)),
        ]
    )
    let totals = featureTotals(feature, nowMs: 0)
    #expect(totals.input == 15)
    #expect(totals.output == 9)
    #expect(totals.turns == 4)
    // Deux runs clos : somme EXACTE des durées (1000 + 2000).
    #expect(totals.durationMs == 3_000)

    // Aucun run lisible : tout à zéro, pas de `—`.
    let bare = FeatureStats(id: "x", slug: "x", runs: [
        RunStats(id: "a", sessionFile: "a", phase: .impl, isLive: false, metrics: .unreadable("session introuvable"))
    ])
    #expect(featureTotals(bare, nowMs: 0) == StatsTotals.zero)
}

@Test("statistiques/AC-5 : l'agrégat du projet est la somme de ses features listées, rien d'autre")
func projectTotalsSumListedFeatures() {
    let project = ProjectStats(
        repoKey: "k",
        label: "depot",
        features: [
            FeatureStats(id: "alpha", slug: "alpha", runs: [
                RunStats(id: "a", sessionFile: "a", phase: .impl, isLive: false, metrics: measured(10, 2, 1, first: 0, last: 1_000))
            ]),
            FeatureStats(id: "beta", slug: "beta", runs: [
                RunStats(id: "b", sessionFile: "b", phase: .impl, isLive: false, metrics: measured(20, 4, 2, first: 0, last: 500))
            ]),
        ],
        // Le compte des features masquées n'entre dans AUCUN total.
        hiddenPlanFeatures: 7
    )
    let totals = projectTotals(project, nowMs: 0)
    #expect(totals.input == 30)
    #expect(totals.output == 6)
    #expect(totals.turns == 3)
    #expect(totals.durationMs == 1_500)
}

// MARK: - S-2 : le modèle et les runs vivants d'une feature

@Test("ios-statistiques/AC-1 : le modèle d'une feature est celui de son dernier run lisible qui en porte un")
func featureModelIsTheLastReadableOne() {
    let feature = FeatureStats(id: "alpha", slug: "alpha", runs: [
        RunStats(id: "a", sessionFile: "a", phase: .impl, isLive: false, metrics: .measured(
            SessionMetrics(input: 1, output: 1, turns: 1, model: "ancien-modele", firstMs: 0, lastMs: 1)
        )),
        // Un run LISIBLE sans modèle (session sans réponse assistant) ne l'emporte pas.
        RunStats(id: "b", sessionFile: "b", phase: .impl, isLive: false, metrics: .measured(
            SessionMetrics(input: 0, output: 0, turns: 1, model: nil, firstMs: 0, lastMs: 1)
        )),
        // Un run illisible ne fournit JAMAIS de modèle, même dernier.
        RunStats(id: "c", sessionFile: "c", phase: .impl, isLive: true, metrics: .unreadable("session introuvable")),
    ])
    #expect(featureModel(feature) == "ancien-modele")

    // Le DERNIER porteur gagne (l'ordre du plan, puis la fin de la liste).
    let twoModels = FeatureStats(id: "alpha", slug: "alpha", runs: [
        RunStats(id: "a", sessionFile: "a", phase: .impl, isLive: false, metrics: .measured(
            SessionMetrics(input: 1, output: 1, turns: 1, model: "ancien", firstMs: 0, lastMs: 1)
        )),
        RunStats(id: "b", sessionFile: "b", phase: .impl, isLive: false, metrics: .measured(
            SessionMetrics(input: 1, output: 1, turns: 1, model: "recent", firstMs: 0, lastMs: 1)
        )),
    ])
    #expect(featureModel(twoModels) == "recent")

    // Aucun run lisible portant un modèle : `nil`, jamais une chaîne vide.
    let none = FeatureStats(id: "alpha", slug: "alpha", runs: [
        RunStats(id: "a", sessionFile: "a", phase: .impl, isLive: false, metrics: .unreadable("session introuvable")),
        RunStats(id: "b", sessionFile: "b", phase: .impl, isLive: false, metrics: .measured(
            SessionMetrics(input: 0, output: 0, turns: 0, model: "", firstMs: nil, lastMs: nil)
        )),
    ])
    #expect(featureModel(none) == nil)
    #expect(featureModel(FeatureStats(id: "x", slug: "x", runs: [])) == nil)
}

@Test("ios-statistiques/AC-6 : les runs vivants d'une feature sont les runs LISIBLES et vivants")
func featureLiveRunsCountsReadableLiveRuns() {
    let feature = FeatureStats(id: "alpha", slug: "alpha", runs: [
        // Vivant ET lisible : compté.
        RunStats(id: "a", sessionFile: "a", phase: .impl, isLive: true, metrics: measured(1, 1, 1)),
        // Vivant mais ILLISIBLE : pas compté (sa durée n'avance pas).
        RunStats(id: "b", sessionFile: "b", phase: .impl, isLive: true, metrics: .unreadable("session introuvable")),
        // Lisible mais clos : pas compté.
        RunStats(id: "c", sessionFile: "c", phase: .impl, isLive: false, metrics: measured(1, 1, 1)),
    ])
    #expect(featureLiveRuns(feature) == 1)

    let none = FeatureStats(id: "alpha", slug: "alpha", runs: [
        RunStats(id: "a", sessionFile: "a", phase: .impl, isLive: false, metrics: measured(1, 1, 1))
    ])
    #expect(featureLiveRuns(none) == 0)
    #expect(featureLiveRuns(FeatureStats(id: "x", slug: "x", runs: [])) == 0)
}

@Test("statistiques/AC-3 : la durée totale d'une feature à run vivant augmente avec `nowMs`")
func liveFeatureTotalsAdvanceWithTime() {
    let feature = FeatureStats(id: "alpha", slug: "alpha", runs: [
        // Run vivant : la durée court jusqu'à `nowMs`.
        RunStats(id: "a", sessionFile: "a", phase: .impl, isLive: true, metrics: measured(1, 1, 1, first: 0, last: 100)),
        // Run clos : sa durée ne bouge plus.
        RunStats(id: "b", sessionFile: "b", phase: .impl, isLive: false, metrics: measured(1, 1, 1, first: 0, last: 400)),
    ])
    let project = ProjectStats(repoKey: "k", label: "d", features: [feature], hiddenPlanFeatures: 0)
    let atZero = projectTotals(project, nowMs: 0)
    let later = projectTotals(project, nowMs: 1_000)
    // Run vivant : 0 à `nowMs = 0`, 1000 à `nowMs = 1000` ; run clos : 400 figés.
    #expect(atZero.durationMs == 400)
    #expect(later.durationMs == 1_400)
    // Les tokens ne dépendent pas du temps.
    #expect(atZero.input == later.input)
}
