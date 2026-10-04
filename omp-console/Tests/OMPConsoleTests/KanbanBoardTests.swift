// Preuves du NOYAU de l'ardoise (S-1 … S-5, S-12) : AC-1 à AC-6 et AC-9 (durée),
// plus la parité des entités (AC-15).
//
// Tout passe par un magasin de fixtures RÉEL sur disque : les appariements et les
// déduplications portent sur `realpath`, donc sur des chemins qui existent.

import Foundation
import Testing
@testable import OMPConsole

// MARK: - AC-1 : les onze colonnes

@Test("kanban-des-pipelines/AC-1 : chaque état du magasin a sa colonne, et aucune carte n'en manque")
func everyStateHasItsColumn() {
    let fixture = StoreFixture()
    let repoRoot = "/tmp/kanban/colonne-r"
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)
    let features = [
        lotFeatureObject(slug: "a-venir", state: "pending", phase: "req"),
        lotFeatureObject(slug: "en-cours", state: "running", phase: "impl"),
        lotFeatureObject(slug: "reponse", state: "waiting", phase: "impl", waitKind: "answer"),
        lotFeatureObject(slug: "specs", state: "waiting", phase: "specs", waitKind: "specs"),
        lotFeatureObject(slug: "review", state: "waiting", phase: "review", waitKind: "review"),
        lotFeatureObject(slug: "bloquee", state: "blocked", phase: "impl"),
        lotFeatureObject(slug: "livree", state: "done", phase: "release", prUrl: "https://exemple/pull/1"),
        lotFeatureObject(slug: "livree-sans-pr", state: "done", phase: "release"),
        lotFeatureObject(slug: "echouee", state: "failed", phase: "impl"),
        lotFeatureObject(slug: "annulee", state: "cancelled", phase: "req"),
    ]
    fixture.publish(
        .lots,
        "\(repoKey).json",
        object: lotObject(id: repoKey, repoRoot: repoRoot, features: features)
    )
    fixture.publish(
        .projects,
        "\(repoKey).json",
        object: projectObject(
            repoKey: repoKey,
            repoRoot: repoRoot,
            segments: [["name": "S", "features": [projectFeatureObject(slug: "fusionnee", status: "merged")]]],
            current: 0
        )
    )

    let board = kanbanBoard(fixture)
    #expect(board.cards.count == 11)
    let expected: [KanbanColumn: String] = [
        .enAttente: "a-venir",
        .enCours: "en-cours",
        .questionEnVol: "reponse",
        .jalonSpecs: "specs",
        .jalonReview: "review",
        .bloquee: "bloquee",
        .prOuverte: "livree",
        .termineeSansPr: "livree-sans-pr",
        .echec: "echouee",
        .annuleeRetiree: "annulee",
        .fusionne: "fusionnee",
    ]
    for (column, slug) in expected {
        let inColumn = board.cards.filter { $0.column == column }
        #expect(inColumn.count == 1, "colonne \(column.rawValue) : \(inColumn.count) carte(s)")
        #expect(inColumn.first?.id.hasSuffix(":\(slug)") == true)
    }
    // Aucune carte n'est absente : la réunion des colonnes EST l'ensemble des cartes.
    let union = KanbanColumn.allCases.flatMap { column in board.cards.filter { $0.column == column } }
    #expect(Set(union.map(\.id)) == Set(board.cards.map(\.id)))
    // Chaque carte est rangée dans EXACTEMENT une colonne.
    #expect(union.count == board.cards.count)
}

// MARK: - AC-2 : une ardoise unique, tous dépôts mêlés

