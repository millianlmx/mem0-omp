// Preuves de la lecture des audits sur le disque (audit-panel-in-omp-console S-5) :
// `StoreReader.readAudits` sur un vrai dossier de magasin, sans service, et la
// relecture de l'enveloppe par `StoreHub` après un ajout au journal.

import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

private let repoKey = "0123456789abcdef"
private let auditA = "a0d1700000000001"
private let auditB = "a0d1700000000002"

private func appAuditObject(_ fixture: StoreFixture, id: String, orientation: String, status: String = "launched", launches: [[String: Any]] = []) -> [String: Any] {
    [
        "version": 1,
        "id": id,
        "repoRoot": "/tmp/omp-audit-depot",
        "repoKey": repoKey,
        "key": joinPath(fixture.directory(.audits), id),
        "orientation": orientation,
        "status": status,
        "createdAt": fixtureT0,
        "updatedAt": fixtureT0,
        "proposal": NSNull(),
        "launches": launches,
        "failure": NSNull(),
    ]
}

private func auditJournalLine(context: String?, slug: String, source: String, question: String, answer: String, at: Double) -> String {
    var object: [String: Any] = [
        "version": 1, "at": at, "slug": slug, "phase": "req", "kind": "question",
        "question": question, "answer": answer, "source": source,
    ]
    object["context"] = context ?? NSNull()
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    return String(decoding: data, as: UTF8.self)
}

/// Une feature lancée par l'audit A, escaladée pendant l'absence de l'app.
private func escalatedFeature(_ fixture: StoreFixture, updatedAt: Double = fixtureT0) -> [String: Any] {
    var feature = lotFeatureObject(slug: "reprise-pipeline", state: "waiting", phase: "req", waitKind: "answer", sinceAt: updatedAt)
    feature["auditSession"] = joinPath(fixture.directory(.audits), auditA)
    feature["escalation"] = [
        "key": "question:reprise-pipeline:\(Int(updatedAt))",
        "kind": "question",
        "phase": "req",
        "question": "Reprendre automatiquement ?",
        "options": ["Oui", "Non"],
        "reason": "Absent du brief.",
        "at": updatedAt,
    ]
    return feature
}

@Test("audit-panel-in-omp-console-mac/AC-9 : à la réouverture, le magasin seul rend l’audit, la question posée pendant l’absence et le journal des décisions")
func readerRestoresAuditsFromDisk() throws {
    let fixture = StoreFixture()
    let launches: [[String: Any]] = [
        ["slug": "reprise-pipeline", "launched": true, "reason": NSNull(), "state": "running", "phase": "req", "prUrl": NSNull()],
    ]
    fixture.publish(.audits, "\(auditA).json", object: appAuditObject(fixture, id: auditA, orientation: "fiabilité des pipelines", launches: launches))
    fixture.publish(.audits, "\(auditB).json", object: appAuditObject(fixture, id: auditB, orientation: "performances", status: "stopped"))
    // Un fichier illisible et un audit au schéma invalide sont ÉCARTÉS et nommés.
    fixture.put(.audits, "a0d17000000000ff.json", text: "{ tronqué")
    var invalid = appAuditObject(fixture, id: "a0d17000000000fe", orientation: "x")
    invalid["status"] = "inconnu"
    fixture.publish(.audits, "a0d17000000000fe.json", object: invalid)
    // La feature escaladée pendant l'absence est dans le lot du dépôt.
    fixture.publish(.lots, "\(repoKey).json", object: lotObject(repoRoot: "/tmp/omp-audit-depot", features: [escalatedFeature(fixture)]))

    let keyA = joinPath(fixture.directory(.audits), auditA)
    let keyB = joinPath(fixture.directory(.audits), auditB)
    let lines = [
        auditJournalLine(context: keyA, slug: "reprise-pipeline", source: "contexte", question: "Quel format ?", answer: "JSON, d’après le brief.", at: fixtureT0 + 1),
        "pas du JSON",
        auditJournalLine(context: keyA, slug: "reprise-pipeline", source: "utilisateur", question: "Valider les specs ?", answer: "v", at: fixtureT0 + 2),
        auditJournalLine(context: nil, slug: "hors-audit", source: "arbitrage", question: "Hors audit ?", answer: "oui", at: fixtureT0 + 3),
        auditJournalLine(context: "/ailleurs/audits/0000000000000000", slug: "autre", source: "arbitrage", question: "Autre ?", answer: "oui", at: fixtureT0 + 4),
        auditJournalLine(context: keyB, slug: "perf", source: "arbitrage", question: "Mesurer ?", answer: "Oui.", at: fixtureT0 + 5),
        auditJournalLine(context: keyA, slug: "reprise-pipeline", source: "arbitrage", question: "Délai de reprise ?", answer: "30 s.", at: fixtureT0 + 6),
    ]
    fixture.put(.journal, "\(repoKey).jsonl", text: lines.joined(separator: "\n") + "\n")

    let snapshot = StoreReader(stateDir: fixture.root, clock: StoreClock(nowMs: { fixtureT0 })).readAll()
    let envelope = snapshot.audits
    #expect(envelope.availability == .present)
    #expect(envelope.records.map(\.id) == [auditA, auditB])
    #expect(envelope.discardedEntries == [
        DiscardedEntry(file: "audits/a0d17000000000fe.json", reason: .schema),
        DiscardedEntry(file: "audits/a0d17000000000ff.json", reason: .unparsable),
    ])
    // Seules les décisions de l'arbitre prises dans le contexte d'un audit connu,
    // dans l'ordre du journal ; la ligne illisible est ignorée.
    #expect(envelope.decisions.map(\.question) == ["Quel format ?", "Mesurer ?", "Délai de reprise ?"])
    #expect(envelope.decisions.map(\.auditId) == [auditA, auditB, auditA])

    let board = AuditBoard.of(snapshot)
    let card = try #require(board.audits.first { $0.id == auditA })
    #expect(card.orientation == "fiabilité des pipelines")
    #expect(card.escalations.map(\.question) == ["Reprendre automatiquement ?"])
    #expect(card.escalations.first?.key == "question:reprise-pipeline:\(Int(fixtureT0))")
    #expect(card.features.map(\.waiting) == [.escalated])
    #expect(card.decisions.map(\.answer) == ["30 s.", "JSON, d’après le brief."])
}

