// Le contrat de la TOUR DE CONTRÔLE du poste de travail : l'arrêt d'urgence, les
// navigateurs (un par extension appairée), la navigation gardée réglable par
// l'approbateur, la capture d'écran d'une action, la transcription d'une réunion, la
// session des jobs du poste et les actions commandées depuis l'app.
//
// Chaque type décode un serveur antérieur sans échouer : un champ absent prend la
// valeur qui dit « rien » (aucun arrêt, aucun navigateur, aucune capture).

import ConsoleCore
import Foundation

extension KeyedDecodingContainer {
    /// Une liste absente ou `null` : vide.
    fileprivate func listed<T: Decodable>(_ type: [T].Type, _ key: Key) throws -> [T] {
        try decodeIfPresent(type, forKey: key) ?? []
    }
}

/// L'arrêt d'urgence en cours : quand, et par quel client.
public struct WorkstationStop: Codable, Equatable, Sendable {
    public var at: Double
    public var by: String

    public init(at: Double, by: String) {
        self.at = at
        self.by = by
    }
}

/// Un navigateur du poste (un profil Chrome où l'extension est appairée).
public struct WorkstationBrowser: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    /// Le libellé réglé dans les options de l'extension ; `nil` : aucun.
    public var label: String?
    public var online: Bool
    public var lastSeenAt: Double
    public var firstSeenAt: Double
    public var extensionVersion: String?
    /// Il reçoit les actions, demandes et automatisations qui n'en ciblent aucun.
    public var isDefault: Bool
    /// Les comptes du navigateur du serveur (`id == "vps"`) : leur état ; vide pour tout autre navigateur.
    public var accounts: [ServerBrowserAccount]

    public init(
        id: String, label: String? = nil, online: Bool = false, lastSeenAt: Double = 0, firstSeenAt: Double = 0,
        extensionVersion: String? = nil, isDefault: Bool = false, accounts: [ServerBrowserAccount] = []
    ) {
        self.id = id
        self.label = label
        self.online = online
        self.lastSeenAt = lastSeenAt
        self.firstSeenAt = firstSeenAt
        self.extensionVersion = extensionVersion
        self.isDefault = isDefault
        self.accounts = accounts
    }

    private enum CodingKeys: String, CodingKey {
        case id, label, online, lastSeenAt, firstSeenAt, extensionVersion, isDefault, accounts
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        label = try container.decodeIfPresent(String.self, forKey: .label)
        online = try container.decodeIfPresent(Bool.self, forKey: .online) ?? false
        lastSeenAt = try container.decodeIfPresent(Double.self, forKey: .lastSeenAt) ?? 0
        firstSeenAt = try container.decodeIfPresent(Double.self, forKey: .firstSeenAt) ?? lastSeenAt
        extensionVersion = try container.decodeIfPresent(String.self, forKey: .extensionVersion)
        isDefault = try container.decodeIfPresent(Bool.self, forKey: .isDefault) ?? false
        accounts = try container.decodeIfPresent([ServerBrowserAccount].self, forKey: .accounts) ?? []
    }

    /// Le nom montré : son libellé, sinon son identifiant.
    public var name: String {
        guard let label, !label.trimmingCharacters(in: .whitespaces).isEmpty else { return id }
        return label
    }
}

/// D'où viennent les réglages de navigation : `config` (le fichier du serveur) ou
/// `setting` (posé par l'approbateur depuis une app).
public struct WorkstationNavigationSource: Codable, Equatable, Sendable {
    public var allowedHosts: String
    public var exfiltrationGuard: String

    public init(allowedHosts: String = "config", exfiltrationGuard: String = "config") {
        self.allowedHosts = allowedHosts
        self.exfiltrationGuard = exfiltrationGuard
    }

    /// La liste des hôtes permis vient d'un réglage (et non de la configuration).
    public var hostsAreSet: Bool { allowedHosts == "setting" }
    /// La garde anti-exfiltration vient d'un réglage.
    public var guardIsSet: Bool { exfiltrationGuard == "setting" }
}

/// Les jobs du poste dont la session se lit comme celle d'un run.
public enum WorkstationSessionJob: String, CaseIterable, Sendable, Identifiable {
    /// L'établissement du profil.
    case profil
    /// Le résumé d'une réunion terminée.
    case digest
    /// Le service de l'agent 24/24.
    case service

