// Les LIGNES présentables d'une conversation, et leur assemblage incrémental
// (S-1 de la feature `visionneuse-de-session`).
//
// Une ligne est un fait AFFICHABLE : une entrée du modèle peut en produire
// plusieurs (un message assistant porte ses appels d'outil) et un résultat
// n'en produit AUCUNE quand il se rattache à l'appel qu'il répond (il le
// COMPLÈTE). Trois invariants gouvernent l'assemblage :
//   — l'ordre EST l'ordre du tableau `rows` : aucune autre vue ne le recalcule ;
//   — une ligne publiée n'est jamais retirée ni réordonnée, son contenu peut
//     seulement être complété — les `id` sont donc stables à vie, ce qui rend
//     lisibles les plis et la position de défilement d'une fenêtre qui suit ;
//   — les `id` sont dérivés de l'OFFSET de l'entrée, pas d'un compteur : deux
//     lectures du même fichier rendent les mêmes identités.
//
// Aucune E/S, aucun état de vue : le modèle de conversation entre, des lignes
// sortent. PARTAGÉ : les deux coques construisent les mêmes lignes.

import Foundation

// MARK: - Question `ask`

/// La question d'un appel `ask` et ses options, telles qu'elles ont été DEMANDÉES.
/// Affichage seul : aucune réponse n'est portée ici (S-6).
public struct AskSpan: Equatable, Sendable {
    public struct Option: Equatable, Sendable {
        public var label: String
        public var description: String?

        public init(label: String, description: String?) {
            self.label = label
            self.description = description
        }
    }

    public struct Question: Equatable, Sendable {
        public var id: String
        public var question: String
        public var header: String?
        public var options: [Option]

        public init(id: String, question: String, header: String?, options: [Option]) {
            self.id = id
            self.question = question
            self.header = header
            self.options = options
        }
    }

    public var questions: [Question]

    public init(questions: [Question]) {
        self.questions = questions
    }
}

/// Lit la charge utile d'un appel `ask`. Validation TOLÉRANTE mais qui ÉCHOUE
/// FERMÉ, parité `recoverAskQuestions` (Documentation §6) : une seule question
/// malformée rend `nil`, et l'appel redevient un appel d'outil ordinaire.
///
/// Un `null` explicite sur un champ optionnel est traité comme ABSENT — l'hôte
/// normalise ainsi ses arguments persistés, et une question dont le `header` est
/// nul reste une question valide.
public func askSpan(from arguments: JSONValue?) -> AskSpan? {
    guard case .object(let object)? = arguments,
        case .array(let rawQuestions)? = object["questions"],
        !rawQuestions.isEmpty
    else { return nil }

    var questions: [AskSpan.Question] = []
    for rawQuestion in rawQuestions {
        guard case .object(let question) = rawQuestion,
            case .string(let id)? = question["id"],
            case .string(let text)? = question["question"],
            case .array(let rawOptions)? = question["options"]
        else { return nil }

        let header: String?
        switch optionalText(question["header"]) {
        case .value(let text): header = text
        case .absent: header = nil
        case .malformed: return nil
        }

        var options: [AskSpan.Option] = []
        for rawOption in rawOptions {
            guard case .object(let option) = rawOption, case .string(let label)? = option["label"] else {
                return nil
            }
            let description: String?
            switch optionalText(option["description"]) {
            case .value(let text): description = text
            case .absent: description = nil
            case .malformed: return nil
            }
            options.append(AskSpan.Option(label: label, description: description))
        }
        questions.append(AskSpan.Question(id: id, question: text, header: header, options: options))
    }
    return AskSpan(questions: questions)
}

/// Un champ texte optionnel : absent ou nul (toléré), chaîne, ou malformé.
private enum OptionalText {
    case absent
    case value(String)
    case malformed
}

private func optionalText(_ raw: JSONValue?) -> OptionalText {
    guard let raw else { return .absent }
    switch raw {
    case .null: return .absent
    case .string(let text): return .value(text)
    default: return .malformed
    }
}

// MARK: - En-tête d'appel

/// L'ordre canonique des arguments « parlants » du TUI
/// (`PRIMARY_ARG_KEYS`, Documentation §6) : le premier présent gagne.
private let primaryArgumentKeys = [
    "path", "file_path", "filePath", "command", "cmd", "pattern", "url", "query",
    "prompt", "assignment", "note", "message", "op", "name", "id",
]

/// Le champ d'intention, ignoré : il décrit pourquoi, pas quoi.
private let intentField = "i"

