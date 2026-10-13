// Preuves des routes d'audit de l'API distante (audit-panel-in-omp-console S-7,
// BR-4) : une requête de l'iPhone passe par le MÊME modèle que la section Audit du
// Mac et produit, vers le service, EXACTEMENT la requête du geste Mac. Les refus
// du service se recopient en codes de l'API ; un dépôt inconnu est un 404.

import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

/// Les quatre routes d'audit du service, scriptées.
private func stubAuditService(_ transport: ScriptedServiceTransport) {
    transport.stubJSON("POST", "/v1/audits", ["id": AuditParity.analysingId, "status": "analysing"])
    transport.stubJSON("POST", "/v1/audits/\(AuditParity.proposedId)/launch", ["launches": [
        ["slug": "relecture-complete", "launched": true, "reason": NSNull(), "state": NSNull(), "phase": NSNull(), "prUrl": NSNull()],
        ["slug": "index-sessions", "launched": true, "reason": NSNull(), "state": NSNull(), "phase": NSNull(), "prUrl": NSNull()],
    ]])
    transport.stubJSON("POST", "/v1/audits/\(AuditParity.launchedId)/escalations", ["accepted": true])
    transport.stubJSON("DELETE", "/v1/audits/\(AuditParity.launchedId)", [
        "cancelled": ["reprise-pipeline"],
        "kept": ["rapport-erreurs"],
        "refused": [["slug": "journal-erreurs", "reason": "déjà livrée"]],
    ])
}

/// Le modèle de la section Audit, branché sur le transport scripté et posé sur
/// l'instantané de parité.
@MainActor
private func auditModel(_ transport: ScriptedServiceTransport) -> AuditConsoleModel {
    let model = AuditConsoleModel(
        stateDir: "/tmp/omp-audit-absent",
        snapshots: { AsyncStream { $0.finish() } },
        makeClient: { scriptedClient(transport) },
        defaults: UserDefaults(suiteName: "audit-remote-\(UUID().uuidString)")!
    )
    model.apply(AuditParity.snapshot)
    return model
}

/// Un dépôt git jetable, publié comme lot du magasin : `knownRepos()` le sert.
private func publishKnownRepo(_ store: StoreFixture) throws -> String {
    let repoRoot = store.root + "/depot-audit"
    try FileManager.default.createDirectory(atPath: repoRoot + "/.git", withIntermediateDirectories: true)
    store.publish(.lots, "\(fixtureId(0xA4)).json", object: lotObject(id: fixtureId(0xA4), repoRoot: repoRoot))
    return realpathOr(repoRoot)
}

/// La pile distante sur un magasin qui connaît un dépôt, avec le modèle d'audit
/// PARTAGÉ (celui que la section du Mac affiche). Le magasin vit autant que la
/// pile : libéré, il efface son dossier et le dépôt cesse d'être connu.
@MainActor
private struct AuditRemote {
    let store: StoreFixture
    let stack: RemoteStack
    let token: String
    let repoKey: String
    let repoRoot: String
}

@MainActor
private func auditStack(_ transport: ScriptedServiceTransport) async throws -> AuditRemote {
    let store = StoreFixture()
    let repoRoot = try publishKnownRepo(store)
    let stack = try await RemoteStack.make(stateDir: store.root, auditModel: auditModel(transport))
    let token = try await stack.pair()
    let repos = try await stack.call("GET", "/v1/repos", token: token)
    let row = try #require(try repos.json(RemoteReposPayload.self).rows.first { $0.repoRoot == repoRoot })
    return AuditRemote(store: store, stack: stack, token: token, repoKey: row.repoKey, repoRoot: repoRoot)
}

/// Deux requêtes de service identiques : méthode, chemin et corps.
private func sameServiceRequest(_ a: ScriptedRequest, _ b: ScriptedRequest) -> Bool {
    a.method == b.method && a.path == b.path
        && NSDictionary(dictionary: a.body ?? [:]).isEqual(to: b.body ?? [:])
}

