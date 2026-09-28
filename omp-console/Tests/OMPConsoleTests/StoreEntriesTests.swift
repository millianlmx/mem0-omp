// Preuves de S-2 (entrées `running/` et `history/`) : AC-1, AC-2, AC-3, plus les
// règles de rejet et de coercition du dépôt qui ne sont pas visibles sur une entrée
// bien formée (pid non entier, chaîne vide, question mal formée, tri et bornes).

import Foundation
import Testing
@testable import OMPConsole

@Test("client-magasin-etat/AC-1 : une entrée running au format réel est rendue typée")
func runningEntryIsTyped() throws {
    let fixture = StoreFixture()
    let id = fixtureId(0x11)
    fixture.publish(
        .running,
        "\(id).json",
        object: runningObject(
            id: id,
            cwd: "/tmp/worktree-ac1",
            label: "mem0-omp/client-magasin-etat",
            phase: "impl",
            state: "waiting",
            phaseStartedAt: fixtureT0 - 5_000,
            updatedAt: fixtureT0 - 1_000,
            ownerPid: Double(getpid())
        )
    )
    let envelope = StoreReader(stateDir: fixture.root, clock: fixtureClock).readRunning()
    let entry = try #require(envelope.entries.first)
    #expect(entry.id == id)
    #expect(entry.cwd == "/tmp/worktree-ac1")
    #expect(entry.label == "mem0-omp/client-magasin-etat")
    #expect(entry.phase == .impl)
    #expect(entry.state == .waiting)
    #expect(entry.phaseStartedAt == fixtureT0 - 5_000)
    #expect(entry.updatedAt == fixtureT0 - 1_000)
    // Champs optionnels ABSENTS du fichier ⇒ nil, jamais une entrée rejetée.
    #expect(entry.sessionFile == nil)
    #expect(entry.sessionId == nil)
    #expect(entry.inbox == nil)
    #expect(entry.pendingAsk == nil)
    #expect(entry.isStale == false)
    #expect(envelope.discarded == 0)
}

@Test("client-magasin-etat/AC-2 : schéma incomplet et version 2 sont écartés, jamais rendus partiels")
func runningSchemaViolationsAreDiscarded() {
    let fixture = StoreFixture()
    let common = (
        cwd: "/tmp/worktree-ac2",
        started: fixtureT0 - 5_000,
        updated: fixtureT0 - 1_000,
        pid: Double(getpid())
    )
    // 1) champ requis MANQUANT (`label`).
    var incomplete = runningObject(
        id: fixtureId(0x21), cwd: common.cwd, phaseStartedAt: common.started,
        updatedAt: common.updated, ownerPid: common.pid
    )
    incomplete.removeValue(forKey: "label")
    fixture.publish(.running, "\(fixtureId(0x21)).json", object: incomplete)

    // 2) champ MAL TYPÉ (`phaseStartedAt` en chaîne).
    var mistyped = runningObject(
        id: fixtureId(0x22), cwd: common.cwd, phaseStartedAt: common.started,
        updatedAt: common.updated, ownerPid: common.pid
    )
    mistyped["phaseStartedAt"] = "1700000000000"
    fixture.publish(.running, "\(fixtureId(0x22)).json", object: mistyped)

    // 3) phase HORS LISTE.
    var unknownPhase = runningObject(
        id: fixtureId(0x23), cwd: common.cwd, phase: "audit", phaseStartedAt: common.started,
        updatedAt: common.updated, ownerPid: common.pid
    )
    unknownPhase["phase"] = "audit"
    fixture.publish(.running, "\(fixtureId(0x23)).json", object: unknownPhase)

    // 4) version 2 : un fichier d'une autre version ne se lit JAMAIS partiellement.
    var future = runningObject(
        id: fixtureId(0x24), cwd: common.cwd, phaseStartedAt: common.started,
        updatedAt: common.updated, ownerPid: common.pid
    )
    future["version"] = 2
    fixture.publish(.running, "\(fixtureId(0x24)).json", object: future)

    // 5) JSON INVALIDE (tronqué) — même traitement.
    fixture.put(.running, "\(fixtureId(0x25)).json", text: "{\"version\":1,")

    let envelope = StoreReader(stateDir: fixture.root, clock: fixtureClock).readRunning()
    #expect(envelope.entries.isEmpty)
    #expect(envelope.discarded == 5)
}

