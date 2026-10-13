// La parité Mac ↔ iPhone de la liste des attentes (attentes-dispersees-entre-
// sources, S-7 et S-8) : la VRAIE pile distante sur un magasin réel, une conduite
// et une session hébergée scriptées, un client appairé. Le Mac calcule la liste
// localement, l'iPhone la calcule depuis ce que le Mac lui renvoie.
//
// Ce fichier vit dans OMPConsoleTests parce qu'il a besoin de `RemoteStack` ; les
// `Remote…` de ConsoleClient y sont qualifiés quand un homonyme interne existe.

import ConsoleClient
import ConsoleCore
import Darwin
import Foundation
import Testing
@testable import OMPConsole

@MainActor
private final class SilentDiscovery: DiscoverySource {
    var onChange: (([DiscoveredMac]) -> Void)?
    var onProtocolVersion: ((Int) -> Void)?
    var onDenied: ((Bool) -> Void)?
    func start(serviceType: String) {}
    func stop() {}
}

@MainActor
private final class SilentPath: ClientPathSource {
    var onChange: ((Bool) -> Void)?
    func start() {}
    func stop() {}
}

/// Les instants de la fixture, distincts et rangés hors de l'ordre des sources.
private enum Instants {
    static let start: Double = 1_699_999_000_000
    static let session: Double = 1_700_000_001_000
    static let review: Double = 1_700_000_002_000
    static let audit: Double = 1_700_000_003_000
    static let ask: Double = 1_700_000_004_000
    static let conduite: Double = 1_700_000_005_000
    static let specs: Double = 1_700_000_006_000
}

private let parityRepoRoot = "/tmp/attentes-parite/depot"
private let parityAuditId = "a0d1700000000077"

/// Publie sur le disque une question en vol, un jalon specs, un jalon revue et une
/// escalade d'audit (portée par `f-audit`, lancée par un audit vivant).
private func publishPendingStore(_ fixture: StoreFixture) {
    let pid = Double(getpid())
    let repoKey = KanbanRepoKey.key(forRoot: parityRepoRoot)
    let runId = fixtureId(0xA77)
    let worktree = "\(parityRepoRoot)/f-question"
    let auditKey = joinPath(fixture.directory(.audits), parityAuditId)

    fixture.publish(.running, "\(runId).json", object: runningObject(
        id: runId,
        cwd: worktree,
        phaseStartedAt: Instants.start,
        updatedAt: Instants.ask,
        ownerPid: pid,
        inbox: fixture.createBox("\(runId)-1"),
        pendingAsk: [
            "toolCallId": "call-1",
            "id": "ask-1",
            "question": "On garde le cache entre deux lancements ?",
            "options": [
                ["label": "Le garder"],
                ["label": "Le vider", "description": "repartir de zéro"],
            ],
        ]
    ))

    var audited = lotFeatureObject(slug: "f-audit", state: "waiting", phase: "req", waitKind: "answer", sinceAt: Instants.start)
    audited["auditSession"] = auditKey
    audited["escalation"] = [
        "key": "ask:f-audit:call-9",
        "kind": "question",
        "phase": "req",
        "question": "Faut-il journaliser les erreurs du service ?",
        "options": ["Oui", "Non"],
        "reason": "Le brief ne dit rien du journal.",
        "at": Instants.audit,
    ]
    fixture.publish(.lots, "\(repoKey).json", object: lotObject(
        id: repoKey,
        repoRoot: parityRepoRoot,
        features: [
            lotFeatureObject(slug: "f-question", state: "running", phase: "impl", worktree: worktree, sinceAt: Instants.start),
            lotFeatureObject(slug: "f-specs", state: "waiting", phase: "specs", waitKind: "specs", sinceAt: Instants.specs),
            lotFeatureObject(slug: "f-review", state: "waiting", phase: "review", waitKind: "review", sinceAt: Instants.review),
            audited,
        ],
        ownerPid: pid
    ))

    fixture.publish(.audits, "\(parityAuditId).json", object: [
        "version": 1,
        "id": parityAuditId,
        "repoRoot": parityRepoRoot,
        "repoKey": repoKey,
        "key": auditKey,
        "orientation": "fiabilité du service",
        "status": "launched",
        "createdAt": Instants.start,
        "updatedAt": Instants.start,
        "proposal": NSNull(),
        "launches": [
            ["slug": "f-audit", "launched": true, "reason": NSNull(), "state": "running", "phase": "req", "prUrl": NSNull()],
        ],
        "failure": NSNull(),
    ])
}

