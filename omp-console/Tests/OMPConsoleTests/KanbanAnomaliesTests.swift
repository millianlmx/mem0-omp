// Preuves des ANOMALIES (S-8, S-9, S-10, S-11) : AC-11 à AC-14.
//
// Le magasin est toujours une fixture RÉELLE : les anomalies portent sur des
// fichiers (tronqué, `version: 2`, pid mort, lien symbolique), donc un mock ne les
// prouverait pas.

import Foundation
import Testing
@testable import OMPConsole

// MARK: - AC-11 : entrée illisible

@Test("kanban-des-pipelines/AC-11 : un lot illisible est nommé, et la carte du projet porte « illisible » sans changer de colonne")
func unreadableLotIsNamedAndMarksTheProjectCard() throws {
    let fixture = StoreFixture()
    let repoRoot = "/tmp/kanban/anomalie-r"
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)
    fixture.publish(
        .projects, "\(repoKey).json",
        object: projectObject(
            repoKey: repoKey, repoRoot: repoRoot,
            segments: [["name": "S", "features": [projectFeatureObject(slug: "s", status: "launched", model: nil)]]],
            current: 0
        )
    )
    fixture.put(.lots, "\(repoKey).json", text: "{\"version\":1,")

    let board = kanbanBoard(fixture)
    #expect(board.cards.count == 1)
    let card = try #require(board.cards.first)
    #expect(card.id == "project:\(repoKey):s")
    #expect(card.marks == [.illisible])
    // La marque remplace l'état INVENTÉ, pas l'état connu : la colonne est celle de
    // la source lisible.
    #expect(card.column == .enCours)
    #expect(board.anomalies.map(\.kind) == [.illisible])
    #expect(board.anomalies.map(\.detail) == ["entrée illisible — lots/\(repoKey).json : JSON illisible"])
}

@Test("kanban-des-pipelines/AC-11 : un JSON valide au schéma incomplet se dit « schéma incomplet ou inconnu »")
func unreadableSchemaIsNamedAsSuch() {
    let fixture = StoreFixture()
    let repoRoot = "/tmp/kanban/anomalie-schema"
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)
    fixture.publish(
        .projects, "\(repoKey).json",
        object: projectObject(
            repoKey: repoKey, repoRoot: repoRoot,
            segments: [["name": "S", "features": [projectFeatureObject(slug: "s", status: "launched", model: nil)]]],
            current: 0
        )
    )
    // JSON valide, `version: 2` : le validateur rend `nil`, donc « schéma ».
    fixture.put(.lots, "\(repoKey).json", text: "{\"version\":2}")

    let board = kanbanBoard(fixture)
    #expect(board.cards.first?.marks == [.illisible])
    #expect(board.anomalies.map(\.detail) == [
        "entrée illisible — lots/\(repoKey).json : schéma incomplet ou inconnu",
    ])
}

@Test("kanban-des-pipelines/AC-11 : un lot illisible sans carte concernée produit quand même sa ligne")
func unreadableLotWithoutCardStillSpeaks() {
    let fixture = StoreFixture()
    let repoKey = "0123456789abcdef"
    fixture.put(.lots, "\(repoKey).json", text: "pas du json")

    let board = kanbanBoard(fixture)
    #expect(board.cards.isEmpty)
    #expect(board.anomalies.map(\.kind) == [.illisible])
    #expect(board.anomalies.map(\.detail) == ["entrée illisible — lots/\(repoKey).json : JSON illisible"])
}

