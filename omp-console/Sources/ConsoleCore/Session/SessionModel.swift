// Le modèle de conversation d'une session OMP : des VALEURS, pas des vues.
//
// Deux invariants portés par ces types, et par eux seuls :
//   — toutes les chaînes sont BRUTES. L'hôte peut y avoir écrit un contenu
//     tronqué par sa propre persistance (« [Session persistence truncated large
//     content] », Doc-1) : nous ne retronquons rien et ne retirons rien.
//   — le modèle et l'usage d'une réponse sont portés par le message assistant
//     lui-même (Doc-2), jamais dérivés des entrées `model_change`/`model_usage`.
//
// Aucun comportement ici : que des types et leurs invariants.

/// `JSONValue` (le socle JSON partagé) vit dans le même module
/// (`ConsoleCore/Session/JSONValue.swift`) : ces types valent pour les DEUX coques.

/// Usage d'une réponse, lu sur `message.usage`.

public struct TokenUsage: Equatable, Sendable {
    public var input: Int
    public var output: Int
    public var cacheRead: Int
    public var cacheWrite: Int
    public var totalTokens: Int
    /// `usage.cost.total`, `nil` si `cost` est absent ou non numérique.
    public var cost: Double?

    public init(
        input: Int,
        output: Int,
        cacheRead: Int,
        cacheWrite: Int,
        totalTokens: Int,
        cost: Double?
    ) {
        self.input = input
        self.output = output
        self.cacheRead = cacheRead
        self.cacheWrite = cacheWrite
        self.totalTokens = totalTokens
        self.cost = cost
    }
}

/// L'en-tête `type:"session"` d'un fichier de session.
public struct SessionHeader: Equatable, Sendable {
    public var id: String
    /// Chaîne vide si l'en-tête ne porte pas de `cwd` exploitable.
    public var cwd: String
    /// `nil` si absent (fichier hérité, Doc-1).
    public var version: Int?
    public var timestamp: String?
    /// Déjà normalisé : `nil` si absent, nul, vide ou non-chaîne. La valeur est
    /// verbatim — un identifiant de session OU un chemin, jamais résolu.
    public var parentSession: String?

    public init(
        id: String,
        cwd: String,
        version: Int?,
        timestamp: String?,
        parentSession: String?
    ) {
        self.id = id
        self.cwd = cwd
        self.version = version
        self.timestamp = timestamp
        self.parentSession = parentSession
    }
}

/// Ce que l'en-tête dit de la session. La marque d'un sous-agent est l'EN-TÊTE,
/// jamais le nom du fichier (Doc-3).
public enum SessionKind: Equatable, Sendable {
    case topLevel
    case subagent(parentSession: String)
}

/// Un bloc `toolCall` du contenu d'un message assistant.
public struct ToolCall: Equatable, Sendable {
    public var id: String
    public var name: String
    /// `nil` si absent ou non-objet.
    public var arguments: JSONValue?

    public init(id: String, name: String, arguments: JSONValue?) {
        self.id = id
        self.name = name
        self.arguments = arguments
    }
}

public struct UserTurn: Equatable, Sendable {
    public var text: String

    public init(text: String) {
        self.text = text
    }
}

public struct AssistantTurn: Equatable, Sendable {
    /// Concaténation par `"\n"` des blocs `text` ; `""` s'il n'y en a aucun.
    public var text: String
    /// Concaténation par `"\n"` des blocs `thinking` ; `nil` s'il n'y en a aucun.
    public var thinking: String?
    public var model: String?
    public var usage: TokenUsage?
    public var toolCalls: [ToolCall]
    /// `message.provider` (« anthropic ») : avec `model`, id NU, il forme le
    /// sélecteur exact `provider/model` du catalogue. `nil` s'il est absent.
    public var provider: String?

    public init(
        text: String,
        thinking: String?,
        model: String?,
        usage: TokenUsage?,
        toolCalls: [ToolCall],
        provider: String? = nil
    ) {
        self.text = text
        self.thinking = thinking
        self.model = model
        self.usage = usage
        self.toolCalls = toolCalls
        self.provider = provider
    }
}