@MainActor
@Test("audit-panel-in-omp-console-mac/AC-8 : lancer un audit, cocher 2 propositions et valider le brief depuis l’iPhone produit vers le service les mêmes requêtes que les gestes du Mac")
func remoteAuditGesturesMatchTheMacGestures() async throws {
    // L'iPhone : les routes distantes, servies par le modèle partagé.
    let remote = ScriptedServiceTransport()
    stubAuditService(remote)
    let fixture = try await auditStack(remote)
    defer { fixture.stack.stop() }

    let started = try await fixture.stack.call("POST", "/v1/audits", token: fixture.token, json: [
        "repoKey": fixture.repoKey,
        "orientation": "accessibilité VoiceOver",
    ])
    #expect(started.status == 200)
    #expect(try started.json(RemoteAuditStartedPayload.self).id == AuditParity.analysingId)

    let brief = try #require(AuditParity.board.card(id: AuditParity.proposedId)?.briefDraft)
    let launched = try await fixture.stack.call("POST", "/v1/audits/\(AuditParity.proposedId)/launch", token: fixture.token, json: [
        "selected": ["relecture-complete", "index-sessions"],
        "brief": brief,
    ])
    #expect(launched.status == 200)
    let launches = try launched.json(RemoteAuditLaunchPayload.self).launches
    #expect(launches.map(\.slug) == ["relecture-complete", "index-sessions"])
    #expect(launches.allSatisfy { $0.launched })

    // Le Mac : la feuille de lancement, puis 2 cases sur 5 et « Valider et lancer ».
    let local = ScriptedServiceTransport()
    stubAuditService(local)
    let mac = auditModel(local)
    mac.draftRepository = URL(fileURLWithPath: fixture.repoRoot, isDirectory: true)
    mac.draftOrientation = "accessibilité VoiceOver"
    mac.commitLaunch()
    #expect(await awaitProject { local.requests.count == 1 && !mac.busy })
    mac.selection = AuditParity.proposedId
    mac.setChecked("relecture-complete", in: AuditParity.proposedId, true)
    mac.setChecked("index-sessions", in: AuditParity.proposedId, true)
    mac.presentBrief()
    #expect(await mac.commitBrief())

    let fromPhone = remote.requests
    let fromMac = local.requests
    #expect(fromPhone.count == 2)
    #expect(fromMac.count == 2)
    for (phone, desk) in zip(fromPhone, fromMac) {
        #expect(sameServiceRequest(phone, desk), "\(phone.method) \(phone.path) \(String(describing: phone.body)) ≠ \(desk.method) \(desk.path) \(String(describing: desk.body))")
    }
    #expect(fromPhone[1].body?["selected"] as? [String] == ["relecture-complete", "index-sessions"])
}

@MainActor
@Test("audit-panel-in-omp-console-mac/AC-6 : une réponse donnée depuis l’iPhone part au service comme celle du Mac, {slug, key, answer} ou {slug, key, decision}")
func remoteAuditAnswerMatchesTheMacAnswer() async throws {
    let remote = ScriptedServiceTransport()
    stubAuditService(remote)
    let fixture = try await auditStack(remote)
    defer { fixture.stack.stop() }
    let escalation = try #require(AuditParity.board.card(id: AuditParity.launchedId)?.escalations.first)

    let answered = try await fixture.stack.call("POST", "/v1/audits/\(AuditParity.launchedId)/escalations", token: fixture.token, json: [
        "slug": escalation.slug,
        "key": escalation.key,
        "answer": "Non, sur demande",
    ])
    #expect(answered.status == 202)
    #expect(try answered.json(RemoteAcceptedPayload.self).accepted)
    let decided = try await fixture.stack.call("POST", "/v1/audits/\(AuditParity.launchedId)/escalations", token: fixture.token, json: [
        "slug": escalation.slug,
        "key": escalation.key,
        "decision": "approve",
    ])
    #expect(decided.status == 202)

    let local = ScriptedServiceTransport()
    stubAuditService(local)
    let mac = auditModel(local)
    #expect(await mac.submitAnswer(auditId: AuditParity.launchedId, escalation: escalation, answer: "Non, sur demande"))
    #expect(await mac.submitDecision(auditId: AuditParity.launchedId, escalation: escalation, decision: .approve))

    #expect(remote.requests.count == 2)
    #expect(local.requests.count == 2)
    for (phone, desk) in zip(remote.requests, local.requests) {
        #expect(sameServiceRequest(phone, desk), "\(String(describing: phone.body)) ≠ \(String(describing: desk.body))")
    }
    #expect(remote.requests[0].body?["decision"] == nil)
    #expect(remote.requests[1].body?["answer"] == nil)
}

@MainActor
@Test("routes d’audit : l’arrêt depuis l’iPhone poste DELETE au service et rend {cancelled, kept, refused} tels quels")
func remoteAuditStopCopiesTheServiceOutcome() async throws {
    let remote = ScriptedServiceTransport()
    stubAuditService(remote)
    let fixture = try await auditStack(remote)
    defer { fixture.stack.stop() }

    let stopped = try await fixture.stack.call("DELETE", "/v1/audits/\(AuditParity.launchedId)", token: fixture.token)
    #expect(stopped.status == 200)
    let payload = try stopped.json(RemoteAuditStopPayload.self)
    #expect(payload.cancelled == ["reprise-pipeline"])
    #expect(payload.kept == ["rapport-erreurs"])
    #expect(payload.refused == [RemoteAuditStopRefusal(slug: "journal-erreurs", reason: "déjà livrée")])
    #expect(remote.requests.map { "\($0.method) \($0.path)" } == ["DELETE /v1/audits/\(AuditParity.launchedId)"])
}

