// Preuves de la dérivation partagée de la section Audit (audit-panel-in-omp-console
// S-5) : `AuditBoard.of` sur la fixture `AuditParity`, l'isolation de deux audits
// d'un même dépôt, et le décodage des champs neufs du magasin.

import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

private func card(_ board: AuditBoard, _ id: String) -> AuditCard? {
    board.audits.first { $0.id == id }
}

@Test("audit-panel-in-omp-console-mac/AC-7 : chaque feature lancée a sa phase, son attente et sa PR ; chaque décision de l’arbitre a sa feature, sa question et sa réponse")
func auditBoardShowsProgressAndDecisions() throws {
    let suivi = try #require(card(AuditParity.board, AuditParity.launchedId))

    // Une rangée par proposition LANCÉE, dans l'ordre de lancement : la feature
    // vivante fait foi (phase, attente, PR).
    #expect(suivi.features == [
        AuditFeatureRow(slug: "journal-erreurs", phase: .impl, waiting: .running, prUrl: nil),
        AuditFeatureRow(slug: "reprise-pipeline", phase: .req, waiting: .escalated, prUrl: nil),
        AuditFeatureRow(slug: "rapport-erreurs", phase: .release, waiting: .prCreated, prUrl: "https://example.com/pr/7"),
        AuditFeatureRow(slug: "alerte-quota", phase: .specs, waiting: .cancelled, prUrl: nil),
    ])
    #expect(suivi.features.map { AuditText.waiting($0.waiting) } == ["En cours", "Attend votre réponse", "PR créée", "Annulée"])
    #expect(suivi.features.compactMap(\.phase).map(PhaseText.title) == ["Implémentation", "Clarification", "Publication", "Spécification"])
    // La proposition cochée mais non lancée reste visible avec son motif.
    #expect(suivi.launches.map(\.slug) == ["tableau-fiabilite"])
    #expect(suivi.launches.first?.reason == "lancement refusé : la feature existe déjà dans le lot")

    // Les décisions : la plus récente d'abord, chacune avec feature, question,
    // réponse et source.
    #expect(suivi.decisions.map(\.slug) == ["rapport-erreurs", "journal-erreurs", "journal-erreurs"])
    #expect(suivi.decisions.map(\.question) == ["Accepter la revue ?", "Valider les specs ?", "Quels journaux faut-il couvrir ?"])
    #expect(suivi.decisions.map(\.answer) == ["Revue acceptée : aucun bloquant.", "Specs validées : elles couvrent le brief.", "Ceux du service, d’après le brief."])
    #expect(suivi.decisions.map { AuditText.source($0.source) } == ["Tranchée par l’arbitre", "Tranchée par l’arbitre", "Déjà tranchée"])

    // La question escaladée, telle que la section la montre.
    #expect(suivi.escalations == [AuditEscalationRow(
        slug: "reprise-pipeline",
        key: "question:reprise-pipeline:1700000001500",
        kind: .question,
        phase: .req,
        question: "Faut-il reprendre automatiquement une pipeline interrompue ?",
        options: ["Oui, automatiquement", "Non, sur demande"],
        reason: "Le brief ne dit rien de la reprise automatique.",
        at: 1_700_000_005_000
    )])

    // Sans feature vivante (lot remplacé), le dernier état recopié par le suivi
    // du service fait foi — sans escalade, faute de feature.
    var withoutLots = AuditParity.snapshot
    withoutLots.lots.lots = []
    let replayed = try #require(card(AuditBoard.of(withoutLots), AuditParity.launchedId))
    #expect(replayed.features == [
        AuditFeatureRow(slug: "journal-erreurs", phase: .impl, waiting: .running, prUrl: nil),
        AuditFeatureRow(slug: "reprise-pipeline", phase: .req, waiting: .waiting, prUrl: nil),
        AuditFeatureRow(slug: "rapport-erreurs", phase: .release, waiting: .prCreated, prUrl: "https://example.com/pr/7"),
        AuditFeatureRow(slug: "alerte-quota", phase: .specs, waiting: .cancelled, prUrl: nil),
    ])
    #expect(replayed.escalations.isEmpty)
}