    public var id: String { rawValue }
}

/// `GET /v1/workstation/actions/{n}/capture` : la capture JPEG d'une action `screenshot`.
public struct WorkstationCapture: Codable, Equatable, Sendable {
    public var seq: Int
    public var at: Double
    public var mimeType: String
    /// Le JPEG, en base64.
    public var image: String

    public init(seq: Int, at: Double = 0, mimeType: String = "image/jpeg", image: String) {
        self.seq = seq
        self.at = at
        self.mimeType = mimeType
        self.image = image
    }

    /// Les octets de l'image ; `nil` pour un base64 illisible.
    public var data: Data? { Data(base64Encoded: image, options: .ignoreUnknownCharacters) }
}

/// `GET /v1/workstation/actions/{n}` : l'action et, si une capture est gardée, son image.
public struct WorkstationActionView: Decodable, Equatable, Sendable {
    public var action: WorkstationAction
    public var image: String?

    public init(action: WorkstationAction, image: String? = nil) {
        self.action = action
        self.image = image
    }

    private enum CodingKeys: String, CodingKey { case action, image }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        action = try container.decode(WorkstationAction.self, forKey: .action)
        image = try container.decodeIfPresent(String.self, forKey: .image)
    }
}

/// Une prise de parole d'une réunion : `moi` (l'utilisateur) ou `autres`.
public struct WorkstationSegment: Codable, Equatable, Sendable {
    public var at: Double
    public var speaker: String
    public var text: String

    public init(at: Double, speaker: String, text: String) {
        self.at = at
        self.speaker = speaker
        self.text = text
    }

    /// L'utilisateur parle.
    public var isSelf: Bool { speaker == "moi" }
}

/// `GET /v1/workstation/meetings/{id}` : la réunion et sa transcription.
public struct WorkstationMeetingDetail: Decodable, Equatable, Sendable {
    public var meeting: WorkstationMeeting
    public var transcript: [WorkstationSegment]

    public init(meeting: WorkstationMeeting, transcript: [WorkstationSegment] = []) {
        self.meeting = meeting
        self.transcript = transcript
    }

    private enum CodingKeys: String, CodingKey { case meeting, transcript }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        meeting = try container.decode(WorkstationMeeting.self, forKey: .meeting)
        transcript = try container.listed([WorkstationSegment].self, .transcript)
    }
}

/// `POST /v1/workstation/stop` : le statut d'après l'arrêt et les actions annulées.
struct WorkstationStopReply: Decodable {
    var status: WorkstationStatus
    var cancelled: [Int]

    private enum CodingKeys: String, CodingKey { case status, cancelled }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = try container.decode(WorkstationStatus.self, forKey: .status)
        cancelled = try container.listed([Int].self, .cancelled)
    }
}

/// La réponse d'une écriture sur une demande (`POST …/requests`, `…/cancel`, `…/launch`).
struct WorkstationRequestReply: Decodable {
    var request: WorkstationRequest
}

/// La réponse de `POST /v1/workstation/automations` (201 nouvelle, 200 l'existante).
struct WorkstationAutomationReply: Decodable {
    var automation: WorkstationAutomation
}

/// Les sortes d'action qu'on commande depuis l'app : ouvrir une page dans un nouvel
/// onglet de la fenêtre de l'agent, ou changer la page d'un onglet.
public enum WorkstationCommandKind: String, CaseIterable, Sendable, Identifiable {
    case open
    case navigate

    public var id: String { rawValue }
}

/// Une action commandée depuis l'app, en cours de saisie.
public struct WorkstationCommandDraft: Equatable, Sendable {
    public var kind: WorkstationCommandKind
    public var url: String
    /// L'onglet visé par `navigate` (un onglet de la fenêtre de l'agent ; `open` n'en a pas).
    public var tabId: String
    public var rationale: String
    /// Le navigateur qui l'exécute ; `nil` : le navigateur par défaut.
    public var browserId: String?

