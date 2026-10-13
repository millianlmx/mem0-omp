// Preuves du modèle de la section Audit (audit-panel-in-omp-console S-6, BR-3) :
// les quatre gestes partent vers le service avec EXACTEMENT les corps attendus
// (`ScriptedServiceTransport`), la feuille du brief fermée ne poste rien, et les
// échecs rendent les phrases de S-6. Les instantanés viennent d'`AuditParity`.

import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

/// Un modèle sans magasin réel : les preuves posent elles-mêmes l'instantané
/// (`apply`), le client parle au transport scripté.
@MainActor
private func makeAuditModel(
    _ transport: ScriptedServiceTransport,
    urlOpener: RecordingURLOpener = RecordingURLOpener()
) -> AuditConsoleModel {
    AuditConsoleModel(
        stateDir: "/tmp/omp-audit-absent",
        snapshots: { AsyncStream { $0.finish() } },
        makeClient: { scriptedClient(transport) },
        urlOpener: urlOpener,
        defaults: UserDefaults(suiteName: "audit-tests-\(UUID().uuidString)")!
    )
}

/// L'audit « recette-propositions » sélectionné, deux cases cochées sur cinq.
@MainActor
private func proposedModel(_ transport: ScriptedServiceTransport) -> AuditConsoleModel {
    let model = makeAuditModel(transport)
    model.apply(AuditParity.snapshot)
    model.selection = AuditParity.proposedId
    model.setChecked("relecture-complete", in: AuditParity.proposedId, true)
    model.setChecked("index-sessions", in: AuditParity.proposedId, true)
    return model
}

private func escalationOfLaunchedAudit() -> AuditEscalationRow {
    AuditParity.board.card(id: AuditParity.launchedId)!.escalations[0]
}

// MARK: - AC-1 : démarrer

@MainActor
@Test("audit-panel-in-omp-console-mac/AC-1 : « Lancer l’audit » poste {repo, orientation} sur /v1/audits, sélectionne l’audit créé et sa carte montre l’orientation")
func startPostsRepoAndOrientationAndSelectsTheAudit() async throws {
    let transport = ScriptedServiceTransport()
    transport.stubJSON("POST", "/v1/audits", ["id": AuditParity.analysingId, "status": "analysing"])
    let model = makeAuditModel(transport)
    model.apply(AuditParity.snapshot)
    model.selection = AuditParity.launchedId
    let repo = try makeGitRepository()

    model.draftRepository = repo
    model.draftOrientation = "  accessibilité VoiceOver \n"
    #expect(model.canCommitLaunch)
    model.commitLaunch()
    #expect(!model.isLaunchSheetPresented)
    #expect(await awaitProject { model.selection == AuditParity.analysingId && !model.busy })

    let requests = transport.requests
    #expect(requests.count == 1)
    #expect(requests[0].method == "POST")
    #expect(requests[0].path.hasSuffix("/v1/audits"))
    #expect(requests[0].body?["repo"] as? String == repo.path)
    #expect(requests[0].body?["orientation"] as? String == "accessibilité VoiceOver")
    #expect(Set(requests[0].body?.keys.map { $0 } ?? []) == ["repo", "orientation"])
    #expect(model.failure == nil)

    // L'instantané suivant porte l'audit : l'en-tête montre l'orientation saisie.
    model.apply(AuditParity.snapshot)
    #expect(model.selection == AuditParity.analysingId)
    #expect(model.selectedCard?.orientation == "accessibilité VoiceOver")
    #expect(AuditDetailContent.of(try #require(model.selectedCard)) == .analysing)
}

