// Trames JSONL du mode RPC d'OMP (S-3, D1 du contrat client-rpc-omp).
//
// Ce fichier est PUR : ni process, ni transport, ni horloge. Il traduit une ligne
// JSONL en valeur (`RpcInbound`) et une valeur en ligne. C'est ce qui le rend
// testable sans `omp`, et c'est ce que la corrélation de S-3 exige : le décodage
// ne décide de rien — le host décide, l'encodage ne peut pas échouer.
//
// Deux choix de tolérance, tous deux mesurés sur omp 18.4.1 (D1) :
//   - les champs annexes absents ou d'un autre type que celui attendu ne sont
//     JAMAIS une erreur : ils retombent sur la valeur par défaut du client, et la
//     raison est portée par `RpcReady.notes` pour que le host la journalise (S-2) ;
//   - une ligne non-JSON rend `unparsable` : le host la journalise et continue
//     (B-6). Rien ici ne lève, rien ici ne meurt.
//
// L'encodage sortant est écrit à la main (échappement JSON minimal) plutôt que
// par `JSONSerialization` : une commande sortante est une chaîne construite à
// partir de six formes fixes, et un encodeur qui ne peut pas échouer vaut mieux
// qu'un `try?` silencieux sur le chemin qui écrit dans le tube.

import CoreFoundation
import Foundation

/// Les deux modes RPC hébergés (S-1). `rpc-ui` est le seul mode headless où
/// `hasUI == true`, donc le seul où l'outil `ask` de l'hôte existe (D1).
enum RpcMode: String, CaseIterable, Identifiable, Sendable {
    case rpcUI = "rpc-ui"
    case rpc = "rpc"

    var id: String { rawValue }

    /// Libellé du sélecteur de mode de la fenêtre (S-9).
    var title: String {
        switch self {
        case .rpcUI: "rpc-ui — dialogues actifs"
        case .rpc: "rpc — sans dialogues"
        }
    }
}

/// Valeur JSON décodée, suffisante pour lire les trames du protocole.
enum JSONValue: Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])

    /// `init?` plutôt que `init` : une valeur non convertible (date, données)
    /// rend `nil`, et l'appelant garde la main sur ce qu'il en fait.
    init?(raw: Any) {
        switch raw {
        case let text as String:
            self = .string(text)
        case let number as NSNumber:
            // `NSNumber` porte AUSSI les booléens : `CFBooleanGetTypeID` est le
            // seul discriminant fiable entre `true` et `1` (piège classique de
            // `JSONSerialization`).
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                self = .bool(number.boolValue)
            } else {
                self = .number(number.doubleValue)
            }
        case let list as [Any]:
            self = .array(list.compactMap(JSONValue.init(raw:)))
        case let object as [String: Any]:
            self = .object(object.compactMapValues(JSONValue.init(raw:)))
        case is NSNull:
            self = .null
        default:
            return nil
        }
    }

    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var numberValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    /// Retour vers `Any` — utilisé par l'encodage des commandes.
    var anyValue: Any {
        switch self {
        case .string(let value): value
        case .number(let value): value
        case .bool(let value): value
        case .null: NSNull()
        case .array(let value): value.map(\.anyValue)
        case .object(let value): value.mapValues(\.anyValue)
        }
    }
}

/// Trame `ready` : la PREMIÈRE ligne de stdout (D1). Elle porte le plafond de
/// réassemblage que le décodeur de fragments doit respecter.
///
/// `notes` n'appartient pas au protocole : c'est le canal par lequel le décodeur
/// dit au host qu'un champ du `ready` était absent ou d'un autre type et qu'une
/// valeur par défaut a été prise (S-2 l'exige en journal `protocol`). Sans ce
/// canal, l'information serait perdue au `parse`, qui est pur.
struct RpcReady: Equatable, Sendable {
    let supportedProtocolVersions: [Int]
    let maxFrameBytes: Int
    let maxReassembledFrameBytes: Int
    var notes: [String] = []
}

