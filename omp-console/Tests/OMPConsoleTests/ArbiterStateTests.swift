// Preuves de l'état partagé de l'arbitre (`ArbiterState`) et de ses lectures :
// décodage des marques du lot, dérivation, voie de l'ardoise, zones d'action,
// Accueil, notifications et fil des décisions. Fonctions pures et magasin réel ;
// aucune vue, aucun texte affiché vérifié.

import Foundation
import Testing
@testable import OMPConsole
@testable import ConsoleCore

private let auditSession = "/tmp/omp-arbitre/state/audits/a0d1700000000001"
private let arbiterRoot = "/tmp/omp-arbitre/depot"

/// Une feature de lot au format réel, complétée de `extra`.
private func featureObject(_ slug: String, state: String = "waiting", phase: String = "specs", waitKind: String? = "specs", extra: [String: Any] = [:]) -> [String: Any] {
    var object = lotFeatureObject(slug: slug, state: state, phase: phase, waitKind: waitKind)
    for (key, value) in extra { object[key] = value }
    return object
}

private func decode(_ object: [String: Any]) throws -> JSONValue {
    try #require(JSONValue.parse(JSONSerialization.data(withJSONObject: object)))
}

private func feature(_ object: [String: Any]) throws -> LotFeature {
    try #require(LotFeature(json: decode(object)))
}

private func lot(arbiter: Bool, features: [[String: Any]]) throws -> Lot {
    var object = lotObject(repoRoot: arbiterRoot, features: features)
    if arbiter { object["arbiter"] = true }
    return try #require(Lot(json: decode(object), nowMs: fixtureT0))
}

private var escalationJalon: [String: Any] {
    [
        "key": "specs:f:1", "kind": "jalon", "phase": "specs", "question": "Valider les specs ?",
        "options": [], "reason": "Les specs ne couvrent pas le brief.", "at": 42,
    ]
}

// MARK: - Décodage

