// Les DEUX écritures que l'app iOS permet sur la mémoire du serveur, depuis la liste :
// corriger un souvenir (texte et étiquettes) et le supprimer. Mêmes routes et même
// corps que la coque Mac (`HTTPMemoryService`, `MemoryWritePath`) : `PUT /memory/{id}`
// avec `tags` TOUJOURS posé (chaîne vide comprise : c'est lui qui remplace les
// étiquettes), `DELETE /memory/{id}` sans corps. Aucune création, aucun lien : le
// graphe reste en lecture.

import ConsoleCore
import Foundation

public struct MemoryWriter: Sendable {
    static let writeTimeout: TimeInterval = 20

    public let server: MemoryServer
    private let transport: any MemoryTransport

    public init(server: MemoryServer, transport: any MemoryTransport = URLSessionMemoryTransport()) {
        self.server = server
        self.transport = transport
    }

    /// Remplace le texte et les étiquettes d'un souvenir.
    public func update(id: String, text: String, tags: [String]) async throws {
        let route = MemoryWritePath.memory(id)
        _ = try await MemoryReader.send(
            server: server,
            transport: transport,
            path: route.path,
            method: route.method,
            body: ["text": text, "tags": MemoryTags.normalized(tags)],
            timeout: Self.writeTimeout
        )
    }

    /// Supprime un souvenir.
    public func delete(id: String) async throws {
        _ = try await MemoryReader.send(
            server: server,
            transport: transport,
            path: MemoryWritePath.memory(id).path,
            method: "DELETE",
            body: nil,
            timeout: Self.writeTimeout
        )
    }
}

/// Les chemins d'ÉCRITURE (S-8, S-9, S-10) : le chemin d'un souvenir se compose par
/// identifiant. `PUT` et `DELETE` partagent le même chemin, comme le service. Partagés
/// par la coque Mac (`HTTPMemoryService`) et l'app iOS (`MemoryWriter`).
public enum MemoryWritePath: Equatable, Sendable {
    case add
    case memory(String)

    public var path: String {
        switch self {
        case .add: "/memory/add"
        case let .memory(id): "/memory/\(id)"
        }
    }

    public var method: String {
        switch self {
        case .add: "POST"
        case .memory: "PUT"
        }
    }
}
