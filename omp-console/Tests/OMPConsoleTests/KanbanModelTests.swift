// Preuves du MODÈLE du tableau (S-5, S-7, S-6) : AC-7 (sélection seule), AC-8
// (aucun départ vers les sections voisines), AC-9 (durée qui avance), AC-10 (le
// tableau suit le magasin sans geste).
//
// Le consommateur du flux est UNIQUE et de longue durée (`for await` dans le
// modèle) : c'est ce que ces tests exercent, pas une scrutation du test.

import Foundation
import Testing
@testable import OMPConsole

/// Un run hors lot, publié dans une fixture, avec un pid vivant.
private func publishRun(_ fixture: StoreFixture, id: String, label: String, started: Double) {
    fixture.publish(
        .running,
        "\(id).json",
        object: runningObject(
            id: id, cwd: "/tmp/kanban/\(id)", label: label,
            phaseStartedAt: started, updatedAt: fixtureT0 - 1_000, ownerPid: Double(getpid())
        )
    )
}

// MARK: - AC-7 : sélection seule

@MainActor
@Test("kanban-des-pipelines/AC-7 : une seule carte sélectionnée, et le panneau décrit la carte courante")
func selectionIsSingleAndThePanelFollows() async throws {
    let fixture = StoreFixture()
    let runId = fixtureId(0xf1)
    let historyId = fixtureId(0xf2)
    publishRun(fixture, id: runId, label: "depot/ouvert", started: fixtureT0 - 5_000)
    fixture.publish(
        .history, "\(historyId).json",
        object: historyObject(
            id: historyId, cwd: "/tmp/kanban/clos", label: "depot/clos", finalState: "done",
            phaseStartedAt: fixtureT0 - 9_000, endedAt: fixtureT0 - 2_000
        )
    )

    let model = KanbanModel(hub: StoreHub(stateDir: fixture.root, nowMs: { fixtureT0 }))
    defer { model.stop() }
    model.start()
    #expect(await awaitMainTrue { model.state.kanbanBoard?.cards.count == 2 })

    // La sélection est VIDE au premier affichage.
    #expect(model.selectedCardID == nil)
    #expect(model.selectedCard == nil)

    model.select("run:\(runId)")
    #expect(model.selectedCardID == "run:\(runId)")
    #expect(model.selectedCard?.title == "depot/ouvert")

    model.select("history:\(historyId)")
    #expect(model.selectedCardID == "history:\(historyId)")
    #expect(model.selectedCard?.title == "depot/clos")
    // Cliquer la carte déjà sélectionnée la garde sélectionnée.
    model.select("history:\(historyId)")
    #expect(model.selectedCardID == "history:\(historyId)")
}

@MainActor
@Test("kanban-des-pipelines/AC-7 : le clavier suit l'ordre total et ne sort jamais de l'ardoise")
func keyboardMovesWithinTheBoard() async {
    let fixture = StoreFixture()
    let runId = fixtureId(0xf3)
    let historyId = fixtureId(0xf4)
    publishRun(fixture, id: runId, label: "depot/ouvert", started: fixtureT0 - 5_000)
    fixture.publish(
        .history, "\(historyId).json",
        object: historyObject(
            id: historyId, cwd: "/tmp/kanban/clos", label: "depot/clos", finalState: "done",
            phaseStartedAt: fixtureT0 - 9_000, endedAt: fixtureT0 - 2_000
        )
    )

    let model = KanbanModel(hub: StoreHub(stateDir: fixture.root, nowMs: { fixtureT0 }))
    defer { model.stop() }
    model.start()
    #expect(await awaitMainTrue { model.state.kanbanBoard?.cards.count == 2 })

    // Sans sélection : `next` prend la PREMIÈRE carte, `previous` la dernière.
    model.move(by: .next)
    #expect(model.selectedCardID == "run:\(runId)")
    model.selectedCardID = nil
    model.move(by: .previous)
    #expect(model.selectedCardID == "history:\(historyId)")

    // `next` depuis la dernière carte ne change rien (on sort de l'ardoise).
    model.move(by: .next)
    #expect(model.selectedCardID == "history:\(historyId)")

    // `nextColumn` depuis « en cours » → la colonne suivante NON VIDE.
    model.select("run:\(runId)")
    model.move(by: .nextColumn)
    #expect(model.selectedCardID == "history:\(historyId)")
    // `previousColumn` revient à la première carte de la colonne précédente non vide.
    model.move(by: .previousColumn)
    #expect(model.selectedCardID == "run:\(runId)")
    // Aucune colonne suivante non vide : rien ne bouge.
    model.move(by: .nextColumn)
    model.move(by: .nextColumn)
    #expect(model.selectedCardID == "history:\(historyId)")
}