@Test("kanban-des-pipelines/AC-2 : deux dépôts coexistent dans la même ardoise, chacun avec son nom")
func twoReposShareOneBoard() {
    let fixture = StoreFixture()
    let rootA = "/tmp/kanban/depot-a"
    let rootB = "/tmp/kanban/depot-b"
    let keyA = KanbanRepoKey.key(forRoot: rootA)
    let keyB = KanbanRepoKey.key(forRoot: rootB)
    fixture.publish(
        .lots, "\(keyA).json",
        object: lotObject(
            id: keyA, repoRoot: rootA,
            features: [lotFeatureObject(slug: "s-a", worktree: "/tmp/kanban/arbre-a")]
        )
    )
    fixture.publish(
        .lots, "\(keyB).json",
        object: lotObject(
            id: keyB, repoRoot: rootB,
            features: [lotFeatureObject(slug: "s-b", worktree: "/tmp/kanban/arbre-b")]
        )
    )
    fixture.publish(
        .running, "\(fixtureId(0xc1)).json",
        object: runningObject(
            id: fixtureId(0xc1), cwd: "/tmp/kanban/hors-a", label: "depot-a/hors-lot",
            phaseStartedAt: fixtureT0 - 5_000, updatedAt: fixtureT0 - 1_000, ownerPid: Double(getpid())
        )
    )
    fixture.publish(
        .running, "\(fixtureId(0xc2)).json",
        object: runningObject(
            id: fixtureId(0xc2), cwd: "/tmp/kanban/hors-b", label: "depot-b/hors-lot",
            phaseStartedAt: fixtureT0 - 4_000, updatedAt: fixtureT0 - 1_000, ownerPid: Double(getpid())
        )
    )

    let board = kanbanBoard(fixture)
    #expect(board.cards.count == 4)
    #expect(Set(board.cards.map(\.repo)) == ["depot-a", "depot-b"])
    #expect(board.cards.filter { $0.repo == "depot-a" }.count == 2)
    #expect(board.cards.filter { $0.repo == "depot-b" }.count == 2)
}

// MARK: - AC-3 : une feature lancée par un projet reste UNE carte

@Test("kanban-des-pipelines/AC-3 : projet + lot + run d'une même feature = une carte, au statut du projet et au maillon du lot")
func projectLotAndRunMergeIntoOneCard() throws {
    let fixture = StoreFixture()
    let repoRoot = makeDirectory(fixture, "depot-r")
    let worktree = makeDirectory(fixture, "arbre-s")
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)
    fixture.publish(
        .lots, "\(repoKey).json",
        object: lotObject(
            id: repoKey, repoRoot: repoRoot,
            features: [lotFeatureObject(slug: "s", state: "running", phase: "impl", worktree: worktree)]
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
    fixture.publish(
        .running, "\(fixtureId(0xc3)).json",
        object: runningObject(
            id: fixtureId(0xc3), cwd: worktree, label: "depot-r/s",
            phaseStartedAt: fixtureT0 - 5_000, updatedAt: fixtureT0 - 1_000, ownerPid: Double(getpid())
        )
    )

    let board = kanbanBoard(fixture)
    #expect(board.cards.count == 1)
    let card = try #require(board.cards.first)
    #expect(card.id == "feature:\(repoKey):s")
    #expect(card.column == .enCours)
    #expect(card.marks.isEmpty)
    #expect(card.phase == .impl)
    // Les trois sources fusionnées : le projet, le lot et le run apparié.
    #expect(card.sources.count == 3)
    #expect(card.sources.map(\.kind) == [.project, .lot, .run])
}

// MARK: - AC-4 : la borne de l'historique

@Test("kanban-des-pipelines/AC-4 : les 20 clôtures les plus récentes sont des cartes, les 5 plus anciennes n'en sont pas")
func historyCardsRespectTheReadLimit() {
    let fixture = StoreFixture()
    for index in 0..<25 {
        let id = fixtureId(0x300 + index)
        fixture.publish(
            .history, "\(id).json",
            object: historyObject(
                id: id, cwd: "/tmp/kanban/h\(index)",
                phaseStartedAt: fixtureT0 - 30_000,
                endedAt: fixtureT0 - Double(index) * 1_000
            )
        )
    }

    let board = kanbanBoard(fixture)
    #expect(board.cards.count == PipelineStore.historyReadLimit)
    #expect(board.cards.first?.endMs == fixtureT0)
    #expect(board.cards.last?.endMs == fixtureT0 - 19_000)
    // Aucune des cinq plus anciennes n'a de carte.
    for index in 20..<25 {
        #expect(board.cards.contains { $0.id == "history:\(fixtureId(0x300 + index))" } == false)
    }
}

// MARK: - AC-5 : le modèle, jamais inventé

@Test("kanban-des-pipelines/AC-5 : une feature écrit son modèle, un run écrit l'absence de modèle")
func modelIsWrittenOrAbsent() throws {
    let fixture = StoreFixture()
    let repoRoot = "/tmp/kanban/depot-modele"
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)
    fixture.publish(
        .lots, "\(repoKey).json",
        object: lotObject(
            id: repoKey, repoRoot: repoRoot,
            features: [lotFeatureObject(slug: "s", worktree: "/tmp/kanban/arbre-modele", model: "opus")]
        )
    )
    fixture.publish(
        .running, "\(fixtureId(0xc5)).json",
        object: runningObject(
            id: fixtureId(0xc5), cwd: "/tmp/kanban/hors-modele", label: "depot/hors-lot",
            phaseStartedAt: fixtureT0 - 5_000, updatedAt: fixtureT0 - 1_000, ownerPid: Double(getpid())
        )
    )

    let board = kanbanBoard(fixture)
    let feature = try #require(board.cards.first { $0.id.hasPrefix("feature:") })
    let run = try #require(board.cards.first { $0.id.hasPrefix("run:") })
    #expect(feature.models == ModelSlots(reqSpecs: "opus", implReview: "opus"))
    #expect(run.models == nil)
}

