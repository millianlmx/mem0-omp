// Le modèle observable UNIQUE du client distant (S-2) : il porte l'état, l'instantané
// du magasin, les appareils, les mises à jour de session, la session hébergée, la
// découverte, l'adresse manuelle et l'erreur d'appairage.
//
// Il ne fabrique aucun état optimiste : les gestes rendent le résultat typé de la
// route, et c'est la trame `store` du flux qui met `snapshot` à jour (AC-11, AC-12).
//
// La reconnexion est BORNÉE (S-7) : repli progressif `ClientRetry.delays`, une seule
// tentative en vol, le compteur repartant à zéro dès `connected`. `suspend()`
// n'affirme JAMAIS `connected` ; `resume()` anime la même routine, sans chemin
// spécial.

import Combine
import ConsoleCore
import Foundation

@MainActor
public final class ConsoleClientModel: ObservableObject {
    // MARK: - État publié

    @Published public private(set) var state: ClientState = .unpaired
    @Published public private(set) var snapshot: StoreSnapshot?
    @Published public private(set) var devices: [RemoteDeviceRow] = []
    @Published public private(set) var sessionUpdates: [RemoteSessionsEvent] = []
    @Published public private(set) var hosted: RemoteHostedEvent?
    @Published public private(set) var discovered: DiscoveredMac?
    @Published public private(set) var manualAddress: ClientAddress?
    @Published public private(set) var pairingFailure: ClientPairingFailure?
    @Published public private(set) var localNetworkDenied = false

    /// La borne des mises à jour de session conservées.
    public static let sessionUpdateLimit = 100

    // MARK: - Dépendances injectées

    private let transport: any ClientTransport
    private let discovery: any DiscoverySource
    private let preferences: any ClientPreferences
    private let tokens: any TokenStore
    private let pacer: any ClientPacer
    private let pathSource: any ClientPathSource
    private let deviceName: String
    private let localProtocolVersion: Int

    // MARK: - Faits internes

    private var running = false
    private var token: String?
    private var deviceId: String?
    private var hasNetwork = true
    private var revoked = false
    private var incompatible: ClientIncompatibility?
    private var connectedEndpoint: ClientEndpoint?
    private var connectingEndpoint: ClientEndpoint?
    private var lastFailure: ClientEndpoint?
    private var attempt = 0
    private var connection: Task<Void, Never>?

    // MARK: - Cycle de vie

    public init(
        transport: any ClientTransport,
        discovery: any DiscoverySource,
        preferences: any ClientPreferences,
        tokens: any TokenStore,
        pacer: any ClientPacer = LiveClientPacer(),
        pathSource: any ClientPathSource,
        deviceName: String = "iPhone",
        localProtocolVersion: Int = ConsoleAPI.protocolVersion
    ) {
        self.transport = transport
        self.discovery = discovery
        self.preferences = preferences
        self.tokens = tokens
        self.pacer = pacer
        self.pathSource = pathSource
        self.deviceName = deviceName
        self.localProtocolVersion = localProtocolVersion
    }

    /// La production : le vrai transport, la vraie découverte, le vrai trousseau.
    public static func live(deviceName: String = "iPhone") -> ConsoleClientModel {
        ConsoleClientModel(
            transport: URLSessionTransport(),
            discovery: BonjourDiscoverySource(),
            preferences: UserDefaultsClientPreferences(),
            tokens: KeychainTokenStore(),
            pacer: LiveClientPacer(),
            pathSource: NWPathSource(),
            deviceName: deviceName
        )
    }

    public func start() {
        guard !running else { return }
        running = true
        manualAddress = loadManualAddress()
        deviceId = preferences.string(forKey: ClientPreferenceKey.deviceId)
        discovery.onChange = { [weak self] list in self?.applyDiscovered(list) }
        discovery.onProtocolVersion = { [weak self] version in self?.applyRemoteProtocol(version) }
        discovery.onDenied = { [weak self] denied in self?.localNetworkDenied = denied }
        pathSource.onChange = { [weak self] satisfied in self?.applyNetwork(satisfied) }
        discovery.start(serviceType: ConsoleAPI.Service.bonjourType)
        pathSource.start()
        publishState()
        Task { [weak self] in await self?.restoreToken() }
    }

    public func stop() {
        running = false
        connection?.cancel()
        connection = nil
        discovery.stop()
        pathSource.stop()
    }

