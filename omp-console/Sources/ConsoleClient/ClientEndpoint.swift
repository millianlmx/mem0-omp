// L'endpoint joignable et le Mac découvert (vocabulaire commun du contrat).
//
// `display` est la SEULE forme montrée à l'utilisateur : l'écran d'état nomme
// toujours l'endpoint réellement utilisé, jamais un autre.

import ConsoleCore
import Foundation

/// Le Mac joint : une adresse manuelle prioritaire, ou un service Bonjour résolu.
public enum ClientEndpoint: Equatable, Sendable, Hashable {
    case manual(host: String, port: Int)
    case bonjour(name: String, host: String, port: Int)

    public var host: String {
        switch self {
        case .manual(let host, _), .bonjour(_, let host, _): return host
        }
    }

    public var port: Int {
        switch self {
        case .manual(_, let port), .bonjour(_, _, let port): return port
        }
    }

    /// La base HTTP de l'endpoint, sans chemin : c'est le transport qui ajoute le
    /// chemin de la route. `nil` quand l'hôte saisi ne s'écrit pas en URL (jamais
    /// de `!` : une adresse manuelle libre ne doit pas faire planter l'app).
    public var baseURL: URL? {
        URL(string: "http://\(Self.urlHost(host)):\(port)")
    }

    /// La forme affichée : `192.168.1.12:8787` pour une adresse, et
    /// `OMP Console — 192.168.1.12:8787` pour un service Bonjour résolu.
    public var display: String {
        switch self {
        case .manual(let host, let port):
            return "\(Self.shownHost(host)):\(port)"
        case .bonjour(let name, let host, let port):
            return "\(name) — \(Self.shownHost(host)):\(port)"
        }
    }

    /// Un littéral IPv6 s'écrit entre crochets (`fe80::1%en0` → `[fe80::1%en0]`) ;
    /// Network.framework rend ainsi l'adresse lien-local d'un Mac découvert par
    /// Bonjour sur un partage de connexion, et `URL` refuse la forme nue.
    private static func shownHost(_ host: String) -> String {
        guard host.contains(":"), !host.hasPrefix("[") else { return host }
        return "[\(host)]"
    }

    /// Dans une URL, la zone d'un lien-local s'écrit `%25en0` (le `%` est échappé).
    private static func urlHost(_ host: String) -> String {
        guard host.contains(":"), !host.hasPrefix("[") else { return host }
        return "[\(host.replacingOccurrences(of: "%", with: "%25"))]"
    }
}

/// Un Mac découvert par Bonjour : son nom d'instance et son endpoint résolu.
public struct DiscoveredMac: Equatable, Sendable {
    public var name: String
    public var endpoint: ClientEndpoint

    public init(name: String, endpoint: ClientEndpoint) {
        self.name = name
        self.endpoint = endpoint
    }
}