@Test("arbitre-visible : les escalades de plafond et d’échec se décodent, l’étape d’arbitrage aussi (absente = en file)")
func arbiterMarksDecode() throws {
    for (raw, kind) in [("plafond", FeatureEscalationKind.plafond), ("echec", .echec), ("question", .question), ("jalon", .jalon)] {
        var escalation = escalationJalon
        escalation["kind"] = raw
        #expect(try feature(featureObject("f", extra: ["escalation": escalation])).escalation?.kind == kind)
    }
    var unknown = escalationJalon
    unknown["kind"] = "autre"
    #expect(try feature(featureObject("f", extra: ["escalation": unknown])).escalation == nil)

    let deciding = try feature(featureObject("f", extra: [
        "arbitration": ["key": "specs:f:1", "startedAt": 10, "status": "deciding", "decidingAt": 25],
    ])).arbitration
    #expect(deciding == FeatureArbitration(key: "specs:f:1", startedAt: 10, status: .deciding, decidingAt: 25))
    let legacy = try feature(featureObject("f", extra: ["arbitration": ["key": "specs:f:1", "startedAt": 10]])).arbitration
    #expect(legacy?.status == .queued && legacy?.decidingAt == nil)

    #expect(try lot(arbiter: true, features: [featureObject("f")]).arbiter == true)
    #expect(try lot(arbiter: false, features: [featureObject("f")]).arbiter == nil)
    #expect(try feature(featureObject("f", extra: ["quota": ["provider": "anthropic"]])).quotaBlocked == true)

    // Le transport garde l'étape, et un arbitrage transporté sans étape se lit en file.
    let encoded = try JSONEncoder().encode(deciding)
    #expect(try JSONDecoder().decode(FeatureArbitration.self, from: encoded) == deciding)
    let old = try JSONDecoder().decode(FeatureArbitration.self, from: Data(#"{"key":"k","startedAt":3}"#.utf8))
    #expect(old == FeatureArbitration(key: "k", startedAt: 3))
}

// MARK: - Dérivation

@Test("arbitre-visible : l’escalade prime, puis la marque d’arbitrage et son étape")
func arbiterStateFromMarks() throws {
    let escalated = try feature(featureObject("f", extra: ["escalation": escalationJalon, "auditSession": auditSession]))
    #expect(ArbiterState.of(lot: nil, feature: escalated, pendingAsk: true) == .escalated(kind: .jalon, reason: "Les specs ne couvrent pas le brief."))

    let queued = try feature(featureObject("f", extra: ["arbitration": ["key": "k", "startedAt": 10]]))
    #expect(ArbiterState.of(lot: nil, feature: queued, pendingAsk: false) == .queued(since: 10))

    let deciding = try feature(featureObject("f", extra: ["arbitration": ["key": "k", "startedAt": 10, "status": "deciding", "decidingAt": 30]]))
    #expect(ArbiterState.of(lot: nil, feature: deciding, pendingAsk: false) == .deciding(since: 30))
    #expect(ArbiterState.deciding(since: 30).isArbitrating && ArbiterState.queued(since: nil).isArbitrating)
    #expect(!ArbiterState.none.isArbitrating && !ArbiterState.escalated(kind: .echec, reason: "r").isArbitrating)
}

@Test("arbitre-visible : dans un lot piloté par le service, une feature d’audit qui demanderait l’utilisateur est en file avant la marque")
func arbiterStateFromServiceLot() throws {
    let audit: [String: Any] = ["auditSession": auditSession]
    let cap = "plafond de 3 tours de correction atteint, revue toujours bloquante"
    let cases: [(object: [String: Any], pendingAsk: Bool, held: Bool)] = [
        (featureObject("specs", extra: audit), false, true),
        (featureObject("revue", phase: "review", waitKind: "review", extra: audit), false, true),
        (featureObject("question", phase: "req", waitKind: "answer", extra: audit), false, true),
        (featureObject("ask", state: "running", phase: "req", waitKind: nil, extra: audit), true, true),
        (featureObject("echec", state: "failed", phase: "impl", waitKind: nil, extra: audit), false, true),
        (featureObject("plafond", state: "blocked", phase: "review", waitKind: nil, extra: audit.merging(["stopReason": cap]) { $1 }), false, true),
        (featureObject("bloquee", state: "blocked", phase: "impl", waitKind: nil, extra: audit.merging(["stopReason": "run illisible"]) { $1 }), false, true),
        // Ni la dépendance, ni le quota, ni un run qui tourne, ni une feature hors audit.
        (featureObject("dependance", state: "blocked", phase: "req", waitKind: nil, extra: audit.merging(["stopReason": "dépend de amont"]) { $1 }), false, false),
        (featureObject("quota", state: "blocked", phase: "impl", waitKind: nil, extra: audit.merging(["quota": ["provider": "anthropic"]]) { $1 }), false, false),
        (featureObject("tourne", state: "running", phase: "impl", waitKind: nil, extra: audit), false, false),
        (featureObject("hors-audit"), false, false),
    ]
    let served = try lot(arbiter: true, features: cases.map(\.object))
    let unserved = try lot(arbiter: false, features: cases.map(\.object))
    for (index, item) in cases.enumerated() {
        let slug = served.features[index].slug
        let state = ArbiterState.of(lot: served, feature: served.features[index], pendingAsk: item.pendingAsk)
        #expect(state == (item.held ? .queued(since: nil) : .none), "\(slug)")
        #expect(ArbiterState.of(lot: unserved, feature: unserved.features[index], pendingAsk: item.pendingAsk) == .none, "\(slug) hors service")
    }
}

// MARK: - Voie, statut et gestes

private func lotCard(_ column: KanbanColumn, arbiter: ArbiterState, waitKind: LotWaitKind? = .specs, state: LotFeatureState = .waiting, ask: Bool = false) -> KanbanCard {
    let run = ask ? KanbanCardRun(
        id: "aaaaaaaaaaaaaaa1", label: "depot/f", inbox: "/tmp/inbox",
        pendingAsk: PanelPendingAsk(toolCallId: "call-1", id: "q", question: "On garde ?", options: [])
    ) : nil
    return KanbanCard(
        id: "feature:k:f", column: column, repo: "depot", title: "f", state: "x", phase: .specs,
        models: nil, prUrl: nil, startMs: 0, endMs: nil, marks: [], sources: [],
        action: KanbanCardAction(repoRoot: arbiterRoot, slug: "f", waitKind: waitKind, featureState: state, run: run, waitPrompt: "Quelle suite ?", arbiter: arbiter)
    )
}

@Test("arbitre-visible : ce que l’arbitre tient quitte « À vous » ; ce qu’il rend — plafond et échec compris — y va")
func arbiterLanePlacement() {
    #expect(KanbanLane.of(lotCard(.jalonSpecs, arbiter: .queued(since: nil))) == .arbitre)
    #expect(KanbanLane.of(lotCard(.questionEnVol, arbiter: .deciding(since: 1), ask: true)) == .arbitre)
    #expect(KanbanLane.of(lotCard(.echec, arbiter: .deciding(since: 1), waitKind: nil, state: .failed)) == .arbitre)
    #expect(KanbanLane.of(lotCard(.jalonSpecs, arbiter: .escalated(kind: .jalon, reason: "r"))) == .aVous)
    #expect(KanbanLane.of(lotCard(.bloquee, arbiter: .escalated(kind: .plafond, reason: "r"), waitKind: nil, state: .blocked)) == .aVous)
    #expect(KanbanLane.of(lotCard(.echec, arbiter: .escalated(kind: .echec, reason: "r"), waitKind: nil, state: .failed)) == .aVous)
    #expect(KanbanLane.of(lotCard(.jalonSpecs, arbiter: .none)) == .aVous)

    // La voie n'apparaît que si elle a des cartes.
    #expect(!KanbanBoard(cards: [], anomalies: []).lanes.contains { $0.lane == .arbitre })
    let held = lotCard(.jalonSpecs, arbiter: .queued(since: nil))
    #expect(KanbanBoard(cards: [held], anomalies: []).lanes.first { $0.lane == .arbitre }?.cards == [held])

    // Le motif n'est porté que par une carte rendue.
    #expect(KanbanCardPresentation.arbiterMotive(held) == nil)
    #expect(KanbanCardPresentation.arbiterMotive(lotCard(.jalonSpecs, arbiter: .escalated(kind: .jalon, reason: "r"))) != nil)
}

@Test("arbitre-visible : tant que l’arbitre tient l’élément, ni Répondre, ni Valider, ni Relancer — une zone d’arbitre à leur place")
func arbiterGatesZones() {
    func hasAnswerOrMilestone(_ zones: [KanbanActionZone]) -> Bool {
        zones.contains { zone in
            switch zone {
            case .pendingQuestion, .textQuestion, .milestone: true
            default: false
            }
        }
    }
    let held: [KanbanCard] = [
        lotCard(.jalonSpecs, arbiter: .queued(since: nil)),
        lotCard(.jalonReview, arbiter: .deciding(since: 3), waitKind: .review),
        lotCard(.questionEnVol, arbiter: .queued(since: 2), waitKind: .answer),
        lotCard(.questionEnVol, arbiter: .deciding(since: 2), waitKind: nil, state: .running, ask: true),
    ]
    for card in held {
        let zones = KanbanActionPresentation.zones(for: card)
        #expect(!hasAnswerOrMilestone(zones))
        #expect(zones.contains(.arbiter(card.action!.arbiter)))
        #expect(MainSheetPolicy.answerZone(for: card) == nil)
    }
    #expect(!KanbanActionPresentation.relaunchable(lotCard(.echec, arbiter: .deciding(since: 1), waitKind: nil, state: .failed)))
    #expect(KanbanActionPresentation.relaunchable(lotCard(.echec, arbiter: .escalated(kind: .echec, reason: "r"), waitKind: nil, state: .failed)))

    // Rendu à l'utilisateur ou hors arbitre : les gestes reviennent.
    for arbiter in [ArbiterState.none, .escalated(kind: .jalon, reason: "r")] {
        let zones = KanbanActionPresentation.zones(for: lotCard(.jalonSpecs, arbiter: arbiter))
        #expect(zones.contains(.milestone(slug: "f", kind: .specs)))
        #expect(!zones.contains { if case .arbiter = $0 { true } else { false } })
    }
}

@Test("arbitre-visible : l’Accueil range ce que l’arbitre tient dans « En cours », jamais dans les attentes ni leurs comptes")
func arbiterHomeDashboard() {
    let held = lotCard(.jalonSpecs, arbiter: .queued(since: nil))
    var failingHeld = lotCard(.echec, arbiter: .deciding(since: 1), waitKind: nil, state: .failed)
    failingHeld.id = "feature:k:e"
    var escalated = lotCard(.jalonReview, arbiter: .escalated(kind: .jalon, reason: "r"), waitKind: .review)
    escalated.id = "feature:k:g"
    var capped = lotCard(.bloquee, arbiter: .escalated(kind: .plafond, reason: "r"), waitKind: nil, state: .blocked)
    capped.id = "feature:k:h"
    let board = KanbanBoard(cards: [held, failingHeld, escalated, capped], anomalies: [])

    let dashboard = HomePresentation.dashboard(board)
    #expect(dashboard.running.map(\.id) == [held.id, failingHeld.id])
    #expect(dashboard.attention.map(\.id) == [escalated.id, capped.id])
    #expect(dashboard.attention.allSatisfy { $0.motive != nil })
    #expect(HomePresentation.counts(board) == HomeCounts(attention: 2, running: 2))
    #expect(HomePresentation.cardAction(dashboard.attention[0]) == .accept)
    #expect(HomePresentation.cardAction(dashboard.attention[1]) == .relaunch)
}

// MARK: - Notifications

@Test("arbitre-visible : aucune notification tant que l’arbitre tient l’élément ; l’escalade notifie, motif dans le corps")
func arbiterSuppressesAlerts() throws {
    let fixture = StoreFixture()
    let key = fixtureId(0xe1)
    let repoKey = KanbanRepoKey.key(forRoot: arbiterRoot)
    func publish(_ features: [[String: Any]], arbiter: Bool) {
        var object = lotObject(id: key, repoRoot: arbiterRoot, features: features)
        if arbiter { object["arbiter"] = true }
        fixture.publish(.lots, "\(key).json", object: object)
    }
    let audit: [String: Any] = ["auditSession": auditSession]
    let marked = featureObject("specs", extra: ["arbitration": ["key": "specs:specs:1", "startedAt": 10]])
    let pending = featureObject("revue", phase: "review", waitKind: "review", extra: audit)
    let failed = featureObject("echec", state: "failed", phase: "impl", waitKind: nil, extra: audit)

    publish([marked, pending, failed], arbiter: true)
    #expect(alertEvents(fixture).isEmpty)

    // Hors service, la même feature d'audit sans marque notifie comme avant.
    publish([pending], arbiter: false)
    #expect(alertEvents(fixture).map(\.key) == ["milestone:\(repoKey):revue:review"])

    // L'escalade : l'évènement normal, une fois, avec le motif après le nom.
    var escalation = escalationJalon
    escalation["key"] = "specs:specs:1"
    let escalated = featureObject("specs", extra: audit.merging(["escalation": escalation]) { $1 })
    publish([escalated], arbiter: true)
    let events = alertEvents(fixture)
    #expect(events.map(\.key) == ["milestone:\(repoKey):specs:specs"])
    #expect(events.first?.body.hasPrefix("specs\n") == true)
    #expect(events.first?.body.contains("Les specs ne couvrent pas le brief.") == true)
}

// MARK: - Fil des décisions

private func journalLine(_ fields: [String: Any]) throws -> String {
    var line: [String: Any] = [
        "version": 1, "slug": "f", "phase": "specs", "kind": "jalon",
        "question": "Valider les specs ?", "answer": "v", "source": "arbitrage", "at": 1,
    ]
    for (key, value) in fields { line[key] = value }
    return try #require(String(data: JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]), encoding: .utf8))
}

@Test("arbitre-visible : le fil lit chaque journal depuis la fin, écarte les notes de contexte et les lignes illisibles, garde le motif")
func decisionFeedParsesJournal() throws {
    let lines = [
        try journalLine(["at": 1, "source": "contexte", "kind": "question", "answer": "déjà tranché"]),
        "pas du JSON",
        try journalLine(["at": 2, "kind": "contexte", "source": "contexte"]),
        try journalLine(["at": 3, "justification": ["reason": "Les specs couvrent le brief.", "citations": [], "references": [], "rubriques": []]]),
        try journalLine(["at": 4, "kind": "plafond", "source": "utilisateur", "justification": ["reason": "  "]]),
        try journalLine(["at": 5, "kind": "inconnue"]),
    ]
    let text = lines.joined(separator: "\n") + "\n"
    let data = Data(text.utf8)
    let decisions = ArbiterDecisionFeed.decisions(journal: data, repoKey: "0123456789abcdef", firstByte: 100, parse: JSONValue.parse)
    #expect(decisions.map(\.at) == [4, 3, 1])
    #expect(decisions.map(\.source) == [.utilisateur, .arbitrage, .contexte])
    #expect(decisions.map(\.reason) == [nil, "Les specs couvrent le brief.", nil])
    // L'identité est l'offset de la ligne dans le fichier : stable quand le journal grandit.
    let offsetOfThird = lines.prefix(3).map { $0.utf8.count + 1 }.reduce(0, +)
    #expect(decisions[1].offset == 100 + offsetOfThird)
    let grown = ArbiterDecisionFeed.decisions(journal: data + Data((try journalLine(["at": 6]) + "\n").utf8), repoKey: "0123456789abcdef", firstByte: 100, parse: JSONValue.parse)
    #expect(grown.dropFirst().map(\.id) == decisions.map(\.id))
    #expect(ArbiterDecisionFeed.decisions(journal: data, repoKey: "k", limit: 1, parse: JSONValue.parse).map(\.at) == [4])
}

@Test("arbitre-visible : le fil de plusieurs journaux est le plus récent d’abord, borné")
func decisionFeedMergesNewestFirst() {
    func decision(_ repoKey: String, _ offset: Int, at: Double) -> ArbiterDecision {
        ArbiterDecision(repoKey: repoKey, offset: offset, slug: "f", phase: "req", kind: .question, question: "q", answer: "a", source: .arbitrage, reason: nil, at: at)
    }
    let a = [decision("aaaaaaaaaaaaaaaa", 30, at: 30), decision("aaaaaaaaaaaaaaaa", 10, at: 10)]
    let b = [decision("bbbbbbbbbbbbbbbb", 20, at: 30), decision("bbbbbbbbbbbbbbbb", 0, at: 5)]
    #expect(ArbiterDecisionFeed.merge([a, b]).map(\.id) == [
        "aaaaaaaaaaaaaaaa:30", "bbbbbbbbbbbbbbbb:20", "aaaaaaaaaaaaaaaa:10", "bbbbbbbbbbbbbbbb:0",
    ])
    #expect(ArbiterDecisionFeed.merge([a, b], limit: 2).count == 2)
}

@Test("arbitre-visible : le lecteur du magasin rend le fil de TOUS les journaux, audits ou non")
func storeReaderReadsEveryJournal() throws {
    let fixture = StoreFixture()
    fixture.put(.journal, "aaaaaaaaaaaaaaaa.jsonl", text: try journalLine(["at": 7, "slug": "a"]) + "\n")
    fixture.put(.journal, "bbbbbbbbbbbbbbbb.jsonl", text: try journalLine(["at": 9, "slug": "b"]) + "\n")
    fixture.put(.journal, "pas-une-cle.jsonl", text: try journalLine(["at": 8, "slug": "x"]) + "\n")
    let feed = StoreReader(stateDir: fixture.root).readAudits().feed
    #expect(feed.map(\.slug) == ["b", "a"])
    #expect(feed.map(\.repoKey) == ["bbbbbbbbbbbbbbbb", "aaaaaaaaaaaaaaaa"])
}