@Test("kanban-des-pipelines/AC-11 : un projet illisible marque les cartes de LOT du dépôt, et un run illisible ne marque rien")
func unreadableProjectMarksLotCards() {
    let fixture = StoreFixture()
    let repoRoot = "/tmp/kanban/anomalie-projet"
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)
    fixture.publish(
        .lots, "\(repoKey).json",
        object: lotObject(
            id: repoKey, repoRoot: repoRoot,
            features: [lotFeatureObject(slug: "s", worktree: "/tmp/kanban/arbre-projet")]
        )
    )
    fixture.put(.projects, "\(repoKey).json", text: "{\"version\":1,")
    // Un run illisible : il n'y a pas de carte pour une entité invisible.
    fixture.put(.running, "\(fixtureId(0xe2)).json", text: "tronqué")

    let board = kanbanBoard(fixture)
    #expect(board.cards.count == 1)
    #expect(board.cards.first?.marks == [.illisible])
    #expect(board.cards.first?.column == .enCours)
    // L'ordre du bandeau : `running` avant `lots`/`projects`.
    #expect(board.anomalies.map(\.detail) == [
        "entrée illisible — running/\(fixtureId(0xe2)).json : JSON illisible",
        "entrée illisible — projects/\(repoKey).json : JSON illisible",
    ])
}

// MARK: - AC-12 : propriétaire mort

@Test("kanban-des-pipelines/AC-12 : un run dont le propriétaire est mort passe en échec et porte « mort »")
func deadRunGoesToFailure() throws {
    let fixture = StoreFixture()
    let dead = deadPid()
    let id = fixtureId(0xe3)
    fixture.publish(
        .running, "\(id).json",
        object: runningObject(
            id: id, cwd: "/tmp/kanban/mort", label: "depot/mort",
            phaseStartedAt: fixtureT0 - 5_000, updatedAt: fixtureT0 - 1_000, ownerPid: Double(dead)
        )
    )

    let board = kanbanBoard(fixture)
    let card = try #require(board.cards.first)
    #expect(card.id == "run:\(id)")
    #expect(card.column == .echec)
    #expect(card.marks == [.mort])
    #expect(board.cards.contains { $0.column == .enCours } == false)
    #expect(board.anomalies.map(\.kind) == [.mort])
    #expect(board.anomalies.map(\.detail) == ["propriétaire mort — running/\(id).json : pid \(dead)"])
    // La phrase affichée ne porte ni fichier ni pid : ils restent dans le détail.
    #expect(board.anomalies.allSatisfy { !$0.text.contains(".json") && !$0.text.contains("pid") })
}

@Test("kanban-des-pipelines/AC-12 : un lot mort bascule ses features en cours en échec et marque les autres sans changer leur colonne")
func deadLotMarksEveryFeature() throws {
    let fixture = StoreFixture()
    let dead = deadPid()
    let repoRoot = "/tmp/kanban/lot-mort"
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)
    fixture.publish(
        .lots, "\(repoKey).json",
        object: lotObject(
            id: repoKey, repoRoot: repoRoot,
            features: [
                lotFeatureObject(slug: "mort-en-cours", state: "running", phase: "impl",
                                 worktree: "/tmp/kanban/arbre-mort-1"),
                lotFeatureObject(slug: "mort-jalon", state: "waiting", phase: "specs",
                                 worktree: "/tmp/kanban/arbre-mort-2", waitKind: "specs"),
            ],
            ownerPid: Double(dead)
        )
    )

    let board = kanbanBoard(fixture)
    #expect(board.cards.count == 2)
    let running = try #require(board.cards.first { $0.id.hasSuffix(":mort-en-cours") })
    let waiting = try #require(board.cards.first { $0.id.hasSuffix(":mort-jalon") })
    #expect(running.column == .echec)
    #expect(running.marks == [.mort])
    // Une feature qui attendait garde son état RÉEL : seul le pid est mort.
    #expect(waiting.column == .jalonSpecs)
    #expect(waiting.marks == [.mort])
    // UNE ligne pour le lot, pas une par feature.
    #expect(board.anomalies.map(\.kind) == [.mort])
    #expect(board.anomalies.map(\.detail) == ["propriétaire mort — lots/\(repoKey).json : pid \(dead)"])
}

