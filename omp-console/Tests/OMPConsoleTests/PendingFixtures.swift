// Les fixtures de la liste des attentes (attentes-dispersees-entre-sources, BR-2) :
// des instantanés du magasin décodés d'un littéral JSON, sur le patron de
// `HomeParity` et `AuditParity`, plus les files de dialogues de la conduite et de
// la session hébergée.
//
// La fixture principale porte UNE demande par source, à six instants distincts
// volontairement rangés hors de l'ordre des sources :
//   session (T1) < revue (T2) < audit (T3) < question en vol (T4)
//   < conduite (T5) < specs (T6).
// La feature `f-audit` attend aussi une réponse sur l'ardoise, mais son escalade
// est celle de l'audit : elle ne compte qu'une fois, comme escalade.

import ConsoleCore
import Foundation

enum PendingFixtures {
    static let repoRoot = "/tmp/attentes/depot"
    static let auditId = "a0d1700000000009"
    static let auditKey = "/tmp/attentes/state/audits/a0d1700000000009"
    static let questionRunId = "aaaaaaaaaaaaaaa1"
    static let start = 1_700_000_000_000

    static let tSession = 1_700_000_001_000
    static let tReview = 1_700_000_002_000
    static let tAudit = 1_700_000_003_000
    static let tAsk = 1_700_000_004_000
    static let tConduite = 1_700_000_005_000
    static let tSpecs = 1_700_000_006_000

    /// L'identifiant de carte d'une feature du lot de la fixture.
    static func cardId(_ slug: String, repoRoot: String = repoRoot) -> String {
        "feature:\(KanbanRepoKey.key(forRoot: repoRoot)):\(slug)"
    }

    // MARK: - La fixture principale

    static let askQuestion = "On garde le cache entre deux lancements ?"
    static let askOptions = [
        PanelAskOption(label: "Le garder", description: nil),
        PanelAskOption(label: "Le vider", description: "repartir de zéro"),
    ]
    static let auditQuestion = "Faut-il journaliser les erreurs du service ?"
    static let auditOptions = ["Oui", "Non"]
    static let auditEscalationKey = "ask:f-audit:call-9"

    /// Un dialogue de sélection de la conduite de projet.
    static let conduiteDialog = RpcDialogRequest(
        id: "dlg-1",
        method: .select,
        title: "Quelle feature conduire d'abord ?",
        options: ["f-specs", "f-review"],
        optionDescriptions: ["la plus ancienne"],
        at: Double(tConduite)
    )

    /// Une confirmation de la session hébergée, avec son message.
    static let sessionDialog = RpcDialogRequest(
        id: "dlg-2",
        method: .confirm,
        title: "Arrêter la session ?",
        message: "La pipeline en cours sera interrompue.",
        at: Double(tSession)
    )

    /// Une question en vol, un jalon specs, un jalon revue et une escalade
    /// d'audit (portée par `f-audit`).
    static var snapshot: StoreSnapshot { decode(snapshotJSON) }

    /// Le littéral JSON de la fixture principale : le décoder deux fois rend deux
    /// instantanés distincts des mêmes données (AC-4).
    static var snapshotJSON: String {
        store(
            running: [questionRun()],
            lots: [lot(id: "eeeeeeeeeeeeeee1", features: [
                feature("f-question", state: "running", phase: "impl", worktree: "\(repoRoot)/f-question", sinceAt: start),
                feature("f-specs", state: "waiting", phase: "specs", waitKind: "specs", sinceAt: tSpecs),
                feature("f-review", state: "waiting", phase: "review", waitKind: "review", sinceAt: tReview),
                feature(
                    "f-audit", state: "waiting", phase: "req", waitKind: "answer", sinceAt: start,
                    extra: """
                    "waitPrompt": \(quoted(auditQuestion)),
                    "auditSession": \(quoted(auditKey)),
                    "escalation": {
                      "key": \(quoted(auditEscalationKey)),
                      "kind": "question",
                      "phase": "req",
                      "question": \(quoted(auditQuestion)),
                      "options": ["Oui", "Non"],
                      "reason": "Le brief ne dit rien du journal.",
                      "at": \(tAudit)
                    },
                    """
                ),
            ])],
            audits: [audit(launched: ["f-audit"])]
        )
    }

