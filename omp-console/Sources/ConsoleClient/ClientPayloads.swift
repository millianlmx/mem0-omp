// Le MIROIR des charges utiles du contrat d'API (S-1). Chaque `struct Remote…`
// de `Sources/OMPConsole/Remote/Payloads.swift` est recopié ici sous le MÊME nom,
// avec les MÊMES noms de propriétés stockées — les clés JSON sont celles du dépôt.
//
// Les modèles PUBLICS de `ConsoleCore` (`StoreSnapshot`, `StoreRun`, `Project`)
// sont réutilisés TELS QUELS, jamais recopiés.

import ConsoleCore
import Foundation

// MARK: - Lectures

public struct RemoteVersionPayload: Codable, Equatable, Sendable {
    public var protocolVersion: Int
}

public struct RemoteStorePayload: Codable, Equatable, Sendable {
    public var snapshot: StoreSnapshot
}

public struct RemoteSessionsPayload: Codable, Equatable, Sendable {
    public var runs: [StoreRun]
}

public struct RemoteProjectsPayload: Codable, Equatable, Sendable {
    public var projects: [Project]
}

public struct RemoteDocument: Codable, Equatable, Sendable {
    public var name: String
    public var state: String
    public var content: String?
    public var reason: String?

    public init(name: String, state: String, content: String?, reason: String?) {
        self.name = name
        self.state = state
        self.content = content
        self.reason = reason
    }
}

public struct RemoteDocumentsPayload: Codable, Equatable, Sendable {
    public var documents: [RemoteDocument]
}

public struct RemoteSessionHeader: Codable, Equatable, Sendable {
    public var id: String
    public var cwd: String
    public var version: Int?
    public var timestamp: String?
    public var parentSession: String?
}

public struct RemoteSkippedEntry: Codable, Equatable, Sendable {
    public var offset: Int
    public var reason: String
}

public struct RemoteUsage: Codable, Equatable, Sendable {
    public var input: Int
    public var output: Int
    public var cacheRead: Int
    public var cacheWrite: Int
    public var totalTokens: Int
    public var cost: Double?
}

public struct RemoteToolCall: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    /// Les arguments bruts de l'appel (S-3). ABSENT de la charge utile quand l'appel
    /// n'en porte pas — le client garde alors le nom seul, comme la coque macOS.
    public var arguments: JSONValue?
}

public struct RemoteConversationEntry: Codable, Equatable, Sendable {
    public var index: Int
    /// Premier octet de la ligne dans le fichier (S-3). Optionnel : un Mac d'avant la
    /// feature n'en envoie aucun, et `SessionWire` retombe alors sur `index`.
    public var offset: Int?
    public var timestampMs: Double?
    public var kind: String
    public var text: String?
    public var thinking: String?
    public var model: String?
    public var usage: RemoteUsage?
    public var toolCalls: [RemoteToolCall]?
    public var callId: String?
    public var name: String?
    public var diff: String?
    public var isError: Bool?
    public var tokensBefore: Int?
    public var fromId: String?
}

public struct RemoteSessionPayload: Codable, Equatable, Sendable {
    public var header: RemoteSessionHeader?
    public var kind: String?
    public var entries: [RemoteConversationEntry]
    public var skipped: [RemoteSkippedEntry]
    public var truncated: Bool
    /// Le motif OS d'un fichier illisible (S-4) ; `nil` quand la lecture est saine.
    public var unreadableReason: String?
}

/// Une entrée du sélecteur de projet (S-1) : la clé du magasin, calculée par la
/// coque, jamais par le client.
public struct RemoteStatsProject: Codable, Equatable, Sendable {
    public var key: String
    public var label: String

    public init(key: String, label: String) {
        self.key = key
        self.label = label
    }
}

/// Les totaux d'une feature LISTÉE, tels que le Mac les a mesurés au relevé (S-1).
public struct RemoteStatsFeature: Codable, Equatable, Sendable {
    public var slug: String
    public var input: Int
    public var output: Int
    public var turns: Int
    public var durationMs: Double
    public var liveRuns: Int
    public var model: String?

