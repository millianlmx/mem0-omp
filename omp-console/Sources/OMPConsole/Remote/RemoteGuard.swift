// Les gardes d'entrée (S-3, S-4) : la version de protocole d'abord, puis le
// jeton — dans cet ordre, impératif (S-1, « ordre des contrôles »). Un client
// incompatible est refusé même sans jeton, et rien de la coque n'est appelé.
//
// L'évaluation est une FONCTION PURE d'un point de décision (patron
// `MainSheetPolicy.sheet`) : testable sans réseau, un seul endroit où la règle
// vit.

import ConsoleCore
import Foundation

/// Le verdict de la garde.
enum GuardOutcome: Equatable {
    /// La requête peut être servie ; `device` est `nil` sur la route d'appairage.
    case allowed(DeviceRecord?)
    case refused(ConsoleAPIError)
}

@MainActor
enum RemoteGuard {
    /// La seule route non authentifiée : `POST /v1/pair`, méthode ET chemin.
    static let pairPath = ConsoleAPI.Service.basePath + "/pair"

    static func isPairing(_ request: HTTPRequest) -> Bool {
        request.method == "POST" && request.path == pairPath
    }

    /// La version de protocole (S-4) : en-tête requis UNIQUE, entier décimal
    /// canonique, égal à celle du socle.
    static func versionRefusal(_ request: HTTPRequest) -> ConsoleAPIError? {
        let values = request.headers.values(ConsoleAPI.Service.protocolHeader)
        guard values.count == 1 else {
            return .badRequest("en-tête \(ConsoleAPI.Service.protocolHeader) absent ou multiple")
        }
        let raw = values[0].trimmingCharacters(in: .whitespaces)
        guard let received = canonicalInteger(raw) else {
            return .badRequest("version de protocole mal formée")
        }
        guard received == ConsoleAPI.protocolVersion else {
            return .incompatibleProtocol(
                "version de protocole \(received) refusée (supportée : \(ConsoleAPI.protocolVersion))"
            )
        }
        return nil
    }

    /// L'ordre complet : (1) version, (2) exemption de l'appairage, (3) jeton.
    static func evaluate(_ request: HTTPRequest, registry: DeviceRegistry) -> GuardOutcome {
        if let refusal = versionRefusal(request) { return .refused(refusal) }
        if isPairing(request) { return .allowed(nil) }
        return authorize(request, registry: registry)
    }

    private static func authorize(_ request: HTTPRequest, registry: DeviceRegistry) -> GuardOutcome {
        let values = request.headers.values("Authorization")
        guard values.count <= 1 else {
            return .refused(.badRequest("en-têtes Authorization multiples"))
        }
        guard let header = values.first else { return .refused(.unauthorized) }
        let parts = header.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0].lowercased() == "bearer" else {
            return .refused(.unauthorized)
        }
        let token = String(parts[1])
        guard !token.isEmpty, token.utf8.count <= 512 else { return .refused(.unauthorized) }
        guard let device = registry.authenticate(token) else { return .refused(.unauthorized) }
        return .allowed(device)
    }

    /// La forme décimale canonique : des chiffres, pas de signe, pas de zéro de
    /// tête (`+1` et `01` sont refusés, `0` est accepté).
    static func canonicalInteger(_ raw: String) -> Int? {
        guard !raw.isEmpty, raw.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        if raw.count > 1, raw.hasPrefix("0") { return nil }
        return Int(raw)
    }
}