    public init(kind: WorkstationCommandKind = .open, url: String = "", tabId: String = "", rationale: String = "", browserId: String? = nil) {
        self.kind = kind
        self.url = url
        self.tabId = tabId
        self.rationale = rationale
        self.browserId = browserId
    }

    /// L'adresse saisie, `https://` ajouté au besoin ; `nil` si ce n'est pas une adresse web.
    public var normalizedURL: String? {
        var text = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !text.contains(" ") else { return nil }
        if !text.contains("://") { text = "https://" + text }
        guard let parsed = URL(string: text), let scheme = parsed.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = parsed.host, !host.isEmpty
        else { return nil }
        return text
    }

    /// L'onglet saisi : un entier positif, ou `nil` (vide ou illisible).
    public var tab: Int? {
        guard let value = Int(tabId.trimmingCharacters(in: .whitespaces)), value >= 0 else { return nil }
        return value
    }

    /// L'adresse est lisible, la raison donnée, et `navigate` vise un onglet.
    public var isComplete: Bool {
        normalizedURL != nil
            && !rationale.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (kind == .open || tab != nil)
    }

    /// Les paramètres de l'action, tels que le serveur les valide.
    public var params: [String: JSONValue] {
        var out: [String: JSONValue] = ["url": .string(normalizedURL ?? "")]
        if kind == .navigate, let tab { out["tabId"] = .number(Double(tab)) }
        return out
    }
}

/// Le corps de `POST /v1/workstation/actions` ; `browserId` absent quand il est `nil`.
struct WorkstationCommandBody: Encodable {
    var kind: String
    var params: [String: JSONValue]
    var rationale: String
    var browserId: String?
}

/// Le corps de `POST /v1/workstation/requests` ; `browserId` absent quand il est `nil`.
struct WorkstationRequestBody: Encodable {
    var instruction: String
    var browserId: String?
}

/// Le corps de `POST /v1/workstation/automations` ; les champs `nil` restent hors du JSON.
struct WorkstationAutomationBody: Encodable {
    var version: Int
    var task: Int
    var browserId: String?
    var schedule: String?
}

/// Un réglage du poste qui peut revenir à la configuration du serveur : `null` l'y
/// ramène, une valeur le pose, l'absence le laisse tel quel.
public enum WorkstationSettingChange<Value: Encodable & Equatable & Sendable>: Equatable, Sendable {
    case keep
    case set(Value)
    case reset
}

/// Le corps de `PUT /v1/workstation/settings` pour la navigation et le navigateur par défaut.
struct WorkstationNavigationBody: Encodable {
    var allowedHosts: WorkstationSettingChange<[String]> = .keep
    var exfiltrationGuard: WorkstationSettingChange<Bool> = .keep
    var defaultBrowser: WorkstationSettingChange<String> = .keep

    private enum CodingKeys: String, CodingKey { case allowedHosts, exfiltrationGuard, defaultBrowser }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try Self.encode(allowedHosts, .allowedHosts, in: &container)
        try Self.encode(exfiltrationGuard, .exfiltrationGuard, in: &container)
        try Self.encode(defaultBrowser, .defaultBrowser, in: &container)
    }

    private static func encode<Value>(
        _ change: WorkstationSettingChange<Value>, _ key: CodingKeys, in container: inout KeyedEncodingContainer<CodingKeys>
    ) throws {
        switch change {
        case .keep: break
        case .set(let value): try container.encode(value, forKey: key)
        case .reset: try container.encodeNil(forKey: key)
        }
    }
}

extension WorkstationModel {
    /// Les hôtes d'une saisie : un par ligne (ou séparés par des virgules ou des espaces),
    /// en minuscules, sans schéma, chemin ni port, sans doublon.
    public nonisolated static func hosts(from text: String) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for raw in text.split(whereSeparator: { $0 == "\n" || $0 == "," || $0 == " " }) {
            var host = raw.trimmingCharacters(in: .whitespaces).lowercased()
            if let scheme = host.range(of: "://") { host = String(host[scheme.upperBound...]) }
            if let slash = host.firstIndex(of: "/") { host = String(host[..<slash]) }
            if let colon = host.firstIndex(of: ":") { host = String(host[..<colon]) }
            guard !host.isEmpty, seen.insert(host).inserted else { continue }
            out.append(host)
        }
        return out
    }
}
