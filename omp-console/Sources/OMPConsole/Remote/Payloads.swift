// Les charges utiles des routes (S-7 … S-13) : ce que l'API ÉCRIT, exactement.
//
// Les modèles du magasin vivent dans `ConsoleCore` et sont `Codable` depuis BR-1 :
// on les sert TELS QUELS (leurs clés sont les noms de champs du dépôt). Les types
// internes de la coque — conversation de session, mémoire, dialogues RPC — sont
// PROJETÉS ici : une charge utile dédiée dit ce qui sort, et le modèle de la coque
// reste libre de changer.

import ConsoleCore
import Foundation

/// Les bornes de l'API (S-7 : 2 Mio par réponse JSON).
enum RemoteLimits {
    static let responseBody = 2 * 1024 * 1024
    static let sessionEntries = 2000
    static let statsRows = 2000
    static let transcriptLines = 500
    static let memoryLimitDefault = 50
    static let memoryLimitMax = 200
}

// MARK: - Lectures

struct RemoteVersionPayload: Codable, Equatable {
    var protocolVersion: Int
}

struct RemoteStorePayload: Codable {
    var snapshot: StoreSnapshot
}

struct RemoteSessionsPayload: Codable {
    var runs: [StoreRun]
}

struct RemoteProjectsPayload: Codable {
    var projects: [Project]
}

/// Un document de projet (S-7) : `content` n'existe que pour `text`, `reason`
/// seulement pour `binary`/`unreadable`.
struct RemoteDocument: Codable, Equatable {
    var name: String
    var state: String
    var content: String?
    var reason: String?
}

struct RemoteDocumentsPayload: Codable, Equatable {
    var documents: [RemoteDocument]
}

struct RemoteSessionHeader: Codable, Equatable {
    var id: String
    var cwd: String
    var version: Int?
    var timestamp: String?
    var parentSession: String?
}

struct RemoteSkippedEntry: Codable, Equatable {
    var offset: Int
    var reason: String
}

struct RemoteUsage: Codable, Equatable {
    var input: Int
    var output: Int
    var cacheRead: Int
    var cacheWrite: Int
    var totalTokens: Int
    var cost: Double?
}

struct RemoteToolCall: Codable, Equatable {
    var id: String
    var name: String
}

struct RemoteConversationEntry: Codable, Equatable {
    var index: Int
    var timestampMs: Double?
    var kind: String
    var text: String?
    var thinking: String?
    var model: String?
    var usage: RemoteUsage?
    var toolCalls: [RemoteToolCall]?
    var callId: String?
    var name: String?
    var diff: String?
    var isError: Bool?
    var tokensBefore: Int?
    var fromId: String?

    init(_ entry: ConversationEntry) {
        index = entry.index
        timestampMs = entry.timestampMs
        switch entry.kind {
        case .user(let turn):
            kind = "user"
            text = turn.text
        case .assistant(let turn):
            kind = "assistant"
            text = turn.text
            thinking = turn.thinking
            model = turn.model
            if let usage = turn.usage {
                self.usage = RemoteUsage(
                    input: usage.input,
                    output: usage.output,
                    cacheRead: usage.cacheRead,
                    cacheWrite: usage.cacheWrite,
                    totalTokens: usage.totalTokens,
                    cost: usage.cost
                )
            }
            if !turn.toolCalls.isEmpty {
                toolCalls = turn.toolCalls.map { RemoteToolCall(id: $0.id, name: $0.name) }
            }
        case .toolResult(let turn):
            kind = "toolResult"
            text = turn.text
            callId = turn.callId
            name = turn.name
            diff = turn.diff
            isError = turn.isError
        case .compaction(let marker):
            kind = "compaction"
            text = marker.summary
            tokensBefore = marker.tokensBefore
        case .branchSummary(let marker):
            kind = "branchSummary"
            text = marker.summary
            fromId = marker.fromId
        }
    }
}

struct RemoteSessionPayload: Codable, Equatable {
    var header: RemoteSessionHeader?
    var kind: String?
    var entries: [RemoteConversationEntry]
    var skipped: [RemoteSkippedEntry]
    var truncated: Bool
}

