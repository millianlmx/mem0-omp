// Preuves du lien profond des notifications (notifications-mac-lien-profond, S-4) :
// la destination PURE d'un clic (AC-9) et son application aux modèles réels de la
// fenêtre, sur le magasin réel d'une fixture (AC-1..AC-7).
//
// Aucune fenêtre n'est construite : `reveal` et `sheetAttached` sont injectés
// (patron `isWindowFrontmost` d'AlertsModel), et chaque ouverture passe par le
// payload `userInfo` puis `AlertOpening(userInfo:)`, comme au clic réel.

import Foundation
import Testing
@testable import OMPConsole
@testable import ConsoleCore

// --- AC-9 : destination pure -----------------------------------------------------

private func card(
    _ id: String,
    column: KanbanColumn,
    action: KanbanCardAction? = nil
) -> KanbanCard {
    KanbanCard(
        id: id, column: column, repo: "depot", title: id, state: "x",
        phase: .req, models: nil, prUrl: nil, startMs: 0, endMs: nil, marks: [], sources: [],
        action: action
    )
}

private func feature(_ slug: String, state: LotFeatureState, waitKind: LotWaitKind? = nil, worktree: String? = "/w/arbre") -> KanbanCardAction {
    KanbanCardAction(repoRoot: "/r", repoKey: "k", worktree: worktree, slug: slug, waitKind: waitKind, featureState: state, run: nil)
}

private func askingRun(_ id: String) -> KanbanCardAction {
    let ask = PanelPendingAsk(toolCallId: "call-1", id: "q", question: "On garde ?", options: [])
    return KanbanCardAction(
        repoRoot: "/r", slug: nil, waitKind: nil, featureState: .running,
        run: KanbanCardRun(id: id, label: "depot/\(id)", inbox: "/box", pendingAsk: ask)
    )
}

/// Le payload posé à la livraison, relu comme au clic.
private func clicked(_ kind: AlertKind, _ cardID: String) -> AlertOpening? {
    let payload: [AnyHashable: Any] = AlertOpening(kind: kind, cardID: cardID).userInfo
    return AlertOpening(userInfo: payload)
}