/// Les clés dont la valeur est un CHEMIN : affichées relatives à la racine du
/// projet, ou sous `~` (`ConsoleFormat.path`), jamais en chemin absolu.
private let pathArgumentKeys: Set<String> = ["path", "paths", "file_path", "filePath"]

/// Les outils mémoire : leur cible est le TEXTE du souvenir (ou la recherche), pas
/// la portée ni le type ; `mem0_forget` ne vise qu'un identifiant, sans cible.
private let memoryTextTools: Set<String> = ["mem0_add", "mem0_update"]

/// La portée d'un souvenir en français : la valeur brute (`project`) ne s'affiche pas.
private let memoryScopeTitles = ["project": "projet", "global": "global"]

/// Borne de l'en-tête d'appel, celle du TUI (`PRIMARY_ARG_MAX`).
private let primaryArgumentMax = 120

/// La cible affichée dans l'en-tête d'un appel d'outil : ce que l'appel vise.
/// Règle reprise du TUI (Documentation §6), avec des ajouts propres à la
/// visionneuse — `ask` rend sa première question, un appel sans argument
/// exploitable rend `""`, un chemin passe par `ConsoleFormat.path` (relatif à
/// `projectRoot` quand il est connu), un outil mémoire rend le texte du souvenir
/// et une portée se dit en français.
public func primaryArgument(name: String, arguments: JSONValue?, projectRoot: String? = nil) -> String {
    guard let arguments, case .object(let object) = arguments else { return "" }

    func value(_ key: String) -> String? {
        if pathArgumentKeys.contains(key) { return pathText(object[key], projectRoot: projectRoot) }
        if key == "scope", let scope = scalarText(object[key]) { return memoryScopeTitles[scope] ?? scope }
        return scalarText(object[key])
    }

    if name == "grep" {
        let pattern = scalarText(object["pattern"])
        let paths = value("path") ?? value("paths")
        if let pattern, let paths { return oneLine("\(pattern) @ \(paths)") }
        if let pattern { return oneLine(pattern) }
        if let paths { return oneLine(paths) }
    }
    if name == "ask", let question = askSpan(from: arguments)?.questions.first, !question.question.isEmpty {
        return oneLine(question.question)
    }
    if name == "mem0_forget" { return "" }
    if memoryTextTools.contains(name), let text = value("text") { return oneLine(text) }

    for key in primaryArgumentKeys {
        if let text = value(key) { return oneLine(text) }
    }
    // Repli : la première valeur texte non vide parmi les clés restantes. Le
    // dictionnaire Swift n'a AUCUN ordre, le tri est donc ce qui rend le repli
    // déterministe — sans lui, deux exécutions pourraient afficher deux cibles.
    let rest = object.keys
        .filter { !primaryArgumentKeys.contains($0) && $0 != intentField }
        .sorted()
    for key in rest {
        if let text = value(key) { return oneLine(text) }
    }
    return oneLine(renderJSON(arguments))
}

/// Un ou plusieurs chemins, chacun rendu par `ConsoleFormat.path`.
private func pathText(_ value: JSONValue?, projectRoot: String?) -> String? {
    switch value {
    case .string(let path)?:
        return path.isEmpty ? nil : ConsoleFormat.path(path, relativeTo: projectRoot)
    case .array(let items)?:
        guard !items.isEmpty else { return nil }
        var parts: [String] = []
        for item in items {
            guard case .string(let path) = item else { return nil }
            parts.append(ConsoleFormat.path(path, relativeTo: projectRoot))
        }
        let joined = parts.joined(separator: ", ")
        return joined.isEmpty ? nil : joined
    default:
        return nil
    }
}

/// Une valeur exploitable pour un en-tête : une chaîne non vide, ou un tableau
/// non vide de chaînes jointes par `", "` (règle `primaryArgValue`, §6).
private func scalarText(_ value: JSONValue?) -> String? {
    guard let value else { return nil }
    switch value {
    case .string(let text):
        return text.isEmpty ? nil : text
    case .array(let items):
        guard !items.isEmpty else { return nil }
        var parts: [String] = []
        for item in items {
            guard case .string(let text) = item else { return nil }
            parts.append(text)
        }
        let joined = parts.joined(separator: ", ")
        return joined.isEmpty ? nil : joined
    default:
        return nil
    }
}

