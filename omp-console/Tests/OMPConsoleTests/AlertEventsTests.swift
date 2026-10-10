// Preuves de la DÉRIVATION des évènements (BR-1, S-3 … S-6) : les six familles, leurs
// clés stables, leurs textes et l'ordre de livraison.
//
// Aucune vue, aucun modèle, aucun appareil : on lit un magasin réel et on confronte
// les évènements rendus. La décision (fenêtre au premier plan, registre) est prouvée
// dans `AlertsModelTests.swift` et `AlertLedgerTests.swift`.

import Foundation
import Testing
@testable import OMPConsole
@testable import ConsoleCore

// MARK: - AC-1 : « attend une réponse »

@Test("notifications-et-barre-de-menus/AC-1 : une question en vol ⇒ un évènement qui nomme le run, clé stable")
func pendingAnswerNamesTheRun() {
    let fixture = StoreFixture()
    let id = fixtureId(0xa1)
    publishPendingAnswer(fixture, id: id, label: "depot/ma-question")

    let events = alertEvents(fixture)
    #expect(events.count == 1)
    #expect(events.first?.kind == .pendingAnswer)
    #expect(events.first?.key == "answer:\(id):call-1")
    #expect(events.first?.title == "Question")
    #expect(events.first?.body == "depot/ma-question")
    #expect(events.first?.cardID == "run:\(id)")
}

@Test("notifications-et-barre-de-menus/AC-1 : un même toolCallId ne produit qu'un évènement, un nouveau en produit un")
func pendingAnswerKeyIsStable() {
    let fixture = StoreFixture()
    let id = fixtureId(0xa2)
    publishPendingAnswer(fixture, id: id, toolCallId: "call-1")
    // Deux lectures du même magasin : la clé ne bouge pas (aucune seconde émission).
    #expect(alertEvents(fixture).map(\.key) == ["answer:\(id):call-1"])
    #expect(alertEvents(fixture).map(\.key) == ["answer:\(id):call-1"])

    // Un nouveau `toolCallId` est un évènement NEUF (une nouvelle clé).
    publishPendingAnswer(fixture, id: id, toolCallId: "call-2")
    #expect(alertEvents(fixture).map(\.key) == ["answer:\(id):call-2"])
}

@Test("notifications-et-barre-de-menus/AC-1 : ni entrée périmée, ni `waiting` sans question, ni label vide inventé")
func pendingAnswerEdgeCases() {
    let fixture = StoreFixture()
    // (a) Propriétaire mort ⇒ la question n'existe plus : aucun évènement.
    let dead = fixtureId(0xa3)
    fixture.publish(
        .running, "\(dead).json",
        object: runningObject(
            id: dead, cwd: "/tmp/alerts/dead", label: "depot/mort",
            state: "waiting", phaseStartedAt: fixtureT0 - 5_000, updatedAt: fixtureT0 - 5_000,
            ownerPid: Double(deadPid()), pendingAsk: pendingAskObject()
        )
    )
    #expect(alertEvents(fixture).isEmpty)

    // (b) `waiting` sans `pendingAsk` : ce n'est pas une question en vol.
    let idle = fixtureId(0xa4)
    fixture.publish(
        .running, "\(idle).json",
        object: runningObject(
            id: idle, cwd: "/tmp/alerts/idle", label: "depot/inactif",
            state: "waiting", phaseStartedAt: fixtureT0 - 400, updatedAt: fixtureT0 - 100,
            ownerPid: Double(getpid())
        )
    )
    #expect(alertEvents(fixture).isEmpty)
}

@Test("notifications-et-barre-de-menus/AC-1 : un label vide est produit tel quel, jamais inventé")
func pendingAnswerEmptyLabel() {
    let fixture = StoreFixture()
    let id = fixtureId(0xa5)
    publishPendingAnswer(fixture, id: id, label: "")
    #expect(alertEvents(fixture).first?.title == "Question")
    #expect(alertEvents(fixture).first?.body == "")
}

// MARK: - AC-2 : « attend une validation »