@MainActor
@Test("kanban-des-pipelines/AC-7 : une carte disparue ne laisse pas un détail fantôme")
func vanishedCardClearsTheSelection() async {
    let fixture = StoreFixture()
    let runId = fixtureId(0xf5)
    publishRun(fixture, id: runId, label: "depot/transitoire", started: fixtureT0 - 5_000)

    let model = KanbanModel(hub: StoreHub(stateDir: fixture.root, nowMs: { fixtureT0 }))
    defer { model.stop() }
    model.start()
    #expect(await awaitMainTrue { model.state.card("run:\(runId)") != nil })
    model.select("run:\(runId)")
    #expect(model.selectedCard != nil)

    fixture.remove(.running, "\(runId).json")
    #expect(await awaitMainTrue { model.selectedCardID == nil })
    #expect(model.selectedCard == nil)
}

// MARK: - AC-8 : aucun départ vers les sections voisines

@MainActor
@Test("kanban-des-pipelines/AC-8 : sélectionner une carte ne touche pas la section de la fenêtre")
func selectionDoesNotChangeTheSection() async {
    let fixture = StoreFixture()
    let runId = fixtureId(0xf6)
    publishRun(fixture, id: runId, label: "depot/section", started: fixtureT0 - 5_000)

    let model = KanbanModel(hub: StoreHub(stateDir: fixture.root, nowMs: { fixtureT0 }))
    defer { model.stop() }
    let console = ConsoleModel()
    let initial = console.selection
    model.start()
    #expect(await awaitMainTrue { model.state.card("run:\(runId)") != nil })

    model.select("run:\(runId)")
    // Le modèle du tableau ne connaît AUCUN `ConsoleModel` : la section courante
    // reste celle de départ, et rien n'ouvre Sessions ni Fichiers.
    #expect(model.selectedCardID == "run:\(runId)")
    #expect(console.selection == initial)
}

// MARK: - AC-9 : la durée avance seule

@MainActor
@Test("kanban-des-pipelines/AC-9 : la durée d'une carte ouverte avance dans le panneau, celle d'une carte close est figée")
func panelDurationGrowsOnlyWhileOpen() async throws {
    let fixture = StoreFixture()
    let runId = fixtureId(0xf7)
    let historyId = fixtureId(0xf8)
    publishRun(fixture, id: runId, label: "depot/ouvert", started: fixtureT0 - 5_000)
    fixture.publish(
        .history, "\(historyId).json",
        object: historyObject(
            id: historyId, cwd: "/tmp/kanban/clos", label: "depot/clos", finalState: "done",
            phaseStartedAt: fixtureT0 - 9_000, endedAt: fixtureT0 - 2_000
        )
    )

    let model = KanbanModel(hub: StoreHub(stateDir: fixture.root, nowMs: { fixtureT0 }))
    defer { model.stop() }
    model.start()
    #expect(await awaitMainTrue { model.state.kanbanBoard?.cards.count == 2 })

    model.select("run:\(runId)")
    let open = try #require(model.selectedCard)
    #expect(open.elapsedMs(nowMs: fixtureT0) == 5_000)
    #expect(open.elapsedMs(nowMs: fixtureT0 + 2_000) == 7_000)

    model.select("history:\(historyId)")
    let closed = try #require(model.selectedCard)
    #expect(closed.elapsedMs(nowMs: fixtureT0) == 7_000)
    #expect(closed.elapsedMs(nowMs: fixtureT0 + 2_000) == 7_000)
}

// MARK: - AC-10 : le tableau suit le magasin