@MainActor
@Test("audit-panel-in-omp-console-mac/AC-1 : la feuille de lancement exige un dépôt Git et une orientation de 1 à 2 000 caractères")
func launchSheetGatesRepositoryAndOrientation() throws {
    let model = makeAuditModel(ScriptedServiceTransport())
    let repo = try makeGitRepository()
    let plain = FileManager.default.temporaryDirectory.appendingPathComponent("omp-audit-plain-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: plain, withIntermediateDirectories: true)

    model.draftRepository = plain
    model.draftOrientation = "accessibilité"
    #expect(!model.canCommitLaunch)
    #expect(model.launchFieldMessage == AuditText.notGitRepository)

    model.draftRepository = repo
    model.draftOrientation = "   \n "
    #expect(!model.canCommitLaunch)
    #expect(model.launchFieldMessage == nil)

    model.draftOrientation = String(repeating: "a", count: 2000)
    #expect(model.canCommitLaunch)
    model.draftOrientation = String(repeating: "a", count: 2001)
    #expect(!model.canCommitLaunch)
    #expect(model.launchFieldMessage == AuditText.orientationTooLong)
}

@MainActor
@Test("audit-panel-in-omp-console-mac/AC-1 : un démarrage refusé affiche « L’audit n’a pas démarré… », le brut en diagnostic, et le succès suivant retire le bandeau")
func startFailureShowsReadableFailureThenClears() async {
    let transport = ScriptedServiceTransport()
    let model = makeAuditModel(transport)
    transport.failRequests(ServiceClientError.unavailable)

    #expect(await model.submitStart(repoRoot: "/tmp/depot", orientation: "fiabilité") == false)
    #expect(model.failure?.message == AuditText.startFailed)
    #expect(model.failure?.diagnostic == ServiceClientError.unavailable.userMessage)
    #expect(model.serviceDown)

    // « Réessayer » rejoue le geste une fois le service revenu.
    transport.failRequests(nil)
    transport.stubJSON("POST", "/v1/audits", ["id": AuditParity.analysingId, "status": "analysing"])
    await model.retry()
    #expect(model.failure == nil)
    #expect(!model.serviceDown)
    #expect(model.selection == AuditParity.analysingId)
}

// MARK: - AC-2 : lancer la sélection

@MainActor
@Test("audit-panel-in-omp-console-mac/AC-2 : 2 cases cochées sur 5, le POST launch porte exactement ces 2 slugs et le brief validé")
func launchPostsExactlyTheCheckedSlugs() async throws {
    let transport = ScriptedServiceTransport()
    transport.stubJSON("POST", "/v1/audits/\(AuditParity.proposedId)/launch", ["launches": [
        ["slug": "relecture-complete", "launched": true, "reason": NSNull(), "state": NSNull(), "phase": NSNull(), "prUrl": NSNull()],
        ["slug": "index-sessions", "launched": true, "reason": NSNull(), "state": NSNull(), "phase": NSNull(), "prUrl": NSNull()],
    ]])
    let model = proposedModel(transport)
    let card = try #require(model.selectedCard)
    #expect(card.proposals.count == 5)
    #expect(model.checkedCount(of: card) == 2)
    #expect(model.canReviewBrief(card))
    // Cocher une case ne poste rien.
    #expect(transport.requests.isEmpty)

    model.presentBrief()
    #expect(model.isBriefSheetPresented)
    #expect(model.briefText == card.briefDraft)
    #expect(model.briefText.contains("## Orientation"))
    model.briefText += "\nRelu."

    #expect(await model.commitBrief())
    let requests = transport.requests
    #expect(requests.count == 1)
    #expect(requests[0].method == "POST")
    #expect(requests[0].path.hasSuffix("/v1/audits/\(AuditParity.proposedId)/launch"))
    #expect(requests[0].body?["selected"] as? [String] == ["relecture-complete", "index-sessions"])
    #expect(requests[0].body?["brief"] as? String == (card.briefDraft ?? "") + "\nRelu.")
    #expect(!model.isBriefSheetPresented)
    #expect(model.failure == nil)
}

@MainActor
@Test("audit-panel-in-omp-console-mac/AC-2 : une proposition déjà dans le lot ne se coche pas")
func takenProposalCannotBeChecked() throws {
    let model = makeAuditModel(ScriptedServiceTransport())
    model.apply(AuditParity.snapshot)
    let card = try #require(model.board.card(id: AuditParity.proposedId))
    #expect(card.proposals.first { $0.slug == "cache-demarrage" }?.taken == true)
    model.setChecked("cache-demarrage", in: card.id, true)
    #expect(!model.isChecked("cache-demarrage", in: card.id))
    #expect(!model.canReviewBrief(card))
    #expect(AuditText.checkedCount(model.checkedCount(of: card)) == AuditText.checkedCount(0))
}

// MARK: - AC-3 : fermer le brief

@MainActor
@Test("audit-panel-in-omp-console-mac/AC-3 : fermer la feuille du brief (Annuler, Échap, fermeture) ne déclenche aucune requête")
func closingTheBriefPostsNothing() {
    let transport = ScriptedServiceTransport()
    let model = proposedModel(transport)
    model.presentBrief()
    #expect(model.isBriefSheetPresented)
    model.briefText = "brouillon corrigé"
    model.cancelBrief()
    #expect(!model.isBriefSheetPresented)
    #expect(transport.requests.isEmpty)
    // Les cases restent cochées, en mémoire seulement.
    #expect(model.isChecked("relecture-complete", in: AuditParity.proposedId))
}

@MainActor
@Test("audit-panel-in-omp-console-mac/AC-3 : une rubrique manquante est signalée dans la feuille avant tout envoi")
func missingRubricBlocksTheLaunch() async {
    let transport = ScriptedServiceTransport()
    let model = proposedModel(transport)
    model.presentBrief()
    model.briefText = model.briefText.replacingOccurrences(of: "## Constats", with: "## Remarques")
    #expect(await model.commitBrief() == false)
    #expect(model.briefError == AuditText.briefIncomplete(rubric: "Constats"))
    #expect(model.isBriefSheetPresented)
    #expect(transport.requests.isEmpty)
}

@MainActor
@Test("audit-panel-in-omp-console-mac/AC-2 : un lancement refusé en 409 dit « Cet audit n’attend plus de validation… », une autre erreur « Le lancement n’a pas eu lieu… »")
func launchFailuresAreReadable() async {
    let conflict = ScriptedServiceTransport()
    conflict.stubStatus("POST", "/launch", status: 409, json: ["error": "conflict", "reason": "l'audit n'attend pas de validation (état : launched)"])
    let first = proposedModel(conflict)
    first.presentBrief()
    #expect(await first.commitBrief() == false)
    #expect(first.failure?.message == AuditText.launchConflict)
    #expect(!first.isBriefSheetPresented)

    let other = ScriptedServiceTransport()
    other.stubStatus("POST", "/launch", status: 400, json: ["error": "bad_request", "reason": "brief incomplet"])
    let second = proposedModel(other)
    second.presentBrief()
    #expect(await second.commitBrief() == false)
    #expect(second.failure?.message == AuditText.launchFailed)
    #expect(second.failure?.diagnostic == "brief incomplet")
    #expect(second.isBriefSheetPresented)
}

/// L'instantané de la fixture augmenté d'un second audit `proposed`, copie de
/// « recette-propositions » sous l'id `id`.
private func snapshotWithSecondProposed(id: String) throws -> StoreSnapshot {
    let data = try JSONEncoder().encode(AuditParity.snapshot)
    var root = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    var audits = try #require(root["audits"] as? [String: Any])
    var records = try #require(audits["records"] as? [[String: Any]])
    var copy = try #require(records.first { $0["id"] as? String == AuditParity.proposedId })
    copy["id"] = id
    copy["key"] = "/tmp/omp-audit-parity/state/audits/\(id)"
    records.append(copy)
    audits["records"] = records
    root["audits"] = audits
    return try JSONDecoder().decode(StoreSnapshot.self, from: JSONSerialization.data(withJSONObject: root))
}

@MainActor
@Test("audit-panel-in-omp-console-mac/AC-2 : « Réessayer » après un lancement échoué rejoue l’audit, les cases et le brief validés — rien ne part vers l’audit sélectionné entre-temps")
func retryReplaysOnlyTheValidatedLaunch() async throws {
    let other = "b0d1700000000002"
    let transport = ScriptedServiceTransport()
    let model = makeAuditModel(transport)
    model.apply(try snapshotWithSecondProposed(id: other))
    #expect(model.board.card(id: other)?.status == .proposed)
    model.selection = AuditParity.proposedId
    model.setChecked("relecture-complete", in: AuditParity.proposedId, true)
    model.setChecked("index-sessions", in: AuditParity.proposedId, true)
    model.presentBrief()
    model.briefText += "\nRelu pour A."
    let validated = model.briefText

    // Le service est arrêté : le lancement de A échoue, l'utilisateur ferme la feuille.
    transport.failRequests(ServiceClientError.unavailable)
    #expect(await model.commitBrief() == false)
    #expect(model.serviceDown)
    model.cancelBrief()

    // Il sélectionne B et y coche une case, sans en valider le brief.
    model.selection = other
    model.setChecked("mesure-demarrage", in: other, true)

    transport.failRequests(nil)
    transport.stubJSON("POST", "/launch", ["launches": [
        ["slug": "relecture-complete", "launched": true, "reason": NSNull(), "state": NSNull(), "phase": NSNull(), "prUrl": NSNull()],
        ["slug": "index-sessions", "launched": true, "reason": NSNull(), "state": NSNull(), "phase": NSNull(), "prUrl": NSNull()],
    ]])
    await model.retry()

    let launches = transport.requests.filter { $0.path.hasSuffix("/launch") }
    #expect(!launches.contains { $0.path.contains(other) }, "aucune requête ne part vers B")
    let replayed = try #require(launches.last)
    #expect(replayed.path.hasSuffix("/v1/audits/\(AuditParity.proposedId)/launch"))
    #expect(replayed.body?["selected"] as? [String] == ["relecture-complete", "index-sessions"])
    #expect(replayed.body?["brief"] as? String == validated)
    #expect(model.failure == nil)
    #expect(!model.isChecked("relecture-complete", in: AuditParity.proposedId))
    #expect(model.isChecked("mesure-demarrage", in: other), "les cases de B restent cochées")
}

// MARK: - AC-6 : répondre

@MainActor
@Test("audit-panel-in-omp-console-mac/AC-6 : répondre poste {slug, key, answer} sur /v1/audits/<id>/escalations")
func answerPostsSlugKeyAndAnswer() async {
    let transport = ScriptedServiceTransport()
    transport.stubJSON("POST", "/v1/audits/\(AuditParity.launchedId)/escalations", ["accepted": true])
    let model = makeAuditModel(transport)
    model.apply(AuditParity.snapshot)
    let escalation = escalationOfLaunchedAudit()
    #expect(escalation.kind == .question)
    model.setDraft("Non, sur demande", for: escalation.key)

    #expect(await model.submitAnswer(auditId: AuditParity.launchedId, escalation: escalation, answer: model.draft(for: escalation.key)))
    let requests = transport.requests
    #expect(requests.count == 1)
    #expect(requests[0].method == "POST")
    #expect(requests[0].path.hasSuffix("/v1/audits/\(AuditParity.launchedId)/escalations"))
    #expect(requests[0].body?["slug"] as? String == "reprise-pipeline")
    #expect(requests[0].body?["key"] as? String == escalation.key)
    #expect(requests[0].body?["answer"] as? String == "Non, sur demande")
    #expect(requests[0].body?["decision"] == nil)
    #expect(model.draft(for: escalation.key).isEmpty)
}

@MainActor
@Test("audit-panel-in-omp-console-mac/AC-6 : un jalon escaladé se tranche par la décision approve ou abandon, sans réponse")
func milestoneDecisionPostsDecision() async {
    let transport = ScriptedServiceTransport()
    transport.stubJSON("POST", "/escalations", ["accepted": true])
    let model = makeAuditModel(transport)
    let specs = AuditEscalationRow(slug: "journal-erreurs", key: "specs:journal-erreurs", kind: .specs, phase: .specs, question: "Valider les specs ?", options: [], reason: "motif", at: 1)
    #expect(await model.submitDecision(auditId: AuditParity.launchedId, escalation: specs, decision: .approve))
    #expect(await model.submitDecision(auditId: AuditParity.launchedId, escalation: specs, decision: .abandon))
    let bodies = transport.requests.map(\.body)
    #expect(bodies.map { $0?["decision"] as? String } == ["approve", "abandon"])
    #expect(bodies.allSatisfy { $0?["answer"] == nil })
}

@MainActor
@Test("audit-panel-in-omp-console-mac/AC-6 : une réponse refusée en 409 affiche « Cette question a déjà reçu une réponse. », une autre erreur la phrase d’échec de réponse")
func answerFailuresAreReadable() async {
    let conflict = ScriptedServiceTransport()
    conflict.stubStatus("POST", "/escalations", status: 409, json: ["error": "conflict", "reason": "question déjà répondue ou périmée"])
    let first = makeAuditModel(conflict)
    #expect(await first.submitAnswer(auditId: AuditParity.launchedId, escalation: escalationOfLaunchedAudit(), answer: "Oui, automatiquement") == false)
    #expect(first.failure?.message == AuditText.alreadyAnswered)

    let other = ScriptedServiceTransport()
    other.stubStatus("POST", "/escalations", status: 400, json: ["error": "bad_request", "reason": "réponse vide"])
    let second = makeAuditModel(other)
    #expect(await second.submitAnswer(auditId: AuditParity.launchedId, escalation: escalationOfLaunchedAudit(), answer: "Oui") == false)
    #expect(second.failure?.message == AuditText.answerFailed)
}

// MARK: - AC-11 : arrêter

@MainActor
@Test("audit-panel-in-omp-console-mac/AC-11 : la confirmation d’arrêt poste DELETE /v1/audits/<id>, et l’annulation ne poste rien")
func stopConfirmationPostsDelete() async {
    let transport = ScriptedServiceTransport()
    transport.stubJSON("DELETE", "/v1/audits/\(AuditParity.launchedId)", ["cancelled": ["journal-erreurs"], "kept": ["rapport-erreurs"], "refused": []])
    let model = makeAuditModel(transport)
    model.apply(AuditParity.snapshot)
    model.selection = AuditParity.launchedId

    model.requestStop()
    #expect(model.pendingStop == AuditParity.launchedId)
    model.cancelStop()
    #expect(model.pendingStop == nil)
    #expect(transport.requests.isEmpty)

    model.requestStop()
    #expect(await model.confirmStop())
    let requests = transport.requests
    #expect(requests.count == 1)
    #expect(requests[0].method == "DELETE")
    #expect(requests[0].path.hasSuffix("/v1/audits/\(AuditParity.launchedId)"))
    #expect(model.pendingStop == nil)
    #expect(model.failure == nil)
}

@MainActor
@Test("audit-panel-in-omp-console-mac/AC-11 : un arrêt qui échoue affiche « L’audit n’a pas été arrêté. Réessayez. »")
func stopFailureIsReadable() async {
    let transport = ScriptedServiceTransport()
    transport.stubStatus("DELETE", "/v1/audits/\(AuditParity.launchedId)", status: 409, json: ["error": "conflict", "reason": "audit déjà arrêté"])
    let model = makeAuditModel(transport)
    model.apply(AuditParity.snapshot)
    model.selection = AuditParity.launchedId
    model.requestStop()
    #expect(await model.confirmStop() == false)
    #expect(model.failure?.message == AuditText.stopFailed)
    #expect(model.failure?.diagnostic == "audit déjà arrêté")
}