    public init(slug: String, input: Int, output: Int, turns: Int, durationMs: Double, liveRuns: Int, model: String?) {
        self.slug = slug
        self.input = input
        self.output = output
        self.turns = turns
        self.durationMs = durationMs
        self.liveRuns = liveRuns
        self.model = model
    }
}

/// Le tableau du projet affiché (S-1) : le projet, TOUS les projets du magasin
/// (options du sélecteur), les features listées et le compte des features du plan
/// sans run lisible. Aucun champ monétaire n'y figure (S-6).
public struct RemoteStatsPayload: Codable, Equatable, Sendable {
    public var projectKey: String?
    public var project: String
    public var projects: [RemoteStatsProject]
    public var features: [RemoteStatsFeature]
    public var hiddenPlanFeatures: Int

    public init(
        projectKey: String?,
        project: String,
        projects: [RemoteStatsProject],
        features: [RemoteStatsFeature],
        hiddenPlanFeatures: Int
    ) {
        self.projectKey = projectKey
        self.project = project
        self.projects = projects
        self.features = features
        self.hiddenPlanFeatures = hiddenPlanFeatures
    }
}

/// Une somme de colonnes, calculée CÔTÉ CLIENT depuis un relevé : ce n'est pas un
/// type du fil, le Mac ne l'envoie jamais.
public struct RemoteStatsTotals: Equatable, Sendable {
    public var input: Int
    public var output: Int
    public var turns: Int
    public var durationMs: Double

    public static let zero = RemoteStatsTotals(input: 0, output: 0, turns: 0, durationMs: 0)

    public init(input: Int, output: Int, turns: Int, durationMs: Double) {
        self.input = input
        self.output = output
        self.turns = turns
        self.durationMs = durationMs
    }
}

public extension RemoteStatsFeature {
    /// Les totaux de la feature `elapsedMs` après la réception du relevé (S-5) :
    /// la durée avance d'un milliseconde par milliseconde et par run VIVANT, sans
    /// un octet de trafic ; les tokens et les tours ne changent pas (ils ne
    /// bougent qu'à l'écriture d'une session, donc à un relevé).
    func totals(elapsedMs: Double) -> RemoteStatsTotals {
        let elapsed = elapsedMs.isFinite ? max(0, elapsedMs) : 0
        return RemoteStatsTotals(
            input: input,
            output: output,
            turns: turns,
            durationMs: durationMs + Double(liveRuns) * elapsed
        )
    }
}

public extension RemoteStatsPayload {
    /// Le total du projet : la somme des features LISTÉES (AC-3), au même instant.
    func totals(elapsedMs: Double) -> RemoteStatsTotals {
        features.reduce(into: RemoteStatsTotals.zero) { totals, feature in
            let computed = feature.totals(elapsedMs: elapsedMs)
            totals.input += computed.input
            totals.output += computed.output
            totals.turns += computed.turns
            totals.durationMs += computed.durationMs
        }
    }
}

public struct RemoteDeviceRow: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var pairedAtMs: Double
    public var lastSeenAtMs: Double
    public var connected: Bool
}

public struct RemoteDevicesPayload: Codable, Equatable, Sendable {
    public var devices: [RemoteDeviceRow]
}

public struct RemoteComponentsPayload: Codable, Equatable, Sendable {
    public var ompInstalled: Bool
    public var ompPath: String?
    public var setupBanner: String?

    public init(ompInstalled: Bool, ompPath: String?, setupBanner: String?) {
        self.ompInstalled = ompInstalled
        self.ompPath = ompPath
        self.setupBanner = setupBanner
    }
}

public struct RemoteJournalPayload: Codable, Equatable, Sendable {
    public var entries: [ActionJournalEntry]

    public init(entries: [ActionJournalEntry]) {
        self.entries = entries
    }
}

public struct RemoteContractPayload: Codable, Equatable, Sendable {
    public var document: RemoteDocument

    public init(document: RemoteDocument) {
        self.document = document
    }
}

// MARK: - Mémoire

public struct RemoteMemoryRow: Codable, Equatable, Sendable {
    public var id: String
    public var text: String
    public var updatedAt: String?
    public var score: Double?
    public var tags: [String]
    public var agentId: String?