/// Réponse à une commande, corrélée par `id` (S-3).
struct RpcResponse: Equatable, Sendable {
    let id: String?
    let command: String
    let success: Bool
    let error: String?
    let code: String?
    let data: [String: JSONValue]?
}

/// Fin de tour (D1) : trame distincte de l'acquittement du `prompt`, écrite après
/// que tout le travail déclenché s'est stabilisé. On ne conclut JAMAIS un tour
/// sur `agent_end`.
struct RpcPromptResult: Equatable, Sendable {
    let id: String?
    let agentInvoked: Bool
    let status: String?
    let error: String?
    let sessionSettled: Bool
}

/// Les quatre méthodes de dialogue auxquelles l'app répond (S-6).
enum RpcDialogMethod: String, CaseIterable, Sendable {
    case select
    case confirm
    case input
    case editor

    /// Méthodes de présentation : elles ne portent AUCUNE réponse (D1, S-6).
    /// Elles sont journalisées, jamais suivies d'une écriture sur stdin.
    static let presentationMethods: Set<String> = [
        "notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "open_url",
    ]
}

/// Demande de dialogue dépliée depuis une trame `extension_ui_request` (S-6).
struct RpcDialogRequest: Identifiable, Equatable, Sendable {
    let id: String
    let method: RpcDialogMethod
    let title: String
    let message: String?
    let options: [String]
    /// `optionDescriptions[i]` correspond POSITIONNELLEMENT à `options[i]`
    /// (D1) : une description absente vaut `nil`, une surnuméraire est ignorée.
    let optionDescriptions: [String?]
    let placeholder: String?
    let prefill: String?
    let promptStyle: Bool
}

/// Trame entrante classée. C'est LE point de décision du décodage : le host
/// aiguille sur ces cas, et rien d'autre n'interprète une ligne JSONL.
enum RpcInbound: Equatable, Sendable {
    case ready(RpcReady)
    case response(RpcResponse)
    case promptResult(RpcPromptResult)
    case dialog(RpcDialogRequest)
    case dialogCancelled(targetId: String)
    /// Méthode de présentation (S-6) : `summary` est la ligne brute, tronquée par
    /// le host à 200 caractères pour le journal.
    case presentation(method: String, summary: String)
    case sessionSettled
    case event(type: String)
    case unknown(type: String)
    case unparsable(String)
}

/// Commande sortante. Chacune produit UNE ligne JSON compacte terminée par `\n`,
/// écrite d'un seul `transport.write` (S-3).
enum RpcCommand: Equatable, Sendable {
    case negotiateProtocol(id: String)
    case getState(id: String)
    case prompt(id: String, message: String)

    var id: String {
        switch self {
        case .negotiateProtocol(let id), .getState(let id), .prompt(let id, _): id
        }
    }

    /// Nom du `command` renvoyé par le serveur : c'est lui que portent les
    /// messages d'erreur, jamais le nom du cas Swift.
    var name: String {
        switch self {
        case .negotiateProtocol: "negotiate_protocol"
        case .getState: "get_state"
        case .prompt: "prompt"
        }
    }

    func encodedLine() -> String {
        switch self {
        case .negotiateProtocol(let id):
            // Seule la version 2 est acceptée (S-2) : elle est donc écrite ici en
            // dur, il n'existe pas de variante v1 à porter.
            RpcFrames.line(["type": "negotiate_protocol", "id": id, "protocolVersion": 2])
        case .getState(let id):
            RpcFrames.line(["type": "get_state", "id": id])
        case .prompt(let id, let message):
            RpcFrames.line(["type": "prompt", "id": id, "message": message])
        }
    }
}

/// Réponse de dialogue : le champ dépend de la méthode, et AUCUN autre ne doit
/// accompagner (S-6, AC-8).
enum RpcDialogResponse: Equatable, Sendable {
    case value(id: String, value: String)
    case confirmed(id: String, confirmed: Bool)
    case cancelled(id: String)

    var id: String {
        switch self {
        case .value(let id, _), .confirmed(let id, _), .cancelled(let id): id
        }
    }

