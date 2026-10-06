// Socle partagé du contrat (BR-1) : les modèles du magasin sont ENCODABLES — un
// instantané complet fait un aller-retour JSON sans perte, et les constantes de
// service / le type d'erreur partagé portent les valeurs figées du contrat.
//
// L'instantané n'est pas construit à la main : il est LU par `StoreReader` d'un
// `StoreFixture` réellement écrit sur disque, puis encodé. Ce qui est prouvé est
// donc l'encodage des modèles tels que la lecture les produit.

import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

@Test("contrat partagé : l'instantané complet du magasin fait un aller-retour JSON sans perte")
func fullyPopulatedSnapshotRoundTripsThroughJSON() throws {
    let fixture = StoreFixture()
    let runId = fixtureId(0x71)
    let historyId = fixtureId(0x72)
    let malformedId = fixtureId(0x73)
    let repoKey = "d0ef9a50f7dc3a37"
    let box = fixture.createBox("\(runId)-1")

    fixture.publish(
        .running,
        "\(runId).json",
        object: runningObject(
            id: runId,
            cwd: "/tmp/worktree-aller-retour",
            phaseStartedAt: fixtureT0 - 5_000,
            updatedAt: fixtureT0 - 1_000,
            ownerPid: Double(getpid()),
            sessionFile: "/tmp/sessions/run.jsonl",
            sessionId: "session-run",
            inbox: box,
            pendingAsk: [
                "toolCallId": "call-1",
                "id": "ask-1",
                "question": "Sur quelle branche ?",
                "options": [
                    ["label": "main", "description": "la branche principale"],
                    ["label": "feat/x"],
                ],
            ]
        )
    )
    fixture.publish(
        .history,
        "\(historyId).json",
        object: historyObject(
            id: historyId,
            cwd: "/tmp/worktree-aller-retour",
            phaseStartedAt: fixtureT0 - 9_000,
            endedAt: fixtureT0 - 2_000,
            sessionFile: "/tmp/sessions/history.jsonl",
            sessionId: "session-history"
        )
    )
    fixture.publish(
        .lots,
        "\(repoKey).json",
        object: lotObject(
            id: repoKey,
            features: [
                lotFeatureObject(
                    slug: "api-distante-du-console",
                    waitKind: "review",
                    model: "opencode-go/deepseek-v4.1-flash",
                    prUrl: "https://example.test/pr/1"
                )
            ]
        )
    )
    fixture.publish(.projects, "\(repoKey).json", object: projectObject(repoKey: repoKey))
    fixture.publish(
        box: box,
        file: "1790599260819-a1b2.json",
        object: textDelivery("relance le run", sentAt: 1_790_599_260_819)
    )
    fixture.publish(
        box: box,
        file: "1790599261500-c3d4.json",
        object: askDelivery(toolCallId: "call-1", selected: "main", sentAt: 1_790_599_261_500)
    )
    fixture.publish(
        .audit,
        "\(fixtureId(0xa9)).json",
        object: auditObject(heartbeatAt: fixtureT0 - 1_000)
    )
    // Une entrée écartée : `discardedEntries` fait partie de l'instantané encodé.
    fixture.put(.running, "\(malformedId).json", text: "{\"version\":1,\"id\":\"tronque")

    let snapshot = StoreReader(stateDir: fixture.root, clock: fixtureClock).readAll()
    // Le magasin est réellement peuplé : sans cela, l'aller-retour ne prouverait rien.
    #expect(snapshot.root == .present)
    #expect(snapshot.running.entries.count == 1)
    #expect(snapshot.history.entries.count == 1)
    #expect(snapshot.lots.lots.count == 1)
    #expect(snapshot.projects.projects.count == 1)
    #expect(snapshot.inbox.boxes.count == 1)
    #expect(snapshot.audit.relays.count == 1)
    #expect(snapshot.running.discardedEntries.map(\.file) == ["running/\(malformedId).json"])

    let data = try JSONEncoder().encode(snapshot)
    let decoded = try JSONDecoder().decode(StoreSnapshot.self, from: data)
    #expect(decoded == snapshot)
    #expect(decoded.running.discarded == 1)

    // Les noms de champs du dépôt, store par store : l'encodage ne les renomme pas.
    let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(Set(object.keys) == ["root", "running", "history", "lots", "projects", "inbox", "audit"])
    let envelopes: [String: Set<String>] = [
        "running": ["availability", "entries", "discardedEntries"],
        "history": ["availability", "entries", "discardedEntries"],
        "lots": ["availability", "lots", "discardedEntries"],
        "projects": ["availability", "projects", "discardedEntries"],
        "inbox": ["availability", "boxes", "discardedEntries"],
        "audit": ["availability", "relays", "discardedEntries"],
    ]
    for (store, keys) in envelopes {
        let envelope = try #require(object[store] as? [String: Any], "l'enveloppe \(store) doit être un objet")
        #expect(Set(envelope.keys) == keys, "l'enveloppe \(store) doit porter les clés du dépôt")
    }
    let runningEntry = try #require((object["running"] as? [String: Any]).flatMap { ($0["entries"] as? [[String: Any]])?.first })
    #expect(
        Set(runningEntry.keys) == [
            "id", "cwd", "label", "phase", "state", "phaseStartedAt", "updatedAt",
            "sessionFile", "sessionId", "ownerPid", "inbox", "pendingAsk", "isStale",
        ]
    )
    #expect(runningEntry["id"] as? String == runId)
    #expect((runningEntry["pendingAsk"] as? [String: Any])?["question"] as? String == "Sur quelle branche ?")
}