@Test("notifications-et-barre-de-menus/AC-2 : un jalon specs et un jalon revue sont deux évènements distincts")
func milestoneEvents() {
    let fixture = StoreFixture()
    let key = fixtureId(0xb1)
    fixture.publish(
        .lots, "\(key).json",
        object: lotObject(
            id: key,
            repoRoot: "/Users/millian/Experiments/mem0-omp",
            features: [
                lotFeatureObject(slug: "jalon-specs", state: "waiting", waitKind: "specs"),
                lotFeatureObject(slug: "jalon-revue", state: "waiting", waitKind: "review"),
            ]
        )
    )
    let repoKey = KanbanRepoKey.key(forRoot: "/Users/millian/Experiments/mem0-omp")
    let events = alertEvents(fixture)
    #expect(events.map(\.key) == [
        "milestone:\(repoKey):jalon-specs:specs",
        "milestone:\(repoKey):jalon-revue:review",
    ])
    #expect(events[0].title == "Spécifications à valider")
    #expect(events[0].body == "jalon-specs")
    #expect(events[0].cardID == "feature:\(repoKey):jalon-specs")
    #expect(events[1].kind == .milestoneReview)
    #expect(events[1].title == "Revue à accepter")
    #expect(events[1].body == "jalon-revue")
    #expect(events[1].cardID == "feature:\(repoKey):jalon-revue")
}

@Test("notifications-et-barre-de-menus/AC-2 : `waitKind` nul ou `answer` n'émet aucun jalon ; le corps est le slug affiché, jamais le name")
func milestoneEdgeCases() {
    let fixture = StoreFixture()
    let key = fixtureId(0xb2)
    fixture.publish(
        .lots, "\(key).json",
        object: lotObject(
            id: key,
            features: [
                // `waitKind` nul : aucune validation nommable.
                lotFeatureObject(slug: "sans-jalon", state: "waiting", waitKind: nil),
                // `answer` : porté par la famille « attend une réponse », pas ici.
                lotFeatureObject(slug: "attend-reponse", state: "waiting", waitKind: "answer"),
            ]
        )
    )
    #expect(alertEvents(fixture).isEmpty)

    // Le corps est le nom que l'Accueil affiche (`KanbanCard.title` = slug), jamais
    // le `name` de la feature.
    var custom = lotFeatureObject(slug: "avec-nom", state: "waiting", waitKind: "specs")
    custom["name"] = "Ma Feature"
    fixture.publish(.lots, "\(fixtureId(0xb3)).json", object: lotObject(id: fixtureId(0xb3), features: [custom]))
    let events = alertEvents(fixture)
    #expect(events.count == 1)
    #expect(events.first?.title == "Spécifications à valider")
    #expect(events.first?.body == "avec-nom")
}

@Test("notifications-et-barre-de-menus/AC-2 : deux lots du même dépôt, même slug ⇒ une seule clé")
func milestoneDeduplicatesByKey() {
    let fixture = StoreFixture()
    let feature = lotFeatureObject(slug: "meme-slug", state: "waiting", waitKind: "specs")
    fixture.publish(.lots, "\(fixtureId(0xb4)).json", object: lotObject(id: fixtureId(0xb4), features: [feature]))
    fixture.publish(.lots, "\(fixtureId(0xb5)).json", object: lotObject(id: fixtureId(0xb5), features: [feature]))
    #expect(alertEvents(fixture).count == 1)
}

// MARK: - AC-3 : « a échoué »

