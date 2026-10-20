// Les charges utiles des routes (S-7 … S-13) : ce que l'API ÉCRIT, exactement.
//
// Les types internes de la coque (mémoire, appareils, composants) sont PROJETÉS
// ici : une charge utile dédiée dit ce qui sort, et le modèle de la coque reste
// libre de changer.

import ConsoleCore
import Foundation

/// Les bornes de l'API (S-7 : 2 Mio par réponse JSON).
enum RemoteLimits {
    static let responseBody = 2 * 1024 * 1024
    /// La taille par défaut d'une page de mémoire (`GET /v1/memory/page`) : la
    /// liste se lit par tranches, jamais d'un seul bloc.
    static let memoryPageSize = 100
    static let memoryLimitMax = 200
    /// La borne d'octets PROPRE au graphe : le graphe d'une portée réelle
    /// (~1 600 souvenirs avec texte et étiquettes) pèse ~3 Mo, au-delà de
    /// `responseBody` ; il est servi entier tant qu'il tient sous cette borne.
    static let memoryGraphBody = 16 * 1024 * 1024
}

// MARK: - Lectures

struct RemoteVersionPayload: Codable, Equatable {
    var protocolVersion: Int
}

struct RemoteDeviceRow: Codable, Equatable {
    var id: String
    var name: String
    var pairedAtMs: Double
    var lastSeenAtMs: Double
    var connected: Bool
}

struct RemoteDevicesPayload: Codable, Equatable {
    var devices: [RemoteDeviceRow]
}

/// L'état RÉEL des composants de la coque (S-4) : `ompPath` porte le chemin du
/// binaire OMP quand il est présent, `nil` sinon ; `setupBanner` la phrase de
/// `SetupText.banner(state:dismissed: true)` (non nulle en préparation/échec).
/// `homeDirectory` est le dossier personnel du Mac (l'app n'est pas sandboxée) :
/// l'app iOS s'en sert pour abréger les chemins en « ~/… ». Toute construction
/// le porte sans le nommer.
struct RemoteComponentsPayload: Codable, Equatable {
    var ompInstalled: Bool
    var ompPath: String?
    var setupBanner: String?
    var homeDirectory: String? = NSHomeDirectory()
}

// MARK: - Mémoire

struct RemoteMemoryRow: Codable, Equatable {
    var id: String
    var text: String
    var updatedAt: String?
    var score: Double?
    var tags: [String]
    var agentId: String?

    init(_ row: MemoryRow) {
        id = row.id
        text = row.text
        updatedAt = row.updatedAt
        score = row.semanticScore
        tags = row.tags
        agentId = row.agentId
    }
}

/// Une page du sommaire d'une portée (S-1) : `scope` vaut `nil` quand AUCUN projet
/// n'est ouvert — c'est LE signal de « aucun projet », sans champ booléen séparé.
/// `total` est le total du service, `offset` le rang de la première ligne servie,
/// `nextOffset` le rang de la page suivante, ABSENT quand la portée est épuisée.
struct RemoteMemoryPagePayload: Codable, Equatable {
    var scope: String?
    var total: Int
    var offset: Int
    var rows: [RemoteMemoryRow]
    var nextOffset: Int?
}

struct RemoteMemorySearchPayload: Codable, Equatable {
    var rows: [RemoteMemoryRow]
    var candidates: Int
    var scored: Int
}

struct RemoteMemoryGraphNode: Codable, Equatable {
    var id: String
    var label: String
    var scope: String
    /// Le texte INTÉGRAL du souvenir (champ ADDITIF OPTIONNEL) ; `nil` pour un
    /// nœud-étiquette. Un Mac plus ancien ne l'émet pas.
    var text: String?
    /// Les étiquettes du souvenir (champ ADDITIF OPTIONNEL) ; `nil` pour un
    /// nœud-étiquette.
    var tags: [String]?
}

struct RemoteMemoryGraphLink: Codable, Equatable {
    var a: String
    var b: String
    var kind: String
    var score: Double?
}

struct RemoteMemoryGraphPayload: Codable, Equatable {
    /// La portée RÉSOLUE du graphe ; `nil` quand aucun projet n'est ouvert.
    var scope: String?
    var nodes: [RemoteMemoryGraphNode]
    var links: [RemoteMemoryGraphLink]
    var total: Int
    /// Vrai dès qu'une LIGNE a été retirée par la borne d'octets du graphe
    /// (`RemoteLimits.memoryGraphBody`) — le graphe affiché est alors partiel, et
    /// l'app le dit.
    var truncated: Bool
}

extension RemoteMemoryGraphPayload {
    /// `truncated` est un champ ADDITIF : un Mac d'avant la feature graphe ne
    /// l'émet pas, et la charge reste lisible (absent ⇒ faux). Extension, pour
    /// garder l'init memberwise utilisé par `RemoteReads.graphPayload`.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        scope = try container.decodeIfPresent(String.self, forKey: .scope)
        nodes = try container.decode([RemoteMemoryGraphNode].self, forKey: .nodes)
        links = try container.decode([RemoteMemoryGraphLink].self, forKey: .links)
        total = try container.decode(Int.self, forKey: .total)
        truncated = try container.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
    }
}

// MARK: - Gestes

struct RemoteAcceptedPayload: Codable, Equatable {
    var accepted: Bool
}

struct RemotePairPayload: Codable, Equatable {
    var deviceId: String
    var token: String
    var protocolVersion: Int
}

// MARK: - Corps de requête

struct RemotePairRequest: Decodable, Equatable {
    var code: String
    var name: String
    /// L'identité de l'installation cliente ; absente pour un client d'avant.
    var deviceKey: String?
    var protocolVersion: Int?
}

/// Le décodage d'un corps de requête : tout échec est un `400 bad_request`.
enum RemoteBody {
    static func decode<T: Decodable>(_ type: T.Type, from request: HTTPRequest) throws -> T {
        guard !request.body.isEmpty else { throw ConsoleAPIError.badRequest("corps JSON absent") }
        do {
            return try HTTPJSON.decoder.decode(T.self, from: request.body)
        } catch {
            throw ConsoleAPIError.badRequest("corps JSON illisible")
        }
    }
}
