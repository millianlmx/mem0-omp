// Preuves de la DÉCISION du modèle d'alertes (BR-3, S-7) : la fenêtre au premier plan
// consomme sans notifier (AC-6), l'arrière-plan notifie une seule fois (AC-1), et
// l'état d'autorisation est publié (AC-11).

import Foundation
import Testing
@testable import OMPConsole
@testable import ConsoleCore

// MARK: - AC-6 : fenêtre au premier plan ⇒ aucune notification, mais clé enregistrée

@MainActor
@Test("notifications-et-barre-de-menus/AC-6 : la fenêtre au premier plan consomme les évènements sans notifier")
func frontmostWindowSuppressesNotifications() async {
    let fixture = StoreFixture()
    let repoRoot = "/Users/millian/Experiments/mem0-omp"
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)

    let answerId = fixtureId(0x11)
    publishPendingAnswer(fixture, id: answerId, toolCallId: "call-9")
    let lotId = fixtureId(0x12)
    fixture.publish(
        .lots, "\(lotId).json",
        object: lotObject(
            id: lotId, repoRoot: repoRoot,
            features: [
                lotFeatureObject(slug: "jalon", state: "waiting", waitKind: "specs"),
                lotFeatureObject(slug: "echec", state: "failed"),
            ]
        )
    )
    let historyId = fixtureId(0x13)
    fixture.publish(
        .history, "\(historyId).json",
        object: historyObject(
            id: historyId, cwd: "/tmp/alerts/echoue", label: "depot/echoue",
            finalState: "failed", phaseStartedAt: fixtureT0 - 9_000, endedAt: fixtureT0 - 1_000
        )
    )
    let projectKey = fixtureId(0x14)
    fixture.publish(
        .projects, "\(projectKey).json",
        object: projectObject(
            repoKey: projectKey,
            segments: [["name": "S", "features": [projectFeatureObject(slug: "fusion", status: "merged")]]],
            current: 0
        )
    )
    let ledgerPath = fixtureLedgerPath(fixture)

    let deliverer = RecorderAlertDeliverer()
    let model = fixtureAlertsModel(fixture, deliverer: deliverer, frontmost: true, ledgerPath: ledgerPath)
    defer { model.stop() }
    model.start()

    // Le modèle a traité l'instantané quand les cinq clés sont au registre.
    let expected = [
        "answer:\(answerId):call-9",
        "milestone:\(repoKey):jalon:specs",
        "failed-lot:\(repoKey):echec",
        "failed-run:\(historyId)",
        "merged-pr:\(projectKey):fusion",
    ]
    #expect(await awaitMainTrue {
        let ledger = AlertLedger(path: ledgerPath)
        return expected.allSatisfy { ledger.contains($0) }
    })
    // Fenêtre au premier plan : AUCUNE livraison, pour AUCUNE des quatre familles.
    try? await Task.sleep(for: .milliseconds(150))
    #expect(deliverer.messages.isEmpty)
}

// MARK: - AC-1 : arrière-plan ⇒ une notification, jamais deux

@MainActor
@Test("notifications-et-barre-de-menus/AC-1 : une question en vol est notifiée une seule fois, texte nominatif")
func pendingAnswerNotifiesOnce() async {
    let fixture = StoreFixture()
    let id = fixtureId(0x21)
    publishPendingAnswer(fixture, id: id, label: "depot/question", toolCallId: "call-1")

    let deliverer = RecorderAlertDeliverer()
    let model = fixtureAlertsModel(fixture, deliverer: deliverer, frontmost: false)
    defer { model.stop() }
    model.start()

    #expect(await awaitMainTrue { deliverer.messages.count == 1 })
    // Titre = libellé de l'Accueil, corps = nom affiché par l'Accueil (le label du run).
    #expect(deliverer.messages.first?.title == "Question")
    #expect(deliverer.messages.first?.body == "depot/question")
    #expect(deliverer.messages.first?.opening == AlertOpening(kind: .pendingAnswer, cardID: "run:\(id)"))
    #expect(deliverer.keys == ["answer:\(id):call-1"])

    // Un second instantané (un run de plus) ne renotifie pas la question en vol.
    publishBusyRun(fixture, id: fixtureId(0x22))
    #expect(await awaitMainTrue { model.status.counters?.busy == 1 })
    #expect(deliverer.messages.count == 1)
}

// MARK: - AC-11 : le modèle publie l'état d'autorisation

@MainActor
@Test("notifications-et-barre-de-menus/AC-11 : le modèle publie l'autorisation refusée, demandée une seule fois")
func modelPublishesDeniedAuthorization() async {
    let fixture = StoreFixture()
    let deliverer = RecorderAlertDeliverer(authorization: .denied)
    let model = fixtureAlertsModel(fixture, deliverer: deliverer, frontmost: true)
    defer { model.stop() }
    model.start()

    #expect(await awaitMainTrue { model.authorization == .denied })
    #expect(deliverer.authorizationRequests == 1)
}

@MainActor
@Test("notifications-et-barre-de-menus/AC-11 : hors bundle, l'autorisation est `unavailable` et aucune livraison n'est tentée")
func modelReportsUnavailableDeliverer() async {
    let fixture = StoreFixture()
    let id = fixtureId(0x31)
    publishPendingAnswer(fixture, id: id)

    let model = AlertsModel(
        hub: StoreHub(stateDir: fixture.root, nowMs: { fixtureT0 }),
        ledgerPath: fixtureLedgerPath(fixture),
        deliverer: UnavailableAlertDeliverer(),
        isWindowFrontmost: { false },
        nowMs: { fixtureT0 }
    )
    defer { model.stop() }
    model.start()

    #expect(await awaitMainTrue { model.authorization == .unavailable })
    // Le livreur indisponible ne fait rien : aucune exception, aucun appel système.
    #expect(await awaitMainTrue { model.status.counters != nil })
}