@MainActor
@Test("kanban-des-pipelines/AC-10 : une carte apparaît, disparaît et change de colonne sans geste")
func boardFollowsTheStore() async {
    let fixture = StoreFixture()
    let model = KanbanModel(hub: StoreHub(stateDir: fixture.root, nowMs: { fixtureT0 }))
    defer { model.stop() }
    model.start()
    // Magasin VIDE : la racine existe, aucune carte, aucune anomalie.
    #expect(await awaitMainTrue { model.state == .storeEmpty(dir: fixture.root) })

    // (a) Un run apparaît dans le magasin.
    let runId = fixtureId(0xf9)
    #expect(model.state.card("run:\(runId)") == nil)
    publishRun(fixture, id: runId, label: "depot/apparu", started: fixtureT0 - 5_000)
    #expect(await awaitMainTrue { model.state.card("run:\(runId)") != nil })
    #expect(model.state.card("run:\(runId)")?.column == .enCours)

    // (b) Il disparaît.
    fixture.remove(.running, "\(runId).json")
    #expect(await awaitMainTrue { model.state.card("run:\(runId)") == nil })

    // (c) Une feature de lot change d'état : sa carte change de colonne.
    let repoRoot = "/tmp/kanban/suivi"
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)
    let worktree = "/tmp/kanban/arbre-suivi"
    fixture.publish(
        .lots, "\(repoKey).json",
        object: lotObject(
            id: repoKey, repoRoot: repoRoot,
            features: [lotFeatureObject(slug: "suivie", state: "running", worktree: worktree)]
        )
    )
    #expect(await awaitMainTrue { model.state.card("feature:\(repoKey):suivie")?.column == .enCours })
    fixture.publish(
        .lots, "\(repoKey).json",
        object: lotObject(
            id: repoKey, repoRoot: repoRoot,
            features: [lotFeatureObject(slug: "suivie", state: "blocked", worktree: worktree)]
        )
    )
    #expect(await awaitMainTrue { model.state.card("feature:\(repoKey):suivie")?.column == .bloquee })
}

@MainActor
@Test("kanban-des-pipelines/AC-10 : après stop(), un nouvel abonnement reçoit bien un instantané neuf")
func restartSubscribesAgain() async {
    let fixture = StoreFixture()
    let model = KanbanModel(hub: StoreHub(stateDir: fixture.root, nowMs: { fixtureT0 }))
    defer { model.stop() }
    model.start()
    #expect(await awaitMainTrue { model.state == .storeEmpty(dir: fixture.root) })
    model.stop()

    // Un hub arrêté ne se rouvre pas : le second `start()` doit construire un
    // abonnement NEUF sur le même magasin.
    let runId = fixtureId(0xfa)
    publishRun(fixture, id: runId, label: "depot/apres-arret", started: fixtureT0 - 5_000)
    model.start()
    #expect(await awaitMainTrue { model.state.card("run:\(runId)") != nil })
}

// MARK: - Le chaînage « Lire le contrat » depuis le détail (S-6, BR-3)

/// Une carte de feature en attente de specs, avec son worktree.
private func waitingCard(slug: String, worktree: String) -> KanbanCard {
    KanbanCard(
        id: "feature:cle:\(slug)", column: .jalonSpecs, repo: "depot", title: slug, state: "attend",
        phase: .specs, model: nil, prUrl: nil, startMs: 0, endMs: nil, marks: [], sources: [],
        action: KanbanCardAction(
            repoRoot: "/tmp/kanban/depot",
            worktree: worktree,
            slug: slug,
            waitKind: .specs,
            featureState: .waiting,
            run: nil
        )
    )
}

@MainActor
@Test("contract-display-omp-console/AC-1 : « Lire le contrat » depuis le détail ferme le détail, et la demande se consomme UNE fois")
func contractRequestClosesDetailAndIsConsumedOnce() {
    let fixture = StoreFixture()
    let model = KanbanModel(hub: StoreHub(stateDir: fixture.root, nowMs: { fixtureT0 }))
    let card = waitingCard(slug: "contrat", worktree: "/tmp/kanban/arbre-contrat")

    model.openDetail(card.id)
    #expect(model.detailShown)

    // Poser la demande ferme le détail : la feuille Contrat n'est demandée qu'à
    // la fermeture effective (l'`onDismiss` de KanbanView consomme).
    model.requestContract(card)
    #expect(model.detailShown == false)
    #expect(model.pendingContract == card)
    #expect(model.consumePendingContract() == card)
    #expect(model.pendingContract == nil)
    #expect(model.consumePendingContract() == nil, "une demande ne se consomme qu'une fois")
}

@MainActor
@Test("contract-display-omp-console/AC-2 : la demande consommée porte la carte du jalon specs, worktree compris")
func contractRequestCarriesTheSpecsCard() {
    let fixture = StoreFixture()
    let model = KanbanModel(hub: StoreHub(stateDir: fixture.root, nowMs: { fixtureT0 }))
    let card = waitingCard(slug: "specs-a-valider", worktree: "/tmp/kanban/arbre-specs")

    model.requestContract(card)
    let consumed = model.consumePendingContract()
    #expect(consumed?.id == card.id)
    #expect(consumed?.action?.worktree == "/tmp/kanban/arbre-specs")
    #expect(ContractDocument.moment(for: card) == .specs)
}