@Test("notifications-mac-lien-profond/AC-9 : chaque famille × carte présente, déjà traitée ou absente mène à la destination attendue, sur la carte de l'identifiant")
func alertDestinationTable() throws {
    let board = KanbanBoardState.board(KanbanBoard(cards: [
        // Questions : deux runs en attente, une feature qui attend une réponse texte,
        // un run dont la question a reçu sa réponse.
        card("run:a", column: .questionEnVol, action: askingRun("a")),
        card("run:b", column: .questionEnVol, action: askingRun("b")),
        card("feature:k:reponse", column: .questionEnVol, action: KanbanCardAction(
            repoRoot: "/r", slug: "reponse", waitKind: .answer, featureState: .waiting, run: nil,
            waitPrompt: "Quel séparateur ?"
        )),
        card("run:repondu", column: .enCours, action: KanbanCardAction(
            repoRoot: "/r", slug: nil, waitKind: nil, featureState: .running,
            run: KanbanCardRun(id: "repondu", label: "depot/repondu", inbox: "/box", pendingAsk: nil)
        )),
        // Jalons specs : deux en attente, un validé, un sans worktree.
        card("feature:k:specs-a", column: .jalonSpecs, action: feature("specs-a", state: .waiting, waitKind: .specs)),
        card("feature:k:specs-b", column: .jalonSpecs, action: feature("specs-b", state: .waiting, waitKind: .specs)),
        card("feature:k:specs-valide", column: .enCours, action: feature("specs-valide", state: .running)),
        card("feature:k:specs-sans-arbre", column: .jalonSpecs, action: feature("specs-sans-arbre", state: .waiting, waitKind: .specs, worktree: nil)),
        // Jalons revue : deux en attente, une acceptée.
        card("feature:k:revue-a", column: .jalonReview, action: feature("revue-a", state: .waiting, waitKind: .review)),
        card("feature:k:revue-b", column: .jalonReview, action: feature("revue-b", state: .waiting, waitKind: .review)),
        card("feature:k:revue-acceptee", column: .fusionne, action: feature("revue-acceptee", state: .done)),
        // Échecs de lot : deux en échec, un repris.
        card("feature:k:echec-a", column: .echec, action: feature("echec-a", state: .failed)),
        card("feature:k:echec-b", column: .echec, action: feature("echec-b", state: .failed)),
        card("feature:k:echec-repris", column: .enCours, action: feature("echec-repris", state: .running)),
        // Échecs de run (historique) et PR fusionnées (projet seul, feature appariée).
        card("history:h1", column: .echec),
        card("history:h2", column: .echec),
        card("project:p:livree-a", column: .fusionne),
        card("feature:k:livree-b", column: .fusionne, action: feature("livree-b", state: .done)),
    ], anomalies: []))

    let table: [(kind: AlertKind, cardID: String, expected: AlertDestination)] = [
        // AC-1 : question en attente → Répondre, sur la carte de l'identifiant (pas l'autre).
        (.pendingAnswer, "run:a", .answer(cardID: "run:a")),
        (.pendingAnswer, "run:b", .answer(cardID: "run:b")),
        (.pendingAnswer, "feature:k:reponse", .answer(cardID: "feature:k:reponse")),
        // AC-4 : question déjà répondue → fiche.
        (.pendingAnswer, "run:repondu", .detail(cardID: "run:repondu")),
        (.pendingAnswer, "run:absent", .home),
        // AC-2 : jalon specs → Contrat ; validé ou sans contrat localisable → fiche.
        (.milestoneSpecs, "feature:k:specs-a", .contract(cardID: "feature:k:specs-a")),
        (.milestoneSpecs, "feature:k:specs-b", .contract(cardID: "feature:k:specs-b")),
        (.milestoneSpecs, "feature:k:specs-valide", .detail(cardID: "feature:k:specs-valide")),
        (.milestoneSpecs, "feature:k:specs-sans-arbre", .detail(cardID: "feature:k:specs-sans-arbre")),
        (.milestoneSpecs, "feature:k:absente", .home),
        // AC-2 : jalon revue → fiche, en attente ou déjà acceptée.
        (.milestoneReview, "feature:k:revue-a", .detail(cardID: "feature:k:revue-a")),
        (.milestoneReview, "feature:k:revue-b", .detail(cardID: "feature:k:revue-b")),
        (.milestoneReview, "feature:k:revue-acceptee", .detail(cardID: "feature:k:revue-acceptee")),
        (.milestoneReview, "feature:k:absente", .home),
        // AC-3 : échecs et PR fusionnée → fiche ; AC-5 : carte disparue → Accueil.
        (.failedLot, "feature:k:echec-a", .detail(cardID: "feature:k:echec-a")),
        (.failedLot, "feature:k:echec-b", .detail(cardID: "feature:k:echec-b")),
        (.failedLot, "feature:k:echec-repris", .detail(cardID: "feature:k:echec-repris")),
        (.failedLot, "feature:k:absente", .home),
        (.failedRun, "history:h1", .detail(cardID: "history:h1")),
        (.failedRun, "history:h2", .detail(cardID: "history:h2")),
        (.failedRun, "history:absent", .home),
        (.mergedPullRequest, "project:p:livree-a", .detail(cardID: "project:p:livree-a")),
        (.mergedPullRequest, "feature:k:livree-b", .detail(cardID: "feature:k:livree-b")),
        (.mergedPullRequest, "project:p:absente", .home),
    ]
    let kinds: [AlertKind] = [.pendingAnswer, .milestoneSpecs, .milestoneReview, .failedLot, .failedRun, .mergedPullRequest]
    #expect(Set(table.map(\.kind.rawValue)) == Set(kinds.map(\.rawValue)), "les six familles sont couvertes")

    for row in table {
        let opening = try #require(clicked(row.kind, row.cardID), "payload \(row.kind) \(row.cardID) illisible")
        #expect(opening == AlertOpening(kind: row.kind, cardID: row.cardID))
        #expect(AlertRoute.destination(for: opening, board: board) == row.expected, "\(row.kind) \(row.cardID)")
    }

    // Magasin absent ou vide : la carte n'existe pas → Accueil.
    for empty in [KanbanBoardState.storeAbsent(dir: "/s"), .storeEmpty(dir: "/s")] {
        for kind in kinds {
            #expect(AlertRoute.destination(for: clicked(kind, "run:a"), board: empty) == .home)
        }
    }
    // Payload absent ou illisible → Accueil, même en chargement ; ardoise en
    // chargement avec une carte → attendre.
    #expect(AlertRoute.destination(for: nil, board: board) == .home)
    #expect(AlertRoute.destination(for: nil, board: .loading) == .home)
    #expect(AlertRoute.destination(for: AlertOpening(userInfo: [:]), board: board) == .home)
    #expect(AlertRoute.destination(for: AlertOpening(userInfo: ["kind": "inconnu", "cardID": "run:a"]), board: board) == .home)
    // Une perte d'ownership ne concerne aucune carte : même nommée par un payload,
    // elle mène à l'Accueil.
    #expect(AlertRoute.destination(for: clicked(.stackOwnershipLost, "run:a"), board: board) == .home)
    for kind in kinds {
        #expect(AlertRoute.destination(for: clicked(kind, "run:a"), board: .loading) == nil)
    }
}

