// Les trames du protocole RPC, HUMANISÉES pour l'inspecteur « Détails techniques »
// de Session OMP (S-18 R8 de omp-console-redesign) : une ligne par trame, un
// symbole, un titre court en français et un détail d'au plus 80 caractères, en
// texte brut (les marques Markdown d'un message sont retirées) et sans valeur
// brute du protocole (« completed » se dit « terminé »).
//
// `summary(_:)` est PURE : elle ne lit que la ligne de transcription
// (`TranscriptLine`, SessionHost.swift) — trame reçue telle quelle, commande
// émise préfixée de « → », erreur locale préfixée de « ! ». Une trame que le
// JSON ne lit pas n'est jamais une erreur : elle se dit « Trame illisible », sauf
// si le host l'a TRONQUÉE (au-delà de 4 096 caractères), auquel cas son type se
// lit encore dans son début.
//
// `RpcActivityCache` évite de réanalyser à chaque passe de rendu les 200 trames
// affichées : une trame est résumée une fois, par identifiant.

import ConsoleCore
import Foundation

/// Une trame humanisée.
struct RpcEventLine: Identifiable, Equatable, Sendable {
    /// L'identifiant de la ligne de transcription d'origine.
    let id: Int
    let symbol: String
    let title: String
    /// Au plus `RpcEventSummary.detailLimit` caractères, sur une ligne ; vide si
    /// la trame n'a rien d'autre à dire que son titre.
    let detail: String
}

enum RpcEventSummary {
    /// Longueur maximale du détail d'une ligne, points de suspension compris.
    static let detailLimit = 80
    /// Nombre maximal de lignes de l'activité.
    static let activityLimit = 200

    /// Le suffixe que `SessionHost.display(_:)` pose sur une trame tronquée.
    private static let truncationMarker = "octets tronqués]"

    private typealias FrameText = SessionConsoleText.Frame

    /// Résume UNE ligne de transcription.
    static func summary(_ line: TranscriptLine) -> RpcEventLine {
        let (symbol, title, detail): (String, String, String)
        switch line.kind {
        case .clientError:
            (symbol, title, detail) = ("exclamationmark.octagon", FrameText.localError, dropPrefix("!", from: line.text))
        case .outbound:
            (symbol, title, detail) = outbound(dropPrefix("→", from: line.text))
        case .inbound:
            (symbol, title, detail) = inbound(line.text)
        }
        return RpcEventLine(id: line.id, symbol: symbol, title: title, detail: clip(detail))
    }

    /// L'activité : les `limit` trames les plus RÉCENTES, la plus récente en haut.
    static func activity(_ lines: [TranscriptLine], limit: Int = activityLimit) -> [RpcEventLine] {
        lines.suffix(limit).reversed().map(summary)
    }

    // MARK: - Commandes émises

    private static func outbound(_ text: String) -> (String, String, String) {
        guard let frame = object(text), let type = frame["type"] as? String else {
            return unreadable(text)
        }
        switch type {
        case "prompt":
            return ("paperplane", FrameText.promptSent, plainText(frame["message"] as? String ?? ""))
        case "get_state":
            return ("info.circle", FrameText.stateRequest, "")
        case "negotiate_protocol":
            let version = (frame["protocolVersion"] as? NSNumber).map { "version \($0)" } ?? ""
            return ("arrow.left.arrow.right", FrameText.negotiation, version)
        case "extension_ui_response":
            return ("arrowshape.turn.up.left", FrameText.hostAnswer, dialogAnswer(frame))
        default:
            return ("arrow.up.circle", FrameText.command(type), "")
        }
    }

    private static func dialogAnswer(_ frame: [String: Any]) -> String {
        if frame["cancelled"] as? Bool == true { return FrameText.cancelled }
        if let confirmed = frame["confirmed"] as? Bool { return confirmed ? FrameText.confirmed : FrameText.declined }
        return frame["value"] as? String ?? ""
    }

    // MARK: - Trames reçues

    private static func inbound(_ text: String) -> (String, String, String) {
        if let frame = object(text), let type = frame["type"] as? String {
            return inbound(type: type, frame: frame, detail: nil)
        }
        // Trame tronquée par le host : le JSON n'est plus lisible, mais son début
        // dit encore ce qu'elle était.
        guard text.hasSuffix(truncationMarker), let type = firstString("type", in: text) else {
            return unreadable(text)
        }
        var frame: [String: Any] = ["type": type]
        for key in ["toolName", "command", "method"] {
            if let value = firstString(key, in: text) { frame[key] = value }
        }
        return inbound(type: type, frame: frame, detail: FrameText.truncated)
    }

