// Le catalogue des routes du client (S-1) : l'image EXACTE des 37 routes servies
// par la coque (`RemoteRouter.routes`), méthode et chemin mis à part. Un test
// confronte les deux — c'est le seul garde-fou contre une route oubliée.

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
    /// La liste UNIQUE des routes du client : 37 entrées, ni plus ni moins.
    static let all: [ClientRoute] = [
        ClientRoute(name: "version", method: "GET", path: "/v1/version"),
        ClientRoute(name: "store", method: "GET", path: "/v1/store"),
        ClientRoute(name: "sessions", method: "GET", path: "/v1/sessions"),
        ClientRoute(name: "session.file", method: "GET", path: "/v1/sessions/{id}"),
        ClientRoute(name: "projects", method: "GET", path: "/v1/projects"),
        ClientRoute(name: "repos", method: "GET", path: "/v1/repos"),
        ClientRoute(name: "documents", method: "GET", path: "/v1/projects/{repoKey}/documents"),
        ClientRoute(name: "stats", method: "GET", path: "/v1/stats"),
        ClientRoute(name: "devices", method: "GET", path: "/v1/devices"),
        ClientRoute(name: "models", method: "GET", path: "/v1/models"),
        ClientRoute(name: "components", method: "GET", path: "/v1/components"),
        ClientRoute(name: "journal", method: "GET", path: "/v1/journal"),
        ClientRoute(name: "card.contract", method: "GET", path: "/v1/cards/{id}/contract"),
        ClientRoute(name: "memory", method: "GET", path: "/v1/memory"),
        ClientRoute(name: "memory.search", method: "GET", path: "/v1/memory/search"),
        ClientRoute(name: "memory.graph", method: "GET", path: "/v1/memory/graph"),
        ClientRoute(name: "stream", method: "GET", path: "/v1/stream"),
        ClientRoute(name: "pair", method: "POST", path: "/v1/pair"),
        ClientRoute(name: "card.answer", method: "POST", path: "/v1/cards/{id}/answer"),
        ClientRoute(name: "card.reply", method: "POST", path: "/v1/cards/{id}/reply"),
        ClientRoute(name: "card.text", method: "POST", path: "/v1/cards/{id}/text"),
        ClientRoute(name: "card.verdict", method: "POST", path: "/v1/cards/{id}/verdict"),
        ClientRoute(name: "card.resume", method: "POST", path: "/v1/cards/{id}/resume"),
        ClientRoute(name: "card.stop", method: "POST", path: "/v1/cards/{id}/stop"),
        ClientRoute(name: "feature.launch", method: "POST", path: "/v1/features"),
        ClientRoute(name: "conduite.start", method: "POST", path: "/v1/projects/{repoKey}/conduite"),
        ClientRoute(name: "conduite.close", method: "DELETE", path: "/v1/projects/{repoKey}/conduite"),
        ClientRoute(name: "conduite.get", method: "GET", path: "/v1/conduite"),
        ClientRoute(name: "conduite.dialog", method: "POST", path: "/v1/conduite/dialogs/{id}"),
        ClientRoute(name: "hosted.get", method: "GET", path: "/v1/session"),
        ClientRoute(name: "hosted.prompt", method: "POST", path: "/v1/session/prompt"),
        ClientRoute(name: "hosted.launch", method: "POST", path: "/v1/session/launch"),
        ClientRoute(name: "hosted.relaunch", method: "POST", path: "/v1/session/relaunch"),
        ClientRoute(name: "hosted.stop", method: "POST", path: "/v1/session/stop"),
        ClientRoute(name: "hosted.dialog", method: "POST", path: "/v1/session/dialogs/{id}"),
        ClientRoute(name: "prs", method: "GET", path: "/v1/projects/{repoKey}/pull-requests"),
        ClientRoute(
            name: "prs.merge",
            method: "POST",
            path: "/v1/projects/{repoKey}/pull-requests/{slug}/merge"
        ),
    ]
}