    public init(
        id: String,
        text: String,
        updatedAt: String?,
        score: Double?,
        tags: [String],
        agentId: String?
    ) {
        self.id = id
        self.text = text
        self.updatedAt = updatedAt
        self.score = score
        self.tags = tags
        self.agentId = agentId
    }
}

/// Le sommaire d'une portée (miroir de `remote.RemoteMemoryPagePayload`, S-1) :
/// `scope` vaut `nil` quand aucun projet n'est ouvert ; `truncated` dit qu'une
/// ligne a été retirée par la borne de nombre ou d'octets.
public struct RemoteMemoryPagePayload: Codable, Equatable, Sendable {
    public var scope: String?
    public var total: Int
    public var rows: [RemoteMemoryRow]
    public var truncated: Bool

    public init(scope: String?, total: Int, rows: [RemoteMemoryRow], truncated: Bool) {
        self.scope = scope
        self.total = total
        self.rows = rows
        self.truncated = truncated
    }
}

public struct RemoteMemorySearchPayload: Codable, Equatable, Sendable {
    public var rows: [RemoteMemoryRow]
    public var candidates: Int
    public var scored: Int

    public init(rows: [RemoteMemoryRow], candidates: Int, scored: Int) {
        self.rows = rows
        self.candidates = candidates
        self.scored = scored
    }
}

public struct RemoteMemoryGraphNode: Codable, Equatable, Sendable {
    public var id: String
    public var label: String
    public var scope: String
    /// Le texte INTÉGRAL du souvenir (champ ADDITIF OPTIONNEL) ; `nil` pour un
    /// nœud-étiquette.
    public var text: String?
    /// Les étiquettes du souvenir (champ ADDITIF OPTIONNEL) ; `nil` pour un
    /// nœud-étiquette.
    public var tags: [String]?

    public init(id: String, label: String, scope: String, text: String? = nil, tags: [String]? = nil) {
        self.id = id
        self.label = label
        self.scope = scope
        self.text = text
        self.tags = tags
    }
}

public struct RemoteMemoryGraphLink: Codable, Equatable, Sendable {
    public var a: String
    public var b: String
    public var kind: String
    public var score: Double?

    public init(a: String, b: String, kind: String, score: Double? = nil) {
        self.a = a
        self.b = b
        self.kind = kind
        self.score = score
    }
}

public struct RemoteMemoryGraphPayload: Codable, Equatable, Sendable {
    public var nodes: [RemoteMemoryGraphNode]
    public var links: [RemoteMemoryGraphLink]
    public var total: Int
    public var truncated: Bool

    public init(nodes: [RemoteMemoryGraphNode], links: [RemoteMemoryGraphLink], total: Int, truncated: Bool = false) {
        self.nodes = nodes
        self.links = links
        self.total = total
        self.truncated = truncated
    }
}

extension RemoteMemoryGraphPayload {
    /// `truncated` est un champ ADDITIF : un Mac d'avant la feature graphe ne
    /// l'émet pas, et la charge reste lisible (absent ⇒ faux).
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        nodes = try container.decode([RemoteMemoryGraphNode].self, forKey: .nodes)
        links = try container.decode([RemoteMemoryGraphLink].self, forKey: .links)
        total = try container.decode(Int.self, forKey: .total)
        truncated = try container.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
    }
}

// MARK: - Gestes

public struct RemoteAcceptedPayload: Codable, Equatable, Sendable {
    public var accepted: Bool
}

public struct RemoteSentPayload: Codable, Equatable, Sendable {
    public var sent: Bool
}

public struct RemotePairPayload: Codable, Equatable, Sendable {
    public var deviceId: String
    public var token: String
    public var protocolVersion: Int
}

public struct RemoteConduitePayload: Codable, Equatable, Sendable {
    public var state: String
}

/// Un dépôt connu de la coque (miroir de `remote.RemoteRepoRow`, S-8) : `repoKey`
/// est CALCULÉ par la coque, jamais par le client.
public struct RemoteRepoRow: Codable, Equatable, Sendable {
    public var repoKey: String
    public var repoRoot: String
    public var name: String