@Test("kanban-des-pipelines/AC-12 : un pid non entier se dit « pid absent », un battement périmé ne dit rien")
func absentPidIsNamedAndStaleHeartbeatIsNotAnAnomaly() throws {
    let fixture = StoreFixture()
    let absentId = fixtureId(0xe4)
    fixture.publish(
        .running, "\(absentId).json",
        object: runningObject(
            id: absentId, cwd: "/tmp/kanban/pid-absent", label: "depot/pid-absent",
            phaseStartedAt: fixtureT0 - 5_000, updatedAt: fixtureT0 - 1_000, ownerPid: 1.5
        )
    )
    // Un lot VIVANT, sans battement, dont le pid vit : `isStale` est un badge de
    // péremption, jamais une anomalie.
    let repoRoot = "/tmp/kanban/lot-frais"
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)
    fixture.publish(
        .lots, "\(repoKey).json",
        object: lotObject(
            id: repoKey, repoRoot: repoRoot,
            features: [lotFeatureObject(slug: "frais", state: "running", worktree: "/tmp/kanban/arbre-frais")]
        )
    )

    let board = kanbanBoard(fixture)
    let absent = try #require(board.cards.first { $0.id == "run:\(absentId)" })
    #expect(absent.column == .echec)
    #expect(absent.marks == [.mort])
    let fresh = try #require(board.cards.first { $0.id.hasSuffix(":frais") })
    #expect(fresh.column == .enCours)
    #expect(fresh.marks.isEmpty)
    #expect(board.anomalies.map(\.kind) == [.mort])
    #expect(board.anomalies.map(\.detail) == ["propriétaire mort — running/\(absentId).json : pid absent"])
}

// MARK: - AC-13 : deux sources vivantes pour la même chose

@Test("kanban-des-pipelines/AC-13 : deux runs du même cwd réel (lien symbolique) ne laissent qu'une carte marquée « doublon »")
func duplicateRunsCollapseIntoOneCard() throws {
    let fixture = StoreFixture()
    let real = makeDirectory(fixture, "depot-sym")
    let link = joinPath(fixture.root, "lien-sym")
    try? FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: real)
    let first = fixtureId(0xe5)
    let second = fixtureId(0xe6)
    fixture.publish(
        .running, "\(first).json",
        object: runningObject(
            id: first, cwd: real, label: "depot-sym/first",
            phaseStartedAt: fixtureT0 - 5_000, updatedAt: fixtureT0 - 1_000, ownerPid: Double(getpid())
        )
    )
    fixture.publish(
        .running, "\(second).json",
        object: runningObject(
            id: second, cwd: link, label: "depot-sym/second",
            phaseStartedAt: fixtureT0 - 4_000, updatedAt: fixtureT0 - 1_000, ownerPid: Double(getpid())
        )
    )

    let board = kanbanBoard(fixture)
    #expect(board.cards.count == 1)
    let card = try #require(board.cards.first)
    #expect(card.id == "run:\(first)")
    #expect(card.marks == [.doublon])
    #expect(board.anomalies.map(\.kind) == [.doublon])
    #expect(board.anomalies.map(\.detail) == [
        "doublon — running/\(first).json et running/\(second).json : cwd \(real)",
    ])
}

@Test("kanban-des-pipelines/AC-13 : deux features de même slug dans un lot ne laissent qu'une carte, le bandeau citant les deux sources")
func duplicateLotFeaturesCollapseIntoOneCard() throws {
    let fixture = StoreFixture()
    let repoRoot = "/tmp/kanban/lot-double"
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)
    fixture.publish(
        .lots, "\(repoKey).json",
        object: lotObject(
            id: repoKey, repoRoot: repoRoot,
            features: [
                lotFeatureObject(slug: "double", worktree: "/tmp/kanban/arbre-double"),
                lotFeatureObject(slug: "double", worktree: "/tmp/kanban/arbre-double"),
            ]
        )
    )

    let board = kanbanBoard(fixture)
    #expect(board.cards.count == 1)
    let card = try #require(board.cards.first)
    #expect(card.id == "feature:\(repoKey):double")
    #expect(card.marks == [.doublon])
    let citation = "lots/\(repoKey).json · feature « double »"
    #expect(board.anomalies.map(\.kind) == [.doublon])
    #expect(board.anomalies.map(\.detail) == ["doublon — \(citation) et \(citation) : feature « double »"])
}

