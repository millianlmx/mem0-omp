// Les valeurs de fil de l'API du service (S-2, S-6) : dialogues, trames SSE,
// identités de session et accusés de commande — la forme EXACTE publiée par
// `omp-mem0-req/serviceApi.ts`.
//
// Ce fichier est PUR : aucun transport, aucune horloge. Il traduit un objet JSON
// en valeur et une réponse de dialogue en corps de requête.

import ConsoleCore
import CoreFoundation
import Foundation

extension JSONValue {
    /// Conversion depuis `JSONSerialization`, avec la distinction STRICTE
    /// booléen / nombre (`NSNumber` porte les deux).
    init?(raw: Any) {
        switch raw {
        case let text as String:
            self = .string(text)
        case let number as NSNumber:
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

    /// Retour vers `Any` — pour les corps de commande construits à la main.
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

// --- dialogues (S-6, Doc-4 §3) -----------------------------------------------

// `RpcDialogMethod` et `RpcDialogRequest` vivent dans ConsoleCore
// (Session/RpcDialog.swift) ; la coque n'en garde que le décodeur de trame.
extension RpcDialogRequest {
    /// Décode un dialogue depuis un objet JSON. `nil` si la forme est inconnue :
    /// une trame illisible est ignorée, jamais devinée.
    static func decode(_ value: JSONValue) -> RpcDialogRequest? {
        guard let object = value.objectValue else { return nil }
        guard let id = object["id"]?.stringValue, !id.isEmpty else { return nil }
        guard let method = object["method"]?.stringValue.flatMap(RpcDialogMethod.init(rawValue:)) else { return nil }
        guard let title = object["title"]?.stringValue else { return nil }
        let options = object["options"]?.arrayValue?.compactMap(\.stringValue) ?? []
        let descriptions: [String?] = object["optionDescriptions"]?.arrayValue?.map { element in
            element == .null ? nil : element.stringValue
        } ?? []
        let promptStyle: Bool = {
            if let flag = object["promptStyle"]?.boolValue { return flag }
            if let text = object["promptStyle"]?.stringValue { return !text.isEmpty }
            return false
        }()
        return RpcDialogRequest(
            id: id,
            method: method,
            title: title,
            message: object["message"]?.stringValue,
            options: options,
            optionDescriptions: descriptions,
            placeholder: object["placeholder"]?.stringValue,
            prefill: object["prefill"]?.stringValue,
            promptStyle: promptStyle,
            at: object["at"]?.numberValue
        )
    }
}

/// La réponse d'un dialogue : le champ dépend de la méthode, et aucun autre ne
/// doit l'accompagner.
enum RpcDialogResponse: Equatable, Sendable {
    case value(id: String, value: String)
    case confirmed(id: String, confirmed: Bool)
    case cancelled(id: String)

    var id: String {
        switch self {
        case .value(let id, _), .confirmed(let id, _), .cancelled(let id): id
        }
    }

    /// Le corps JSON exact de la route `POST …/dialogs/{dialogId}` (S-2, S-6).
    var body: [String: Any] {
        switch self {
        case .value(_, let value): ["value": value]
        case .confirmed(_, let confirmed): ["confirmed": confirmed]
        case .cancelled: ["cancelled": true]
        }
    }
}

// --- sessions (S-6) ----------------------------------------------------------

/// L'état d'exécution d'une session, tel que l'API le publie.
enum SessionRunState: String, Equatable, Sendable {
    case idle
    case running
}

/// L'identité d'une session telle que l'API la rend.
struct ServiceSessionInfo: Equatable, Sendable {
    let id: String
    let cwd: String
    let purpose: String
    let state: SessionRunState
    let sessionFile: String?

    static func decode(_ value: JSONValue) -> ServiceSessionInfo? {
        guard let object = value.objectValue else { return nil }
        guard let id = object["id"]?.stringValue, !id.isEmpty else { return nil }
        guard let cwd = object["cwd"]?.stringValue else { return nil }
        guard let purpose = object["purpose"]?.stringValue else { return nil }
        guard let state = object["state"]?.stringValue.flatMap(SessionRunState.init(rawValue:)) else { return nil }
        let file = object["sessionFile"]?.stringValue
        return ServiceSessionInfo(id: id, cwd: cwd, purpose: purpose, state: state, sessionFile: file)
    }
}

// --- trames SSE (S-6) --------------------------------------------------------

/// Une trame du flux d'une session.
enum ServiceFrame: Equatable, Sendable {
    case state(SessionRunState)
    case dialog(RpcDialogRequest)
    case dialogCancelled(id: String)
    case notice(level: String, message: String)
    case promptEnd(status: String)

    /// Décode `event: <nom>`, `data: <json>` en trame (S-2, S-6). `nil` pour un
    /// événement inconnu ou un corps illisible : la trame est ignorée.
    static func decode(event: String, data: String) -> ServiceFrame? {
        guard let bytes = data.data(using: .utf8), let json = JSONValue.parse(bytes) else { return nil }
        switch event {
        case "state":
            guard let state = json.objectValue?["state"]?.stringValue.flatMap(SessionRunState.init(rawValue:)) else {
                return nil
            }
            return .state(state)
        case "dialog":
            guard let dialog = RpcDialogRequest.decode(json) else { return nil }
            return .dialog(dialog)
        case "dialog_cancelled":
            guard let id = json.objectValue?["id"]?.stringValue else { return nil }
            return .dialogCancelled(id: id)
        case "notice":
            guard let object = json.objectValue,
                  let level = object["level"]?.stringValue,
                  let message = object["message"]?.stringValue else { return nil }
            return .notice(level: level, message: message)
        case "prompt_end":
            guard let status = json.objectValue?["status"]?.stringValue else { return nil }
            return .promptEnd(status: status)
        default:
            return nil
        }
    }
}

// --- accusés de commande (S-9) -----------------------------------------------

/// L'accusé d'une commande, tel que la réponse de l'API le porte
/// (`{ack:{version,id,repo,kind,state,reason,at}}`).
struct ServiceCommandAck: Equatable, Sendable {
    let id: String
    let repo: String
    let kind: String?
    let state: CommandAckState
    let reason: String?
    let at: Double

    static func decode(_ value: JSONValue) -> ServiceCommandAck? {
        guard let object = value.objectValue else { return nil }
        guard let id = object["id"]?.stringValue, !id.isEmpty else { return nil }
        guard let state = object["state"]?.stringValue.flatMap(CommandAckState.init(rawValue:)) else { return nil }
        let repo = object["repo"]?.stringValue ?? ""
        let kind = object["kind"]?.stringValue
        let reason = object["reason"]?.stringValue
        let at = object["at"]?.numberValue ?? 0
        return ServiceCommandAck(id: id, repo: repo, kind: kind, state: state, reason: reason, at: at)
    }
}

// --- audits (audit-panel-in-omp-console S-1 … S-4) ---------------------------

/// La réponse de `POST /v1/audits` : `{id, status}`, rendue dès l'enregistrement
/// écrit — l'analyse continue dans le service.
struct ServiceAuditStarted: Equatable, Sendable {
    let id: String
    let status: AuditStatus

    static func decode(_ value: JSONValue) -> ServiceAuditStarted? {
        guard let object = value.objectValue,
              let id = object["id"]?.stringValue, isAuditId(id),
              let status = object["status"]?.stringValue.flatMap(AuditStatus.init(rawValue:)) else { return nil }
        return ServiceAuditStarted(id: id, status: status)
    }
}

/// Le corps de `POST /v1/audits/{id}/escalations` : la clé de l'escalade
/// renvoyée telle quelle, puis une réponse (sortes `ask`, `question`) OU une
/// décision de jalon (sortes `specs`, `review`). Un champ `nil` n'est pas envoyé.
struct ServiceAuditAnswer: Equatable, Sendable {
    let slug: String
    let key: String
    let answer: String?
    let decision: AuditMilestoneDecision?

    var body: [String: Any] {
        var body: [String: Any] = ["slug": slug, "key": key]
        if let answer { body["answer"] = answer }
        if let decision { body["decision"] = decision.rawValue }
        return body
    }
}

/// Une feature que l'arrêt n'a pas pu annuler, avec le refus du pilote.
struct ServiceAuditStopRefusal: Equatable, Sendable {
    let slug: String
    let reason: String
}

/// La réponse de `DELETE /v1/audits/{id}` : `{cancelled, kept, refused}`.
struct ServiceAuditStopOutcome: Equatable, Sendable {
    let cancelled: [String]
    let kept: [String]
    let refused: [ServiceAuditStopRefusal]

    static func decode(_ value: JSONValue) -> ServiceAuditStopOutcome? {
        guard let object = value.objectValue,
              let cancelled = object["cancelled"]?.arrayValue?.map({ $0.stringValue }),
              let kept = object["kept"]?.arrayValue?.map({ $0.stringValue }),
              let refused = object["refused"]?.arrayValue?.map({ entry -> ServiceAuditStopRefusal? in
                  guard let slug = entry.objectValue?["slug"]?.stringValue,
                        let reason = entry.objectValue?["reason"]?.stringValue else { return nil }
                  return ServiceAuditStopRefusal(slug: slug, reason: reason)
              }) else { return nil }
        // Tout ou rien : une entrée mal formée rend la réponse illisible.
        let cancelledSlugs = cancelled.compactMap { $0 }
        let keptSlugs = kept.compactMap { $0 }
        let refusals = refused.compactMap { $0 }
        guard cancelledSlugs.count == cancelled.count, keptSlugs.count == kept.count, refusals.count == refused.count else { return nil }
        return ServiceAuditStopOutcome(cancelled: cancelledSlugs, kept: keptSlugs, refused: refusals)
    }
}