// MARK: - AC-6 : l'URL de PR, jamais fabriquée

@Test("kanban-des-pipelines/AC-6 : une entité close écrit son URL de PR, une autre n'en fabrique aucune")
func prURLIsWrittenOrAbsent() throws {
    let fixture = StoreFixture()
    let repoRoot = "/tmp/kanban/depot-pr"
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)
    fixture.publish(
        .lots, "\(repoKey).json",
        object: lotObject(
            id: repoKey, repoRoot: repoRoot,
            features: [lotFeatureObject(
                slug: "livree", state: "done", phase: "release",
                worktree: "/tmp/kanban/arbre-pr", prUrl: "https://exemple/pull/7"
            )]
        )
    )
    fixture.publish(
        .history, "\(fixtureId(0xc6)).json",
        object: historyObject(
            id: fixtureId(0xc6), cwd: "/tmp/kanban/clos", finalState: "done",
            phaseStartedAt: fixtureT0 - 9_000, endedAt: fixtureT0 - 2_000
        )
    )

    let board = kanbanBoard(fixture)
    let delivered = try #require(board.cards.first { $0.id.hasPrefix("feature:") })
    let closed = try #require(board.cards.first { $0.id.hasPrefix("history:") })
    #expect(delivered.prUrl == "https://exemple/pull/7")
    #expect(delivered.column == .prOuverte)
    #expect(closed.prUrl == nil)
}

// MARK: - AC-9 : la durée écoulée