@Test("client-magasin-etat/AC-3 : history rend finalState, endedAt et phaseStartedAt")
func historyEntriesAreTyped() throws {
    let fixture = StoreFixture()
    let withSession = fixtureId(0x31)
    let withoutSession = fixtureId(0x32)
    fixture.publish(
        .history,
        "\(withSession).json",
        object: historyObject(
            id: withSession,
            cwd: "/tmp/worktree-ac3-a",
            phase: "review",
            finalState: "failed",
            phaseStartedAt: fixtureT0 - 9_000,
            endedAt: fixtureT0 - 2_000,
            sessionFile: "/Users/x/sessions/a.jsonl",
            sessionId: "01a0e808"
        )
    )
    fixture.publish(
        .history,
        "\(withoutSession).json",
        object: historyObject(
            id: withoutSession,
            cwd: "/tmp/worktree-ac3-b",
            phase: "release",
            finalState: "done",
            phaseStartedAt: fixtureT0 - 8_000,
            endedAt: fixtureT0 - 1_000
        )
    )
    let envelope = StoreReader(stateDir: fixture.root, clock: fixtureClock).readHistory()
    // Le plus récent d'abord.
    #expect(envelope.entries.map(\.id) == [withoutSession, withSession])
    let ended = try #require(envelope.entries.first)
    #expect(ended.finalState == .done)
    #expect(ended.endedAt == fixtureT0 - 1_000)
    #expect(ended.phaseStartedAt == fixtureT0 - 8_000)
    // La session ABSENTE vaut nil — et l'entrée est rendue quand même.
    #expect(ended.sessionFile == nil)
    #expect(ended.sessionId == nil)
    let failed = try #require(envelope.entries.last)
    #expect(failed.finalState == .failed)
    #expect(failed.sessionFile == "/Users/x/sessions/a.jsonl")
    #expect(failed.sessionId == "01a0e808")
    #expect(envelope.discarded == 0)
}

@Test("client-magasin-etat/AC-2 : une question `ask` bien formée est rendue, mal formée rejette l'entrée")
func pendingAskRules() throws {
    let fixture = StoreFixture()
    let good = fixtureId(0x41)
    fixture.publish(
        .running,
        "\(good).json",
        object: runningObject(
            id: good,
            cwd: "/tmp/worktree-ask",
            phaseStartedAt: fixtureT0 - 5_000,
            updatedAt: fixtureT0 - 1_000,
            ownerPid: Double(getpid()),
            pendingAsk: [
                "toolCallId": "call-1",
                "id": "ask-1",
                "question": "Quelle branche ?",
                "options": [
                    ["label": "main", "description": "la branche par défaut"],
                    ["label": "feat/x"],
                ],
            ]
        )
    )
    let envelope = StoreReader(stateDir: fixture.root, clock: fixtureClock).readRunning()
    let entry = try #require(envelope.entries.first)
    let ask = try #require(entry.pendingAsk)
    #expect(ask.toolCallId == "call-1")
    #expect(ask.id == "ask-1")
    #expect(ask.question == "Quelle branche ?")
    #expect(ask.options.count == 2)
    #expect(ask.options.first?.label == "main")
    #expect(ask.options.first?.description == "la branche par défaut")
    // Description ABSENTE ⇒ nil (jamais une option rejetée).
    #expect(ask.options.last?.description == nil)

    // `options` VIDE : la forme est invalide, donc l'ENTRÉE est rejetée (S-2).
    let emptyOptions = fixtureId(0x42)
    fixture.publish(
        .running,
        "\(emptyOptions).json",
        object: runningObject(
            id: emptyOptions,
            cwd: "/tmp/worktree-ask-b",
            phaseStartedAt: fixtureT0 - 5_000,
            updatedAt: fixtureT0 - 1_000,
            ownerPid: Double(getpid()),
            pendingAsk: ["toolCallId": "call-2", "id": "ask-2", "question": "?", "options": []]
        )
    )
    let afterEmpty = StoreReader(stateDir: fixture.root, clock: fixtureClock).readRunning()
    #expect(afterEmpty.entries.map(\.id) == [good])
    #expect(afterEmpty.discarded == 1)
}

