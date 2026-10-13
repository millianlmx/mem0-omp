// Le Mac scripté des preuves Siri de l'iPhone (siri-iphone-questions-en-attente,
// S-8 ; étendu par siri-iphone-pilotage-pipelines, BR-2) : les fragments JSON du
// magasin, de la conduite et de la session, les états du Mac, ses réponses aux
// routes de lecture et de geste, la conversation scriptée et les outils de
// relecture des requêtes. Partagés par `IOSSiriPendingTests` et
// `IOSSiriPilotTests`.
//
// Les corps des trois routes de lecture sont recopiés de
// `Tests/ConsoleClientTests/PendingRequestsFetchTests.swift`, les fragments du
// magasin de `Tests/OMPConsoleTests/PendingFixtures.swift` (doublures COPIÉES
// entre cibles, invisibles du projet Xcode).

import ConsoleClient
import ConsoleCore
import Foundation

@testable import OMPConsoleIOS

// MARK: - Le Mac scripté

/// Les fragments JSON servis par le Mac : magasin, conduite, session hébergée.
enum PendingJSON {
    static let repoRoot = "/tmp/siri/depot"
    static let auditId = "a0d1700000000009"
    static let auditKey = "/tmp/siri/state/audits/a0d1700000000009"
    static let start = 1_700_000_000_000

    /// L'instant `n` secondes après `start`, en ms.
    static func at(_ n: Int) -> Int { start + n * 1000 }

    static func cardId(_ slug: String, root: String = repoRoot) -> String {
        "feature:\(KanbanRepoKey.key(forRoot: root)):\(slug)"
    }

    static func quoted(_ text: String) -> String {
        guard let data = try? JSONEncoder().encode(text), let json = String(data: data, encoding: .utf8) else {
            fatalError("PendingJSON : chaîne non encodable")
        }
        return json
    }

    static func quoted(_ texts: [String]) -> String {
        "[" + texts.map { quoted($0) }.joined(separator: ",") + "]"
    }

    /// Le magasin : le lot vivant de `repoRoot` porte `features`, `lots` ajoute
    /// les lots d'autres dépôts (`MacState.lot(on:features:pilotDead:)`).
    static func store(running: [String], features: [String], audits: [String], lots extra: [String] = []) -> String {
        let lots = ((features.isEmpty ? [] : [lot(features: features)]) + extra).joined(separator: ",")
        return """
        {
          "root": "present",
          "running": { "availability": "present", "discardedEntries": [], "entries": [\(running.joined(separator: ","))] },
          "history": { "availability": "present", "discardedEntries": [], "entries": [] },
          "lots": { "availability": "present", "discardedEntries": [], "lots": [\(lots)] },
          "projects": { "availability": "present", "discardedEntries": [], "projects": [] },
          "inbox": { "availability": "present", "discardedEntries": [], "boxes": [] },
          "audit": { "availability": "present", "discardedEntries": [], "relays": [] },
          "audits": { "availability": "present", "discardedEntries": [], "records": [\(audits.joined(separator: ","))], "decisions": [] }
        }
        """
    }

    /// Un run vivant dans le worktree de `slug`, qui pose une question en vol.
    static func run(id: String, slug: String, updatedAt: Int, toolCallId: String, question: String, labels: [String]) -> String {
        let options = labels.map { "{ \"label\": \(quoted($0)) }" }.joined(separator: ",")
        return """
        {
          "id": "\(id)",
          "cwd": \(quoted("\(repoRoot)/\(slug)")),
          "label": "depot/\(id)",
          "phase": "impl",
          "state": "running",
          "phaseStartedAt": \(start),
          "updatedAt": \(updatedAt),
          "ownerPid": 1,
          "inbox": "/tmp/siri/state/inbox/\(id)",
          "pendingAsk": {
            "toolCallId": \(quoted(toolCallId)),
            "id": "ask-\(id)",
            "question": \(quoted(question)),
            "options": [\(options)]
          },
          "isStale": false
        }
        """
    }