    /// L'app passe en arrière-plan : le flux est coupé et l'état n'est JAMAIS
    /// `connected`.
    public func suspend() {
        connection?.cancel()
        connection = nil
        connectedEndpoint = nil
        connectingEndpoint = effectiveEndpoint
        publishState()
    }

    /// Le retour au premier plan : la MÊME routine de reconnexion, sans chemin
    /// spécial.
    public func resume() {
        guard running else { return }
        beginConnection(resetCounter: false)
    }

    /// La seule sortie du verrou de version : le Mac a pu être mis à jour.
    public func retry() {
        incompatible = nil
        lastFailure = nil
        beginConnection(resetCounter: true)
    }

    // MARK: - Adresse manuelle

    /// Pose une adresse manuelle. Un refus ne change RIEN : l'ancienne adresse
    /// reste en vigueur.
    public func setManualAddress(_ text: String) -> Result<ClientAddress, ClientAddressFailure> {
        switch ClientAddress.parse(text) {
        case .failure(let failure):
            return .failure(failure)
        case .success(let address):
            manualAddress = address
            preferences.set(address.text, forKey: ClientPreferenceKey.manualAddress)
            lastFailure = nil
            beginConnection(resetCounter: true)
            return .success(address)
        }
    }

    /// La SEULE action qui retire l'adresse posée.
    public func clearManualAddress() {
        manualAddress = nil
        preferences.set(nil, forKey: ClientPreferenceKey.manualAddress)
        lastFailure = nil
        beginConnection(resetCounter: true)
    }

    // MARK: - Appairage

    public func pair(code: String) async throws {
        try await pair(code: code, deviceName: deviceName)
    }

    /// Appaire par le code affiché par le Mac. Un refus laisse l'état `unpaired`,
    /// n'écrit AUCUN jeton et ne programme AUCUN réessai.
    public func pair(code: String, deviceName: String) async throws {
        let normalized = ClientPairing.normalizeCode(code)
        guard ClientPairing.isValidCode(normalized) else {
            pairingFailure = .malformedCode
            return
        }
        let endpoint = try pairingEndpoint()
        let name = ClientPairing.normalizeDeviceName(deviceName)
        guard let body = try? JSONEncoder().encode(
            RemotePairRequest(code: normalized, name: name, protocolVersion: nil)
        ) else {
            pairingFailure = .unavailable("corps d'appairage non encodable")
            return
        }
        let response: ClientHTTPResponse
        do {
            response = try await transport.send(
                ClientHTTPRequest(method: "POST", path: ConsoleAPI.Service.basePath + "/pair", body: body),
                to: endpoint,
                token: nil
            )
        } catch let error as ClientError {
            pairingFailure = pairingFailure(from: error)
            return
        }
        if let error = statusError(response) {
            pairingFailure = pairingFailure(from: error)
            return
        }
        guard let payload = try? JSONDecoder().decode(RemotePairPayload.self, from: response.body) else {
            pairingFailure = .unavailable("réponse d'appairage illisible")
            return
        }
        let id = payload.deviceId.lowercased()
        do {
            try await tokens.save(payload.token, for: id)
        } catch {
            // Échec d'écriture au trousseau : l'appairage est refusé, aucun demi-appairage.
            pairingFailure = .unavailable("le jeton n'a pas pu être conservé")
            return
        }
        deviceId = id
        token = payload.token
        preferences.set(id, forKey: ClientPreferenceKey.deviceId)
        pairingFailure = nil
        revoked = false
        beginConnection(resetCounter: true)
    }

    // MARK: - Flux typé