    public init(repoKey: String, repoRoot: String, name: String) {
        self.repoKey = repoKey
        self.repoRoot = repoRoot
        self.name = name
    }
}

/// La liste des dépôts connus de la coque (S-8).
public struct RemoteReposPayload: Codable, Equatable, Sendable {
    public var rows: [RemoteRepoRow]

    public init(rows: [RemoteRepoRow]) {
        self.rows = rows
    }
}

/// L'état de session RÉDUIT de la conduite (S-11, miroir de
/// `remote.RemoteConduiteStatePayload`) : la file d'escalades entière, l'identité
/// quand elle est connue, la pastille `status` et le `state` qui la classe.
public struct RemoteConduiteStatePayload: Codable, Equatable, Sendable {
    public var state: String
    /// L'identité VIVE de la conduite (S-1/S-8) : `nil` quand `state` est
    /// `"none"` ou `"closed"` — le client ne calcule jamais ce `repoKey`.
    public var repoKey: String?
    public var name: String?
    public var repoRoot: String?
    public var status: ConsoleStatus?
    public var dialogs: [RpcDialogRequest]

    public init(
        state: String,
        repoKey: String? = nil,
        name: String? = nil,
        repoRoot: String? = nil,
        status: ConsoleStatus? = nil,
        dialogs: [RpcDialogRequest] = []
    ) {
        self.state = state
        self.repoKey = repoKey
        self.name = name
        self.repoRoot = repoRoot
        self.status = status
        self.dialogs = dialogs
    }

    private enum CodingKeys: String, CodingKey {
        case state, repoKey, name, repoRoot, status, dialogs
    }

    /// Décodage TOLÉRANT à une coque plus ancienne : seule `state` est exigée, la
    /// file absente vaut vide (le client ignore ce qu'il ne comprend pas, sans
    /// couper le flux). L'encodage, lui, reste synthétisé (mêmes clés que la coque).
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        state = try container.decode(String.self, forKey: .state)
        repoKey = try container.decodeIfPresent(String.self, forKey: .repoKey)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        repoRoot = try container.decodeIfPresent(String.self, forKey: .repoRoot)
        status = try container.decodeIfPresent(ConsoleStatus.self, forKey: .status)
        dialogs = try container.decodeIfPresent([RpcDialogRequest].self, forKey: .dialogs) ?? []
    }
}

/// Les statuts requis d'une PR, miroir de la coque.
public enum RequiredCheck: String, CaseIterable, Codable, Sendable {
    case ubuntu = "check (ubuntu-latest)"
    case macos = "check (macos-latest)"
    case releaseSimulation = "release-simulation"

    /// L'identifiant d'accessibilité et de test (miroir de `project.RequiredCheck.id`),
    /// jamais le nom GitHub, qui porte espaces et parenthèses.
    public var id: String {
        switch self {
        case .ubuntu: "ubuntu"
        case .macos: "macos"
        case .releaseSimulation: "release-simulation"
        }
    }
}

/// L'état affiché d'un statut de PR.
public enum PRCheckState: String, Codable, Sendable {
    case green
    case red
    case pending
    case ignored

    /// Le mot affiché, lu de `core.PRCheckText` (miroir de `project.PRCheckState.label`).
    public var label: String {
        switch self {
        case .green: PRCheckText.green
        case .red: PRCheckText.red
        case .pending: PRCheckText.pending
        case .ignored: PRCheckText.ignored
        }
    }
}

/// L'âge d'une connaissance de PR.
public enum PRFreshness: String, Codable, Sendable {
    case unknown
    case fresh
    case stale
}

public struct PRCheckRow: Codable, Equatable, Sendable {
    public let required: RequiredCheck
    public let state: PRCheckState
    public let link: String?
}

public struct ProjectPRRow: Codable, Equatable, Sendable {
    public let slug: String
    public let number: Int?
    public let title: String?
    public let url: String
    public let checks: [PRCheckRow]
    public let freshness: PRFreshness
    /// Le commit de tête de la PR (`headRefOid`), exigé par la fusion. `nil` tant
    /// que le Mac ne l'a pas relu fraîchement.
    public var headOid: String? = nil
}

