// Le rendu texte du modèle : le seul artefact observable de cette feature.
//
// Le format est NORMATIF au caractère (S-5) : un bloc est introduit par `== …`,
// une sous-partie par `-- …`, les corps sont verbatim (aucun échappement, aucune
// troncature, aucune couleur, aucun markdown), l'absent s'écrit `?` et le parent
// absent `-`. `renderEntry` est autonome : le bloc d'une entrée ne dépend pas de
// ses voisines, ce qui permet de peindre une entrée à la fois.
//
// Trois fonctions PURES : aucune E/S, aucun état.

/// Rend une valeur JSON de façon compacte et déterministe : clés TRIÉES, aucun
/// espace superflu. `JSONSerialization` ne garantit aucun ordre de clés (Doc-4),
/// donc le tri est explicite.
public func renderJSON(_ value: JSONValue) -> String {
    switch value {
    case .object(let dictionary):
        let body = dictionary.keys.sorted().map { key in
            "\"\(escapeJSON(key))\":\(renderJSON(dictionary[key]!))"
        }
        return "{" + body.joined(separator: ",") + "}"
    case .array(let items):
        return "[" + items.map(renderJSON).joined(separator: ",") + "]"
    case .string(let text):
        return "\"\(escapeJSON(text))\""
    case .number(let number):
        return renderNumber(number)
    case .bool(let flag):
        return flag ? "true" : "false"
    case .null:
        return "null"
    }
}

/// Rend le bloc d'UNE entrée, terminé par un saut de ligne.
public func renderEntry(_ entry: ConversationEntry) -> String {
    switch entry.kind {
    case .user(let turn):
        var parts = ["== \(entry.index) user offset=\(entry.offset)"]
        appendBody(turn.text, to: &parts)
        return block(parts)

    case .assistant(let turn):
        var parts = ["== \(entry.index) assistant offset=\(entry.offset) model=\(display(turn.model))" + usageField(turn.usage)]
        if let thinking = turn.thinking, !thinking.isEmpty {
            parts.append("-- thinking")
            parts.append(thinking)
        }
        appendBody(turn.text, section: "-- text", to: &parts)
        for call in turn.toolCalls {
            parts.append("-- tool \(call.name) id=\(call.id)")
            if let arguments = call.arguments {
                parts.append("-- args \(renderJSON(arguments))")
            } else {
                parts.append("-- args")
            }
        }
        return block(parts)

    case .toolResult(let turn):
        var parts = [
            "== \(entry.index) tool-result offset=\(entry.offset) name=\(display(turn.name)) "
                + "id=\(display(turn.callId)) error=\(turn.isError)"
        ]
        appendBody(turn.text, to: &parts)
        if let diff = turn.diff {
            parts.append("-- diff")
            appendBody(diff, to: &parts)
        }
        return block(parts)

    case .compaction(let marker):
        var parts = ["== \(entry.index) compaction offset=\(entry.offset) tokensBefore=\(marker.tokensBefore.map { String($0) } ?? "?")"]
        appendBody(marker.summary, to: &parts)
        return block(parts)

    case .branchSummary(let marker):
        var parts = ["== \(entry.index) branch-summary offset=\(entry.offset) from=\(marker.fromId)"]
        appendBody(marker.summary, to: &parts)
        return block(parts)
    }
}

/// Rend le modèle entier : la ligne d'en-tête, un bloc par entrée de conversation
/// dans l'ordre des `index`, puis une ligne par entrée ignorée. Les blocs sont
/// séparés par une ligne vide et le rendu se termine par un saut de ligne.
public func renderConversation(_ conversation: SessionConversation) -> String {
    var blocks = [headerLine(conversation)]
    blocks.append(contentsOf: conversation.entries.sorted { $0.index < $1.index }.map(renderEntry))
    blocks.append(
        contentsOf: conversation.skipped.map {
            "== ignored offset=\($0.offset) reason=\(reasonName($0.reason))\n"
        }
    )
    return blocks.joined(separator: "\n")
}

// MARK: - Sous-parties

private func headerLine(_ conversation: SessionConversation) -> String {
    let header = conversation.header
    let kind: String = switch conversation.kind {
    case .topLevel: "top-level"
    case .subagent: "subagent"
    case nil: "?"
    }
    return "== session id=\(display(header?.id)) cwd=\(display(header?.cwd)) "
        + "version=\(header?.version.map { String($0) } ?? "?") kind=\(kind) parent=\(display(header?.parentSession, absent: "-"))\n"
}

/// `usage …` si l'usage est connu, un `?` unique sinon.
private func usageField(_ usage: TokenUsage?) -> String {
    guard let usage else { return " usage=?" }
    let cost = usage.cost.map { String($0) } ?? "?"
    return " usage input=\(usage.input) output=\(usage.output) cacheRead=\(usage.cacheRead) "
        + "cacheWrite=\(usage.cacheWrite) total=\(usage.totalTokens) cost=\(cost)"
}

/// Un corps vide n'ajoute AUCUNE ligne : « un bloc est introduit par une ligne
/// `== …` (seule si son corps est vide) ».
private func appendBody(_ body: String, section: String? = nil, to parts: inout [String]) {
    guard !body.isEmpty else { return }
    if let section { parts.append(section) }
    parts.append(body)
}

private func block(_ parts: [String]) -> String {
    parts.joined(separator: "\n") + "\n"
}

private func display(_ value: String?, absent: String = "?") -> String {
    guard let value, !value.isEmpty else { return absent }
    return value
}

private func reasonName(_ reason: SkipReason) -> String {
    switch reason {
    case .invalidJSON: "invalid-json"
    case .unknownType: "unknown-type"
    case .malformed: "malformed"
    }
}

private func renderNumber(_ number: Double) -> String {
    guard number.isFinite else { return "null" }
    if number == number.rounded(), abs(number) < 1e15 { return String(Int64(number)) }
    return String(number)
}

/// Échappement JSON standard, sur les scalaires : le non-ASCII passe verbatim.
private func escapeJSON(_ text: String) -> String {
    var escaped = ""
    for scalar in text.unicodeScalars {
        switch scalar {
        case "\"": escaped += "\\\""
        case "\\": escaped += "\\\\"
        case "\n": escaped += "\\n"
        case "\r": escaped += "\\r"
        case "\t": escaped += "\\t"
        case Unicode.Scalar(0x08): escaped += "\\b"
        case Unicode.Scalar(0x0C): escaped += "\\f"
        default:
            if scalar.value < 0x20 {
                escaped += String(format: "\\u%04x", scalar.value)
            } else {
                escaped.unicodeScalars.append(scalar)
            }
        }
    }
    return escaped
}