    /// `detail` remplace le détail calculé (trame tronquée) ; le titre, lui, se
    /// lit toujours dans la trame.
    private static func inbound(type: String, frame: [String: Any], detail forced: String?) -> (String, String, String) {
        let (symbol, title, detail) = classify(type: type, frame: frame)
        return (symbol, title, forced ?? detail)
    }

    private static func classify(type: String, frame: [String: Any]) -> (String, String, String) {
        switch type {
        case "ready":
            return ("power", FrameText.ready, "")
        case "response":
            let command = frame["command"] as? String ?? "?"
            if frame["success"] as? Bool == false {
                return ("xmark.octagon", FrameText.failedResponse(command), errorText(frame["error"]))
            }
            return ("arrow.down.circle", FrameText.response(command), "")
        case "prompt_result":
            let error = errorText(frame["error"])
            let status = FrameText.turnStatus(frame["status"] as? String ?? "")
            return ("flag.checkered", FrameText.turnResult, error.isEmpty ? status : "\(status) · \(error)")
        case "session_settled":
            return ("checkmark.seal", FrameText.settled, "")
        case "agent_start":
            return ("play.circle", FrameText.agentStart, "")
        case "agent_end":
            return ("pause.circle", FrameText.agentEnd, "")
        case "turn_start":
            return ("arrow.right.circle", FrameText.turnStart, "")
        case "turn_end":
            return ("arrow.down.right.circle", FrameText.turnEnd, "")
        case "message_start", "message_end", "message_update":
            return message(type: type, frame: frame)
        case "tool_execution_start", "tool_execution_update", "tool_execution_end":
            return tool(type: type, frame: frame)
        case "extension_ui_request":
            return hostRequest(frame)
        case "available_commands_update":
            return ("command", FrameText.commandsUpdate, "")
        case "thinking_level_changed":
            return ("brain", FrameText.thinkingLevel, scalar(frame["level"]) ?? "")
        case "advisor_cost_changed":
            return ("dollarsign.circle", FrameText.advisorCost, "")
        default:
            return ("circle.dashed", FrameText.event(type), "")
        }
    }

    private static func message(type: String, frame: [String: Any]) -> (String, String, String) {
        let message = frame["message"] as? [String: Any] ?? [:]
        let role = message["role"] as? String
        let (symbol, title): (String, String)
        switch role {
        case "user":
            (symbol, title) = ("person.crop.circle", FrameText.userMessage)
        case "toolResult":
            let name = message["toolName"] as? String ?? "?"
            (symbol, title) = (ToolVerb.symbol(name), FrameText.toolResult(name))
        case "assistant":
            (symbol, title) = ("text.bubble", FrameText.agentMessage)
        case nil where type == "message_update":
            (symbol, title) = ("text.bubble", FrameText.agentMessage)
        default:
            (symbol, title) = ("text.bubble", FrameText.otherMessage)
        }
        switch type {
        case "message_start":
            return (symbol, title, FrameText.messageStart)
        case "message_update":
            let event = frame["assistantMessageEvent"] as? [String: Any] ?? [:]
            let kind = event["type"] as? String ?? ""
            if kind.contains("thinking") { return (symbol, title, FrameText.thinking) }
            return (symbol, title, plainText(event["delta"] as? String ?? kind))
        default:
            return (symbol, title, plainText(messageText(message["content"])))
        }
    }

    private static func tool(type: String, frame: [String: Any]) -> (String, String, String) {
        let name = frame["toolName"] as? String ?? "?"
        switch type {
        case "tool_execution_start":
            return (ToolVerb.symbol(name), FrameText.toolCall(name), toolTarget(frame["args"]))
        case "tool_execution_update":
            return (ToolVerb.symbol(name), FrameText.toolProgress(name), "")
        default:
            if frame["isError"] as? Bool == true {
                return ("xmark.circle", FrameText.toolFailed(name), "")
            }
            return ("checkmark.circle", FrameText.toolDone(name), "")
        }
    }