/// Le catalogue des modèles servi par `GET /v1/models` (S-14) : les sélecteurs
/// triés, dédoublonnés, non blancs, et un motif quand le chargement a échoué
/// (la liste est alors vide). Miroir EXACT de la charge utile du serveur.
public struct RemoteModelsPayload: Codable, Equatable, Sendable {
    public var selectors: [String]
    public var failure: String?

    public init(selectors: [String], failure: String?) {
        self.selectors = selectors
        self.failure = failure
    }
}

public struct RemotePullRequestsPayload: Codable, Equatable, Sendable {
    public var rows: [ProjectPRRow]
    public var failure: String?
    public var stale: Bool
}

public struct RemoteMergedPayload: Codable, Equatable, Sendable {
    public var merged: Bool
    public var number: Int?
    public var url: String
}

public struct RemoteHostedSessionPayload: Codable, Equatable, Sendable {
    public var state: String
    public var stateLabel: String
    public var sessionId: String?
    public var sessionFile: String?
    public var protocolVersion: Int?
    public var dialogs: [RpcDialogRequest]
    public var transcript: [TranscriptLine]
    public var truncated: Bool
}

// MARK: - Corps de requête

public struct RemotePairRequest: Codable, Equatable, Sendable {
    public var code: String
    public var name: String
    public var protocolVersion: Int?
}

public struct RemoteAnswerRequest: Codable, Equatable, Sendable {
    public var toolCallId: String?
    public var kind: String
    public var label: String?
    public var text: String?
}

public struct RemoteTextRequest: Codable, Equatable, Sendable {
    public var text: String
}

public struct RemoteVerdictRequest: Codable, Equatable, Sendable {
    public var verdict: String
}

public struct RemotePromptRequest: Codable, Equatable, Sendable {
    public var message: String
}

public struct RemoteFeatureRequest: Codable, Equatable, Sendable {
    public var repoRoot: String
    public var title: String
    public var description: String
    public var modelReqSpecs: String?
    public var modelImplReview: String?
}

public struct RemoteConduiteRequest: Codable, Equatable, Sendable {
    public var name: String
}

/// La réponse à une escalade de la conduite (S-4/S-5, miroir de
/// `remote.RemoteDialogAnswerRequest`) : `value` pour `editor`/`select`/`input`,
/// `confirmed` pour `confirm`, `cancelled` pour une annulation.
public struct RemoteDialogAnswerRequest: Codable, Equatable, Sendable {
    public var kind: String
    public var value: String?
    public var confirmed: Bool?

    public init(kind: String, value: String? = nil, confirmed: Bool? = nil) {
        self.kind = kind
        self.value = value
        self.confirmed = confirmed
    }
}

public struct RemoteMergeRequest: Codable, Equatable, Sendable {
    public var headOid: String
}

// MARK: - Évènements du flux temps réel

public struct RemoteHelloEvent: Codable, Equatable, Sendable {
    public var protocolVersion: Int
}

public struct RemoteSessionsEvent: Codable, Equatable, Sendable {
    public var file: String
    public var added: [RemoteConversationEntry]?
    public var issue: String?
}

public struct RemoteHostedEvent: Codable, Equatable, Sendable {
    public var state: String
    public var dialogs: [RpcDialogRequest]
    public var added: [TranscriptLine]
}

public struct RemoteDevicesEvent: Codable, Equatable, Sendable {
    public var devices: [RemoteDeviceRow]
}

// MARK: - Types portés par `GET /v1/session` et par les évènements

/// Les quatre méthodes de dialogue auxquelles l'app répond.
public enum RpcDialogMethod: String, CaseIterable, Codable, Sendable {
    case select
    case confirm
    case input
    case editor
}

/// Une demande de dialogue dépliée.
public struct RpcDialogRequest: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let method: RpcDialogMethod
    public let title: String
    public let message: String?
    public let options: [String]
    public let optionDescriptions: [String?]
    public let placeholder: String?
    public let prefill: String?
    public let promptStyle: Bool
}

/// Une ligne de la transcription brute.
public struct TranscriptLine: Identifiable, Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case inbound
        case outbound
        case clientError
    }

    public let id: Int
    public let kind: Kind
    public let text: String
}