/// Une conduite de projet vivante dont la file porte un dialogue horodaté.
@MainActor
private func conduiteWithDialog(repo: URL) async throws -> ProjectConsoleModel {
    let transport = ScriptedServiceTransport()
    emitProjectDialog(
        transport,
        id: "dlg-1",
        method: "select",
        title: "Quelle feature conduire d'abord ?",
        options: ["f-specs", "f-review"],
        optionDescriptions: ["la plus ancienne"],
        at: Instants.conduite
    )
    keepProjectAlive(transport)
    stubProjectConduite(transport, repo: repo.path)
    let model = makeProjectModel(host: makeScriptedProjectHost(transport), stateDir: try makeProjectStateDir())
    await model.startConduite(repoRoot: repo, name: "Mon projet")
    return model
}

/// Une session hébergée vivante, son flux gardé ouvert pour y pousser un dialogue.
@MainActor
private func hostedSession(root: URL) async throws -> (SessionConsoleModel, ScriptedServiceTransport) {
    let transport = ScriptedServiceTransport()
    let host = makeScriptedHostedHost(transport, sessionFile: "/tmp/attentes-parite/session.jsonl")
    let session = SessionConsoleModel(host: host)
    try await host.start(projectRoot: root, resumeFile: nil)
    return (session, transport)
}

@MainActor
@Suite("attentes-dispersees-entre-sources — parité Mac ↔ iPhone")
struct PendingRequestsParityTests {
    @Test("attentes-dispersees-entre-sources/AC-7 : l'iPhone calcule depuis le Mac exactement la liste que le Mac calcule localement")
    func iPhoneListEqualsMacList() async throws {
        let fixture = StoreFixture()
        publishPendingStore(fixture)

        let repo = try makeGitRepository()
        let sessionRoot = try makeGitRepository()
        defer {
            try? FileManager.default.removeItem(at: repo)
            try? FileManager.default.removeItem(at: sessionRoot)
        }
        let project = try await conduiteWithDialog(repo: repo)
        let (session, sessionTransport) = try await hostedSession(root: sessionRoot)
        // Une trame poussée avant l'ouverture du flux de la session serait perdue :
        // on attend la connexion, puis les deux files (5 s, la suite complète en
        // série charge le fil principal).
        try #require(await awaitTrue(timeout: 5.0) { sessionTransport.streamOpenCount >= 1 })
        emitServiceDialog(sessionTransport, id: "dlg-2", method: "confirm", title: "Arrêter la session ?", at: Instants.session)
        try #require(await awaitMainTrue(timeout: 5.0) {
            project.host.dialogQueue.count == 1 && session.host.dialogQueue.count == 1
        })

        let clock = MutableRemoteClock(Instants.specs + 60_000)
        let stack = try await RemoteStack.make(stateDir: fixture.root, clock: clock, projectModel: project, sessionModel: session)
        defer {
            stack.stop()
            project.stop()
        }
        #expect(await awaitTrue(timeout: 3.0) {
            let snapshot = stack.storeHub.current()
            return snapshot.running.entries.count == 1
                && snapshot.lots.lots.first?.features.count == 4
                && snapshot.audits.records.count == 1
        })

        let client = ConsoleClientModel(
            transport: ConsoleClient.URLSessionTransport(),
            discovery: SilentDiscovery(),
            preferences: InMemoryClientPreferences(),
            tokens: InMemoryTokenStore(),
            pacer: LiveClientPacer(),
            pathSource: SilentPath(),
            deviceName: "Tests",
            nowMs: { clock.nowMs }
        )
        defer { client.stop() }
        _ = client.setManualAddress("127.0.0.1:\(stack.port)")
        try await client.pair(code: try stack.registry.generateCode().value, deviceName: "Tests")

        let remote = try await client.pendingRequests()
        let local = LocalPendingRequests.list(storeHub: stack.storeHub, project: stack.project, session: stack.session)

        #expect(remote == local)
        #expect(local.count == 6)
        #expect(local.map(\.nature) == [
            .sessionDialog, .milestoneReview, .auditEscalation, .question, .conduiteDialog, .milestoneSpecs,
        ])
        #expect(local.map(\.at) == [
            Instants.session, Instants.review, Instants.audit, Instants.ask, Instants.conduite, Instants.specs,
        ])
    }
}