@Test("contrat partagé : les constantes de service portent les valeurs figées")
func serviceConstantsMatchTheContract() {
    #expect(ConsoleAPI.protocolVersion == 1)
    #expect(ConsoleAPI.Service.defaultPort == 8787)
    #expect(ConsoleAPI.Service.basePath == "/v1")
    #expect(ConsoleAPI.Service.bonjourType == "_ompconsole._tcp")
    #expect(ConsoleAPI.Service.bonjourName == "OMP Console")
    #expect(ConsoleAPI.Service.protocolHeader == "X-Console-Protocol-Version")
    #expect(ConsoleAPI.Service.pairingCodeLength == 8)
    #expect(ConsoleAPI.Service.pairingCodeTTLSeconds == 120)
    #expect(ConsoleAPI.Service.pairingAttemptLimit == 5)

    // L'alphabet d'appairage : exactement 32 symboles UNIQUES (l'entropie d'AC-25
    // repose sur cette taille, pas seulement sur celle du code).
    let alphabet = Array(ConsoleAPI.Service.pairingCodeAlphabet)
    #expect(alphabet.count == 32)
    #expect(Set(alphabet).count == 32)
}

@Test("contrat partagé : chaque erreur porte son code stable et son message")
func errorCasesKeepStableCodes() {
    #expect(ConsoleAPIError.incompatibleProtocol("protocole 2").code == "incompatible_protocol")
    #expect(ConsoleAPIError.incompatibleProtocol("protocole 2").message == "protocole 2")
    #expect(ConsoleAPIError.unauthorized.message == nil)

    // Les sept cas préexistants gardent leur code : le socle les avait déjà figés.
    #expect(ConsoleAPIError.badRequest("x").code == "bad_request")
    #expect(ConsoleAPIError.unauthorized.code == "unauthorized")
    #expect(ConsoleAPIError.notFound("x").code == "not_found")
    #expect(ConsoleAPIError.conflict("x").code == "conflict")
    #expect(ConsoleAPIError.unavailable("x").code == "unavailable")
    #expect(ConsoleAPIError.server("x").code == "server")
    #expect(ConsoleAPIError.decoding("x").code == "decoding")

    // Le message est rendu tel quel, jamais reformulé par le code.
    #expect(ConsoleAPIError.notFound("route inconnue").message == "route inconnue")
    #expect(ConsoleAPIError.badRequest("cible invalide").message == "cible invalide")
    #expect(ConsoleAPIError.server("échec").message == "échec")
}
