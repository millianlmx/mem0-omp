// Preuves de S-5 (boîtes de run) et S-6 (relais audit) : AC-5 et AC-6, plus les
// règles propres au canal de livraison (rejet NON destructif, fichier non `.json`
// ignoré sans comptage, boîte absente).

import Foundation
import Testing
@testable import OMPConsole

/// Le nom d'une livraison : `<epoch ms sur 16 chiffres>-<4 hex>.json` (store.ts:372-380).
private func deliveryName(_ stamp: Double, salt: String = "a1b2", suffix: Int? = nil) -> String {
    let base = String(Int(stamp)).padded(to: 16, with: "0") + "-" + salt
    return (suffix.map { "\(base)-\($0)" } ?? base) + ".json"
}

@Test("client-magasin-etat/AC-5 : les livraisons d'une boîte sont rendues dans l'ordre chronologique")
func inboxDeliveriesInOrder() throws {
    let fixture = StoreFixture()
    let runId = fixtureId(0x51)
    let box = fixture.createBox("\(runId)-1")
    let callId = "call-42"

    // Deux livraisons publiées ATOMIQUEMENT, textes d'abord puis la réponse.
    fixture.publish(box: box, file: deliveryName(1_790_599_260_819), object: textDelivery("relance le run", sentAt: 1_790_599_260_819))
    fixture.publish(
        box: box,
        file: deliveryName(1_790_599_261_500, salt: "c3d4"),
        object: askDelivery(toolCallId: callId, selected: "main", sentAt: 1_790_599_261_500)
    )
    // La QUESTION n'est pas dans la livraison : elle vit dans l'entrée du run.
    fixture.publish(
        .running,
        "\(runId).json",
        object: runningObject(
            id: runId,
            cwd: "/tmp/worktree-ac5",
            phaseStartedAt: fixtureT0 - 5_000,
            updatedAt: fixtureT0 - 1_000,
            ownerPid: Double(getpid()),
            inbox: box,
            pendingAsk: [
                "toolCallId": callId,
                "id": "ask-42",
                "question": "Sur quelle branche ?",
                "options": [["label": "main"], ["label": "feat/x"]],
            ]
        )
    )

    let snapshot = StoreReader(stateDir: fixture.root, clock: fixtureClock).readAll()
    #expect(snapshot.inbox.availability == .present)
    #expect(snapshot.inbox.discarded == 0)
    let readBox = try #require(snapshot.inbox.boxes.first)
    #expect(readBox.name == "\(runId)-1")
    #expect(readBox.path == box)
    #expect(readBox.deliveries.count == 2)
    #expect(readBox.deliveries.map { ($0.file as NSString).lastPathComponent }
        == [deliveryName(1_790_599_260_819), deliveryName(1_790_599_261_500, salt: "c3d4")])
    #expect(readBox.deliveries.first?.payload == .text("relance le run"))

    // Appariement question / réponse par `toolCallId` : le couple d'AC-5 est
    // vérifiable sans inventer de donnée.
    let ask = try #require(readBox.deliveries.last?.payload)
    guard case .askAnswer(let toolCallId, let answer) = ask else {
        Issue.record("la seconde livraison devrait être une réponse `ask`")
        return
    }
    #expect(toolCallId == callId)
    #expect(answer == .selected("main"))
    let entry = try #require(snapshot.running.entries.first)
    #expect(entry.inbox == box)
    #expect(entry.pendingAsk?.toolCallId == toolCallId)
    #expect(entry.pendingAsk?.question == "Sur quelle branche ?")
    #expect(entry.pendingAsk?.options.map(\.label) == ["main", "feat/x"])
}

@Test("client-magasin-etat/AC-5 : une livraison illisible est CONSERVÉE, jamais écartée ni devinée")
func inboxKeepsUnreadableDeliveries() {
    let fixture = StoreFixture()
    let runId = fixtureId(0x52)
    let box = fixture.createBox("\(runId)-1")
    fixture.publish(box: box, file: deliveryName(1_790_599_262_000), object: textDelivery("bonjour", sentAt: 1))
    // Illisible : JSON tronqué.
    fixture.put(box: box, file: deliveryName(1_790_599_263_000, salt: "aaaa"), text: "{\"version\":1,")
    // Forme inconnue : les DEUX réponses à la fois.
    fixture.publish(
        box: box,
        file: deliveryName(1_790_599_264_000, salt: "bbbb"),
        object: askDelivery(toolCallId: "call-1", selected: "oui", custom: "non", sentAt: 1)
    )
    // Version 2 : forme inconnue.
    var future = textDelivery("futur", sentAt: 1)
    future["version"] = 2
    fixture.publish(box: box, file: deliveryName(1_790_599_265_000, salt: "cccc"), object: future)
    // Fichiers NON `.json` (dont le temporaire d'une écriture en cours) : ignorés.
    fixture.put(box: box, file: "\(deliveryName(1_790_599_266_000)).json.tmp-\(getpid())", text: "{}")
    fixture.put(box: box, file: "notes.txt", text: "à lire")

    let envelope = StoreReader(stateDir: fixture.root, clock: fixtureClock).readInbox()
    // Quatre livraisons rendues (nom de fichier compris), trois `payload == nil`.
    #expect(envelope.boxes.count == 1)
    #expect(envelope.boxes.first?.deliveries.count == 4)
    #expect(envelope.boxes.first?.deliveries.compactMap(\.payload).count == 1)
    // Aucune entrée n'est écartée dans une boîte : le champ n'existe que pour
    // l'uniformité de l'enveloppe.
    #expect(envelope.discarded == 0)
}