@Test("notifications-et-barre-de-menus/AC-3 : une feature de lot échouée et un run clos échoué, deux familles de clés")
func failedEvents() {
    let fixture = StoreFixture()
    let key = fixtureId(0xc1)
    fixture.publish(
        .lots, "\(key).json",
        object: lotObject(
            id: key,
            repoRoot: "/Users/millian/Experiments/mem0-omp",
            features: [lotFeatureObject(slug: "feature-echouee", state: "failed")]
        )
    )
    let historyId = fixtureId(0xc2)
    fixture.publish(
        .history, "\(historyId).json",
        object: historyObject(
            id: historyId, cwd: "/tmp/alerts/clos", label: "depot/run-clos",
            finalState: "failed", phaseStartedAt: fixtureT0 - 9_000, endedAt: fixtureT0 - 1_000
        )
    )
    let repoKey = KanbanRepoKey.key(forRoot: "/Users/millian/Experiments/mem0-omp")
    let events = alertEvents(fixture)
    #expect(events.map(\.key) == ["failed-lot:\(repoKey):feature-echouee", "failed-run:\(historyId)"])
    #expect(events[0].kind == .failedLot)
    #expect(events[0].title == "Échec")
    #expect(events[0].body == "feature-echouee")
    #expect(events[0].cardID == "feature:\(repoKey):feature-echouee")
    #expect(events[1].kind == .failedRun)
    #expect(events[1].title == "Échec")
    #expect(events[1].body == "depot/run-clos")
    #expect(events[1].cardID == "history:\(historyId)")
}

@Test("notifications-et-barre-de-menus/AC-3 : un run clos en `done` et un run vivant périmé n'émettent rien")
func failedEdgeCases() {
    let fixture = StoreFixture()
    let done = fixtureId(0xc3)
    fixture.publish(
        .history, "\(done).json",
        object: historyObject(
            id: done, cwd: "/tmp/alerts/fini", label: "depot/fini",
            finalState: "done", phaseStartedAt: fixtureT0 - 9_000, endedAt: fixtureT0 - 1_000
        )
    )
    // Une entrée `running` avec un propriétaire mort : un état de départ, pas une
    // transition — la fenêtre la marque `mort`, elle ne la notifie pas.
    let stale = fixtureId(0xc4)
    fixture.publish(
        .running, "\(stale).json",
        object: runningObject(
            id: stale, cwd: "/tmp/alerts/perime", label: "depot/perime",
            state: "running", phaseStartedAt: fixtureT0 - 5_000, updatedAt: fixtureT0 - 5_000,
            ownerPid: Double(deadPid())
        )
    )
    #expect(alertEvents(fixture).isEmpty)
}

// MARK: - AC-4 : « PR fusionnée »

@Test("notifications-et-barre-de-menus/AC-4 : une PR fusionnée n'émet qu'une fois, une PR non fusionnée jamais")
func mergedPullRequestEvents() {
    let fixture = StoreFixture()
    let key = fixtureId(0xd1)
    fixture.publish(
        .projects, "\(key).json",
        object: projectObject(
            repoKey: key,
            segments: [[
                "name": "Segment",
                "features": [
                    projectFeatureObject(slug: "fusionnee", status: "merged"),
                    projectFeatureObject(slug: "ouverte", status: "pr", prUrl: "https://example/pr/1"),
                ],
            ]],
            current: 0
        )
    )
    let events = alertEvents(fixture)
    #expect(events.count == 1)
    #expect(events.first?.key == "merged-pr:\(key):fusionnee")
    #expect(events.first?.kind == .mergedPullRequest)
    #expect(events.first?.title == "PR fusionnée")
    #expect(events.first?.body == "fusionnee")
    #expect(events.first?.cardID == "project:\(key):fusionnee")
    // Une seconde lecture ne crée pas une seconde clé.
    #expect(alertEvents(fixture).map(\.key) == ["merged-pr:\(key):fusionnee"])
}

@Test("notifications-et-barre-de-menus/AC-4 : une feature de LOT `done` avec PR ouverte n'est pas une fusion")
func mergedPullRequestIgnoresLotPR() {
    let fixture = StoreFixture()
    let key = fixtureId(0xd2)
    fixture.publish(
        .lots, "\(key).json",
        object: lotObject(
            id: key,
            features: [lotFeatureObject(slug: "pr-ouverte", state: "done", prUrl: "https://example/pr/2")]
        )
    )
    #expect(alertEvents(fixture).isEmpty)
}

// MARK: - Ordre de livraison

