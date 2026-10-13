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

/// L'horloge qui rend AUSSITÔT, sans lever : passée en `readinessPacer`,
/// l'échéance de `waitUntilReady()` tombe tout de suite (Mac sans réponse).
struct ReturningPacer: ClientPacer {
    func sleep(seconds: Double) async throws {}
}

/// Le trousseau qui compte ses lectures (client-ios-possede-par-la-vue, S-3) :
/// `held` retient chaque lecture jusqu'à `open()`, pour observer l'intent témoin
/// pendant que le trousseau est lu.
actor CountingTokenStore: TokenStore {
    private var tokens: [String: String]
    private var held: Bool
    private var gates: [CheckedContinuation<Void, Never>] = []
    private(set) var reads = 0

    init(_ tokens: [String: String] = [:], held: Bool = false) {
        self.tokens = tokens
        self.held = held
    }

    func save(_ token: String, for deviceId: String) async throws {
        tokens[deviceId] = token
    }

    func token(for deviceId: String) async throws -> String? {
        reads += 1
        if held {
            await withCheckedContinuation { gates.append($0) }
        }
        return tokens[deviceId]
    }

    func remove(deviceId: String) async throws {
        tokens[deviceId] = nil
    }

    /// Libère les lectures retenues et laisse passer les suivantes.
    func open() {
        held = false
        let waiting = gates
        gates = []
        for gate in waiting { gate.resume() }
    }
}

/// La découverte qui annonce un Mac dès son démarrage.
@MainActor
final class AnnouncingDiscovery: DiscoverySource {
    var onChange: (([DiscoveredMac]) -> Void)?
    var onProtocolVersion: ((Int) -> Void)?
    var onDenied: ((Bool) -> Void)?
    private let mac: DiscoveredMac

    init(_ mac: DiscoveredMac) {
        self.mac = mac
    }

    func start(serviceType: String) {
        onChange?([mac])
    }

    func stop() {}
}

/// Le transport dont le flux temps réel reste ouvert : le client se connecte et
/// le reste. Chaque requête est enregistrée ; toute requête ordinaire reçoit un
/// 404, aucune trame ne passe dans le flux.
final class OpenStreamTransport: ClientTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [ClientHTTPRequest] = []
    private var continuations: [AsyncThrowingStream<Data, Error>.Continuation] = []

    var requests: [ClientHTTPRequest] { lock.withLock { recorded } }

    func send(
        _ request: ClientHTTPRequest,
        to endpoint: ClientEndpoint,
        token: String?
    ) async throws -> ClientHTTPResponse {
        lock.withLock { recorded.append(request) }
        return ClientDoubles.response(status: 404, json: #"{"error":{"code":"not_found"}}"#)
    }

    func stream(
        _ request: ClientHTTPRequest,
        to endpoint: ClientEndpoint,
        token: String?
    ) async throws -> AsyncThrowingStream<Data, Error> {
        let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        lock.withLock {
            recorded.append(request)
            continuations.append(continuation)
        }
        return stream
    }
}

/// Le transport dont le flux temps réel s'ouvre sur la trame `hello` de
/// `version` puis reste ouvert (trame de `ClientFixtures.helloFrame` du paquet).
/// À la version de l'app, le client est « prêt » ; à une autre, il se verrouille
/// en version incompatible. Chaque requête ordinaire est enregistrée et reçoit la
/// réponse de `responder`.
final class HelloStreamTransport: ClientTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [ClientHTTPRequest] = []
    private var continuations: [AsyncThrowingStream<Data, Error>.Continuation] = []
    private let version: Int
    private let responder: @Sendable (ClientHTTPRequest) -> ClientHTTPResponse

    init(version: Int, _ responder: @escaping @Sendable (ClientHTTPRequest) -> ClientHTTPResponse) {
        self.version = version
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
        let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        continuation.yield(Data("event: hello\ndata: {\"protocolVersion\":\(version)}\n\n".utf8))
        lock.withLock {
            recorded.append(request)
            continuations.append(continuation)
        }
        return stream
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

    /// Un modèle client APPAIRÉ (préférence `client.deviceId` = `dev-1`, le jeton
    /// est celui de `tokens`), câblé sur `transport` et `discovery`, avec
    /// l'adresse manuelle `address` si elle est donnée, et l'échéance de
    /// `waitUntilReady()` mesurée par `readinessPacer`. Le modèle n'est PAS
    /// démarré : c'est le lancement à froid d'un intent.
    @MainActor
    static func pairedModel(
        tokens: CountingTokenStore,
        transport: any ClientTransport,
        discovery: (any DiscoverySource)? = nil,
        address: String? = nil,
        readinessPacer: any ClientPacer = LiveClientPacer()
    ) -> ConsoleClientModel {
        var preferences = [ClientPreferenceKey.deviceId: "dev-1"]
        if let address { preferences[ClientPreferenceKey.manualAddress] = address }
        return ConsoleClientModel(
            transport: transport,
            discovery: discovery ?? SilentDiscovery(),
            preferences: InMemoryClientPreferences(preferences),
            tokens: tokens,
            pacer: ImmediatePacer(),
            pathSource: SilentPathSource(),
            deviceName: "iPhone",
            searchPacer: ImmediatePacer(),
            readinessPacer: readinessPacer
        )
    }

    /// Une réponse du Mac à la version de protocole de l'app.
    static func response(status: Int, json: String) -> ClientHTTPResponse {
        ClientHTTPResponse(status: status, protocolVersion: ConsoleAPI.protocolVersion, body: Data(json.utf8))
    }
}
