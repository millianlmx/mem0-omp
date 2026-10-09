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
    /// de `!` : une adresse manuelle libre ne doit pas faire planter l'app), ou
    /// quand il ne reste rien une fois la zone retirée (`%en0`) : `URL(string:)`
    /// ne garantit pas `nil` devant un hôte vide.
    public var baseURL: URL? {
        guard !Self.zoneless(host).isEmpty else { return nil }
        return URL(string: "http://\(Self.urlHost(host)):\(port)")
    }

    /// La forme affichée : `192.168.1.12:8787` pour une adresse, et
    /// `OMP Console — 192.168.1.12:8787` pour un service Bonjour résolu. Jamais de
    /// zone d'interface : `%en0` ne dit rien à l'utilisateur.
    public var display: String {
        switch self {
        case .manual(let host, let port):
            return "\(Self.shownHost(host)):\(port)"
        case .bonjour(let name, let host, let port):
            return "\(name) — \(Self.shownHost(host)):\(port)"
        }
    }

    /// L'hôte sans sa zone d'interface : du PREMIER `%` jusqu'à la fin, ou jusqu'au
    /// `]` exclu pour un hôte déjà entre crochets (`[fe80::1%en0]` → `[fe80::1]`).
    /// Network.framework rend la zone EN IPv4 comme en IPv6 (`192.168.1.175%en0`,
    /// `NWEndpoint.Host` décrit l'interface de résolution).
    private static func zoneless(_ host: String) -> String {
        guard let percent = host.firstIndex(of: "%") else { return host }
        if host.hasPrefix("["), let close = host[percent...].firstIndex(of: "]") {
            return String(host[..<percent] + host[close...])
        }
        return String(host[..<percent])
    }

    /// Un littéral IPv6 s'affiche entre crochets (`fe80::1%en0` → `[fe80::1]`),
    /// zone retirée comme pour toute adresse montrée.
    private static func shownHost(_ host: String) -> String {
        let bare = zoneless(host)
        guard bare.contains(":"), !bare.hasPrefix("[") else { return bare }
        return "[\(bare)]"
    }

    /// L'hôte tel qu'il s'écrit dans une URL. Un lien-local IPv6 GARDE sa zone,
    /// échappée en `%25en0` et entre crochets : sans elle, le système ne sait pas
    /// par quelle interface joindre le lien (Mac découvert sur un partage de
    /// connexion). Un IPv4 ou un nom PERD la sienne : `URL` refuse le `%` nu, et
    /// `%25en0` fait résoudre l'hôte comme un nom (`NSURLErrorCannotFindHost`) ;
    /// une adresse IPv4 n'a pas de zone, la retirer ne change pas la destination.
    /// Un hôte déjà entre crochets (saisie manuelle) passe tel quel.
    private static func urlHost(_ host: String) -> String {
        if host.contains(":"), !host.hasPrefix("[") {
            return "[\(host.replacingOccurrences(of: "%", with: "%25"))]"
        }
        guard host.contains(":") else { return zoneless(host) }
        return host
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