@Test("client-magasin-etat/AC-2 : coercitions de `running` — chaîne vide, pid non entier, inbox mal typée")
func runningCoercions() throws {
    let fixture = StoreFixture()
    let id = fixtureId(0x51)
    var object = runningObject(
        id: id,
        cwd: "/tmp/worktree-coercion",
        phaseStartedAt: fixtureT0 - 5_000,
        updatedAt: fixtureT0 - 1_000,
        ownerPid: 1.5,
        sessionFile: ""
    )
    object["sessionId"] = 42
    object["inbox"] = ""
    fixture.publish(.running, "\(id).json", object: object)

    let envelope = StoreReader(stateDir: fixture.root, clock: fixtureClock).readRunning()
    let entry = try #require(envelope.entries.first)
    // Chaîne vide ou valeur non textuelle : « chaîne ou rien », sans rejet.
    #expect(entry.sessionFile == nil)
    #expect(entry.sessionId == nil)
    #expect(entry.inbox == nil)
    // Pid NON ENTIER : l'entrée est rendue, le pid vaut nil, l'entrée est périmée.
    #expect(entry.ownerPid == nil)
    #expect(entry.isStale)

    // `inbox` d'un type autre que chaîne/nul : LÀ, l'entrée est rejetée.
    let badInbox = fixtureId(0x52)
    var rejected = runningObject(
        id: badInbox,
        cwd: "/tmp/worktree-coercion-b",
        phaseStartedAt: fixtureT0 - 5_000,
        updatedAt: fixtureT0 - 1_000,
        ownerPid: Double(getpid())
    )
    rejected["inbox"] = 7
    fixture.publish(.running, "\(badInbox).json", object: rejected)
    let after = StoreReader(stateDir: fixture.root, clock: fixtureClock).readRunning()
    #expect(after.entries.map(\.id) == [id])
    #expect(after.discarded == 1)
}

@Test("client-magasin-etat/AC-1 : tri et bornes de lecture (200 en cours, 20 en historique)")
func readOrderAndLimits() {
    let fixture = StoreFixture()
    // Trois entrées en cours : la plus ANCIENNE d'abord, départage par `cwd` quand
    // `phaseStartedAt` est égal.
    let runs: [(id: Int, cwd: String, started: Double)] = [
        (0x100, "/tmp/z", fixtureT0 - 3_000),
        (0x101, "/tmp/a", fixtureT0 - 2_000),
        (0x102, "/tmp/b", fixtureT0 - 2_000),
    ]
    for run in runs {
        fixture.publish(
            .running,
            "\(fixtureId(run.id)).json",
            object: runningObject(
                id: fixtureId(run.id),
                cwd: run.cwd,
                phaseStartedAt: run.started,
                updatedAt: fixtureT0 - 500,
                ownerPid: Double(getpid())
            )
        )
    }
    let running = StoreReader(stateDir: fixture.root, clock: fixtureClock).readRunning().entries
    #expect(running.map(\.cwd) == ["/tmp/z", "/tmp/a", "/tmp/b"])

    // Historique : 21 entrées valides + 1 illisible ⇒ 20 rendues, 1 écartée, du plus
    // récent au plus ancien (le filtrage et le comptage PRÉCÈDENT le bornage).
    for index in 0..<21 {
        fixture.publish(
            .history,
            "\(fixtureId(0x200 + index)).json",
            object: historyObject(
                id: fixtureId(0x200 + index),
                cwd: "/tmp/h\(index)",
                phaseStartedAt: fixtureT0 - 9_000,
                endedAt: fixtureT0 - Double(index) * 1_000
            )
        )
    }
    fixture.put(.history, "\(fixtureId(0x2ff)).json", text: "pas du json")
    let history = StoreReader(stateDir: fixture.root, clock: fixtureClock).readHistory()
    #expect(history.entries.count == PipelineStore.historyReadLimit)
    #expect(history.entries.first?.id == fixtureId(0x200))
    #expect(history.entries.last?.id == fixtureId(0x200 + 19))
    #expect(history.discarded == 1)
    #expect(PipelineStore.runningReadLimit == 200)
}
