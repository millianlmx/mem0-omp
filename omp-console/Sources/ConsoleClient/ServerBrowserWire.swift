// Le contrat du NAVIGATEUR DU SERVEUR : le navigateur du poste de travail qui vit sur le
// VPS (`browserId: "vps"`) et que l'agent 24/24 pilote sans passer par le Chrome de
// l'utilisateur. Ses comptes (Slack, Google) y sont ouverts par la copie continue de tout
// le profil Chrome (l'extension choisie comme source, `mirrorBrowser`) et, en secours,
// par la connexion interactive réservée à l'appareil APPROBATEUR
// (`/v1/workstation/vps/login` : des images de la page, des clics et des frappes renvoyés
// au serveur, deux facteurs compris).
//
// Chaque type décode un serveur antérieur sans échouer : un champ absent prend la valeur
// qui dit « rien » (aucun compte, aucune connexion).

import Foundation

/// L'état d'un compte du navigateur du serveur, tel que le serveur l'écrit.
public enum ServerBrowserAccountState: String, CaseIterable, Sendable {
    case disconnected
    case connected
    case expired
    case blocked
}

/// Un compte du navigateur du serveur : jamais un cookie ni un jeton, seulement son état.
public struct ServerBrowserAccount: Codable, Equatable, Sendable, Identifiable {
    /// `slack.com` ou `google.com`.
    public var domain: String
    /// L'état brut ; `phase` le lit, `nil` pour un état apparu après cette version.
    public var state: String
    /// Quand l'état a changé pour la dernière fois (ms) ; `nil` : jamais.
    public var changedAt: Double?

    public init(domain: String, state: String = "disconnected", changedAt: Double? = nil) {
        self.domain = domain
        self.state = state
        self.changedAt = changedAt
    }

    private enum CodingKeys: String, CodingKey {
        case domain, state, changedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        domain = try container.decode(String.self, forKey: .domain)
        state = try container.decodeIfPresent(String.self, forKey: .state) ?? "disconnected"
        changedAt = try container.decodeIfPresent(Double.self, forKey: .changedAt)
    }

    public var id: String { domain }

    public var phase: ServerBrowserAccountState? { ServerBrowserAccountState(rawValue: state) }

    /// L'adresse où la connexion interactive démarre : le serveur n'accepte qu'une page du
    /// domaine du compte (sous-domaines compris).
    public var loginURL: String {
        switch domain {
        case "slack.com": "https://slack.com/signin"
        case "google.com": "https://accounts.google.com/"
        default: "https://\(domain)/"
        }
    }
}

extension WorkstationBrowser {
    /// L'identifiant du navigateur du serveur parmi les navigateurs du poste.
    public static let serverID = "vps"
}

extension WorkstationStatus {
    /// Le navigateur du serveur, s'il est connu du poste ; `nil` pour un serveur qui n'en a pas.
    public var serverBrowser: WorkstationBrowser? {
        browsers.first { $0.id == WorkstationBrowser.serverID }
    }

    /// Les navigateurs qui peuvent être la source de la copie du profil Chrome : toute
    /// extension appairée, jamais le navigateur du serveur lui-même.
    public var mirrorSources: [WorkstationBrowser] {
        browsers.filter { $0.id != WorkstationBrowser.serverID }
    }
}

// MARK: - Connexion interactive

/// Une connexion ouverte sur le serveur : la page qu'on y remplit à distance.
public struct ServerBrowserLogin: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var domain: String
    /// L'hôte de la page affichée.
    public var host: String
    public var startedAt: Double
    /// Pourquoi la connexion est refusée (la page a quitté les domaines permis) ; `nil` : aucun.
    public var error: String?

    public init(id: String, domain: String, host: String = "", startedAt: Double = 0, error: String? = nil) {
        self.id = id
        self.domain = domain
        self.host = host
        self.startedAt = startedAt
        self.error = error
    }

    private enum CodingKeys: String, CodingKey {
        case id, domain, host, startedAt, error
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        domain = try container.decode(String.self, forKey: .domain)
        host = try container.decodeIfPresent(String.self, forKey: .host) ?? ""
        startedAt = try container.decodeIfPresent(Double.self, forKey: .startedAt) ?? 0
        error = try container.decodeIfPresent(String.self, forKey: .error)
    }
}