    /// Les sources complètes de la fixture principale.
    static var sources: PendingSources {
        sources(snapshot: snapshot, conduite: [conduiteDialog], session: [sessionDialog])
    }

    // MARK: - Variantes

    /// AC-2 : une feature en échec et une feature bloquée, toutes deux relançables.
    static var failedAndBlocked: StoreSnapshot {
        decode(store(lots: [lot(id: "eeeeeeeeeeeeeee2", features: [
            feature("f-echec", state: "failed", phase: "impl", sinceAt: start),
            feature("f-bloquee", state: "blocked", phase: "specs", sinceAt: start),
        ])]))
    }

    /// AC-3 : un run en marche sans question, une feature jamais lancée et un
    /// audit lancé sans escalade.
    static var nothingPending: StoreSnapshot {
        decode(store(
            running: [run(id: "aaaaaaaaaaaaaaa4", cwd: "\(repoRoot)/f-calme", pendingAsk: nil)],
            lots: [lot(id: "eeeeeeeeeeeeeee3", features: [
                feature("f-calme", state: "running", phase: "impl", worktree: "\(repoRoot)/f-calme", sinceAt: start),
                feature("f-plus-tard", state: "pending", phase: "req", sinceAt: start),
            ])],
            audits: [audit(launched: ["f-calme"])]
        ))
    }

    /// AC-3 : le magasin présent mais vide de toute entrée.
    static var emptyStore: StoreSnapshot { decode(store()) }

    /// AC-10 : un lot au pilote mort (lot et run périmés) portant une question en
    /// vol et un jalon specs.
    static var pausedLot: StoreSnapshot {
        decode(store(
            running: [questionRun(cwd: "/tmp/attentes/pause/f-pause-question", ownerPid: 424_242, isStale: true)],
            lots: [lot(id: "eeeeeeeeeeeeeee4", repoRoot: "/tmp/attentes/pause", ownerPid: 424_242, isStale: true, features: [
                feature("f-pause-question", state: "running", phase: "impl", worktree: "/tmp/attentes/pause/f-pause-question", sinceAt: start),
                feature("f-pause-specs", state: "waiting", phase: "specs", waitKind: "specs", sinceAt: tSpecs),
            ])]
        ))
    }

    /// Une question en vol portée par un run qu'aucune feature n'apparie.
    static var unpairedRun: StoreSnapshot {
        decode(store(running: [questionRun(cwd: "/tmp/attentes/ailleurs")]))
    }

    // MARK: - Dérivation

    /// Les sources d'un instantané : l'ardoise est dérivée de CE snapshot, horloge
    /// fixe et `stateDir` vide, vivacité transportée (le cas de l'iPhone).
    static func sources(
        snapshot: StoreSnapshot,
        conduite: [RpcDialogRequest] = [],
        session: [RpcDialogRequest] = []
    ) -> PendingSources {
        PendingSources(
            snapshot: snapshot,
            board: KanbanBoardState.derive(
                snapshot: snapshot,
                nowMs: 1_700_000_000_000,
                stateDir: "",
                isAlive: .transported(snapshot),
                prFacts: [:]
            ),
            conduiteDialogs: conduite,
            sessionDialogs: session
        )
    }

    // MARK: - Fragments JSON

    static func decode(_ json: String) -> StoreSnapshot {
        do {
            return try JSONDecoder().decode(StoreSnapshot.self, from: Data(json.utf8))
        } catch {
            fatalError("PendingFixtures : instantané illisible — \(error)")
        }
    }

    private static func quoted(_ text: String) -> String {
        guard let data = try? JSONEncoder().encode(text), let json = String(data: data, encoding: .utf8) else {
            fatalError("PendingFixtures : chaîne non encodable")
        }
        return json
    }