    /// Un lot du dépôt `root` : son pilote (`pid`) est vivant, ou mort quand la
    /// vivacité que le Mac transporte (`isStale`) est périmée.
    static func lot(
        features: [String], root: String = repoRoot, id: String = "eeeeeeeeeeeeeee1", pid: Int = 1, stale: Bool = false
    ) -> String {
        """
        {
          "id": "\(id)",
          "repoRoot": \(quoted(root)),
          "status": "running",
          "reviewCap": 1,
          "slotCap": 4,
          "recapAt": null,
          "owner": { "pid": \(pid) },
          "createdAt": \(start),
          "launchedAt": \(start),
          "features": [\(features.joined(separator: ","))],
          "isStale": \(stale)
        }
        """
    }

    static func feature(
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

    static func audit(launched slug: String) -> String {
        """
        {
          "id": "\(auditId)",
          "repoRoot": \(quoted(repoRoot)),
          "repoKey": "0123456789abcdef",
          "key": \(quoted(auditKey)),
          "orientation": "fiabilité du service",
          "status": "launched",
          "createdAt": \(start),
          "updatedAt": \(start),
          "launches": [{ "slug": "\(slug)", "launched": true, "reason": null, "state": "running", "phase": "req", "prUrl": null }],
          "failure": null
        }
        """
    }

    static func dialog(id: String, method: String, title: String, options: [String], at: Int) -> String {
        """
        {"id":\(quoted(id)),"method":"\(method)","title":\(quoted(title)),"options":\(quoted(options)),\
        "optionDescriptions":[],"promptStyle":false,"at":\(at)}
        """
    }

    static func conduite(_ dialogs: [String]) -> String {
        """
        {"state":"live","repoKey":"0123456789abcdef","name":"Projet","repoRoot":"/tmp/projet",\
        "dialogs":[\(dialogs.joined(separator: ","))]}
        """
    }

    static func session(_ dialogs: [String]) -> String {
        """
        {"state":"running","stateLabel":"En marche","sessionId":"sess-1","dialogs":[\(dialogs.joined(separator: ","))],\
        "transcript":[],"truncated":false}
        """
    }
}

/// Ce que le Mac porte à un instant : runs, features du lot, lots d'autres
/// dépôts, audits, dialogues.
struct MacState {
    var running: [String] = []
    var features: [String] = []
    var lots: [String] = []
    var audits: [String] = []
    var conduite: [String] = []
    var session: [String] = []

    /// Une question en vol de la feature `slug`, posée à `at` par le run `runId`.
    func asking(
        _ slug: String, run runId: String, at: Int, toolCallId: String, question: String, labels: [String]
    ) -> MacState {
        var next = self
        next.running.append(PendingJSON.run(
            id: runId, slug: slug, updatedAt: at, toolCallId: toolCallId, question: question, labels: labels
        ))
        next.features.append(PendingJSON.feature(
            slug, state: "running", phase: "impl", worktree: "\(PendingJSON.repoRoot)/\(slug)", sinceAt: PendingJSON.start
        ))
        return next
    }

    /// Une question en texte (sans run qui la pose) de la feature `slug`.
    func textQuestion(_ slug: String, prompt: String, at: Int) -> MacState {
        var next = self
        next.features.append(PendingJSON.feature(
            slug, state: "waiting", phase: "impl", waitKind: "answer", sinceAt: at,
            extra: "\"waitPrompt\": \(PendingJSON.quoted(prompt)),"
        ))
        return next
    }

    /// Un jalon `specs` ou `review` de la feature `slug`.
    func milestone(_ slug: String, _ kind: String, at: Int) -> MacState {
        var next = self
        next.features.append(PendingJSON.feature(slug, state: "waiting", phase: kind, waitKind: kind, sinceAt: at))
        return next
    }

    /// Une feature `slug` en cours, pilote vivant : l'app n'offre que « Arrêter ».
    func running(_ slug: String, at: Int) -> MacState {
        var next = self
        next.features.append(PendingJSON.feature(slug, state: "running", phase: "impl", sinceAt: at))
        return next
    }

    /// Une feature `slug` en échec : l'app offre « Relancer » (et « Arrêter »).
    func failed(_ slug: String, at: Int) -> MacState {
        var next = self
        next.features.append(PendingJSON.feature(slug, state: "failed", phase: "impl", sinceAt: at))
        return next
    }