@Test("kanban-des-pipelines/AC-13 : l'appariement projet ↔ lot de même slug n'est PAS un doublon")
func normalPairingIsNotADuplicate() throws {
    let fixture = StoreFixture()
    let repoRoot = "/tmp/kanban/appariement"
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)
    fixture.publish(
        .lots, "\(repoKey).json",
        object: lotObject(
            id: repoKey, repoRoot: repoRoot,
            features: [lotFeatureObject(slug: "s", state: "running", worktree: "/tmp/kanban/arbre-apparie")]
        )
    )
    fixture.publish(
        .projects, "\(repoKey).json",
        object: projectObject(
            repoKey: repoKey, repoRoot: repoRoot,
            segments: [["name": "S", "features": [projectFeatureObject(slug: "s", status: "launched")]]],
            current: 0
        )
    )

    let board = kanbanBoard(fixture)
    #expect(board.cards.count == 1)
    let card = try #require(board.cards.first)
    #expect(card.id == "feature:\(repoKey):s")
    #expect(card.marks.isEmpty)
    #expect(board.anomalies.isEmpty)
}

// MARK: - AC-14 : magasin absent, magasin vide, tableau

@MainActor
@Test("kanban-des-pipelines/AC-14 : la vue dit « absent », « vide » ou montre le tableau — jamais un tableau muet")
func boardStateDistinguishesAbsentEmptyAndBoard() async {
    // (a) RACINE ABSENTE : aucun répertoire n'est créé.
    let absent = StoreFixture(stores: [])
    let absentModel = KanbanModel(hub: StoreHub(stateDir: absent.root, nowMs: { fixtureT0 }))
    defer { absentModel.stop() }
    absentModel.start()
    #expect(await awaitMainTrue { absentModel.state == .storeAbsent(dir: absent.root) })

    // (b) MAGASIN VIDE : la racine et ses six répertoires existent, aucun fichier.
    let empty = StoreFixture()
    let emptyModel = KanbanModel(hub: StoreHub(stateDir: empty.root, nowMs: { fixtureT0 }))
    defer { emptyModel.stop() }
    emptyModel.start()
    #expect(await awaitMainTrue { emptyModel.state == .storeEmpty(dir: empty.root) })

    // (c) RACINE PRÉSENTE, un seul fichier illisible : un TABLEAU, jamais « vide » —
    // les anomalies ne sont jamais tues.
    let illisible = StoreFixture()
    illisible.put(.running, "\(fixtureId(0xe7)).json", text: "{\"version\":1,")
    let illisibleModel = KanbanModel(hub: StoreHub(stateDir: illisible.root, nowMs: { fixtureT0 }))
    defer { illisibleModel.stop() }
    illisibleModel.start()
    #expect(await awaitMainTrue { illisibleModel.state.kanbanBoard != nil })
    #expect(illisibleModel.state.kanbanBoard?.cards.isEmpty == true)
    #expect(illisibleModel.state.kanbanBoard?.anomalies.count == 1)
}

@MainActor
@Test("kanban-des-pipelines/AC-14 : une racine créée pendant la session cesse d'être « absente »")
func rootAppearingDuringTheSessionIsSeen() async {
    let fixture = StoreFixture(stores: [])
    let model = KanbanModel(hub: StoreHub(stateDir: fixture.root, nowMs: { fixtureT0 }))
    defer { model.stop() }
    model.start()
    #expect(await awaitMainTrue { model.state == .storeAbsent(dir: fixture.root) })

    // Le magasin apparaît (racine + ses six répertoires) : la veille porte sur
    // l'ancêtre existant le plus proche et voit la création.
    for store in PipelineStore.allCases {
        try? FileManager.default.createDirectory(atPath: fixture.directory(store), withIntermediateDirectories: true)
    }
    #expect(await awaitMainTrue { model.state == .storeEmpty(dir: fixture.root) })
}