@Test("notifications-et-barre-de-menus/AC-4 : l'ordre de livraison est déterministe (kind puis clé)")
func deliveryOrderIsDeterministic() {
    let fixture = StoreFixture()
    let repoRoot = "/Users/millian/Experiments/mem0-omp"
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)
    let lotId = fixtureId(0xe1)
    fixture.publish(
        .lots, "\(lotId).json",
        object: lotObject(
            id: lotId, repoRoot: repoRoot,
            features: [
                lotFeatureObject(slug: "echec", state: "failed"),
                lotFeatureObject(slug: "revue", state: "waiting", waitKind: "review"),
                lotFeatureObject(slug: "specs", state: "waiting", waitKind: "specs"),
            ]
        )
    )
    let runId = fixtureId(0xe2)
    publishPendingAnswer(fixture, id: runId)
    let historyId = fixtureId(0xe3)
    fixture.publish(
        .history, "\(historyId).json",
        object: historyObject(
            id: historyId, cwd: "/tmp/alerts/echoue", label: "depot/echoue",
            finalState: "failed", phaseStartedAt: fixtureT0 - 9_000, endedAt: fixtureT0 - 1_000
        )
    )
    let projectKey = fixtureId(0xe4)
    fixture.publish(
        .projects, "\(projectKey).json",
        object: projectObject(
            repoKey: projectKey,
            segments: [["name": "S", "features": [projectFeatureObject(slug: "fusion", status: "merged")]]],
            current: 0
        )
    )

    #expect(alertEvents(fixture).map(\.kind) == [
        .pendingAnswer, .milestoneSpecs, .milestoneReview, .failedLot, .failedRun, .mergedPullRequest,
    ])
    // Le garde-fou : les clés des jalon specs/revue du lot sont bien celles attendues.
    #expect(alertEvents(fixture).map(\.key).contains("milestone:\(repoKey):specs:specs"))
}

// MARK: - notifications-mac-lien-profond : textes alignés sur l'Accueil, carte portée

/// Le libellé d'état que l'Accueil affiche pour une carte : la nature d'une attente
/// (`HomeText.natureText`) ou l'état d'une livraison (`ConsoleStatus.of(card:)`).
/// `nil` si l'Accueil ne montre la carte ni en attente ni en livraison.
private func homeLabel(of cardID: String, in board: KanbanBoard) -> String? {
    let dashboard = HomePresentation.dashboard(board)
    if let attention = dashboard.attention.first(where: { $0.card.id == cardID }) {
        return HomeText.natureText(attention.nature)
    }
    if let delivered = dashboard.delivered.first(where: { $0.id == cardID }) {
        return ConsoleStatus.of(card: delivered).text
    }
    return nil
}

