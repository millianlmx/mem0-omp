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
    #expect(events.first?.title == "depot/ma-question attend une réponse")
    #expect(events.first?.body == "Une question attend votre réponse.")
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
    #expect(alertEvents(fixture).first?.title == " attend une réponse")
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
    #expect(events[0].title == "jalon-specs attend une validation")
    #expect(events[0].body == "Jalon specs : validez le contrat pour continuer.")
    #expect(events[1].kind == .milestoneReview)
    #expect(events[1].body == "Jalon revue : validez la livraison pour continuer.")
}

@Test("notifications-et-barre-de-menus/AC-2 : `waitKind` nul ou `answer` n'émet aucun jalon ; le name non blanc prime")
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

    // Un `name` non blanc prime sur le slug dans le TITRE.
    var custom = lotFeatureObject(slug: "avec-nom", state: "waiting", waitKind: "specs")
    custom["name"] = "Ma Feature"
    fixture.publish(.lots, "\(fixtureId(0xb3)).json", object: lotObject(id: fixtureId(0xb3), features: [custom]))
    let events = alertEvents(fixture)
    #expect(events.count == 1)
    #expect(events.first?.title == "Ma Feature attend une validation")
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
    #expect(events[0].title == "feature-echouee a échoué")
    #expect(events[0].body == "La feature feature-echouee a échoué.")
    #expect(events[1].kind == .failedRun)
    #expect(events[1].title == "depot/run-clos a échoué")
    #expect(events[1].body == "Le run a échoué.")
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
    #expect(events.first?.title == "PR fusionnée : fusionnee")
    #expect(events.first?.body == "La PR de fusionnee est fusionnée.")
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