/// Aplati les blancs, rogne, et coupe à `primaryArgumentMax` avec `…` (règle
/// `oneLine`, §6). Un découpage sur les blancs suivi d'une jointure par un espace
/// fait exactement ce que `replace(/\s+/g, " ").trim()` fait côté hôte.
private func oneLine(_ text: String) -> String {
    let flat = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    guard flat.count > primaryArgumentMax else { return flat }
    return String(flat.prefix(primaryArgumentMax - 1)) + "…"
}

// MARK: - Lignes

/// Une ligne affichable. `id` est stable à vie : il dérive de l'OFFSET de
/// l'entrée dans le fichier.
public struct SessionRow: Identifiable, Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case user(UserRow)
        case assistant(AssistantRow)
        case toolCall(ToolCallRow)
        case toolResult(ToolResultRow)
        case marker(MarkerRow)
    }

    public var id: String
    public var kind: Kind

    public init(id: String, kind: Kind) {
        self.id = id
        self.kind = kind
    }
}

public struct UserRow: Equatable, Sendable {
    public var text: String

    public init(text: String) {
        self.text = text
    }
}

/// Un message de l'agent. La réflexion n'est PAS un fait essentiel : elle est
/// portée par la ligne du message qui la contient, derrière un pli.
public struct AssistantRow: Equatable, Sendable {
    public var text: String
    public var thinking: String?

    public init(text: String, thinking: String?) {
        self.text = text
        self.thinking = thinking
    }
}

/// Un appel d'outil : son en-tête (nom + cible) et son corps (arguments,
/// résultat, diff), ce dernier ouvert à la demande.
public struct ToolCallRow: Equatable, Sendable {
    public var callId: String
    public var name: String
    public var target: String
    public var argumentsJSON: String
    /// `nil` tant que l'appel n'a pas de réponse : le résultat le COMPLÈTE.
    public var result: ToolResultRow?
    /// Renseigné seulement pour un appel `ask` dont la charge utile est valide.
    public var ask: AskSpan?

    public init(
        callId: String,
        name: String,
        target: String,
        argumentsJSON: String,
        result: ToolResultRow?,
        ask: AskSpan?
    ) {
        self.callId = callId
        self.name = name
        self.target = target
        self.argumentsJSON = argumentsJSON
        self.result = result
        self.ask = ask
    }
}

/// Le résultat d'un appel : autonome (aucun appel vu), ou le corps d'un appel.
public struct ToolResultRow: Equatable, Sendable {
    public var callId: String?
    public var name: String?
    public var text: String
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

public enum MarkerRow: Equatable, Sendable {
    case compaction(summary: String, tokensBefore: Int?)
    case branchSummary(summary: String, fromId: String)
}

// MARK: - Assemblage

/// L'état d'assemblage INCRÉMENTAL d'une conversation. `append` est le seul point
/// d'entrée : il ne reçoit jamais deux fois la même entrée (l'offset consommé est
/// mémorisé), donc une lecture qui repasserait sur un fait déjà vu n'ajoute rien.
public struct SessionRowBuilder: Sendable {
    public private(set) var rows: [SessionRow] = []
    /// `callId → index de la ligne d'appel`, pour rattacher le résultat à son
    /// appel. Le PREMIER appel mémorisé gagne (`callRows[id] == nil`).
    private var callRows: [String: Int] = [:]
    /// Les offsets d'entrée déjà consommés : l'anti-doublon.
    private var consumedOffsets: Set<Int> = []
    /// Les textes de l'agent (rognés, non vides) déjà montrés depuis le dernier
    /// message de l'utilisateur. Mesuré sur les sessions réelles : l'agent redonne
    /// sa réponse finale, soit MOT POUR MOT après un dernier appel d'outil, soit —
    /// quand un avis `[pipeline]` (un `custom_message`, silencieux pour le lecteur)
    /// déclenche un tour automatique — en DERNIER PARAGRAPHE d'un message précédé
    /// d'un préambule. Les DONNÉES portent le doublon ; le fil ne le montre
    /// qu'une fois. Un vrai message de l'utilisateur vide l'ensemble.
    private var shownAssistantTexts: Set<String> = []
    /// La racine du projet de la session (le `cwd` de son en-tête) : les chemins
    /// des appels d'outil s'affichent relatifs à elle. Posée avant `append` ; une
    /// ligne déjà bâtie n'est pas réécrite.
    public var projectRoot: String?

    public init() {}