    /// Un run vivant hors de toute feature de lot (carte `run:`) : aucun arrêt,
    /// aucune reprise, aucun jalon.
    func strayRun(_ runId: String, at: Int) -> MacState {
        var next = self
        next.running.append(PendingJSON.run(
            id: runId, slug: "hors-lot", updatedAt: at, toolCallId: "call-\(runId)", question: "Hors lot ?", labels: ["Oui"]
        ))
        return next
    }

    /// Un lot du dépôt `root` portant `features`. Pilote mort (`pilotDead`) :
    /// le Mac transporte un lot périmé sans aucun run, donc une feature vivante
    /// y devient reprenable (marque `mort` : propriétaire mort sur le lot, et pas
    /// de run qui le masquerait).
    func lot(on root: String, features: [String], pilotDead: Bool = false) -> MacState {
        var next = self
        let id = String(format: "dddddddddddddd%02d", lots.count)
        next.lots.append(PendingJSON.lot(
            features: features, root: root, id: id, pid: pilotDead ? 2 : 1, stale: pilotDead
        ))
        return next
    }

    /// Une escalade d'audit (question à options) portée par la feature `slug`.
    func escalation(_ slug: String, question: String, labels: [String], at: Int) -> MacState {
        var next = self
        next.features.append(PendingJSON.feature(
            slug, state: "waiting", phase: "req", waitKind: "answer", sinceAt: PendingJSON.start,
            extra: """
            "waitPrompt": \(PendingJSON.quoted(question)),
            "auditSession": \(PendingJSON.quoted(PendingJSON.auditKey)),
            "escalation": {
              "key": \(PendingJSON.quoted("ask:\(slug):call-9")),
              "kind": "question",
              "phase": "req",
              "question": \(PendingJSON.quoted(question)),
              "options": \(PendingJSON.quoted(labels)),
              "reason": "Le brief ne dit rien.",
              "at": \(at)
            },
            """
        ))
        next.audits.append(PendingJSON.audit(launched: slug))
        return next
    }

    func conduiteDialog(_ id: String, method: String, title: String, options: [String] = [], at: Int) -> MacState {
        var next = self
        next.conduite.append(PendingJSON.dialog(id: id, method: method, title: title, options: options, at: at))
        return next
    }

    func sessionDialog(_ id: String, method: String, title: String, options: [String] = [], at: Int) -> MacState {
        var next = self
        next.session.append(PendingJSON.dialog(id: id, method: method, title: title, options: options, at: at))
        return next
    }
}

/// Un refus scripté d'une route de geste, au format d'erreur de l'API
/// (`{"error":{"code":…,"message":…}}`).
struct MacRefusal {
    var status: Int
    var code: String
    var message: String

    static func conflict(_ message: String) -> MacRefusal {
        MacRefusal(status: 409, code: "conflict", message: message)
    }
}

/// Le Mac scripté : la i-ème lecture du magasin sert le i-ème état (le dernier se
/// répète), la conduite et la session suivent la dernière lecture du magasin ;
/// tout geste (POST) est accepté (202) sauf ceux que `refusals` refuse, par
/// route ; toute autre route répond 404.
final class PendingMac: @unchecked Sendable {
    private let lock = NSLock()
    private let states: [MacState]
    private let refusals: [String: MacRefusal]
    private var reads = 0

    init(_ states: [MacState], refusals: [String: MacRefusal] = [:]) {
        precondition(!states.isEmpty)
        self.states = states
        self.refusals = refusals
    }