@Test("notifications-mac-lien-profond/AC-8 : titre = libellé d'état de l'Accueil (« Échec » pour les échecs), corps = nom affiché, carte portée")
func homeAlignedTextsAndCardIDs() throws {
    let fixture = StoreFixture()
    let repoRoot = "/Users/millian/Experiments/mem0-omp"
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)

    // Une question d'un run seul, et une question d'un run ABSORBÉ par une feature
    // de lot (cwd du run == worktree de la feature).
    let soloRun = fixtureId(0xf1)
    publishPendingAnswer(fixture, id: soloRun, label: "depot/question-seule")
    let absorbedRun = fixtureId(0xf2)
    publishPendingAnswer(fixture, id: absorbedRun, label: "depot/question-absorbee", toolCallId: "call-9")

    // Jalon specs dont le `name` diffère du slug, jalon revue, feature échouée,
    // feature absorbant le run, feature livrée appariée à une PR fusionnée.
    var specs = lotFeatureObject(slug: "jalon-specs", state: "waiting", waitKind: "specs")
    specs["name"] = "Un nom qui n'est pas le slug"
    let lotId = fixtureId(0xf3)
    fixture.publish(
        .lots, "\(lotId).json",
        object: lotObject(
            id: lotId, repoRoot: repoRoot,
            features: [
                specs,
                lotFeatureObject(slug: "jalon-revue", state: "waiting", waitKind: "review"),
                lotFeatureObject(slug: "feature-echouee", state: "failed"),
                lotFeatureObject(slug: "feature-question", state: "running", worktree: "/tmp/alerts/\(absorbedRun)"),
                lotFeatureObject(slug: "livree-appariee", state: "done"),
            ]
        )
    )
    // PR fusionnée appariée à la feature de lot (même dépôt, même slug), et PR
    // fusionnée d'un projet seul.
    fixture.publish(
        .projects, "\(repoKey).json",
        object: projectObject(
            repoKey: repoKey, repoRoot: repoRoot,
            segments: [["name": "S", "features": [projectFeatureObject(slug: "livree-appariee", status: "merged")]]],
            current: 0
        )
    )
    let soloProject = fixtureId(0xf4)
    fixture.publish(
        .projects, "\(soloProject).json",
        object: projectObject(
            repoKey: soloProject, repoRoot: "/tmp/alerts/autre-depot",
            segments: [["name": "S", "features": [projectFeatureObject(slug: "livree-seule", status: "merged")]]],
            current: 0
        )
    )
    // Un run clos en échec.
    let historyId = fixtureId(0xf5)
    fixture.publish(
        .history, "\(historyId).json",
        object: historyObject(
            id: historyId, cwd: "/tmp/alerts/clos-echec", label: "depot/run-echoue",
            finalState: "failed", phaseStartedAt: fixtureT0 - 9_000, endedAt: fixtureT0 - 1_000
        )
    )

    let board = kanbanBoard(fixture)
    let events = AlertDerivation.events(from: alertsSnapshot(fixture), board: board)
    func event(_ key: String) throws -> AlertEvent {
        try #require(events.first { $0.key == key }, "évènement \(key) absent")
    }
    func card(_ id: String) throws -> KanbanCard {
        try #require(board.cards.first { $0.id == id }, "carte \(id) absente de l'ardoise")
    }

    // (a) Jalon specs : « Spécifications à valider », corps = nom affiché par l'Accueil (le slug).
    let specsEvent = try event("milestone:\(repoKey):jalon-specs:specs")
    #expect(specsEvent.kind == .milestoneSpecs)
    #expect(specsEvent.cardID == "feature:\(repoKey):jalon-specs")
    #expect(specsEvent.title == "Spécifications à valider")
    #expect(specsEvent.body == "jalon-specs")
    #expect(specsEvent.body == (try card(try #require(specsEvent.cardID))).title)

    // Les six familles, avec la carte attendue pour chacune.
    let expected: [(key: String, kind: AlertKind, cardID: String)] = [
        ("answer:\(soloRun):call-1", .pendingAnswer, "run:\(soloRun)"),
        ("answer:\(absorbedRun):call-9", .pendingAnswer, "feature:\(repoKey):feature-question"),
        ("milestone:\(repoKey):jalon-specs:specs", .milestoneSpecs, "feature:\(repoKey):jalon-specs"),
        ("milestone:\(repoKey):jalon-revue:review", .milestoneReview, "feature:\(repoKey):jalon-revue"),
        ("failed-lot:\(repoKey):feature-echouee", .failedLot, "feature:\(repoKey):feature-echouee"),
        ("failed-run:\(historyId)", .failedRun, "history:\(historyId)"),
        ("merged-pr:\(repoKey):livree-appariee", .mergedPullRequest, "feature:\(repoKey):livree-appariee"),
        ("merged-pr:\(soloProject):livree-seule", .mergedPullRequest, "project:\(soloProject):livree-seule"),
    ]
    #expect(Set(events.map(\.key)) == Set(expected.map(\.key)))
    for row in expected {
        let alert = try event(row.key)
        let target = try card(row.cardID)
        #expect(alert.kind == row.kind, "\(row.key)")
        #expect(alert.cardID == row.cardID, "\(row.key)")
        // (d) Corps = nom affiché par l'Accueil, run absorbé compris (slug de la feature).
        #expect(alert.body == target.title, "\(row.key)")
        switch row.kind {
        case .failedLot, .failedRun:
            // (c) Échec de lot ou de run : toujours « Échec ».
            #expect(alert.title == "Échec", "\(row.key)")
        case .pendingAnswer, .milestoneSpecs, .milestoneReview, .mergedPullRequest:
            // (b) Titre == libellé d'état de l'Accueil pour la même carte.
            let label = try #require(homeLabel(of: row.cardID, in: board), "\(row.cardID) absente de l'Accueil")
            #expect(alert.title == label, "\(row.key)")
        case .stackOwnershipLost:
            Issue.record("\(row.key) : une perte d'ownership ne vient jamais du magasin")
        }
    }
    #expect(try event("answer:\(absorbedRun):call-9").body == "feature-question")
}