    func encodedLine() -> String {
        switch self {
        case .value(let id, let value):
            RpcFrames.line(["type": "extension_ui_response", "id": id, "value": value])
        case .confirmed(let id, let confirmed):
            RpcFrames.line(["type": "extension_ui_response", "id": id, "confirmed": confirmed])
        case .cancelled(let id):
            RpcFrames.line(["type": "extension_ui_response", "id": id, "cancelled": true])
        }
    }
}

enum RpcFrames {
    /// Types de trames d'événement connus de omp 18.4.1 (D1). Ce qui n'y figure
    /// pas est rendu `unknown`, journalisé, et affiché brut : une version future
    /// du serveur ne casse donc rien.
    static let eventTypes: Set<String> = [
        "agent_start", "agent_end",
        "turn_start", "turn_end",
        "message_start", "message_update", "message_end",
        "tool_execution_start", "tool_execution_update", "tool_execution_end",
        "available_commands_update", "advisor_cost_changed", "thinking_level_changed",
    ]

    /// Plafond par ligne physique annoncé par défaut (D1) : 1 Mio.
    static let defaultMaxFrameBytes = 1_048_576
    /// Plafond de réassemblage par défaut du client (D1) : 64 Mio.
    static let defaultMaxReassembledFrameBytes = 67_108_864

    /// Classe une ligne JSONL. Ne lève jamais : tout ce qui n'est pas compris
    /// devient `unparsable` ou `unknown`, jamais une exception (B-6).
    static func parse(line: String) -> RpcInbound {
        guard
            let data = line.data(using: .utf8),
            let raw = try? JSONSerialization.jsonObject(with: data),
            let dict = raw as? [String: Any],
            let type = dict["type"] as? String
        else { return .unparsable(line) }

        switch type {
        case "ready":
            return parseReady(line: line, dict: dict)
        case "response":
            return parseResponse(line: line, dict: dict)
        case "prompt_result":
            let result = RpcPromptResult(
                id: dict["id"] as? String,
                agentInvoked: (dict["agentInvoked"] as? Bool) ?? false,
                status: dict["status"] as? String,
                // Le message du fournisseur arrive soit en chaîne, soit en objet
                // `{message}` (D1) : les deux formes sont acceptées.
                error: stringField(dict["error"]),
                sessionSettled: (dict["sessionSettled"] as? Bool) ?? false
            )
            return .promptResult(result)
        case "session_settled":
            return .sessionSettled
        case "extension_ui_request":
            return parseDialog(line: line, dict: dict)
        default:
            if eventTypes.contains(type) { return .event(type: type) }
            return .unknown(type: type)
        }
    }

    // MARK: - Encodage

    /// Construit une ligne JSON compacte terminée par `\n`. Les clés sont triées :
    /// la sortie est donc déterministe, ce dont les preuves ont besoin. Seules
    /// les formes ci-dessus sont encodées, jamais une valeur venue de l'extérieur
    /// du client.
    static func line(_ object: [String: Any]) -> String {
        let body = object.keys.sorted().map { key in
            "\(quoted(key)):\(value(object[key]))"
        }
        return "{" + body.joined(separator: ",") + "}\n"
    }

    private static func value(_ raw: Any?) -> String {
        switch raw {
        case let text as String: quoted(text)
        case let flag as Bool: flag ? "true" : "false"
        case let number as Int: String(number)
        case let number as Double: String(number)
        case let list as [String]: "[" + list.map(quoted).joined(separator: ",") + "]"
        default: "null"
        }
    }