    private static func store(running: [String] = [], lots: [String] = [], audits: [String] = []) -> String {
        """
        {
          "root": "present",
          "running": { "availability": "present", "discardedEntries": [], "entries": [\(running.joined(separator: ","))] },
          "history": { "availability": "present", "discardedEntries": [], "entries": [] },
          "lots": { "availability": "present", "discardedEntries": [], "lots": [\(lots.joined(separator: ","))] },
          "projects": { "availability": "present", "discardedEntries": [], "projects": [] },
          "inbox": { "availability": "present", "discardedEntries": [], "boxes": [] },
          "audit": { "availability": "present", "discardedEntries": [], "relays": [] },
          "audits": { "availability": "present", "discardedEntries": [], "records": [\(audits.joined(separator: ","))], "decisions": [] }
        }
        """
    }

    private static func questionRun(
        cwd: String = "\(repoRoot)/f-question",
        ownerPid: Int = 1,
        isStale: Bool = false
    ) -> String {
        run(
            id: questionRunId,
            cwd: cwd,
            ownerPid: ownerPid,
            isStale: isStale,
            pendingAsk: """
            {
              "toolCallId": "call-1",
              "id": "ask-1",
              "question": \(quoted(askQuestion)),
              "options": [
                { "label": "Le garder" },
                { "label": "Le vider", "description": "repartir de zéro" }
              ]
            }
            """
        )
    }

    private static func run(
        id: String,
        cwd: String,
        ownerPid: Int = 1,
        isStale: Bool = false,
        pendingAsk: String?
    ) -> String {
        """
        {
          "id": "\(id)",
          "cwd": \(quoted(cwd)),
          "label": "depot/\(id)",
          "phase": "impl",
          "state": "running",
          "phaseStartedAt": \(start),
          "updatedAt": \(tAsk),
          "ownerPid": \(ownerPid),
          "inbox": "/tmp/attentes/state/inbox/\(id)",
          \(pendingAsk.map { "\"pendingAsk\": \($0)," } ?? "")
          "isStale": \(isStale)
        }
        """
    }

    private static func lot(
        id: String,
        repoRoot: String = repoRoot,
        ownerPid: Int = 1,
        isStale: Bool = false,
        features: [String]
    ) -> String {
        """
        {
          "id": "\(id)",
          "repoRoot": \(quoted(repoRoot)),
          "status": "running",
          "reviewCap": 1,
          "slotCap": 4,
          "recapAt": null,
          "owner": { "pid": \(ownerPid) },
          "createdAt": \(start),
          "launchedAt": \(start),
          "features": [\(features.joined(separator: ","))],
          "isStale": \(isStale)
        }
        """
    }

    private static func feature(
        _ slug: String,
        state: String,
        phase: String,
        waitKind: String? = nil,
        worktree: String = "",
        sinceAt: Int,
        extra: String = ""
    ) -> String {
        """
        {
          "slug": "\(slug)",
          "name": "\(slug)",
          "branch": "feat/\(slug)",
          "worktree": \(quoted(worktree)),
          "deps": [],
          "origin": "session",
          "state": "\(state)",
          "phase": "\(phase)",
          "waitKind": \(waitKind.map { "\"\($0)\"" } ?? "null"),
          "pendingTexts": [],
          "fixes": 0,
          "reviewRuns": 0,
          "unreadableRuns": 0,
          "lastBlockers": 0,
          \(extra)
          "addedAt": \(start),
          "sinceAt": \(sinceAt),
          "updatedAt": \(sinceAt)
        }
        """
    }

    private static func audit(launched: [String]) -> String {
        let launches = launched.map { slug in
            """
            { "slug": "\(slug)", "launched": true, "reason": null, "state": "running", "phase": "req", "prUrl": null }
            """
        }
        return """
        {
          "id": "\(auditId)",
          "repoRoot": \(quoted(repoRoot)),
          "repoKey": "0123456789abcdef",
          "key": \(quoted(auditKey)),
          "orientation": "fiabilité du service",
          "status": "launched",
          "createdAt": \(start),
          "updatedAt": \(start),
          "launches": [\(launches.joined(separator: ","))],
          "failure": null
        }
        """
    }
}