@Test("kanban-des-pipelines/AC-9 : la durée d'une carte ouverte avance, celle d'une carte close est figée")
func elapsedTextGrowsOnlyWhileOpen() throws {
    let fixture = StoreFixture()
    fixture.publish(
        .running, "\(fixtureId(0xc9)).json",
        object: runningObject(
            id: fixtureId(0xc9), cwd: "/tmp/kanban/ouvert", label: "depot/ouvert",
            phaseStartedAt: fixtureT0 - 5_000, updatedAt: fixtureT0 - 1_000, ownerPid: Double(getpid())
        )
    )
    fixture.publish(
        .history, "\(fixtureId(0xca)).json",
        object: historyObject(
            id: fixtureId(0xca), cwd: "/tmp/kanban/close", finalState: "done",
            phaseStartedAt: fixtureT0 - 9_000, endedAt: fixtureT0 - 2_000
        )
    )

    let board = kanbanBoard(fixture)
    let open = try #require(board.cards.first { $0.id.hasPrefix("run:") })
    let closed = try #require(board.cards.first { $0.id.hasPrefix("history:") })
    // La durée est RECALCULÉE depuis l'instant de rendu, jamais accumulée.
    #expect(open.elapsedText(nowMs: fixtureT0) == "0:05")
    #expect(open.elapsedText(nowMs: fixtureT0 + 2_000) == "0:07")
    #expect(closed.elapsedText(nowMs: fixtureT0) == "0:07")
    #expect(closed.elapsedText(nowMs: fixtureT0 + 2_000) == closed.elapsedText(nowMs: fixtureT0))
    // Le format de parité : `<m>:<ss>` sous une heure, `<h>:<mm>:<ss>` au-delà.
    #expect(elapsedLabel(ms: 0) == "0:00")
    #expect(elapsedLabel(ms: 59_999) == "0:59")
    #expect(elapsedLabel(ms: 3_600_000) == "1:00:00")
    #expect(elapsedLabel(ms: 3_661_000) == "1:01:01")
    #expect(elapsedLabel(ms: -5_000) == "0:00")
}

// MARK: - AC-15 : la parité avec `/pipelines`

@Test("kanban-des-pipelines/AC-15 : toute entité lue a sa carte, aucune carte n'est absente du magasin")
func boardMatchesTheStoreEntities() {
    let fixture = StoreFixture()
    let repoRoot = "/tmp/kanban/depot-parite"
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)
    let paired = fixtureId(0xd1)
    let unpaired = fixtureId(0xd2)
    let done = fixtureId(0xd3)
    let failed = fixtureId(0xd4)
    fixture.publish(
        .lots, "\(repoKey).json",
        object: lotObject(
            id: repoKey, repoRoot: repoRoot,
            features: [
                lotFeatureObject(slug: "f1", state: "running", phase: "impl", worktree: "/tmp/kanban/arbre-1"),
                lotFeatureObject(slug: "f2", state: "waiting", phase: "specs", waitKind: "specs"),
            ]
        )
    )
    fixture.publish(
        .running, "\(paired).json",
        object: runningObject(
            id: paired, cwd: "/tmp/kanban/arbre-1", label: "depot-parite/f1",
            phaseStartedAt: fixtureT0 - 5_000, updatedAt: fixtureT0 - 1_000, ownerPid: Double(getpid())
        )
    )
    fixture.publish(
        .running, "\(unpaired).json",
        object: runningObject(
            id: unpaired, cwd: "/tmp/kanban/hors-lot", label: "depot-parite/hors-lot",
            phaseStartedAt: fixtureT0 - 4_000, updatedAt: fixtureT0 - 1_000, ownerPid: Double(getpid())
        )
    )
    fixture.publish(
        .history, "\(done).json",
        object: historyObject(
            id: done, cwd: "/tmp/kanban/clos-ok", finalState: "done",
            phaseStartedAt: fixtureT0 - 9_000, endedAt: fixtureT0 - 2_000
        )
    )
    fixture.publish(
        .history, "\(failed).json",
        object: historyObject(
            id: failed, cwd: "/tmp/kanban/clos-ko", finalState: "failed",
            phaseStartedAt: fixtureT0 - 8_000, endedAt: fixtureT0 - 3_000
        )
    )

    let board = kanbanBoard(fixture)
    // Les rangs attendus de `/pipelines` : les deux features du lot, le run NON
    // apparié, les deux clôtures — le run apparié est ABSORBÉ par sa feature.
    let expected: [String: KanbanColumn] = [
        "feature:\(repoKey):f1": .enCours,
        "feature:\(repoKey):f2": .jalonSpecs,
        "run:\(unpaired)": .enCours,
        "history:\(done)": .termineeSansPr,
        "history:\(failed)": .echec,
    ]
    #expect(board.cards.count == expected.count)
    for (id, column) in expected {
        let matches = board.cards.filter { $0.id == id }
        #expect(matches.count == 1, "\(id) : \(matches.count) carte(s)")
        #expect(matches.first?.column == column)
    }
    // Rien d'inventé : aucune carte n'est absente du magasin.
    #expect(Set(board.cards.map(\.id)) == Set(expected.keys))
    #expect(board.anomalies.isEmpty)
}