    private static func hostRequest(_ frame: [String: Any]) -> (String, String, String) {
        let method = frame["method"] as? String ?? "?"
        let title = frame["title"] as? String ?? ""
        let message = frame["message"] as? String ?? ""
        if RpcDialogMethod(rawValue: method) != nil {
            return ("questionmark.bubble", FrameText.hostQuestion, title.isEmpty ? message : title)
        }
        switch method {
        case "cancel":
            return ("minus.circle", FrameText.questionWithdrawn, "")
        case "notify":
            return ("bell", FrameText.notification, plainText(message))
        case "setStatus":
            return ("info.bubble", FrameText.hostStatus, scalar(frame["statusText"]) ?? scalar(frame["text"]) ?? "")
        case "setTitle":
            return ("textformat", FrameText.hostTitle, title)
        case "setWidget":
            // La clé du panneau est un identifiant interne : le titre suffit.
            return ("rectangle.on.rectangle", FrameText.hostWidget, "")
        case "set_editor_text":
            return ("text.cursor", FrameText.hostEditorText, scalar(frame["text"]) ?? "")
        case "open_url":
            return ("link", FrameText.hostLink, scalar(frame["url"]) ?? "")
        default:
            return ("rectangle.and.text.magnifyingglass", FrameText.hostDisplay(method), "")
        }
    }

    private static func unreadable(_ text: String) -> (String, String, String) {
        ("exclamationmark.triangle", FrameText.unreadable, text)
    }

    // MARK: - Lecture

    private static func object(_ text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    /// La première valeur chaîne de `"key":"…"` dans un JSON illisible (tronqué).
    private static func firstString(_ key: String, in text: String) -> String? {
        guard let range = text.range(of: "\"\(key)\":\"") else { return nil }
        let rest = text[range.upperBound...]
        guard let end = rest.firstIndex(of: "\"") else { return nil }
        let value = rest[..<end]
        return value.isEmpty ? nil : String(value)
    }

    /// La cible lisible d'un appel d'outil : le premier argument parlant.
    private static func toolTarget(_ raw: Any?) -> String {
        guard let args = raw as? [String: Any] else { return "" }
        for key in ["path", "file_path", "command", "pattern", "query", "url", "description", "title"] {
            if let value = scalar(args[key]), !value.isEmpty { return value }
        }
        return ""
    }

    /// Le texte d'un message : chaîne, ou blocs `{type: "text", text}` mis bout à bout.
    private static func messageText(_ raw: Any?) -> String {
        if let text = raw as? String { return text }
        guard let blocks = raw as? [[String: Any]] else { return "" }
        return blocks.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }
            .joined(separator: " ")
    }

    /// Le texte d'un aperçu sans ses marques Markdown en ligne (gras, code,
    /// liens…) ; un texte que Markdown ne lit pas reste tel quel.
    static func plainText(_ text: String) -> String {
        guard text.contains(where: { "*_`[~#".contains($0) }),
              let parsed = try? AttributedString(
                  markdown: text,
                  options: AttributedString.MarkdownParsingOptions(
                      interpretedSyntax: .inlineOnlyPreservingWhitespace,
                      failurePolicy: .returnPartiallyParsedIfPossible
                  )
              )
        else { return text }
        return String(parsed.characters)
    }

    /// Un message d'erreur en chaîne, ou en objet `{message}` (D1).
    private static func errorText(_ raw: Any?) -> String {
        if let text = raw as? String { return text }
        return (raw as? [String: Any])?["message"] as? String ?? ""
    }

    private static func scalar(_ raw: Any?) -> String? {
        switch raw {
        case let text as String: return text
        case let number as NSNumber: return number.stringValue
        default: return nil
        }
    }

    private static func dropPrefix(_ prefix: String, from text: String) -> String {
        guard text.hasPrefix(prefix) else { return text }
        return String(text.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
    }

    /// Une ligne d'au plus `detailLimit` caractères : blancs et retours à la ligne
    /// réduits à une espace, coupe marquée « … ».
    static func clip(_ text: String) -> String {
        let flat = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard flat.count > detailLimit else { return flat }
        return String(flat.prefix(detailLimit - 1)) + "…"
    }
}

/// Les résumés déjà calculés, par identifiant de trame. L'inspecteur se réévalue à
/// CHAQUE trame reçue (la transcription est publiée) : sans ce cache, les 200
/// trames affichées seraient réanalysées à chaque fois, en plein flux de
/// `message_update`. Les identifiants sortis de la fenêtre sont oubliés.
@MainActor
final class RpcActivityCache {
    private var lines: [Int: RpcEventLine] = [:]

    func activity(_ transcript: [TranscriptLine], limit: Int = RpcEventSummary.activityLimit) -> [RpcEventLine] {
        let window = transcript.suffix(limit)
        if let oldest = window.first?.id, lines.count > limit {
            lines = lines.filter { $0.key >= oldest }
        }
        return window.reversed().map { line in
            if let cached = lines[line.id] { return cached }
            let summary = RpcEventSummary.summary(line)
            lines[line.id] = summary
            return summary
        }
    }
}