@Test("audit-panel-in-omp-console-mac/AC-10 : deux audits du même lot — les escalades et décisions de B n’apparaissent pas dans A")
func auditBoardIsolatesAuditsOfTheSameLot() throws {
    let idB = "b0d1700000000009"
    let keyB = "/tmp/omp-audit-parity/state/audits/\(idB)"
    var snapshot = AuditParity.snapshot
    var recordB = try #require(snapshot.audits.records.first { $0.id == AuditParity.launchedId })
    recordB.id = idB
    recordB.key = keyB
    recordB.orientation = "sécurité des jetons"
    recordB.createdAt = 1_700_000_008_000
    recordB.launches = [AuditLaunchOutcome(slug: "jetons-chiffres", launched: true, reason: nil, state: .running, phase: .req, prUrl: nil)]
    snapshot.audits.records.append(recordB)

    var featureB = try #require(snapshot.lots.lots[0].features.first { $0.slug == "journal-erreurs" })
    featureB.slug = "jetons-chiffres"
    featureB.auditSession = keyB
    featureB.state = .running
    featureB.phase = .req
    featureB.escalation = FeatureEscalation(key: "ask:jetons-chiffres:call-9", kind: .question, phase: .req, question: "Quel algorithme de chiffrement ?", options: ["AES-GCM", "ChaCha20"], reason: "Le brief de B ne le dit pas.", at: 1_700_000_009_000)
    snapshot.lots.lots[0].features.append(featureB)
    snapshot.audits.decisions.append(AuditDecision(auditId: idB, slug: "jetons-chiffres", phase: .req, kind: .question, question: "Faut-il chiffrer les jetons ?", answer: "Oui, d’après le brief de B.", source: .contexte, at: 1_700_000_008_500))

    let board = AuditBoard.of(snapshot)
    let auditA = try #require(card(board, AuditParity.launchedId))
    let auditB = try #require(card(board, idB))

    #expect(auditA.escalations.map(\.slug) == ["reprise-pipeline"])
    #expect(auditA.decisions.allSatisfy { $0.auditId == AuditParity.launchedId })
    #expect(!auditA.decisions.contains { $0.slug == "jetons-chiffres" })
    #expect(!auditA.features.contains { $0.slug == "jetons-chiffres" })

    #expect(auditB.escalations.map(\.slug) == ["jetons-chiffres"])
    #expect(auditB.escalations.first?.kind == .ask)
    #expect(auditB.decisions.map(\.question) == ["Faut-il chiffrer les jetons ?"])
    #expect(auditB.features == [AuditFeatureRow(slug: "jetons-chiffres", phase: .req, waiting: .escalated, prUrl: nil)])
}

@Test("audit-panel-in-omp-console : les propositions gardent l’ordre de l’analyse et marquent celles déjà dans le lot du dépôt")
func auditBoardMarksTakenProposals() throws {
    let board = AuditParity.board
    #expect(board.audits.map(\.id) == [AuditParity.analysingId, AuditParity.proposedId, AuditParity.launchedId, AuditParity.stoppedId, AuditParity.failedId])

    let propositions = try #require(card(board, AuditParity.proposedId))
    #expect(propositions.repoName == "depot")
    #expect(propositions.proposals.map(\.slug) == ["relecture-complete", "cache-ignore", "cache-demarrage", "index-sessions", "mesure-demarrage"])
    #expect(propositions.proposals.map(\.kind) == [.weakness, .weakness, .feature, .feature, .feature])
    #expect(propositions.proposals.filter(\.taken).map(\.slug) == ["cache-demarrage"])
    #expect(propositions.briefDraft.map(AuditBrief.missingRubric) == .some(nil))

    let analyse = try #require(card(board, AuditParity.analysingId))
    #expect(analyse.orientation == "accessibilité VoiceOver")
    #expect(analyse.status == .analysing)
    #expect(analyse.proposals.isEmpty && analyse.briefDraft == nil)
}

@Test("audit-panel-in-omp-console : l’attente suit la priorité escalade, arbitrage, puis état de la feature")
func auditWaitingPriority() {
    #expect(AuditWaiting.of(state: .running, prUrl: nil, escalated: true, arbitrating: true) == .escalated)
    #expect(AuditWaiting.of(state: .waiting, prUrl: nil, escalated: false, arbitrating: true) == .arbitrating)
    #expect(AuditWaiting.of(state: .pending, prUrl: nil, escalated: false, arbitrating: false) == .notStarted)
    #expect(AuditWaiting.of(state: nil, prUrl: nil, escalated: false, arbitrating: false) == .notStarted)
    #expect(AuditWaiting.of(state: .blocked, prUrl: nil, escalated: false, arbitrating: false) == .blocked)
    #expect(AuditWaiting.of(state: .failed, prUrl: nil, escalated: false, arbitrating: false) == .failed)
    #expect(AuditWaiting.of(state: .done, prUrl: nil, escalated: false, arbitrating: false) == .done)
    #expect(AuditWaiting.of(state: .done, prUrl: "https://example.com/pr/1", escalated: false, arbitrating: false) == .prCreated)
    #expect(AuditText.waiting(.arbitrating) == "L’arbitre examine une question")
    #expect(AuditText.waiting(.notStarted) == "En attente de démarrage")
}

@Test("audit-panel-in-omp-console : la sorte d’une escalade vient du préfixe de sa clé, et une autre sorte n’est pas une question d’audit")
func auditEscalationKindFromKey() throws {
    #expect(AuditEscalationKind(key: "ask:slug:call-1") == .ask)
    #expect(AuditEscalationKind(key: "question:slug:17") == .question)
    #expect(AuditEscalationKind(key: "specs:slug:17") == .specs)
    #expect(AuditEscalationKind(key: "review:slug:17") == .review)
    #expect(AuditEscalationKind(key: "cap:slug:17") == nil)
    #expect(AuditEscalationKind(key: "quota:anthropic") == nil)

    var snapshot = AuditParity.snapshot
    let index = try #require(snapshot.lots.lots[0].features.firstIndex { $0.slug == "reprise-pipeline" })
    snapshot.lots.lots[0].features[index].escalation?.key = "cap:reprise-pipeline:1"
    #expect(card(AuditBoard.of(snapshot), AuditParity.launchedId)?.escalations.isEmpty == true)
}