@MainActor
@Test("routes d’audit : dépôt inconnu et identifiant hors forme en 404 sans appel au service, refus du service recopiés, service arrêté en 503")
func remoteAuditErrorsAreCopied() async throws {
    let remote = ScriptedServiceTransport()
    let fixture = try await auditStack(remote)
    defer { fixture.stack.stop() }

    let unknownRepo = try await fixture.stack.call("POST", "/v1/audits", token: fixture.token, json: ["repoKey": "0000000000000000", "orientation": "x"])
    #expect(unknownRepo.status == 404)
    #expect(unknownRepo.errorMessage == "dépôt inconnu")
    let malformed = try await fixture.stack.call("DELETE", "/v1/audits/inconnu", token: fixture.token)
    #expect(malformed.status == 404)
    #expect(malformed.errorMessage == "audit inconnu")
    let noBody = try await fixture.stack.call("POST", "/v1/audits/\(AuditParity.proposedId)/launch", token: fixture.token)
    #expect(noBody.status == 400)
    #expect(remote.requests.isEmpty, "aucune requête ne part au service pour une demande invalide")

    remote.stubStatus("POST", "/v1/audits", status: 400, json: ["error": "bad_request", "reason": "orientation vide"])
    let blank = try await fixture.stack.call("POST", "/v1/audits", token: fixture.token, json: ["repoKey": fixture.repoKey, "orientation": "  "])
    #expect(blank.status == 400)
    #expect(blank.errorMessage == "orientation vide")

    remote.stubStatus("POST", "/launch", status: 409, json: ["error": "conflict", "reason": "l'audit n'attend pas de validation (état : launched)"])
    let late = try await fixture.stack.call("POST", "/v1/audits/\(AuditParity.proposedId)/launch", token: fixture.token, json: ["selected": ["a"], "brief": "b"])
    #expect(late.status == 409)
    #expect(late.errorMessage == "l'audit n'attend pas de validation (état : launched)")

    remote.stubStatus("POST", "/escalations", status: 404, json: ["error": "not_found", "reason": "audit inconnu"])
    let gone = try await fixture.stack.call("POST", "/v1/audits/\(AuditParity.launchedId)/escalations", token: fixture.token, json: ["slug": "a", "key": "question:a:1", "answer": "Oui"])
    #expect(gone.status == 404)

    remote.failRequests(ServiceClientError.unavailable)
    let down = try await fixture.stack.call("DELETE", "/v1/audits/\(AuditParity.launchedId)", token: fixture.token)
    #expect(down.status == 503)
    #expect(down.errorMessage == ServiceClientError.unavailable.userMessage)
}

// MARK: - Réponse d'escalade typée (validations-de-geste-enfermees-dans-le-h, BR-2)

@MainActor
@Test("validations-de-geste-enfermees-dans-le-h/AC-7 : répondre à une escalade d'audit par la méthode typée poste au service la même requête que la route")
func typedAuditAnswerMatchesTheRoute() async throws {
    let remote = ScriptedServiceTransport()
    stubAuditService(remote)
    let fixture = try await auditStack(remote)
    defer { fixture.stack.stop() }

    let routed = try await fixture.stack.call(
        "POST", "/v1/audits/\(AuditParity.launchedId)/escalations",
        token: fixture.token,
        json: ["slug": "a", "key": "question:a:1", "answer": "Oui"]
    )
    #expect(routed.status == 202)
    try await fixture.stack.remoteActions.answerAudit(
        id: AuditParity.launchedId,
        slug: "a",
        key: "question:a:1",
        answer: "Oui",
        decision: nil
    )

    #expect(remote.requests.count == 2)
    let fromRoute = try #require(remote.requests.first)
    let fromTyped = try #require(remote.requests.last)
    #expect(sameServiceRequest(fromRoute, fromTyped), "\(fromRoute.method) \(fromRoute.path) ≠ \(fromTyped.method) \(fromTyped.path)")
    #expect(fromTyped.path.hasSuffix("/v1/audits/\(AuditParity.launchedId)/escalations"))
    #expect(fromTyped.body?["answer"] as? String == "Oui")
}

@MainActor
@Test("validations-de-geste-enfermees-dans-le-h/AC-9 : un corps de réponse d'escalade d'audit mal formé est un 400 sans requête au service")
func malformedAuditAnswerNeverReachesTheService() async throws {
    let remote = ScriptedServiceTransport()
    stubAuditService(remote)
    let fixture = try await auditStack(remote)
    defer { fixture.stack.stop() }

    let path = "/v1/audits/\(AuditParity.launchedId)/escalations"
    let unreadable = try await fixture.stack.call("POST", path, token: fixture.token, body: Data("{".utf8))
    #expect(unreadable.status == 400)
    #expect(unreadable.errorCode == "bad_request")
    #expect(unreadable.errorMessage == "corps JSON illisible")
    let absent = try await fixture.stack.call("POST", path, token: fixture.token)
    #expect(absent.status == 400)
    #expect(absent.errorMessage == "corps JSON absent")
    // Le corps est décodé AVANT le contrôle d'identité : un id hors forme avec un
    // corps illisible est un 400, jamais un 404.
    let outOfShape = try await fixture.stack.call("POST", "/v1/audits/inconnu/escalations", token: fixture.token, body: Data("{".utf8))
    #expect(outOfShape.status == 400)
    #expect(remote.requests.isEmpty, "aucune requête ne part au service")
}
