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
    /// Le sommaire mémoire, borné en NOMBRE comme ses voisines : au-delà, la
    /// charge dépasserait la borne de corps et le client refuserait la réponse.
    static let memoryRows = 2000
    static let transcriptLines = 500
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
    /// Les arguments bruts de l'appel (S-3) : le client iOS en dérive la cible et le
    /// texte des arguments. `nil` quand l'appel n'en porte pas — le champ est alors
    /// ABSENT de la charge utile (champ additif optionnel).
    var arguments: JSONValue?
}

struct RemoteConversationEntry: Codable, Equatable {
    var index: Int
    /// Premier octet de la ligne dans le fichier (S-3) : c'est de lui que le client
    /// dérive les identités de lignes, stables entre deux lectures. Optionnel pour
    /// qu'un Mac d'avant la feature reste décodable — l'app retombe alors sur `index`.
    var offset: Int?
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
        offset = entry.offset
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
                toolCalls = turn.toolCalls.map {
                    RemoteToolCall(id: $0.id, name: $0.name, arguments: $0.arguments)
                }
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
    /// Le motif OS d'un fichier illisible (S-4). `nil` quand la lecture est saine : le
    /// client affiche alors le fil. Un fichier illisible reste un 200 — c'est
    /// l'absence de ce champ ET de toute entrée qui distingue « vide » d'« illisible ».
    var unreadableReason: String?
}

/// Une entrée du sélecteur de projet servi (S-1) : la clé du magasin (que le
/// client ne calcule jamais) et son libellé affichable.
struct RemoteStatsProject: Codable, Equatable, Sendable {
    var key: String
    var label: String
}

/// Les totaux d'une feature LISTÉE, par relevé (S-1) : des scalaires seulement.
/// `liveRuns` fait avancer la durée côté client, sans trafic (S-5).
struct RemoteStatsFeature: Codable, Equatable, Sendable {
    var slug: String
    var input: Int
    var output: Int
    var turns: Int
    var durationMs: Double
    var liveRuns: Int
    var model: String?
}

/// Le tableau du projet AFFICHÉ (S-1) : le projet, tous les projets du magasin
/// pour le sélecteur, les features LISTÉES et le compte des features masquées.
struct RemoteStatsPayload: Codable, Equatable, Sendable {
    var projectKey: String?
    var project: String
    var projects: [RemoteStatsProject]
    var features: [RemoteStatsFeature]
    var hiddenPlanFeatures: Int
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

/// Un dépôt connu de la coque (S-8) : sa clé (que le client ne calcule jamais),
/// son chemin réel et son nom.
struct RemoteRepoRow: Codable, Equatable, Sendable {
    let repoKey: String
    let repoRoot: String
    let name: String
}

struct RemoteReposPayload: Codable, Equatable, Sendable {
    let rows: [RemoteRepoRow]
}

/// L'état RÉEL des composants de la coque (S-4) : `ompPath` porte le chemin du
/// binaire OMP quand il est présent, `nil` sinon ; `setupBanner` la phrase de
/// `SetupText.banner(state:dismissed: true)` (non nulle en préparation/échec).
struct RemoteComponentsPayload: Codable, Equatable {
    var ompInstalled: Bool
    var ompPath: String?
    var setupBanner: String?
}

/// Le journal des gestes, servi tel quel (S-5) : borné par le modèle.
struct RemoteJournalPayload: Codable, Equatable {
    var entries: [ActionJournalEntry]
}

/// Le contrat d'une feature (S-6) : le même `RemoteDocument` que les documents
/// de projet, avec ses états `text | missing | binary | unreadable`.
struct RemoteContractPayload: Codable, Equatable {
    var document: RemoteDocument
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

/// Le sommaire d'une portée (S-1) : `scope` vaut `nil` quand AUCUN projet n'est
/// ouvert — c'est LE signal de « aucun projet », sans champ booléen séparé ;
/// `truncated` dit qu'une ligne a été retirée par la borne de nombre ou d'octets.
struct RemoteMemoryPagePayload: Codable, Equatable {
    var scope: String?
    var total: Int
    var rows: [RemoteMemoryRow]
    var truncated: Bool
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
    /// Le texte INTÉGRAL du souvenir (champ ADDITIF OPTIONNEL) ; `nil` pour un
    /// nœud-étiquette. Un Mac plus ancien ne l'émet pas.
    var text: String?
    /// Les étiquettes du souvenir (champ ADDITIF OPTIONNEL) ; `nil` pour un
    /// nœud-étiquette.
    var tags: [String]?
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
    /// Vrai dès qu'une LIGNE a été retirée par l'une des deux bornes (nombre ou
    /// octets) — le graphe affiché est alors partiel, et l'app le dit.
    var truncated: Bool
}

extension RemoteMemoryGraphPayload {
    /// `truncated` est un champ ADDITIF : un Mac d'avant la feature graphe ne
    /// l'émet pas, et la charge reste lisible (absent ⇒ faux). Extension, pour
    /// garder l'init memberwise utilisé par `RemoteReads.graphPayload`.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        nodes = try container.decode([RemoteMemoryGraphNode].self, forKey: .nodes)
        links = try container.decode([RemoteMemoryGraphLink].self, forKey: .links)
        total = try container.decode(Int.self, forKey: .total)
        truncated = try container.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
    }
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

/// L'état réduit de la conduite (S-11, S-9) : le vocabulaire de `ConduiteState`,
/// la pastille de session, l'identité quand elle existe, et la file d'escalades
/// ENTIÈRE (jamais un delta). Le miroir de dialogue est celui de `GET /v1/session`.
struct RemoteConduiteStatePayload: Codable, Equatable, Sendable {
    let state: String          // "none"|"starting"|"live"|"closing"|"closed"
    let repoKey: String?       // identité vive ; nil quand state ∈ {"none","closed"}
    let name: String?
    let repoRoot: String?
    let status: ConsoleStatus? // ConsoleCore, présent des deux côtés
    let dialogs: [RpcDialogRequest] // file ENTIÈRE à chaque fois, jamais un delta
}

struct RemotePullRequestsPayload: Codable, Equatable {
    var rows: [ProjectPRRow]
    var failure: String?
    var stale: Bool
}

/// Le catalogue des modèles servis par `omp models --json` (S-14) : les sélecteurs
/// triés, dédoublonnés, non blancs, et un motif quand le chargement a échoué (la
/// liste est alors vide). Le client affiche le motif — ce n'est pas une erreur de
/// transport.
struct RemoteModelsPayload: Codable, Equatable {
    var selectors: [String]
    var failure: String?
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
    /// Le dernier segment de la racine de projet mémorisée (S-2) : c'est le
    /// « dépôt » que l'iPad affiche. `nil` distingue « Aucune session » de
    /// « Prête à démarrer ».
    var projectName: String?
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

/// Le corps de `POST /v1/session/launch` (S-1) : la clé d'un dépôt servi par
/// `GET /v1/repos` — jamais un chemin.
struct RemoteHostedLaunchRequest: Decodable, Equatable {
    var repoKey: String
}

/// Le corps de `POST /v1/conduite/dialogs/{id}` (S-4, S-5) : `kind` vaut `value`,
/// `confirmed` ou `cancelled` ; `value`/`confirmed` ne vivent que pour leur kind.
struct RemoteDialogAnswerRequest: Codable, Equatable, Sendable {
    let kind: String
    let value: String?
    let confirmed: Bool?
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