/// `POST` (201) et `GET /v1/workstation/vps/login` : `{login: {…} | null}`.
struct ServerBrowserLoginReply: Decodable {
    var login: ServerBrowserLogin?
}

/// Le corps de `POST /v1/workstation/vps/login` : la page où la connexion démarre.
struct ServerBrowserLoginBody: Encodable {
    var url: String
}

/// `DELETE /v1/workstation/vps/login` : `{closed: <domaine> | null}`.
struct ServerBrowserClosed: Decodable {
    var closed: String?
}

/// `POST /v1/workstation/vps/login/input` : `{sent: true}`.
struct ServerBrowserSent: Decodable {}

/// `GET /v1/workstation/vps/login/frame` : une image PNG de la page, à la demande.
public struct ServerBrowserFrame: Codable, Equatable, Sendable {
    public var seq: Int
    public var mime: String
    /// La taille de la fenêtre du serveur (1280 × 720) : celle des coordonnées d'un clic.
    public var width: Int
    public var height: Int
    public var host: String
    /// Le PNG, en base64.
    public var image: String

    public init(seq: Int, mime: String = "image/png", width: Int = 1280, height: Int = 720, host: String = "", image: String) {
        self.seq = seq
        self.mime = mime
        self.width = width
        self.height = height
        self.host = host
        self.image = image
    }

    private enum CodingKeys: String, CodingKey {
        case seq, mime, width, height, host, image
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        seq = try container.decodeIfPresent(Int.self, forKey: .seq) ?? 0
        mime = try container.decodeIfPresent(String.self, forKey: .mime) ?? "image/png"
        width = try container.decodeIfPresent(Int.self, forKey: .width) ?? 1280
        height = try container.decodeIfPresent(Int.self, forKey: .height) ?? 720
        host = try container.decodeIfPresent(String.self, forKey: .host) ?? ""
        image = try container.decodeIfPresent(String.self, forKey: .image) ?? ""
    }

    /// Les octets de l'image ; `nil` pour un base64 illisible.
    public var data: Data? { Data(base64Encoded: image, options: .ignoreUnknownCharacters) }

    /// Le clic de la page qui répond à un clic en (`x`, `y`) sur l'image affichée à
    /// `displayedWidth` × `displayedHeight` : les coordonnées ramenées à la fenêtre du
    /// serveur. `nil` hors de l'image, ou pour une image sans surface.
    public func click(atX x: Double, y: Double, displayedWidth: Double, displayedHeight: Double) -> ServerBrowserInput? {
        guard displayedWidth > 0, displayedHeight > 0, width > 0, height > 0,
              x >= 0, y >= 0, x <= displayedWidth, y <= displayedHeight
        else { return nil }
        return .click(x: x / displayedWidth * Double(width), y: y / displayedHeight * Double(height))
    }
}

/// Les touches que le serveur accepte d'une connexion (`KEYS` d'omp-harness/browser/session.ts).
public enum ServerBrowserKey: String, CaseIterable, Sendable {
    case enter = "Enter"
    case tab = "Tab"
    case backspace = "Backspace"
}

/// Un geste renvoyé à la page du serveur : le corps de `POST …/login/input`.
public enum ServerBrowserInput: Equatable, Sendable {
    case click(x: Double, y: Double)
    case text(String)
    case key(ServerBrowserKey)
    case scroll(dy: Double)

    /// De combien de pixels un geste de défilement fait avancer la page.
    public static let scrollStep = 400.0
}

extension ServerBrowserInput: Encodable {
    private enum CodingKeys: String, CodingKey {
        case type, x, y, text, key, dy
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .click(let x, let y):
            try container.encode("click", forKey: .type)
            try container.encode(x, forKey: .x)
            try container.encode(y, forKey: .y)
        case .text(let text):
            try container.encode("text", forKey: .type)
            try container.encode(text, forKey: .text)
        case .key(let key):
            try container.encode("key", forKey: .type)
            try container.encode(key.rawValue, forKey: .key)
        case .scroll(let dy):
            try container.encode("scroll", forKey: .type)
            try container.encode(dy, forKey: .dy)
        }
    }
}