// --- AC-1..AC-7 : application aux modèles réels ----------------------------------

/// Les modèles de la fenêtre sur le magasin réel d'une fixture, et le routeur
/// branché sur des dépendances de fenêtre injectées. Le clic suit le chemin de
/// l'app : livreur → `AlertsModel.onOpen` → `AlertRouter.open` (S-3), le livreur
/// système étant remplacé par l'enregistreur.
@MainActor
private final class RouterScene {
    let fixture: StoreFixture
    let console = ConsoleModel()
    let home: HomeModel
    let kanban: KanbanModel
    let contract = ContractModel()
    let actions: ActionsModel
    let recorder = RecorderAlertDeliverer()
    let alerts: AlertsModel
    private let suite: String
    /// Le journal d'ordre : `reveal` y écrit, avec l'état de la feuille Contrat à
    /// cet instant.
    var log: [String] = []
    var sheetIsAttached = false

    init(_ fixture: StoreFixture) {
        self.fixture = fixture
        suite = "alert-router-\(UUID().uuidString)"
        home = HomeModel(
            resolve: { _ in .success(URL(fileURLWithPath: "/usr/local/bin/omp")) },
            environment: { [:] },
            defaults: UserDefaults(suiteName: suite) ?? .standard
        )
        kanban = KanbanModel(hub: StoreHub(stateDir: fixture.root, nowMs: { fixtureT0 }))
        actions = ActionsModel(writer: PipelineWriter(stateDir: fixture.root))
        // Fenêtre « au premier plan » : le modèle ne livre rien, il ne sert qu'au clic.
        alerts = fixtureAlertsModel(fixture, deliverer: recorder, frontmost: true)
        let router = AlertRouter(
            console: console, home: home, kanban: kanban, contract: contract, actions: actions,
            reveal: { [unowned self] in log.append(contract.sheet == nil ? "reveal" : "reveal après mutation") },
            sheetAttached: { [unowned self] in sheetIsAttached }
        )
        // Le câblage d'`AppDelegate` : `onOpen` posé AVANT `start()` ; la closure
        // retient le routeur, comme l'accroche `AppDelegate.openAlert`.
        alerts.onOpen = { router.open($0) }
        alerts.start()
    }

    func start() async -> Bool {
        kanban.start()
        return await awaitMainTrue { self.kanban.state.kanbanBoard != nil }
    }

    func stop() {
        alerts.stop()
        kanban.stop()
        UserDefaults.standard.removePersistentDomain(forName: suite)
    }

    /// Le clic réel, à partir du délégué : le payload décodé remis au modèle d'alertes.
    func open(_ opening: AlertOpening?) {
        recorder.simulateOpen(opening)
    }

    /// Le clic : le payload de la notification, relu comme au clic réel.
    func click(_ kind: AlertKind, _ cardID: String) {
        open(clicked(kind, cardID))
    }

    /// La feuille racine que la fenêtre présenterait.
    var mainSheet: MainSheet? {
        MainSheetPolicy.sheet(
            omp: home.omp, setup: .ready, setupDismissed: false, board: kanban.state,
            welcomeSeen: true, welcomeRequested: false, launchFormShown: false,
            answerCardID: home.answerCardID, contract: contract.sheet, pairing: false
        )
    }

    /// La fiche de `id` est affichée et aucune feuille d'action n'est ouverte.
    func expectDetail(_ id: String, _ comment: Comment, sourceLocation: SourceLocation = #_sourceLocation) {
        #expect(console.selection == .kanban, comment, sourceLocation: sourceLocation)
        #expect(kanban.selectedCardID == id, comment, sourceLocation: sourceLocation)
        #expect(kanban.detailShown, comment, sourceLocation: sourceLocation)
        #expect(contract.sheet == nil, comment, sourceLocation: sourceLocation)
        #expect(home.answerCardID == nil, comment, sourceLocation: sourceLocation)
        #expect(mainSheet == nil, comment, sourceLocation: sourceLocation)
    }

