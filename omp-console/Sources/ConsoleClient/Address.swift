// L'analyse de l'adresse manuelle (S-4) : `hôte`, `hôte:port`, avec un préfixe
// `http://` facultatif. Cinq refus nommés, aucun deviné.

import ConsoleCore
import Foundation

/// Une adresse manuelle posée pour cet appareil.
public struct ClientAddress: Equatable, Sendable {
    public var host: String
    public var port: Int

    public init(host: String, port: Int = ConsoleAPI.Service.defaultPort) {
        self.host = host
        self.port = port
    }

    /// La forme persistée et réaffichée.
    public var text: String { "\(host):\(port)" }

    /// Analyse une saisie. Un refus ne change RIEN : l'ancienne adresse reste en
    /// vigueur.
    public static func parse(_ text: String) -> Result<ClientAddress, ClientAddressFailure> {
        var rest = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rest.isEmpty else { return .failure(.empty) }

        if let separator = rest.range(of: "://") {
            let scheme = String(rest[rest.startIndex..<separator.lowerBound]).lowercased()
            guard scheme == "http" else { return .failure(.scheme) }
            rest = String(rest[separator.upperBound...])
        }
        guard !rest.contains("://") else { return .failure(.scheme) }
        guard !rest.contains("/"), !rest.contains("?"), !rest.contains("#") else {
            return .failure(.hasPath)
        }

        var host = rest
        var port = ConsoleAPI.Service.defaultPort
        if let colon = rest.lastIndex(of: ":") {
            let rawPort = String(rest[rest.index(after: colon)...])
            host = String(rest[rest.startIndex..<colon])
            guard !rawPort.isEmpty, rawPort.allSatisfy({ $0.isASCII && $0.isNumber }),
                  let value = Int(rawPort), (1...65535).contains(value) else {
                return .failure(.badPort)
            }
            port = value
        }

        guard !host.isEmpty, !host.contains(" ") else { return .failure(.badHost) }
        return .success(ClientAddress(host: host, port: port))
    }
}

/// Les cinq refus d'une adresse manuelle.
public enum ClientAddressFailure: Error, Equatable, Sendable {
    case empty
    case scheme
    case hasPath
    case badPort
    case badHost
}