    /// Le pendant typé de `GET /v1/stream` : les évènements décodés du flux.
    public func openStream() async throws -> AsyncThrowingStream<ClientStreamEvent, Error> {
        let endpoint = try endpointForRequest()
        let raw = try await transport.stream(
            ClientHTTPRequest(method: "GET", path: "/v1/stream", isStream: true),
            to: endpoint,
            token: token
        )
        return AsyncThrowingStream { continuation in
            let task = Task {
                var parser = ClientStreamParser()
                do {
                    for try await chunk in raw {
                        for event in parser.consume(chunk) { continuation.yield(event) }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: - Lectures

    public func version() async throws -> Int {
        try await perform(
            ClientHTTPRequest(method: "GET", path: "/v1/version"),
            as: RemoteVersionPayload.self
        ).protocolVersion
    }

    public func store() async throws -> RemoteStorePayload {
        try await perform(ClientHTTPRequest(method: "GET", path: "/v1/store"), as: RemoteStorePayload.self)
    }

    public func sessions() async throws -> RemoteSessionsPayload {
        try await perform(ClientHTTPRequest(method: "GET", path: "/v1/sessions"), as: RemoteSessionsPayload.self)
    }

    public func session(file: String) async throws -> RemoteSessionPayload {
        try await perform(
            ClientHTTPRequest(method: "GET", path: "/v1/sessions/" + encode(file)),
            as: RemoteSessionPayload.self
        )
    }

    public func projects() async throws -> RemoteProjectsPayload {
        try await perform(ClientHTTPRequest(method: "GET", path: "/v1/projects"), as: RemoteProjectsPayload.self)
    }

    public func documents(repoKey: String) async throws -> RemoteDocumentsPayload {
        try await perform(
            ClientHTTPRequest(method: "GET", path: "/v1/projects/" + encode(repoKey) + "/documents"),
            as: RemoteDocumentsPayload.self
        )
    }

    public func statistics() async throws -> RemoteStatsPayload {
        try await perform(ClientHTTPRequest(method: "GET", path: "/v1/stats"), as: RemoteStatsPayload.self)
    }

    public func devices() async throws -> RemoteDevicesPayload {
        try await perform(ClientHTTPRequest(method: "GET", path: "/v1/devices"), as: RemoteDevicesPayload.self)
    }

    /// Le catalogue des modèles du Mac (S-14). Une réponse 200 porte soit des
    /// sélecteurs, soit un motif d'échec — jamais une erreur de transport.
    public func models() async throws -> RemoteModelsPayload {
        try await perform(ClientHTTPRequest(method: "GET", path: "/v1/models"), as: RemoteModelsPayload.self)
    }

    public func memory(scope: String?, limit: Int?) async throws -> RemoteMemoryPagePayload {
        var query: [String] = []
        if let scope { query.append("scope=" + encode(scope)) }
        if let limit { query.append("limit=\(limit)") }
        let path = "/v1/memory" + (query.isEmpty ? "" : "?" + query.joined(separator: "&"))
        return try await perform(ClientHTTPRequest(method: "GET", path: path), as: RemoteMemoryPagePayload.self)
    }

    public func memorySearch(query: String, scope: String?, limit: Int?) async throws -> RemoteMemorySearchPayload {
        var parts = ["q=" + encode(query)]
        if let scope { parts.append("scope=" + encode(scope)) }
        if let limit { parts.append("limit=\(limit)") }
        let path = "/v1/memory/search?" + parts.joined(separator: "&")
        return try await perform(ClientHTTPRequest(method: "GET", path: path), as: RemoteMemorySearchPayload.self)
    }

    public func memoryGraph(scope: String?) async throws -> RemoteMemoryGraphPayload {
        let path = scope.map { "/v1/memory/graph?scope=" + encode($0) } ?? "/v1/memory/graph"
        return try await perform(ClientHTTPRequest(method: "GET", path: path), as: RemoteMemoryGraphPayload.self)
    }

    // MARK: - Gestes

    public func answer(
        cardId: String,
        kind: String,
        label: String?,
        text: String?,
        toolCallId: String? = nil
    ) async throws -> RemoteAcceptedPayload {
        let body = try encode(RemoteAnswerRequest(toolCallId: toolCallId, kind: kind, label: label, text: text))
        return try await perform(
            ClientHTTPRequest(method: "POST", path: "/v1/cards/" + encode(cardId) + "/answer", body: body),
            as: RemoteAcceptedPayload.self
        )
    }

    public func reply(cardId: String, text: String) async throws -> RemoteAcceptedPayload {
        let body = try encode(RemoteTextRequest(text: text))
        return try await perform(
            ClientHTTPRequest(method: "POST", path: "/v1/cards/" + encode(cardId) + "/reply", body: body),
            as: RemoteAcceptedPayload.self
        )
    }

    public func text(cardId: String, text: String) async throws -> RemoteAcceptedPayload {
        let body = try encode(RemoteTextRequest(text: text))
        return try await perform(
            ClientHTTPRequest(method: "POST", path: "/v1/cards/" + encode(cardId) + "/text", body: body),
            as: RemoteAcceptedPayload.self
        )
    }

    public func verdict(cardId: String, verdict: String) async throws -> RemoteAcceptedPayload {
        let body = try encode(RemoteVerdictRequest(verdict: verdict))
        return try await perform(
            ClientHTTPRequest(method: "POST", path: "/v1/cards/" + encode(cardId) + "/verdict", body: body),
            as: RemoteAcceptedPayload.self
        )
    }

    public func resume(cardId: String) async throws -> RemoteAcceptedPayload {
        try await perform(
            ClientHTTPRequest(method: "POST", path: "/v1/cards/" + encode(cardId) + "/resume"),
            as: RemoteAcceptedPayload.self
        )
    }

    public func stop(cardId: String) async throws -> RemoteAcceptedPayload {
        try await perform(
            ClientHTTPRequest(method: "POST", path: "/v1/cards/" + encode(cardId) + "/stop"),
            as: RemoteAcceptedPayload.self
        )
    }

    public func launch(
        repoRoot: String,
        title: String,
        description: String,
        modelReqSpecs: String?,
        modelImplReview: String?
    ) async throws -> RemoteAcceptedPayload {
        let body = try encode(RemoteFeatureRequest(
            repoRoot: repoRoot,
            title: title,
            description: description,
            modelReqSpecs: modelReqSpecs,
            modelImplReview: modelImplReview
        ))
        return try await perform(
            ClientHTTPRequest(method: "POST", path: "/v1/features", body: body),
            as: RemoteAcceptedPayload.self
        )
    }

    public func startConduite(repoKey: String, name: String) async throws -> RemoteConduitePayload {
        let body = try encode(RemoteConduiteRequest(name: name))
        return try await perform(
            ClientHTTPRequest(method: "POST", path: "/v1/projects/" + encode(repoKey) + "/conduite", body: body),
            as: RemoteConduitePayload.self
        )
    }

    public func closeConduite(repoKey: String) async throws -> RemoteConduitePayload {
        try await perform(
            ClientHTTPRequest(method: "DELETE", path: "/v1/projects/" + encode(repoKey) + "/conduite"),
            as: RemoteConduitePayload.self
        )
    }

    public func hostedSession() async throws -> RemoteHostedSessionPayload {
        try await perform(ClientHTTPRequest(method: "GET", path: "/v1/session"), as: RemoteHostedSessionPayload.self)
    }

    public func prompt(message: String) async throws -> RemoteSentPayload {
        let body = try encode(RemotePromptRequest(message: message))
        return try await perform(
            ClientHTTPRequest(method: "POST", path: "/v1/session/prompt", body: body),
            as: RemoteSentPayload.self
        )
    }

    public func pullRequests(repoKey: String) async throws -> RemotePullRequestsPayload {
        try await perform(
            ClientHTTPRequest(method: "GET", path: "/v1/projects/" + encode(repoKey) + "/pull-requests"),
            as: RemotePullRequestsPayload.self
        )
    }

    public func merge(repoKey: String, slug: String, headOid: String) async throws -> RemoteMergedPayload {
        let body = try encode(RemoteMergeRequest(headOid: headOid))
        return try await perform(
            ClientHTTPRequest(
                method: "POST",
                path: "/v1/projects/" + encode(repoKey) + "/pull-requests/" + encode(slug) + "/merge",
                body: body
            ),
            as: RemoteMergedPayload.self
        )
    }

    // MARK: - Fait observé par les tests : l'endpoint utilisé

    /// L'endpoint réellement utilisé : l'adresse manuelle PRIME sur la découverte.
    public var effectiveEndpoint: ClientEndpoint? {
        if let manualAddress { return .manual(host: manualAddress.host, port: manualAddress.port) }
        return discovered?.endpoint
    }

    // MARK: - Exécution d'une route

    private func perform<T: Decodable>(_ request: ClientHTTPRequest, as type: T.Type) async throws -> T {
        let endpoint = try endpointForRequest()
        let response: ClientHTTPResponse
        do {
            response = try await transport.send(request, to: endpoint, token: token)
        } catch let error as ClientError {
            absorb(error)
            throw error
        }
        if let error = statusError(response) {
            absorb(error)
            throw error
        }
        guard let value = try? JSONDecoder().decode(T.self, from: response.body) else {
            throw ClientError.decoding("charge utile illisible (\(T.self))")
        }
        return value
    }

    /// Le refus LOCAL : toute méthode est refusée sans un octet sur le réseau si
    /// l'état est verrouillé ou si aucun endpoint n'est connu.
    private func endpointForRequest() throws -> ClientEndpoint {
        if let incompatible {
            throw ClientError.incompatibleProtocol(local: incompatible.local, remote: incompatible.remote)
        }
        if revoked { throw ClientError.notConnected }
        guard let endpoint = effectiveEndpoint else { throw ClientError.notConnected }
        return endpoint
    }

    /// L'endpoint de `POST /v1/pair`, SEULE route qui échappe au verrou `revoked` :
    /// c'est l'appairage qui fait sortir de la révocation (S-9), un 401 sur cette
    /// route restant un refus d'appairage (S-6) et non une révocation. Le verrou de
    /// version, lui, s'applique aussi ici.
    private func pairingEndpoint() throws -> ClientEndpoint {
        if let incompatible {
            throw ClientError.incompatibleProtocol(local: incompatible.local, remote: incompatible.remote)
        }
        guard let endpoint = effectiveEndpoint else { throw ClientError.notConnected }
        return endpoint
    }

    private func statusError(_ response: ClientHTTPResponse) -> ClientError? {
        if response.protocolVersion != localProtocolVersion {
            return .incompatibleProtocol(local: localProtocolVersion, remote: response.protocolVersion)
        }
        guard !(200..<300).contains(response.status) else { return nil }
        return ClientErrorMapping.translate(
            status: response.status,
            protocolVersion: response.protocolVersion,
            body: response.body,
            localVersion: localProtocolVersion
        )
    }

    private func encode<T: Encodable>(_ value: T) throws -> Data {
        do {
            return try JSONEncoder().encode(value)
        } catch {
            throw ClientError.decoding("corps de requête non encodable")
        }
    }

    private func encode(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? component
    }

    // MARK: - Traitement des erreurs

    /// Le verrou de version et la révocation, absorbés par le modèle.
    private func absorb(_ error: ClientError) {
        switch error {
        case .incompatibleProtocol(let local, let remote):
            lock(local: local, remote: remote)
        case .api(.unauthorized):
            if token != nil {
                connection?.cancel()
                connection = nil
                connectedEndpoint = nil
                connectingEndpoint = nil
                lastFailure = nil
                Task { [weak self] in await self?.revoke() }
            }
        default:
            break
        }
    }

    private func lock(local: Int, remote: Int?) {
        incompatible = ClientIncompatibility(local: local, remote: remote)
        connection?.cancel()
        connection = nil
        connectedEndpoint = nil
        connectingEndpoint = nil
        lastFailure = nil
        publishState()
    }

    private func revoke() async {
        if let deviceId {
            try? await tokens.remove(deviceId: deviceId)
        }
        deviceId = nil
        token = nil
        preferences.set(nil, forKey: ClientPreferenceKey.deviceId)
        revoked = true
        connectedEndpoint = nil
        connectingEndpoint = nil
        lastFailure = nil
        connection?.cancel()
        connection = nil
        publishState()
    }

    private func pairingFailure(from error: ClientError) -> ClientPairingFailure {
        switch error {
        case .transport(let failure): return .transport(failure)
        case .incompatibleProtocol(let local, let remote):
            return .incompatibleProtocol(local: local, remote: remote)
        case .api(.unauthorized): return .refused
        case .api(.unavailable(let message)): return .unavailable(message)
        case .api(let other): return .unavailable(other.message ?? other.code)
        case .decoding(let message): return .unavailable(message)
        case .notConnected: return .transport(.unreachable("aucun endpoint connu"))
        }
    }

    // MARK: - Reconnexion

    private func restoreToken() async {
        if let deviceId, let stored = try? await tokens.token(for: deviceId) {
            token = stored
            revoked = false
        } else {
            // `deviceId` mémorisé sans jeton : le couple est incohérent, l'appairage
            // est requis.
            token = nil
        }
        beginConnection(resetCounter: true)
    }

    private func beginConnection(resetCounter: Bool) {
        if resetCounter { attempt = 0 }
        connection?.cancel()
        connection = nil
        connectedEndpoint = nil
        guard running, !revoked, incompatible == nil else {
            connectingEndpoint = nil
            publishState()
            return
        }
        guard token != nil else {
            connectingEndpoint = nil
            publishState()
            return
        }
        guard let endpoint = effectiveEndpoint else {
            connectingEndpoint = nil
            publishState()
            return
        }
        guard hasNetwork else {
            connectingEndpoint = nil
            publishState()
            return
        }
        lastFailure = nil
        connectingEndpoint = endpoint
        publishState()
        connection = Task { @MainActor [weak self] in
            await self?.connectionLoop(endpoint: endpoint)
        }
    }

    private func connectionLoop(endpoint: ClientEndpoint) async {
        while running && !Task.isCancelled {
            do {
                try await runStream(endpoint: endpoint)
            } catch is CancellationError {
                return
            } catch let error as ClientError {
                if Task.isCancelled { return }
                if case .incompatibleProtocol = error {
                    absorb(error)
                    return
                }
                if case .api(.unauthorized) = error, token != nil {
                    absorb(error)
                    return
                }
            } catch {
                if Task.isCancelled { return }
            }
            guard running, !Task.isCancelled else { return }
            if revoked || incompatible != nil || token == nil || !hasNetwork {
                connectingEndpoint = nil
                publishState()
                return
            }
            connectedEndpoint = nil
            connectingEndpoint = nil
            lastFailure = endpoint
            attempt += 1
            publishState()
            do {
                try await pacer.sleep(seconds: ClientRetry.delay(attempt: attempt))
            } catch {
                return
            }
            guard running, !Task.isCancelled else { return }
            connectingEndpoint = endpoint
            publishState()
        }
    }

    private func runStream(endpoint: ClientEndpoint) async throws {
        guard let token else { throw ClientError.notConnected }
        let stream = try await transport.stream(
            ClientHTTPRequest(method: "GET", path: "/v1/stream", isStream: true),
            to: endpoint,
            token: token
        )
        var parser = ClientStreamParser()
        connectedEndpoint = endpoint
        connectingEndpoint = nil
        lastFailure = nil
        attempt = 0
        publishState()
        for try await chunk in stream {
            if Task.isCancelled { throw CancellationError() }
            for event in parser.consume(chunk) {
                apply(event)
            }
            if let incompatible {
                throw ClientError.incompatibleProtocol(local: incompatible.local, remote: incompatible.remote)
            }
        }
    }

    // MARK: - Application des évènements

    private func apply(_ event: ClientStreamEvent) {
        switch event {
        case .hello(let hello):
            if hello.protocolVersion != localProtocolVersion {
                incompatible = ClientIncompatibility(local: localProtocolVersion, remote: hello.protocolVersion)
            }
        case .store(let snapshot):
            self.snapshot = snapshot
        case .devices(let event):
            devices = event.devices
        case .sessions(let event):
            sessionUpdates.insert(event, at: 0)
            if sessionUpdates.count > Self.sessionUpdateLimit {
                sessionUpdates.removeLast(sessionUpdates.count - Self.sessionUpdateLimit)
            }
        case .hosted(let event):
            hosted = event
        case .unknown:
            break
        }
    }

    // MARK: - Découverte, réseau, version distante

    private func applyDiscovered(_ list: [DiscoveredMac]) {
        let only = list.min { left, right in
            Array(left.name.utf8).lexicographicallyPrecedes(Array(right.name.utf8))
        }
        guard only != discovered else { return }
        discovered = only
        // Une adresse manuelle posée n'est JAMAIS remplacée en silence.
        guard manualAddress == nil else {
            publishState()
            return
        }
        lastFailure = nil
        beginConnection(resetCounter: true)
    }

    private func applyRemoteProtocol(_ version: Int) {
        guard version != localProtocolVersion else { return }
        lock(local: localProtocolVersion, remote: version)
    }

    private func applyNetwork(_ satisfied: Bool) {
        let changed = hasNetwork != satisfied
        hasNetwork = satisfied
        if !satisfied {
            connection?.cancel()
            connection = nil
            connectedEndpoint = nil
            connectingEndpoint = nil
            publishState()
        } else if changed, running {
            beginConnection(resetCounter: false)
        } else {
            publishState()
        }
    }

    private func loadManualAddress() -> ClientAddress? {
        guard let raw = preferences.string(forKey: ClientPreferenceKey.manualAddress) else { return nil }
        guard case .success(let address) = ClientAddress.parse(raw) else { return nil }
        return address
    }

    private func publishState() {
        state = ClientStateMachine.resolve(ClientFacts(
            revoked: revoked,
            incompatible: incompatible,
            hasNetwork: hasNetwork,
            hasToken: token != nil,
            connectedEndpoint: connectedEndpoint,
            connectingEndpoint: connectingEndpoint,
            lastFailure: lastFailure
        ))
    }
}