    public mutating func append(_ entries: [ConversationEntry]) {
        for entry in entries {
            guard !consumedOffsets.contains(entry.offset) else { continue }
            consumedOffsets.insert(entry.offset)

            switch entry.kind {
            case .user(let turn):
                shownAssistantTexts.removeAll()
                rows.append(
                    SessionRow(id: rowId(entry.offset), kind: .user(UserRow(text: turn.text)))
                )

            case .assistant(let turn):
                let text = turn.text.trimmingCharacters(in: .whitespacesAndNewlines)
                let thinking = turn.thinking.flatMap { $0.isEmpty ? nil : $0 }
                let shown = displayedText(of: turn.text, trimmed: text)
                if !text.isEmpty { shownAssistantTexts.insert(text) }
                // Un texte déjà montré dans le même tour est REPLIÉ : la ligne ne
                // garde que sa réflexion, ou disparaît s'il n'y en a pas. Ses appels
                // d'outil restent, eux, tous affichés.
                if shown != nil || thinking != nil {
                    rows.append(
                        SessionRow(
                            id: rowId(entry.offset),
                            kind: .assistant(AssistantRow(text: shown ?? "", thinking: turn.thinking))
                        )
                    )
                }
                for (index, call) in turn.toolCalls.enumerated() {
                    rows.append(SessionRow(id: callId(entry.offset, index), kind: .toolCall(callRow(call))))
                    if !call.id.isEmpty, callRows[call.id] == nil { callRows[call.id] = rows.count - 1 }
                }

            case .toolResult(let turn):
                let result = ToolResultRow(
                    callId: turn.callId,
                    name: turn.name,
                    text: turn.text,
                    diff: turn.diff,
                    isError: turn.isError
                )
                if let id = turn.callId, !id.isEmpty, let index = callRows[id],
                    case .toolCall(let row) = rows[index].kind, row.result == nil
                {
                    // Rattachement à l'appel : AUCUNE ligne nouvelle. Un appel déjà
                    // répondu ne l'est pas deux fois — la seconde réponse devient
                    // autonome, elle aussi affichée.
                    var completed = row
                    completed.result = result
                    rows[index].kind = .toolCall(completed)
                } else {
                    rows.append(
                        SessionRow(id: rowId(entry.offset), kind: .toolResult(result))
                    )
                }

            case .compaction(let marker):
                rows.append(
                    SessionRow(
                        id: rowId(entry.offset),
                        kind: .marker(.compaction(summary: marker.summary, tokensBefore: marker.tokensBefore))
                    )
                )

            case .branchSummary(let marker):
                rows.append(
                    SessionRow(
                        id: rowId(entry.offset),
                        kind: .marker(.branchSummary(summary: marker.summary, fromId: marker.fromId))
                    )
                )
            }
        }
    }

    /// Le texte à montrer pour un message de l'agent : `nil` si c'est la copie
    /// INTÉGRALE d'un texte déjà montré ; le message sans sa copie finale si un
    /// texte déjà montré revient en fin de message, juste après une fin de ligne
    /// (la copie la plus longue, donc le plus petit début) ; sinon le texte tel quel.
    /// Comparaison exacte sur textes rognés : aucun rapprochement flou. `Character.isNewline`
    /// et non `== "\n"` : « \r\n » est un seul `Character`.
    private func displayedText(of original: String, trimmed text: String) -> String? {
        guard !text.isEmpty else { return original }
        if shownAssistantTexts.contains(text) { return nil }
        guard !shownAssistantTexts.isEmpty else { return original }
        var index = text.startIndex
        while index < text.endIndex {
            let next = text.index(after: index)
            if text[index].isNewline, next < text.endIndex, shownAssistantTexts.contains(String(text[next...])) {
                let preamble = String(text[..<next]).trimmingCharacters(in: .whitespacesAndNewlines)
                return preamble
            }
            index = next
        }
        return original
    }

    private func callRow(_ call: ToolCall) -> ToolCallRow {
        ToolCallRow(
            callId: call.id,
            name: call.name,
            target: primaryArgument(name: call.name, arguments: call.arguments, projectRoot: projectRoot),
            // Le rendu des arguments est celui du dépôt (`renderJSON` : clés
            // triées, compact) : jamais une seconde mise en forme.
            argumentsJSON: renderJSON(call.arguments ?? .null),
            result: nil,
            ask: call.name == "ask" ? askSpan(from: call.arguments) : nil
        )
    }

    private func rowId(_ offset: Int) -> String { "r\(offset)" }

    /// Le k-ième appel (0-based) de l'entrée assistant d'offset `offset`.
    private func callId(_ offset: Int, _ index: Int) -> String { "r\(offset).c\(index)" }
}
