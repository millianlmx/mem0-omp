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
// sortent.

import Foundation

// MARK: - Question `ask`

/// La question d'un appel `ask` et ses options, telles qu'elles ont été DEMANDÉES.
/// Affichage seul : aucune réponse n'est portée ici (S-6).
struct AskSpan: Equatable, Sendable {
    struct Option: Equatable, Sendable {
        var label: String
        var description: String?
    }

    struct Question: Equatable, Sendable {
        var id: String
        var question: String
        var header: String?
        var options: [Option]
    }

    var questions: [Question]
}

/// Lit la charge utile d'un appel `ask`. Validation TOLÉRANTE mais qui ÉCHOUE
/// FERMÉ, parité `recoverAskQuestions` (Documentation §6) : une seule question
/// malformée rend `nil`, et l'appel redevient un appel d'outil ordinaire.
///
/// Un `null` explicite sur un champ optionnel est traité comme ABSENT — l'hôte
/// normalise ainsi ses arguments persistés, et une question dont le `header` est
/// nul reste une question valide.
func askSpan(from arguments: JSONValue?) -> AskSpan? {
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

/// Borne de l'en-tête d'appel, celle du TUI (`PRIMARY_ARG_MAX`).
private let primaryArgumentMax = 120

/// La cible affichée dans l'en-tête d'un appel d'outil : ce que l'appel vise.
/// Règle reprise du TUI (Documentation §6), avec deux ajouts propres à la
/// visionneuse — `ask` rend sa première question, et un appel sans argument
/// exploitable rend `""`.
func primaryArgument(name: String, arguments: JSONValue?) -> String {
    guard let arguments, case .object(let object) = arguments else { return "" }

    if name == "grep" {
        let pattern = scalarText(object["pattern"])
        let paths = scalarText(object["path"]) ?? scalarText(object["paths"])
        if let pattern, let paths { return oneLine("\(pattern) @ \(paths)") }
        if let pattern { return oneLine(pattern) }
        if let paths { return oneLine(paths) }
    }
    if name == "ask", let question = askSpan(from: arguments)?.questions.first, !question.question.isEmpty {
        return oneLine(question.question)
    }

    for key in primaryArgumentKeys {
        if let value = scalarText(object[key]) { return oneLine(value) }
    }
    // Repli : la première valeur texte non vide parmi les clés restantes. Le
    // dictionnaire Swift n'a AUCUN ordre, le tri est donc ce qui rend le repli
    // déterministe — sans lui, deux exécutions pourraient afficher deux cibles.
    let rest = object.keys
        .filter { !primaryArgumentKeys.contains($0) && $0 != intentField }
        .sorted()
    for key in rest {
        if let value = scalarText(object[key]) { return oneLine(value) }
    }
    return oneLine(renderJSON(arguments))
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
struct SessionRow: Identifiable, Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case user(UserRow)
        case assistant(AssistantRow)
        case toolCall(ToolCallRow)
        case toolResult(ToolResultRow)
        case marker(MarkerRow)
    }

    var id: String
    var kind: Kind
}

struct UserRow: Equatable, Sendable {
    var text: String
}

/// Un message de l'agent. La réflexion n'est PAS un fait essentiel : elle est
/// portée par la ligne du message qui la contient, derrière un pli.
struct AssistantRow: Equatable, Sendable {
    var text: String
    var thinking: String?
}

/// Un appel d'outil : son en-tête (nom + cible) et son corps (arguments,
/// résultat, diff), ce dernier ouvert à la demande.
struct ToolCallRow: Equatable, Sendable {
    var callId: String
    var name: String
    var target: String
    var argumentsJSON: String
    /// `nil` tant que l'appel n'a pas de réponse : le résultat le COMPLÈTE.
    var result: ToolResultRow?
    /// Renseigné seulement pour un appel `ask` dont la charge utile est valide.
    var ask: AskSpan?
}

/// Le résultat d'un appel : autonome (aucun appel vu), ou le corps d'un appel.
struct ToolResultRow: Equatable, Sendable {
    var callId: String?
    var name: String?
    var text: String
    var diff: String?
    var isError: Bool
}

enum MarkerRow: Equatable, Sendable {
    case compaction(summary: String, tokensBefore: Int?)
    case branchSummary(summary: String, fromId: String)
}

// MARK: - Assemblage

/// L'état d'assemblage INCRÉMENTAL d'une conversation. `append` est le seul point
/// d'entrée : il ne reçoit jamais deux fois la même entrée (l'offset consommé est
/// mémorisé), donc une lecture qui repasserait sur un fait déjà vu n'ajoute rien.
struct SessionRowBuilder {
    private(set) var rows: [SessionRow] = []
    /// `callId → index de la ligne d'appel`, pour rattacher le résultat à son
    /// appel. Le PREMIER appel mémorisé gagne (`callRows[id] == nil`).
    private var callRows: [String: Int] = [:]
    /// Les offsets d'entrée déjà consommés : l'anti-doublon.
    private var consumedOffsets: Set<Int> = []

    mutating func append(_ entries: [ConversationEntry]) {
        for entry in entries {
            guard !consumedOffsets.contains(entry.offset) else { continue }
            consumedOffsets.insert(entry.offset)

            switch entry.kind {
            case .user(let turn):
                rows.append(
                    SessionRow(id: rowId(entry.offset), kind: .user(UserRow(text: turn.text)))
                )

            case .assistant(let turn):
                rows.append(
                    SessionRow(
                        id: rowId(entry.offset),
                        kind: .assistant(AssistantRow(text: turn.text, thinking: turn.thinking))
                    )
                )
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

    private func callRow(_ call: ToolCall) -> ToolCallRow {
        ToolCallRow(
            callId: call.id,
            name: call.name,
            target: primaryArgument(name: call.name, arguments: call.arguments),
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