    /// Referme la fiche et revient à l'Accueil, entre deux clics.
    func reset() {
        kanban.detailShown = false
        kanban.selectedCardID = nil
        contract.close()
        home.dismissAnswer(actions: actions)
        console.select(.home)
    }
}

/// Un worktree jetable qui porte `.omp/pipeline/contract.md`.
private func makeWorktree(_ name: String) throws -> String {
    let worktree = (NSTemporaryDirectory() as NSString)
        .appendingPathComponent("alert-router-\(name)-\(UUID().uuidString)")
    let directory = joinPath(worktree, ".omp/pipeline")
    try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
    let markdown = "# Contrat\n\n## Spécifications\n\nLa spec.\n\n## Lots\n\n### BR-1\n"
    try Data(markdown.utf8).write(to: URL(fileURLWithPath: joinPath(directory, "contract.md")))
    return worktree
}

private let repoRoot = "/Users/millian/Experiments/mem0-omp"

private func publishFeatures(_ fixture: StoreFixture, seed: Int, _ features: [[String: Any]]) {
    let lotId = fixtureId(seed)
    fixture.publish(.lots, "\(lotId).json", object: lotObject(id: lotId, repoRoot: repoRoot, features: features))
}

@MainActor
@Test("notifications-mac-lien-profond/AC-1 : la notification de question de A ouvre la feuille Répondre de A, pas celle de B")
func clickOnQuestionOpensAnswerOfThatCard() async throws {
    let fixture = StoreFixture()
    let runA = fixtureId(0xa1)
    let runB = fixtureId(0xb1)
    publishPendingAnswer(fixture, id: runA, label: "depot/question-a")
    publishPendingAnswer(fixture, id: runB, label: "depot/question-b", toolCallId: "call-2")
    let scene = RouterScene(fixture)
    defer { scene.stop() }
    #expect(await scene.start())
    let idA = "run:\(runA)"
    #expect(scene.kanban.state.card(idA).flatMap(MainSheetPolicy.answerZone(for:)) != nil)
    #expect(scene.kanban.state.card("run:\(runB)").flatMap(MainSheetPolicy.answerZone(for:)) != nil, "B attend aussi")
    scene.actions.replyText = "brouillon d'une réponse fermée"

    scene.click(.pendingAnswer, idA)

    #expect(scene.recorder.openingObservationCount == 1, "le clic est confié au livreur une seule fois")
    #expect(scene.log == ["reveal"])
    #expect(scene.home.answerCardID == idA)
    #expect(scene.mainSheet == .answer(cardID: idA))
    #expect(scene.actions.replyText == "", "la feuille s'ouvre sur une saisie vierge")
    #expect(scene.console.selection == .home, "la section courante ne change pas")
    #expect(scene.kanban.detailShown == false)
}

@MainActor
@Test("notifications-mac-lien-profond/AC-2 : jalon specs → feuille Contrat de A ; jalon revue → fiche de A sans feuille d'action")
func clickOnMilestoneOpensContractOrDetail() async throws {
    let fixture = StoreFixture()
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)
    let worktree = try makeWorktree("specs")
    defer { try? FileManager.default.removeItem(atPath: worktree) }
    publishFeatures(fixture, seed: 0xc1, [
        lotFeatureObject(slug: "jalon-specs", state: "waiting", worktree: worktree, waitKind: "specs"),
        lotFeatureObject(slug: "autre-specs", state: "waiting", waitKind: "specs"),
        lotFeatureObject(slug: "jalon-revue", state: "waiting", waitKind: "review"),
    ])
    let scene = RouterScene(fixture)
    defer { scene.stop() }
    #expect(await scene.start())

    scene.click(.milestoneSpecs, "feature:\(repoKey):jalon-specs")
    #expect(scene.log == ["reveal"])
    #expect(scene.contract.sheet?.moment == .specs)
    #expect(scene.contract.sheet?.slug == "jalon-specs")
    #expect(scene.contract.sheet?.path == ContractDocument.path(worktree: worktree))
    if case .sections = scene.contract.sheet?.content {} else {
        Issue.record("la feuille Contrat lit le contrat du worktree de A")
    }
    #expect(scene.console.selection == .home, "la section courante ne change pas")
    #expect(scene.kanban.detailShown == false)

    scene.reset()
    let review = "feature:\(repoKey):jalon-revue"
    scene.click(.milestoneReview, review)
    scene.expectDetail(review, "jalon revue")
}

