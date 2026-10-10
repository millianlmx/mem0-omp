// Preuves de S-2 : les métriques d'une session, réduites par des fonctions pures.
//
// Les sessions de fixture sont ÉCRITES à l'exécution dans un répertoire temporaire
// (`ViewerSessionFixture`) — jamais un `.jsonl` versionné.

import Foundation
import Testing

@testable import OMPConsole

/// Les lignes d'une session synthétique, au format réel de l'hôte.
private enum SessionLines {
    static func json(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
            return "{}"
        }
        return String(decoding: data, as: UTF8.self)
    }

    static func entry(_ type: String, id: String, timestamp: String, _ payload: [String: Any]) -> String {
        var object: [String: Any] = ["type": type, "id": id, "timestamp": timestamp]
        for (key, value) in payload { object[key] = value }
        return json(object)
    }

    static func header(stamp: String = "2026-09-30T07:59:59.000Z") -> String {
        entry("session", id: "session-1", timestamp: stamp, ["id": "session-1", "timestamp": stamp, "cwd": "/tmp/projet", "version": 3])
    }

    static func user(_ body: String, id: String, stamp: String) -> String {
        entry("message", id: id, timestamp: stamp, [
            "parentId": NSNull(),
            "message": ["role": "user", "content": [["type": "text", "text": body]]],
        ])
    }

    /// Une réponse assistant ; `usage` n'est écrit QUE quand il porte une valeur.
    /// `withCacheKeys: false` écrit un `usage` SANS `cacheRead`/`cacheWrite`.
    static func assistant(
        id: String,
        stamp: String,
        model: String? = nil,
        input: Int? = nil,
        output: Int? = nil,
        cacheRead: Int = 0,
        cacheWrite: Int = 0,
        withCacheKeys: Bool = true,
        stopReason: String? = "toolUse"
    ) -> String {
        var message: [String: Any] = [
            "role": "assistant",
            "content": [["type": "text", "text": "réponse"]],
        ]
        if let model { message["model"] = model }
        if let stopReason { message["stopReason"] = stopReason }
        if let input, let output {
            var usage: [String: Any] = ["input": input, "output": output, "totalTokens": input + output]
            if withCacheKeys {
                usage["cacheRead"] = cacheRead
                usage["cacheWrite"] = cacheWrite
            }
            message["usage"] = usage
        }
        return entry("message", id: id, timestamp: stamp, ["parentId": NSNull(), "message": message])
    }
}

private func readMetrics(_ fixture: ViewerSessionFixture) -> SessionMetrics {
    let reader = SessionReader(path: fixture.path)
    _ = reader.read()
    return sessionMetrics(reader.conversation)
}

// MARK: - AC-1

@Test("statistiques/AC-1 : tokens, tours, modèle et bornes égalent ce que porte la session")
func metricsEqualWhatTheSessionCarries() throws {
    let fixture = try ViewerSessionFixture()
    defer { fixture.remove() }
    try fixture.write([
        SessionLines.header(),
        SessionLines.user("premier prompt", id: "u1", stamp: "2026-09-30T08:00:00.000Z"),
        SessionLines.assistant(id: "a1", stamp: "2026-09-30T08:00:10.000Z", model: "m1", input: 100, output: 20),
        SessionLines.user("second prompt", id: "u2", stamp: "2026-09-30T08:01:00.000Z"),
        SessionLines.assistant(id: "a2", stamp: "2026-09-30T08:01:30.000Z", model: "m2", input: 5, output: 7),
    ])

    let metrics = readMetrics(fixture)
    #expect(metrics.input == 105)
    #expect(metrics.output == 27)
    #expect(metrics.turns == 2)
    // Le modèle est celui de la DERNIÈRE réponse qui en porte un.
    #expect(metrics.model == "m2")
    #expect(metrics.firstMs == 1_790_755_200_000)
    #expect(metrics.lastMs == 1_790_755_290_000)
    // Durée d'un run clos : de la première à la dernière entrée horodatée.
    #expect(durationMs(metrics, isLive: false, nowMs: 0) == 90_000)
}