@Test("audit-panel-in-omp-console : un magasin sans audits/ rend une enveloppe absente, et un repoKey hors forme n’ouvre aucun journal")
func readerWithoutAuditsDirectory() {
    let fixture = StoreFixture(stores: [.lots])
    #expect(StoreReader(stateDir: fixture.root).readAudits() == AuditsEnvelope.absent)

    let full = StoreFixture()
    var record = appAuditObject(full, id: auditA, orientation: "x")
    record["repoKey"] = "../journal/secret"
    full.publish(.audits, "\(auditA).json", object: record)
    full.put(.journal, "secret.jsonl", text: auditJournalLine(context: joinPath(full.directory(.audits), auditA), slug: "a", source: "arbitrage", question: "Q", answer: "R", at: 1) + "\n")
    let envelope = StoreReader(stateDir: full.root).readAudits()
    #expect(envelope.records.map(\.id) == [auditA])
    #expect(envelope.decisions.isEmpty)
}

@Test("audit-panel-in-omp-console : le flux global relit les décisions quand le lot est réécrit après un ajout au journal")
func hubRereadsAuditsAfterJournalAppend() async throws {
    let fixture = StoreFixture()
    fixture.publish(.audits, "\(auditA).json", object: appAuditObject(fixture, id: auditA, orientation: "fiabilité"))
    fixture.publish(.lots, "\(repoKey).json", object: lotObject(repoRoot: "/tmp/omp-audit-depot", features: [escalatedFeature(fixture)]))
    let keyA = joinPath(fixture.directory(.audits), auditA)
    fixture.put(.journal, "\(repoKey).jsonl", text: auditJournalLine(context: keyA, slug: "reprise-pipeline", source: "contexte", question: "Q1", answer: "R1", at: fixtureT0 + 1) + "\n")

    let hub = StoreHub(stateDir: fixture.root, nowMs: { fixtureT0 })
    let seen = Recorder<StoreSnapshot>()
    let task = consume(hub.snapshots(), into: seen)
    defer {
        task.cancel()
        hub.stop()
    }
    #expect(await awaitTrue { seen.last?.audits.decisions.map(\.question) == ["Q1"] })

    // L'arbitre ajoute une ligne au journal EXISTANT (aucun événement du
    // répertoire), puis réécrit le lot (`clearArbitration`).
    let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: fixture.path(.journal, "\(repoKey).jsonl")))
    try handle.seekToEnd()
    try handle.write(contentsOf: Data((auditJournalLine(context: keyA, slug: "reprise-pipeline", source: "arbitrage", question: "Q2", answer: "R2", at: fixtureT0 + 2) + "\n").utf8))
    try handle.close()
    var cleared = escalatedFeature(fixture, updatedAt: fixtureT0 + 2)
    cleared["escalation"] = nil
    fixture.publish(.lots, "\(repoKey).json", object: lotObject(repoRoot: "/tmp/omp-audit-depot", features: [cleared]))

    #expect(await awaitTrue(timeout: 2.0) { seen.last?.audits.decisions.map(\.question) == ["Q1", "Q2"] })
    #expect(seen.last?.lots.lots.first?.features.first?.escalation == nil)
}