    func respond(_ request: ClientHTTPRequest) -> ClientHTTPResponse {
        switch (request.method, request.path) {
        case ("GET", "/v1/store"):
            let state = lock.withLock { () -> MacState in
                defer { reads += 1 }
                return states[min(reads, states.count - 1)]
            }
            let store = PendingJSON.store(
                running: state.running, features: state.features, audits: state.audits, lots: state.lots
            )
            return ClientDoubles.response(status: 200, json: "{\"snapshot\":\(store)}")
        case ("GET", "/v1/conduite"):
            return ClientDoubles.response(status: 200, json: PendingJSON.conduite(current.conduite))
        case ("GET", "/v1/session"):
            return ClientDoubles.response(status: 200, json: PendingJSON.session(current.session))
        case ("POST", let path):
            if let refusal = refusals[path] {
                return ClientDoubles.response(
                    status: refusal.status,
                    json: "{\"error\":{\"code\":\(PendingJSON.quoted(refusal.code)),\"message\":\(PendingJSON.quoted(refusal.message))}}"
                )
            }
            return ClientDoubles.response(status: 202, json: #"{"accepted":true}"#)
        default:
            return ClientDoubles.response(status: 404, json: #"{"error":{"code":"not_found","message":"route"}}"#)
        }
    }

    /// L'état de la dernière lecture du magasin.
    private var current: MacState {
        lock.withLock { states[min(max(reads - 1, 0), states.count - 1)] }
    }
}

// MARK: - La conversation scriptée

struct Abandoned: Error {}

/// Enregistre chaque dialogue ; `ask` rejoue `answers` puis lève (abandon),
/// `confirm` rejoue `confirmations` (faux = « non », qui lève), puis lève.
@MainActor
final class ScriptedConversation: VoiceConversation {
    private var answers: [String]
    private var confirmations: [Bool]
    private(set) var asks: [String] = []
    private(set) var confirms: [String] = []
    /// Tous les dialogues, dans l'ordre.
    private(set) var dialogs: [String] = []

    init(answers: [String] = [], confirmations: [Bool] = []) {
        self.answers = answers
        self.confirmations = confirmations
    }

    func ask(_ dialog: String) async throws -> String {
        asks.append(dialog)
        dialogs.append(dialog)
        guard !answers.isEmpty else { throw Abandoned() }
        return answers.removeFirst()
    }

    func confirm(_ dialog: String) async throws {
        confirms.append(dialog)
        dialogs.append(dialog)
        guard !confirmations.isEmpty, confirmations.removeFirst() else { throw Abandoned() }
    }
}

let macAddress = "127.0.0.1:18787"

/// Un client non démarré, au Mac connu par son adresse manuelle, sur le Mac
/// scripté par `states`.
@MainActor
func connect(_ states: MacState..., refusals: [String: MacRefusal] = [:]) -> (client: ConsoleClientModel, transport: ScriptedClientTransport) {
    let mac = PendingMac(states, refusals: refusals)
    let transport = ScriptedClientTransport { mac.respond($0) }
    return (ClientDoubles.model(transport: transport, address: macAddress), transport)
}

/// Un client APPAIRÉ, non démarré (lancement à froid d'un intent), dont le Mac
/// salue à la version de l'app : `waitUntilReady()` le rend prêt. L'appelant
/// l'arrête (`stop()`) en fin de preuve.
@MainActor
func connectReady(_ states: MacState..., refusals: [String: MacRefusal] = [:]) -> (client: ConsoleClientModel, transport: HelloStreamTransport) {
    let mac = PendingMac(states, refusals: refusals)
    let transport = HelloStreamTransport(version: ConsoleAPI.protocolVersion) { mac.respond($0) }
    let client = ClientDoubles.pairedModel(
        tokens: CountingTokenStore(["dev-1": "tok-1"]), transport: transport, address: macAddress
    )
    return (client, transport)
}

/// Les gestes envoyés : les POST vers une route de réponse ou de geste (carte,
/// dialogue, escalade, lancement). La relance de l'état des PR qu'un client
/// connecté émet n'en est pas.
func posts(_ requests: [ClientHTTPRequest]) -> [ClientHTTPRequest] {
    let routes = ["/v1/cards/", "/v1/conduite/dialogs/", "/v1/session/dialogs/", "/v1/audits/", "/v1/features"]
    return requests.filter { request in
        request.method == "POST" && routes.contains { request.path.hasPrefix($0) }
    }
}

func body(_ request: ClientHTTPRequest) -> [String: Any] {
    request.body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
}

/// Un segment de route encodé comme le client l'encode.
func encoded(_ component: String) -> String {
    component.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? component
}

/// La route d'une carte de feature du dépôt `root`.
func cardPath(_ slug: String, _ route: String, root: String = PendingJSON.repoRoot) -> String {
    "/v1/cards/\(encoded(PendingJSON.cardId(slug, root: root)))/\(route)"
}