public struct ToolResultTurn: Equatable, Sendable {
    /// `message.toolCallId` : c'est par cet id que l'appel et son résultat se
    /// répondent. `nil` si absent ou non-chaîne.
    public var callId: String?
    /// `message.toolName`.
    public var name: String?
    public var text: String
    /// `message.details.diff`, retenu seulement si c'est une chaîne (outil `edit`).
    public var diff: String?
    public var isError: Bool

    public init(callId: String?, name: String?, text: String, diff: String?, isError: Bool) {
        self.callId = callId
        self.name = name
        self.text = text
        self.diff = diff
        self.isError = isError
    }
}

/// Entrée `compaction` : une bascule de contexte, à sa position dans le fichier.
public struct CompactionMarker: Equatable, Sendable {
    public var summary: String
    public var tokensBefore: Int?

    public init(summary: String, tokensBefore: Int?) {
        self.summary = summary
        self.tokensBefore = tokensBefore
    }
}

/// Entrée `branch_summary` : résumé de la branche dont la lecture part.
public struct BranchSummaryMarker: Equatable, Sendable {
    public var summary: String
    /// `fromId` verbatim ; `"root"` littéral quand la branche part de la racine.
    /// Chaîne vide si l'entrée n'en porte pas (seul `summary` est indispensable).
    public var fromId: String

    public init(summary: String, fromId: String) {
        self.summary = summary
        self.fromId = fromId
    }
}

/// Une entrée de conversation, à sa place dans le fichier.
public struct ConversationEntry: Equatable, Sendable {
    /// Rang 1-based parmi les entrées de conversation : `1…n` sans trou.
    public var index: Int
    /// Premier octet de la LIGNE dans le fichier.
    public var offset: Int

    public enum Kind: Equatable, Sendable {
        case user(UserTurn)
        case assistant(AssistantTurn)
        case toolResult(ToolResultTurn)
        case compaction(CompactionMarker)
        case branchSummary(BranchSummaryMarker)
    }

    public var kind: Kind

    /// `timestamp` de l'entrée, analysé UNE fois à la classification (Doc-3) et
    /// porté en millisecondes depuis l'époque. `nil` quand la clé est absente ou
    /// non analysable. Valeur par défaut `nil` : les constructions littérales
    /// existantes (tests) restent valides.
    public var timestampMs: Double? = nil

    public init(index: Int, offset: Int, kind: Kind, timestampMs: Double? = nil) {
        self.index = index
        self.offset = offset
        self.kind = kind
        self.timestampMs = timestampMs
    }
}

/// Pourquoi une ligne complète n'a pas produit d'entrée.
public enum SkipReason: Equatable, Sendable {
    /// Ligne non décodable en UTF-8, ou JSON invalide.
    case invalidJSON
    /// Objet sans « type », « type » non-chaîne, ou hors des types connus.
    case unknownType
    /// Type connu, charge utile indispensable absente ou mal typée.
    case malformed
}

public struct SkippedEntry: Equatable, Sendable {
    public var offset: Int
    public var reason: SkipReason

    public init(offset: Int, reason: SkipReason) {
        self.offset = offset
        self.reason = reason
    }
}

/// Le modèle accumulé d'une session : l'en-tête une fois, puis les entrées de
/// conversation et les lignes ignorées, toutes deux dans l'ordre du fichier.
public struct SessionConversation: Equatable, Sendable {
    public var header: SessionHeader?
    /// Posé en même temps que `header`, et jamais modifié ensuite.
    public var kind: SessionKind?
    public var entries: [ConversationEntry]
    public var skipped: [SkippedEntry]

    public init(
        header: SessionHeader?,
        kind: SessionKind?,
        entries: [ConversationEntry],
        skipped: [SkippedEntry]
    ) {
        self.header = header
        self.kind = kind
        self.entries = entries
        self.skipped = skipped
    }
}