@Test("audit-panel-in-omp-console : une feature de lot relit son escalade et son arbitrage complets, et ignore une escalade incomplète sans se perdre")
func lotFeatureDecodesEscalationAndArbitration() throws {
    func feature(_ extra: String) throws -> LotFeature? {
        let text = """
        {"slug":"reprise","name":"reprise","branch":"feat/reprise","worktree":"","deps":[],"origin":"session",\
        "state":"waiting","phase":"req","waitKind":"answer","pendingTexts":[]\(extra)}
        """
        return LotFeature(json: try #require(JSONValue.parse(Data(text.utf8))))
    }
    let complete = try #require(try feature("""
    ,"escalation":{"key":"question:reprise:12","kind":"question","phase":"req","question":"Reprendre ?","options":["Oui","Non"],"reason":"Absent du brief.","at":42},\
    "arbitration":{"key":"question:reprise:12","startedAt":40}
    """))
    #expect(complete.escalation == FeatureEscalation(key: "question:reprise:12", kind: .question, phase: .req, question: "Reprendre ?", options: ["Oui", "Non"], reason: "Absent du brief.", at: 42))
    #expect(complete.arbitration == FeatureArbitration(key: "question:reprise:12", startedAt: 40))

    let partial = try #require(try feature("""
    ,"escalation":{"key":"question:reprise:12","kind":"question","phase":"req","question":"Reprendre ?","options":["Oui",3],"reason":"","at":42},\
    "arbitration":{"key":"","startedAt":40}
    """))
    #expect(partial.escalation == nil)
    #expect(partial.arbitration == nil)

    let absent = try #require(try feature(""))
    #expect(absent.escalation == nil && absent.arbitration == nil)

    // Le transport (trame `store`) les garde, et un instantané sans `audits` —
    // celui d'un Mac antérieur à la section — se lit avec une enveloppe absente.
    let encoded = try JSONEncoder().encode(complete)
    #expect(try JSONDecoder().decode(LotFeature.self, from: encoded) == complete)
    #expect(HomeParity.snapshot.audits == .absent)
    let roundTrip = try JSONDecoder().decode(StoreSnapshot.self, from: JSONEncoder().encode(AuditParity.snapshot))
    #expect(roundTrip == AuditParity.snapshot)
}

@Test("audit-panel-in-omp-console : un audit se relit comme le service l’écrit, et une issue sans motif explicite le rejette")
func auditRecordDecodesLikeTheService() throws {
    func record(_ launches: String, version: String = "1") throws -> AuditRecord? {
        let text = """
        {"version":\(version),"id":"0123456789abcdef","repoRoot":"/tmp/depot","repoKey":"fedcba9876543210",\
        "key":"/tmp/etat/audits/0123456789abcdef","orientation":"accessibilité VoiceOver","status":"launched",\
        "createdAt":1,"updatedAt":2,"proposal":null,"launches":[\(launches)],"failure":null}
        """
        return AuditRecord(json: try #require(JSONValue.parse(Data(text.utf8))))
    }
    let launched = try #require(try record(#"{"slug":"a","launched":true,"reason":null,"state":"running","phase":"impl","prUrl":null}"#))
    #expect(launched.launches == [AuditLaunchOutcome(slug: "a", launched: true, reason: nil, state: .running, phase: .impl, prUrl: nil)])
    #expect(launched.proposal == nil)
    #expect(try record(#"{"slug":"a","launched":true,"state":"running","phase":"impl","prUrl":null}"#) == nil)
    #expect(try record(#"{"slug":"a","launched":true,"reason":null,"state":"perdu","phase":"impl","prUrl":null}"#) == nil)
    #expect(try record("", version: "2") == nil)
}

@Test("audit-panel-in-omp-console : la feuille du brief nomme la première rubrique absente, dans l’ordre du service")
func auditBriefMissingRubric() throws {
    let draft = try #require(card(AuditParity.board, AuditParity.proposedId)?.briefDraft)
    #expect(AuditBrief.sections == ["But", "Fonction", "Décisions", "Contraintes", "Non-objectifs", "Orientation", "Constats"])
    #expect(AuditBrief.missingRubric(draft) == nil)
    #expect(AuditBrief.missingRubric(draft.replacingOccurrences(of: "## Constats", with: "Constats")) == "Constats")
    #expect(AuditBrief.missingRubric(draft.replacingOccurrences(of: "## Fonction", with: "### Fonction").replacingOccurrences(of: "## Orientation", with: "")) == "Fonction")
    #expect(AuditBrief.missingRubric("") == "But")
    #expect(AuditText.briefIncomplete(rubric: "Constats").hasPrefix("Le brief est incomplet"))
}