@MainActor
@Test("notifications-mac-lien-profond/AC-3 : échec de lot, échec de run et PR fusionnée → fiche de A, aucune feuille d'action")
func clickOnFailureOrMergeOpensDetail() async throws {
    let fixture = StoreFixture()
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)
    publishFeatures(fixture, seed: 0xd1, [
        lotFeatureObject(slug: "feature-echouee", state: "failed"),
        lotFeatureObject(slug: "autre-echouee", state: "failed"),
    ])
    let historyId = fixtureId(0xd2)
    fixture.publish(
        .history, "\(historyId).json",
        object: historyObject(
            id: historyId, cwd: "/tmp/alert-router/clos-echec", label: "depot/run-echoue",
            finalState: "failed", phaseStartedAt: fixtureT0 - 9_000, endedAt: fixtureT0 - 1_000
        )
    )
    let soloProject = fixtureId(0xd3)
    fixture.publish(
        .projects, "\(soloProject).json",
        object: projectObject(
            repoKey: soloProject, repoRoot: "/tmp/alert-router/autre-depot",
            segments: [["name": "S", "features": [projectFeatureObject(slug: "livree-seule", status: "merged")]]],
            current: 0
        )
    )
    let scene = RouterScene(fixture)
    defer { scene.stop() }
    #expect(await scene.start())

    let rows: [(AlertKind, String)] = [
        (.failedLot, "feature:\(repoKey):feature-echouee"),
        (.failedRun, "history:\(historyId)"),
        (.mergedPullRequest, "project:\(soloProject):livree-seule"),
    ]
    for (kind, id) in rows {
        #expect(scene.kanban.state.card(id) != nil, "\(id) est sur l'ardoise")
        scene.reset()
        scene.click(kind, id)
        scene.expectDetail(id, "\(kind)")
    }
    #expect(scene.log == ["reveal", "reveal", "reveal"])
}

@MainActor
@Test("notifications-mac-lien-profond/AC-4 : une question déjà répondue (ou un jalon déjà validé) ouvre la fiche, sans feuille Répondre")
func clickOnStaleNotificationOpensDetail() async throws {
    let fixture = StoreFixture()
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)
    let answered = fixtureId(0xe1)
    publishBusyRun(fixture, id: answered, label: "depot/deja-repondu")
    publishFeatures(fixture, seed: 0xe2, [
        lotFeatureObject(slug: "specs-validees", state: "running", phase: "impl"),
    ])
    let scene = RouterScene(fixture)
    defer { scene.stop() }
    #expect(await scene.start())

    let run = "run:\(answered)"
    scene.click(.pendingAnswer, run)
    scene.expectDetail(run, "question déjà répondue")

    scene.reset()
    let validated = "feature:\(repoKey):specs-validees"
    scene.click(.milestoneSpecs, validated)
    scene.expectDetail(validated, "jalon déjà validé")
}

@MainActor
@Test("notifications-mac-lien-profond/AC-5 : une carte disparue mène à l'Accueil, sans feuille ni message")
func clickOnVanishedCardShowsHome() async throws {
    let fixture = StoreFixture()
    publishBusyRun(fixture, id: fixtureId(0xf1), label: "depot/autre")
    let scene = RouterScene(fixture)
    defer { scene.stop() }
    #expect(await scene.start())

    let kinds: [AlertKind] = [.pendingAnswer, .milestoneSpecs, .milestoneReview, .failedLot, .failedRun, .mergedPullRequest]
    for kind in kinds {
        scene.console.select(.memory)
        scene.click(kind, "feature:inconnu:\(kind.rawValue)")
        #expect(scene.console.selection == .home, "\(kind)")
        #expect(scene.kanban.detailShown == false, "\(kind)")
        #expect(scene.kanban.selectedCardID == nil, "\(kind)")
        #expect(scene.contract.sheet == nil, "\(kind)")
        #expect(scene.home.answerCardID == nil, "\(kind)")
        #expect(scene.mainSheet == nil, "\(kind)")
    }
    // Payload absent (notification d'une version antérieure) : Accueil aussi.
    scene.console.select(.memory)
    scene.open(AlertOpening(userInfo: [:]))
    #expect(scene.console.selection == .home)
    #expect(scene.mainSheet == nil)
}

