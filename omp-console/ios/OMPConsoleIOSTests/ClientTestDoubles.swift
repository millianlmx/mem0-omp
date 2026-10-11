// Les doublures qui alimentent un vrai `ConsoleClientModel` dans les tests de
// l'app iOS (ios-onboarding-et-connexion, S-3) : transport scripté, découverte et
// chemin réseau inertes, horloge de repli qui n'attend jamais. Calquées sur
// `Tests/ConsoleClientTests/ScriptedTransport.swift` et `ClientHarness.swift` du
// paquet, invisibles du projet Xcode. Les préférences et le trousseau sont les
// doublures publiques de ConsoleClient (`InMemoryClientPreferences`,
// `InMemoryTokenStore`). AUCUN réseau, AUCUN Mac réel, AUCUN trousseau réel.

import ConsoleClient
import ConsoleCore
import Foundation

/// Le transport scripté : enregistre chaque requête et rend la réponse décidée
/// par le test. Un flux demandé échoue tout de suite (aucun test ne le lit).
final class ScriptedClientTransport: ClientTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [ClientHTTPRequest] = []
    private let responder: @Sendable (ClientHTTPRequest) -> ClientHTTPResponse

    init(_ responder: @escaping @Sendable (ClientHTTPRequest) -> ClientHTTPResponse) {
        self.responder = responder
    }

    var requests: [ClientHTTPRequest] { lock.withLock { recorded } }

    func send(
        _ request: ClientHTTPRequest,
        to endpoint: ClientEndpoint,
        token: String?
    ) async throws -> ClientHTTPResponse {
        lock.withLock { recorded.append(request) }
        return responder(request)
    }

    func stream(
        _ request: ClientHTTPRequest,
        to endpoint: ClientEndpoint,
        token: String?
    ) async throws -> AsyncThrowingStream<Data, Error> {
        lock.withLock { recorded.append(request) }
        throw ClientError.transport(.unreachable("flux non scripté"))
    }
}

/// La découverte inerte : aucun Mac annoncé.
@MainActor
final class SilentDiscovery: DiscoverySource {
    var onChange: (([DiscoveredMac]) -> Void)?
    var onProtocolVersion: ((Int) -> Void)?
    var onDenied: ((Bool) -> Void)?

    func start(serviceType: String) {}
    func stop() {}
}

/// Le chemin réseau inerte : aucune transition.
@MainActor
final class SilentPathSource: ClientPathSource {
    var onChange: ((Bool) -> Void)?

    func start() {}
    func stop() {}
}

/// L'horloge de repli qui n'attend jamais et interrompt toute boucle.
struct ImmediatePacer: ClientPacer {
    func sleep(seconds: Double) async throws {
        throw CancellationError()
    }
}

enum ClientDoubles {
    /// Un modèle client câblé sur `transport`, sans jeton, avec l'adresse
    /// manuelle `address` (l'endpoint connu de l'appairage). Le modèle n'est pas
    /// démarré : aucune connexion ne part après un appairage réussi.
    @MainActor
    static func model(transport: ScriptedClientTransport, address: String) -> ConsoleClientModel {
        let model = ConsoleClientModel(
            transport: transport,
            discovery: SilentDiscovery(),
            preferences: InMemoryClientPreferences(),
            tokens: InMemoryTokenStore(),
            pacer: ImmediatePacer(),
            pathSource: SilentPathSource(),
            deviceName: "iPhone",
            searchPacer: ImmediatePacer()
        )
        _ = model.setManualAddress(address)
        return model
    }

    /// Une réponse du Mac à la version de protocole de l'app.
    static func response(status: Int, json: String) -> ClientHTTPResponse {
        ClientHTTPResponse(status: status, protocolVersion: ConsoleAPI.protocolVersion, body: Data(json.utf8))
    }
}