@Test("client-magasin-etat/AC-5 : boîte absente et boîte vide")
func inboxAvailabilityAndEmptyBox() {
    // `inbox/` absente : `.absent`, zéro boîte.
    let absent = StoreFixture(stores: [.running, .history])
    #expect(StoreReader(stateDir: absent.root, clock: fixtureClock).readInbox().availability == .absent)

    // `inbox/` présente, avec une boîte vide et un nom hors format ignoré.
    let fixture = StoreFixture()
    let runId = fixtureId(0x53)
    fixture.createBox("\(runId)-1")
    fixture.createBox("boite-bidon")
    fixture.put(.inbox, "5fd065abf520fda4-1.json", text: "{}")
    let envelope = StoreReader(stateDir: fixture.root, clock: fixtureClock).readInbox()
    #expect(envelope.availability == .present)
    #expect(envelope.boxes.map(\.name) == ["\(runId)-1"])
    #expect(envelope.boxes.first?.deliveries.isEmpty == true)
    #expect(envelope.discarded == 0)
}

@Test("client-magasin-etat/AC-6 : le relais audit est rendu avec sa session, son pid et son battement")
func auditRelayIsTyped() throws {
    let fixture = StoreFixture()
    let id = fixtureId(0x61)
    let sessionFile = "/Users/millian/.omp/agent/sessions/-Experiments-mem0-omp/session.jsonl"
    fixture.publish(
        .audit,
        "\(id).json",
        object: auditObject(sessionFile: sessionFile, pid: Double(getpid()), heartbeatAt: fixtureT0 - 1_000)
    )
    let envelope = StoreReader(stateDir: fixture.root, clock: fixtureClock).readAudit()
    let relay = try #require(envelope.relays.first)
    #expect(relay.id == id)
    #expect(relay.sessionFile == sessionFile)
    #expect(relay.pid == Int(getpid()))
    #expect(relay.heartbeatAt == fixtureT0 - 1_000)
    #expect(relay.isStale == false)
    #expect(envelope.discarded == 0)
}

@Test("client-magasin-etat/AC-6 : un relais hors schéma est écarté, un nom de fichier non conforme ne l'est pas")
func auditRelaySchema() throws {
    let fixture = StoreFixture()
    // pid 0 : refusé (le dépôt exige un entier strictement positif).
    var zeroPid = auditObject(heartbeatAt: fixtureT0)
    zeroPid["pid"] = 0
    fixture.publish(.audit, "\(fixtureId(0x62)).json", object: zeroPid)
    // sessionFile vide : refusé.
    var emptySession = auditObject(heartbeatAt: fixtureT0)
    emptySession["sessionFile"] = ""
    fixture.publish(.audit, "\(fixtureId(0x63)).json", object: emptySession)
    // version 2 : refusé.
    var future = auditObject(heartbeatAt: fixtureT0)
    future["version"] = 2
    fixture.publish(.audit, "\(fixtureId(0x64)).json", object: future)

    // Un `sessionFile` qui ne correspond PAS au nom du fichier n'est PAS un rejet :
    // le lecteur du dépôt ne le vérifie pas sur un balayage de répertoire (S-6).
    let id = fixtureId(0x65)
    fixture.publish(
        .audit,
        "\(id).json",
        object: auditObject(sessionFile: "/ailleurs/session.jsonl", heartbeatAt: fixtureT0 - 500)
    )

    let envelope = StoreReader(stateDir: fixture.root, clock: fixtureClock).readAudit()
    #expect(envelope.relays.map(\.id) == [id])
    #expect(envelope.relays.first?.sessionFile == "/ailleurs/session.jsonl")
    #expect(envelope.discarded == 3)
}