struct RemoteStatsTotals: Codable, Equatable {
    var input: Int
    var output: Int
    var turns: Int
    var durationMs: Double
}

struct RemoteStatsPayload: Codable, Equatable {
    var project: String
    var totals: RemoteStatsTotals
    var rows: [StatsRow]
    var truncated: Bool
}

struct RemoteDeviceRow: Codable, Equatable {
    var id: String
    var name: String
    var pairedAtMs: Double
    var lastSeenAtMs: Double
    var connected: Bool
}

struct RemoteDevicesPayload: Codable, Equatable {
    var devices: [RemoteDeviceRow]
}

// MARK: - Mémoire

struct RemoteMemoryRow: Codable, Equatable {
    var id: String
    var text: String
    var updatedAt: String?
    var score: Double?
    var tags: [String]
    var agentId: String?

    init(_ row: MemoryRow) {
        id = row.id
        text = row.text
        updatedAt = row.updatedAt
        score = row.semanticScore
        tags = row.tags
        agentId = row.agentId
    }
}

struct RemoteMemoryPagePayload: Codable, Equatable {
    var total: Int
    var rows: [RemoteMemoryRow]
}

struct RemoteMemorySearchPayload: Codable, Equatable {
    var rows: [RemoteMemoryRow]
    var candidates: Int
    var scored: Int
}

struct RemoteMemoryGraphNode: Codable, Equatable {
    var id: String
    var label: String
    var scope: String
}

struct RemoteMemoryGraphLink: Codable, Equatable {
    var a: String
    var b: String
    var kind: String
    var score: Double?
}

struct RemoteMemoryGraphPayload: Codable, Equatable {
    var nodes: [RemoteMemoryGraphNode]
    var links: [RemoteMemoryGraphLink]
    var total: Int
}

// MARK: - Gestes

struct RemoteAcceptedPayload: Codable, Equatable {
    var accepted: Bool
}

struct RemoteSentPayload: Codable, Equatable {
    var sent: Bool
}

struct RemotePairPayload: Codable, Equatable {
    var deviceId: String
    var token: String
    var protocolVersion: Int
}

struct RemoteConduitePayload: Codable, Equatable {
    var state: String
}

struct RemotePullRequestsPayload: Codable, Equatable {
    var rows: [ProjectPRRow]
    var failure: String?
    var stale: Bool
}

struct RemoteMergedPayload: Codable, Equatable {
    var merged: Bool
    var number: Int?
    var url: String
}

struct RemoteHostedSessionPayload: Codable, Equatable {
    var state: String
    var stateLabel: String
    var sessionId: String?
    var sessionFile: String?
    var protocolVersion: Int?
    var dialogs: [RpcDialogRequest]
    var transcript: [TranscriptLine]
    var truncated: Bool
}

// MARK: - Corps de requête

struct RemotePairRequest: Decodable, Equatable {
    var code: String
    var name: String
    var protocolVersion: Int?
}

struct RemoteAnswerRequest: Decodable, Equatable {
    var toolCallId: String?
    var kind: String
    var label: String?
    var text: String?
}

struct RemoteTextRequest: Decodable, Equatable {
    var text: String
}

struct RemoteVerdictRequest: Decodable, Equatable {
    var verdict: String
}

struct RemotePromptRequest: Decodable, Equatable {
    var message: String
}

struct RemoteFeatureRequest: Decodable, Equatable {
    var repoRoot: String
    var title: String
    var description: String
    var modelReqSpecs: String?
    var modelImplReview: String?
}

struct RemoteConduiteRequest: Decodable, Equatable {
    var name: String
}

struct RemoteMergeRequest: Decodable, Equatable {
    var headOid: String
}

/// Le décodage d'un corps de requête : tout échec est un `400 bad_request`.
enum RemoteBody {
    static func decode<T: Decodable>(_ type: T.Type, from request: HTTPRequest) throws -> T {
        guard !request.body.isEmpty else { throw ConsoleAPIError.badRequest("corps JSON absent") }
        do {
            return try HTTPJSON.decoder.decode(T.self, from: request.body)
        } catch {
            throw ConsoleAPIError.badRequest("corps JSON illisible")
        }
    }
}
