// Le catalogue des routes du client (S-1) : l'image EXACTE des 9 routes servies
// par la coque (`RemoteRouter.routes`), méthode et chemin mis à part. Un test
// confronte les deux — c'est le seul garde-fou contre une route oubliée. Les
// pipelines ne passent plus par le Mac : l'app joint le serveur du VPS
// (`HarnessModel`).

import ConsoleCore
import Foundation

/// Une route du client : un nom, une méthode, un gabarit de chemin.
public struct ClientRoute: Equatable, Sendable {
    public var name: String
    public var method: String
    public var path: String

    public init(name: String, method: String, path: String) {
        self.name = name
        self.method = method
        self.path = path
    }

    /// Le gabarit normalisé pour la confrontation : sans barre initiale, `{x}`
    /// ramené à `:x` (la forme du routeur de la coque).
    public var normalized: (method: String, path: String) {
        (
            method,
            String(path.drop(while: { $0 == "/" }))
                .replacingOccurrences(of: "{", with: ":")
                .replacingOccurrences(of: "}", with: "")
        )
    }
}

public extension ClientRoute {
    /// La liste UNIQUE des routes du client : 9 entrées, ni plus ni moins.
    static let all: [ClientRoute] = [
        ClientRoute(name: "version", method: "GET", path: "/v1/version"),
        ClientRoute(name: "devices", method: "GET", path: "/v1/devices"),
        ClientRoute(name: "components", method: "GET", path: "/v1/components"),
        ClientRoute(name: "memory.page", method: "GET", path: "/v1/memory/page"),
        ClientRoute(name: "memory.search", method: "GET", path: "/v1/memory/search"),
        ClientRoute(name: "memory.graph", method: "GET", path: "/v1/memory/graph"),
        ClientRoute(name: "stream", method: "GET", path: "/v1/stream"),
        ClientRoute(name: "pair", method: "POST", path: "/v1/pair"),
        ClientRoute(name: "devices.forget", method: "DELETE", path: "/v1/devices/self"),
    ]
}