@Test("ios-stats-tokens-envoyes-incoherent/AC-1, AC-3 : le cache lu et écrit se somme à part, une clé absente vaut 0")
func metricsSumTheCacheApart() throws {
    let fixture = try ViewerSessionFixture()
    defer { fixture.remove() }
    try fixture.write([
        SessionLines.header(),
        SessionLines.user("premier prompt", id: "u1", stamp: "2026-09-30T08:00:00.000Z"),
        SessionLines.assistant(
            id: "a1", stamp: "2026-09-30T08:00:10.000Z", input: 2, output: 233, cacheRead: 13_206, cacheWrite: 14_936
        ),
        SessionLines.assistant(
            id: "a2", stamp: "2026-09-30T08:00:20.000Z", input: 74, output: 40_000, cacheRead: 20_000, cacheWrite: 1_000
        ),
    ])
    let metrics = readMetrics(fixture)
    // `input` reste l'entrée HORS cache : le cache ne s'y mélange jamais.
    #expect(metrics.input == 76)
    #expect(metrics.output == 40_233)
    #expect(metrics.cacheRead == 33_206)
    #expect(metrics.cacheWrite == 15_936)

    let bare = try ViewerSessionFixture()
    defer { bare.remove() }
    try bare.write([
        SessionLines.header(),
        SessionLines.user("prompt", id: "u1", stamp: "2026-09-30T08:00:00.000Z"),
        SessionLines.assistant(id: "a1", stamp: "2026-09-30T08:00:10.000Z", input: 10, output: 3, withCacheKeys: false),
        SessionLines.assistant(id: "a2", stamp: "2026-09-30T08:00:20.000Z", input: 5, output: 1, withCacheKeys: false),
    ])
    let noCache = readMetrics(bare)
    #expect(noCache.cacheRead == 0)
    #expect(noCache.cacheWrite == 0)
    #expect(noCache.input == 15)
    #expect(noCache.output == 4)
}

@Test("statistiques/AC-1 : un run `-p` réel porte UN tour, jamais compté sur la réponse finale")
func pipRunCountsOneTurn() throws {
    let fixture = try ViewerSessionFixture()
    defer { fixture.remove() }
    var lines = [SessionLines.header(), SessionLines.user("prompt du pipeline", id: "u1", stamp: "2026-09-30T08:00:00.000Z")]
    // Des centaines d'assistants, AUCUN `stopReason:"stop"` (le cas des runs `-p`).
    for index in 0..<50 {
        lines.append(
            SessionLines.assistant(
                id: "a\(index)",
                stamp: "2026-09-30T08:00:\(String(format: "%02d", index % 60)).500Z",
                model: "m",
                input: 1,
                output: 1,
                stopReason: "toolUse"
            )
        )
    }
    try fixture.write(lines)

    let metrics = readMetrics(fixture)
    #expect(metrics.turns == 1)
    #expect(metrics.input == 50)
    #expect(metrics.output == 50)
}

@Test("statistiques/AC-1 : session vide, entrée sans usage et horodatage illisible")
func edgeCasesOfTheReduction() throws {
    // Session vide (en-tête seul) : zéro partout, aucune borne.
    let empty = try ViewerSessionFixture(fileName: "2026-09-30T08-00-00-000Z_empty.jsonl")
    defer { empty.remove() }
    try empty.write([SessionLines.header()])
    let emptyMetrics = readMetrics(empty)
    #expect(emptyMetrics.input == 0)
    #expect(emptyMetrics.output == 0)
    #expect(emptyMetrics.turns == 0)
    #expect(emptyMetrics.model == nil)
    #expect(emptyMetrics.firstMs == nil)
    #expect(emptyMetrics.lastMs == nil)
    #expect(durationMs(emptyMetrics, isLive: false, nowMs: 0) == nil)

    // Entrée assistant sans `usage` : elle ne contribue à rien ; un modèle vide
    // ne remplace pas le modèle courant.
    let bare = try ViewerSessionFixture(fileName: "2026-09-30T08-00-01-000Z_bare.jsonl")
    defer { bare.remove() }
    try bare.write([
        SessionLines.header(),
        SessionLines.user("prompt", id: "u1", stamp: "2026-09-30T08:00:00.000Z"),
        SessionLines.assistant(id: "a1", stamp: "2026-09-30T08:00:01.000Z", model: "modele", input: 4, output: 6),
        SessionLines.assistant(id: "a2", stamp: "2026-09-30T08:00:02.000Z", stopReason: nil),
    ])
    let bareMetrics = readMetrics(bare)
    #expect(bareMetrics.input == 4)
    #expect(bareMetrics.output == 6)
    #expect(bareMetrics.model == "modele")

    // Une seule entrée horodatée : durée 0.
    let single = try ViewerSessionFixture(fileName: "2026-09-30T08-00-02-000Z_single.jsonl")
    defer { single.remove() }
    try single.write([
        SessionLines.header(),
        SessionLines.user("seul", id: "u1", stamp: "2026-09-30T08:00:00.000Z"),
    ])
    #expect(durationMs(readMetrics(single), isLive: false, nowMs: 0) == 0)

    // Horodatage illisible : ignoré pour les bornes, JAMAIS pour les compteurs.
    let bad = try ViewerSessionFixture(fileName: "2026-09-30T08-00-03-000Z_bad.jsonl")
    defer { bad.remove() }
    try bad.write([
        SessionLines.header(),
        SessionLines.user("compté", id: "u1", stamp: "pas une date"),
        SessionLines.assistant(id: "a1", stamp: "non plus", input: 3, output: 1),
    ])
    let badMetrics = readMetrics(bad)
    #expect(badMetrics.turns == 1)
    #expect(badMetrics.input == 3)
    #expect(badMetrics.firstMs == nil)
    #expect(durationMs(badMetrics, isLive: false, nowMs: 0) == nil)
}