// MARK: - S-10 : la carte porte les valeurs de ses gestes

@Test("reponses-et-jalons/AC-1 : une carte de feature de lot porte slug, jalon, run et question")
func lotFeatureCardCarriesItsAction() {
    let fixture = StoreFixture()
    let repoRoot = makeDirectory(fixture, "depot-alpha")
    let worktree = makeDirectory(fixture, "worktree-alpha")
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)
    let box = fixture.createBox("run-1")
    let ask: [String: Any] = [
        "toolCallId": "call-1", "id": "q", "question": "On garde ?",
        "options": [["label": "oui", "description": "on garde"]],
    ]
    fixture.publish(
        .running, "\(fixtureId(1)).json",
        object: runningObject(
            id: fixtureId(1), cwd: worktree, phase: "specs", state: "waiting",
            phaseStartedAt: fixtureT0, updatedAt: fixtureT0, ownerPid: Double(getpid()),
            inbox: box, pendingAsk: ask
        )
    )
    fixture.publish(
        .lots, "\(repoKey).json",
        object: lotObject(
            id: repoKey, repoRoot: repoRoot,
            features: [lotFeatureObject(
                slug: "alpha", state: "waiting", phase: "specs", worktree: worktree, waitKind: "specs"
            )]
        )
    )

    let board = kanbanBoard(fixture)
    let card = board.cards.first { $0.id.hasPrefix("feature:") }
    let action = card?.action
    #expect(action?.repoRoot == repoRoot)
    #expect(action?.slug == "alpha")
    #expect(action?.waitKind == .specs)
    #expect(action?.featureState == .waiting)
    #expect(action?.run?.inbox == box, "la boîte PUBLIÉE, jamais recalculée")
    #expect(action?.run?.label == "mem0-omp/feature")
    #expect(action?.run?.pendingAsk?.toolCallId == "call-1")
    #expect(action?.run?.pendingAsk?.options == [PanelAskOption(label: "oui", description: "on garde")])
}

@Test("reponses-et-jalons/AC-3 : une carte de run hors lot porte son run et AUCUN slug")
func unpairedRunCardCarriesItsAction() {
    let fixture = StoreFixture()
    let worktree = makeDirectory(fixture, "worktree-orphan")
    let box = fixture.createBox("run-2")
    fixture.publish(
        .running, "\(fixtureId(2)).json",
        object: runningObject(
            id: fixtureId(2), cwd: worktree, label: "depot/orpheline",
            phaseStartedAt: fixtureT0, updatedAt: fixtureT0, ownerPid: Double(getpid()), inbox: box
        )
    )

    let board = kanbanBoard(fixture)
    let card = board.cards.first { $0.id.hasPrefix("run:") }
    #expect(card?.action?.slug == nil)
    #expect(card?.action?.repoRoot == nil)
    #expect(card?.action?.run?.inbox == box)
    #expect(card?.action?.run?.pendingAsk == nil)
}

@Test("reponses-et-jalons/AC-5 : une carte d'historique ne porte aucun geste")
func historyCardHasNoAction() {
    let fixture = StoreFixture()
    fixture.publish(
        .history, "\(fixtureId(3)).json",
        object: historyObject(
            id: fixtureId(3), cwd: "/tmp/depot-historique",
            phaseStartedAt: fixtureT0, endedAt: fixtureT0 + 1000
        )
    )

    let board = kanbanBoard(fixture)
    let card = board.cards.first { $0.id.hasPrefix("history:") }
    #expect(card != nil)
    #expect(card?.action == nil)
}