    /// Échappement JSON strict : guillemet, antislash, contrôles. Les caractères
    /// non-ASCII passent tels quels (le tube est en UTF-8).
    private static func quoted(_ text: String) -> String {
        var out = "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }

    // MARK: - Décodage, trame par trame

    private static func parseReady(line: String, dict: [String: Any]) -> RpcInbound {
        guard let rawVersions = dict["supportedProtocolVersions"] as? [Any] else {
            return .unparsable(line)
        }
        var versions: [Int] = []
        for value in rawVersions {
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
                return .unparsable(line)
            }
            versions.append(number.intValue)
        }
        guard !versions.isEmpty else { return .unparsable(line) }

        var notes: [String] = []
        let maxFrame = integer(
            dict["maxFrameBytes"],
            fallback: defaultMaxFrameBytes,
            field: "maxFrameBytes",
            notes: &notes
        )
        let maxReassembled = integer(
            dict["maxReassembledFrameBytes"],
            fallback: defaultMaxReassembledFrameBytes,
            field: "maxReassembledFrameBytes",
            notes: &notes
        )
        return .ready(
            RpcReady(
                supportedProtocolVersions: versions,
                maxFrameBytes: maxFrame,
                maxReassembledFrameBytes: maxReassembled,
                notes: notes
            )
        )
    }

    private static func parseResponse(line: String, dict: [String: Any]) -> RpcInbound {
        guard let command = dict["command"] as? String else { return .unparsable(line) }
        let error = stringField(dict["error"])
        // Tolérance mesurée de S-3 : `error` présent sans `success:false` est un
        // succès. Quand la clé `success` manque, c'est `error` qui tranche.
        let declared = dict["success"] as? Bool
        let success = declared ?? (error == nil)
        let response = RpcResponse(
            id: dict["id"] as? String,
            command: command,
            success: success,
            error: error,
            code: dict["code"] as? String,
            data: (dict["data"] as? [String: Any])?.compactMapValues(JSONValue.init(raw:))
        )
        return .response(response)
    }

    private static func parseDialog(line: String, dict: [String: Any]) -> RpcInbound {
        guard let method = dict["method"] as? String else { return .unknown(type: "extension_ui_request") }

        if method == "cancel" {
            guard let targetId = dict["targetId"] as? String else {
                return .unknown(type: "extension_ui_request")
            }
            return .dialogCancelled(targetId: targetId)
        }

        if RpcDialogMethod.presentationMethods.contains(method) {
            return .presentation(method: method, summary: line)
        }

        guard let dialogMethod = RpcDialogMethod(rawValue: method), let id = dict["id"] as? String else {
            return .unknown(type: "extension_ui_request")
        }

        let options = (dict["options"] as? [Any])?.compactMap { $0 as? String } ?? []
        let descriptions: [String?] = ((dict["optionDetails"] as? [Any]) ?? []).map { detail in
            (detail as? [String: Any])?["description"] as? String
        }
        let request = RpcDialogRequest(
            id: id,
            method: dialogMethod,
            title: (dict["title"] as? String) ?? "",
            message: dict["message"] as? String,
            options: options,
            optionDescriptions: descriptions,
            placeholder: dict["placeholder"] as? String,
            prefill: dict["prefill"] as? String,
            promptStyle: (dict["promptStyle"] as? Bool) ?? false
        )
        return .dialog(request)
    }

    /// Champ d'erreur polymorphe : chaîne, ou objet `{message}` (D1).
    private static func stringField(_ raw: Any?) -> String? {
        if let text = raw as? String { return text }
        if let object = raw as? [String: Any], let message = object["message"] as? String { return message }
        return nil
    }

    private static func integer(_ raw: Any?, fallback: Int, field: String, notes: inout [String]) -> Int {
        if let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
            return number.intValue
        }
        notes.append("champ \(field) absent ou non numérique : valeur par défaut \(fallback) prise")
        return fallback
    }

    /// Description courte d'une trame pour le journal (jamais affichée brute : la
    /// transcription, elle, porte la ligne telle quelle).
    static func shortDescription(_ inbound: RpcInbound) -> String {
        switch inbound {
        case .ready: "ready"
        case .response(let response): "response \(response.command)"
        case .promptResult(let result): "prompt_result \(result.status ?? "-")"
        case .dialog(let dialog): "extension_ui_request \(dialog.method.rawValue)"
        case .dialogCancelled(let targetId): "cancel \(targetId)"
        case .presentation(let method, _): "extension_ui_request \(method)"
        case .sessionSettled: "session_settled"
        case .event(let type): type
        case .unknown(let type): type
        case .unparsable: "ligne illisible"
        }
    }
}