// MARK: - AC-2

@Test("statistiques/AC-2 : la durée est murale — un run vivant court jusqu'à l'instant de rendu")
func liveDurationIsWallClock() throws {
    let fixture = try ViewerSessionFixture()
    defer { fixture.remove() }
    try fixture.write([
        SessionLines.header(),
        SessionLines.user("prompt", id: "u1", stamp: "2026-09-30T08:00:00.000Z"),
        SessionLines.assistant(id: "a1", stamp: "2026-09-30T08:00:10.000Z", input: 1, output: 1),
    ])
    let metrics = readMetrics(fixture)
    // Clos : s'arrête à la dernière entrée.
    #expect(durationMs(metrics, isLive: false, nowMs: 1_790_755_999_000) == 10_000)
    // Vivant : court jusqu'à `nowMs`, donc l'attente d'une réponse est INCLUSE.
    #expect(durationMs(metrics, isLive: true, nowMs: 1_790_755_200_000) == 0)
    #expect(durationMs(metrics, isLive: true, nowMs: 1_790_755_240_000) == 40_000)
    // Une horloge reculée ne rend jamais une durée négative.
    #expect(durationMs(metrics, isLive: true, nowMs: 0) == 0)
}

@Test("statistiques/AC-2 : un incident de lecture se dit en toutes lettres, jamais par un montant")
func unreadableReasonsAreNamed() throws {
    // Fichier absent.
    #expect(statsUnreadableReason(.fileMissing) == "session introuvable")
    // Fichier illisible : le message OS est repris verbatim.
    #expect(statsUnreadableReason(.unreadable("Permission denied")) == "session illisible : Permission denied")
    // Une réécriture n'est jamais montrée.
    #expect(statsUnreadableReason(.truncated(previousBytes: 10, currentBytes: 4)) == nil)
    #expect(statsUnreadableReason(.replaced) == nil)

    // Le lecteur lui-même nomme l'absence.
    let reader = SessionReader(path: "/tmp/omp-console-inexistant-\(UUID().uuidString).jsonl")
    #expect(reader.read().issue == .fileMissing)

    // Une réécriture en place plus courte est vue comme `truncated`.
    let fixture = try ViewerSessionFixture()
    defer { fixture.remove() }
    try fixture.write([SessionLines.header(), SessionLines.user("prompt", id: "u1", stamp: "2026-09-30T08:00:00.000Z")])
    let rewrite = SessionReader(path: fixture.path)
    #expect(rewrite.read().issue == nil)
    try fixture.write([SessionLines.header()])
    let rewriteIssue = rewrite.read().issue
    guard case .truncated = rewriteIssue else {
        Issue.record("réécriture attendue en `truncated`, reçu \(String(describing: rewriteIssue))")
        return
    }
}

// MARK: - Horodatage porté par l'entrée

@Test("statistiques/AC-1 : chaque entrée porte son horodatage, avec ou sans fraction")
func entriesCarryTheirTimestamp() throws {
    let fixture = try ViewerSessionFixture()
    defer { fixture.remove() }
    try fixture.write([
        SessionLines.header(),
        SessionLines.user("avec fraction", id: "u1", stamp: "2026-09-30T08:00:00.136Z"),
        SessionLines.user("sans fraction", id: "u2", stamp: "2026-09-30T08:01:00Z"),
    ])
    let reader = SessionReader(path: fixture.path)
    _ = reader.read()
    let entries = reader.conversation.entries
    #expect(entries.count == 2)
    // L'analyse passe par des secondes `Double` : on compare à la sous-milliseconde.
    #expect(abs((entries[0].timestampMs ?? 0) - 1_790_755_200_136) < 0.01)
    #expect(abs((entries[1].timestampMs ?? 0) - 1_790_755_260_000) < 0.01)
    // Un horodatage absent laisse `nil` sans perdre l'entrée.
    let absent = try ViewerSessionFixture(fileName: "2026-09-30T08-00-04-000Z_absent.jsonl")
    defer { absent.remove() }
    let line = SessionLines.user("sans clé", id: "u1", stamp: "2026-09-30T08:00:00.000Z")
        .replacingOccurrences(of: "\"timestamp\":\"2026-09-30T08:00:00.000Z\",", with: "")
    try absent.write([SessionLines.header(), line])
    let absentReader = SessionReader(path: absent.path)
    _ = absentReader.read()
    #expect(absentReader.conversation.entries.count == 1)
    #expect(absentReader.conversation.entries[0].timestampMs == nil)
}