@MainActor
@Test("notifications-mac-lien-profond/AC-6 : fenêtre fermée → la fenêtre revient d'abord, puis la feuille Contrat de A s'ouvre, y compris à la première ardoise")
func clickWithClosedWindowRevealsThenOpensContract() async throws {
    let fixture = StoreFixture()
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)
    let worktree = try makeWorktree("fermee")
    defer { try? FileManager.default.removeItem(atPath: worktree) }
    publishFeatures(fixture, seed: 0xa6, [
        lotFeatureObject(slug: "jalon-specs", state: "waiting", worktree: worktree, waitKind: "specs"),
        lotFeatureObject(slug: "jalon-revue", state: "waiting", waitKind: "review"),
    ])
    let specs = "feature:\(repoKey):jalon-specs"

    // Ardoise publiée : `reveal` précède la mutation (journal d'ordre).
    let ready = RouterScene(fixture)
    defer { ready.stop() }
    #expect(await ready.start())
    ready.click(.milestoneSpecs, specs)
    #expect(ready.log == ["reveal"], "reveal est appelé AVANT l'ouverture de la feuille")
    #expect(ready.contract.sheet?.slug == "jalon-specs")
    #expect(ready.contract.sheet?.moment == .specs)

    // Ardoise encore en chargement : rien n'est appliqué, puis la feuille s'ouvre à
    // la première ardoise ; la plus récente des ouvertures en attente l'emporte,
    // et `reveal` n'est pas rappelé.
    let loading = RouterScene(fixture)
    defer { loading.stop() }
    #expect(loading.kanban.state == .loading)
    loading.click(.milestoneReview, "feature:\(repoKey):jalon-revue")
    loading.click(.milestoneSpecs, specs)
    #expect(loading.log == ["reveal", "reveal"])
    #expect(loading.contract.sheet == nil)
    #expect(loading.kanban.detailShown == false)
    #expect(await loading.start())
    #expect(await awaitMainTrue { loading.contract.sheet != nil })
    #expect(loading.contract.sheet?.slug == "jalon-specs")
    #expect(loading.kanban.detailShown == false, "l'ouverture remplacée n'est pas appliquée")
    #expect(loading.console.selection == .home)
    #expect(loading.log == ["reveal", "reveal"])
}

@MainActor
@Test("notifications-mac-lien-profond/AC-7 : une feuille déjà ouverte (Répondre de B avec texte saisi) n'est jamais remplacée")
func clickWithAttachedSheetOnlyReveals() async throws {
    let fixture = StoreFixture()
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)
    let runA = fixtureId(0xa7)
    let runB = fixtureId(0xb7)
    publishPendingAnswer(fixture, id: runA, label: "depot/question-a")
    publishPendingAnswer(fixture, id: runB, label: "depot/question-b", toolCallId: "call-2")
    let worktree = try makeWorktree("feuille")
    defer { try? FileManager.default.removeItem(atPath: worktree) }
    publishFeatures(fixture, seed: 0xc7, [
        lotFeatureObject(slug: "jalon-specs", state: "waiting", worktree: worktree, waitKind: "specs"),
    ])
    let scene = RouterScene(fixture)
    defer { scene.stop() }
    #expect(await scene.start())

    let idB = "run:\(runB)"
    scene.home.openAnswer(idB, actions: scene.actions)
    scene.actions.replyText = "texte"
    scene.sheetIsAttached = true
    #expect(scene.mainSheet == .answer(cardID: idB))

    scene.click(.pendingAnswer, "run:\(runA)")
    #expect(scene.log == ["reveal"], "seule la fenêtre revient au premier plan")
    let clicks: [(AlertKind, String)] = [
        (.milestoneSpecs, "feature:\(repoKey):jalon-specs"),
        (.failedRun, "run:\(runA)"),
        (.mergedPullRequest, "project:absent:x"),
    ]
    for (kind, id) in clicks { scene.click(kind, id) }
    scene.open(nil)
    #expect(scene.log.count == 5)
    #expect(scene.home.answerCardID == idB)
    #expect(scene.actions.replyText == "texte")
    #expect(scene.mainSheet == .answer(cardID: idB))
    #expect(scene.kanban.detailShown == false)
    #expect(scene.kanban.selectedCardID == nil)
    #expect(scene.contract.sheet == nil)
    #expect(scene.console.selection == .home)

    // Une ouverture en attente de l'ardoise est abandonnée si une feuille s'est
    // attachée entre-temps.
    let loading = RouterScene(fixture)
    defer { loading.stop() }
    loading.click(.milestoneSpecs, "feature:\(repoKey):jalon-specs")
    loading.sheetIsAttached = true
    #expect(await loading.start())
    #expect(loading.contract.sheet == nil)
    #expect(loading.console.selection == .home)
    #expect(loading.log == ["reveal"])
}