@Test("notifications-mac-lien-profond/AC-8 : sans ardoise, le titre reste celui de la famille et le corps prend le repli")
func homeAlignedTextsWithoutBoard() {
    let fixture = StoreFixture()
    let repoRoot = "/Users/millian/Experiments/mem0-omp"
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)
    let runId = fixtureId(0xf6)
    publishPendingAnswer(fixture, id: runId, label: "depot/sans-ardoise")
    var specs = lotFeatureObject(slug: "repli-specs", state: "waiting", waitKind: "specs")
    specs["name"] = "Nom ignoré"
    fixture.publish(.lots, "\(fixtureId(0xf7)).json", object: lotObject(id: fixtureId(0xf7), repoRoot: repoRoot, features: [specs]))

    let events = AlertDerivation.events(from: alertsSnapshot(fixture), board: nil)
    #expect(events.map(\.title) == ["Question", "Spécifications à valider"])
    #expect(events.map(\.body) == ["depot/sans-ardoise", "repli-specs"])
    #expect(events.map(\.cardID) == ["run:\(runId)", "feature:\(repoKey):repli-specs"])
}

@Test("notifications-mac-lien-profond/AC-9 : le payload porte la famille et la carte ; un payload incomplet ou illisible se décode en nil")
func alertOpeningPayloadRoundTrip() {
    let kinds: [AlertKind] = [.pendingAnswer, .milestoneSpecs, .milestoneReview, .failedLot, .failedRun, .mergedPullRequest]
    for kind in kinds {
        let opening = AlertOpening(kind: kind, cardID: "feature:abc:\(kind.rawValue)")
        let payload: [AnyHashable: Any] = opening.userInfo
        #expect(AlertOpening(userInfo: payload) == opening)
    }
    #expect(AlertOpening(kind: .failedRun, cardID: "history:x").userInfo == ["kind": "failedRun", "cardID": "history:x"])

    // Notification d'une version antérieure, clé manquante, type faux, famille
    // inconnue, carte vide : aucun lien profond.
    #expect(AlertOpening(userInfo: [:]) == nil)
    #expect(AlertOpening(userInfo: ["kind": "pendingAnswer"]) == nil)
    #expect(AlertOpening(userInfo: ["cardID": "run:a"]) == nil)
    #expect(AlertOpening(userInfo: ["kind": 3, "cardID": "run:a"]) == nil)
    #expect(AlertOpening(userInfo: ["kind": "pendingAnswer", "cardID": 7]) == nil)
    #expect(AlertOpening(userInfo: ["kind": "inconnue", "cardID": "run:a"]) == nil)
    #expect(AlertOpening(userInfo: ["kind": "pendingAnswer", "cardID": ""]) == nil)
}

// MARK: - AC-5 : le rang de `stackOwnershipLost`

@Test("bug-embedded-podman-machine/AC-5 : `stackOwnershipLost` a le rang 6, juste après `mergedPullRequest`")
func stackOwnershipLostIsRankedLast() {
    #expect(AlertKind.mergedPullRequest.rank == 5)
    #expect(AlertKind.stackOwnershipLost.rank == 6)
    // Le rang suit l'ORDRE DE DÉCLARATION : aucun trou, aucun doublon.
    #expect([
        AlertKind.pendingAnswer, .milestoneSpecs, .milestoneReview,
        .failedLot, .failedRun, .mergedPullRequest, .stackOwnershipLost,
    ].map(\.rank) == [0, 1, 2, 3, 4, 5, 6])
}
