// Le modèle observable UNIQUE du client du Mac (S-2) : il porte l'état, les
// appareils, les composants, la découverte, l'adresse manuelle et l'erreur
// d'appairage, et lit la mémoire du projet. Les pipelines ne passent plus par le
// Mac : l'app joint le serveur du VPS (`HarnessModel`).
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
    @Published public private(set) var devices: [RemoteDeviceRow] = []
    @Published public private(set) var discovered: DiscoveredMac?
    @Published public private(set) var manualAddress: ClientAddress?
    @Published public private(set) var pairingFailure: ClientPairingFailure?
    @Published public private(set) var localNetworkDenied = false
    /// La tentative en cours suit-elle un échec ? Vrai après l'échec d'une
    /// tentative (`lastFailure`, gardé pendant les relances automatiques) ou
    /// après `ClientRetry.searchGrace` passées en `.searching` sans Mac trouvé.
    /// Recalculé à chaque `publishState()`, toujours `false` en `.connected`.
    @Published public private(set) var attemptFollowsFailure = false
    /// Le statut d'appairage (indépendant de `state`) : `.restoring` tant que le
    /// trousseau n'est pas lu, puis `.paired`, `.unpaired` ou `.refused`.
    @Published public private(set) var pairing: ClientPairingStatus = .restoring

    /// L'état des composants du Mac (S-8), posé par la trame `components` et par
    /// la lecture `components()`.
    @Published public private(set) var components: RemoteComponentsPayload?
    // MARK: - Dépendances injectées

    private let transport: any ClientTransport
    private let discovery: any DiscoverySource
    private let preferences: any ClientPreferences
    private let tokens: any TokenStore
    private let pacer: any ClientPacer
    /// L'attente du délai de recherche Bonjour (`ClientRetry.searchGrace`).
    private let searchPacer: any ClientPacer
    /// L'échéance de `waitUntilReady()` (`ClientRetry.readinessTimeout`).
    private let readinessPacer: any ClientPacer
    private let pathSource: any ClientPathSource
    private let deviceName: String
    private let localProtocolVersion: Int

    // MARK: - Faits internes

    private var running = false
    private var token: String?
    private var deviceId: String?
    private var hasNetwork = true
    private var revoked = false
    /// Le trousseau a été lu au moins une fois (fin de `restoreToken`).
    private var tokenRead = false
    /// Les attentes de `awaitPairingRestored()` suspendues pendant la première
    /// lecture du trousseau : toutes reprises, une seule fois, à la fin de
    /// `restoreToken()`, avec le même statut.
    private var pairingWaiters: [CheckedContinuation<ClientPairingStatus, Never>] = []
    /// L'endpoint vers lequel était partie la requête ou le flux refusé (401) :
    /// porté par `.refused`, repli de `pairingEndpoint()`. Remis à `nil` par un
    /// appairage réussi et par `forget()`.
    private var refusedEndpoint: ClientEndpoint?
    private var incompatible: ClientIncompatibility?
    private var connectedEndpoint: ClientEndpoint?
    private var connectingEndpoint: ClientEndpoint?
    private var lastFailure: ClientEndpoint?
    private var attempt = 0
    private var connection: Task<Void, Never>?
    /// Resté `.searching` au-delà de `ClientRetry.searchGrace` ; remis à `false`
    /// à chaque `beginConnection` et à `stop()`.
    private var searchExpired = false
    private var searchTask: Task<Void, Never>?
    /// Une trame `hello` de la version locale a été reçue sur le flux ouvert : vrai
    /// seulement entre ce `hello` et la prochaine ouverture de flux.
    private var macConfirmed = false
    /// Les attentes « prêt à émettre » en cours. Chaque continuation est RETIRÉE
    /// avant d'être reprise (`finishReadiness`, `settleReadiness`) : reprise unique.
    private var readinessWaiters: [UUID: CheckedContinuation<ClientReadiness, Never>] = [:]

    // MARK: - Cycle de vie

    public init(
        transport: any ClientTransport,
        discovery: any DiscoverySource,
        preferences: any ClientPreferences,
        tokens: any TokenStore,
        pacer: any ClientPacer = LiveClientPacer(),
        pathSource: any ClientPathSource,
        deviceName: String = ClientDeviceModel.current,
        localProtocolVersion: Int = ConsoleAPI.protocolVersion,
        searchPacer: any ClientPacer = LiveClientPacer(),
        readinessPacer: any ClientPacer = LiveClientPacer()
    ) {
        self.transport = transport
        self.discovery = discovery
        self.preferences = preferences
        self.tokens = tokens
        self.pacer = pacer
        self.pathSource = pathSource
        self.deviceName = deviceName
        self.localProtocolVersion = localProtocolVersion
        self.searchPacer = searchPacer
        self.readinessPacer = readinessPacer
    }

    /// La production : le vrai transport, la vraie découverte, le vrai trousseau.
    public static func live(deviceName: String = ClientDeviceModel.current) -> ConsoleClientModel {
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

    /// Le dossier personnel du Mac, publié par `components` : l'app iOS abrège les
    /// chemins du Mac en « ~/… » contre LUI, jamais contre son bac à sable. `nil`
    /// avant la première trame `components`, ou face à un Mac antérieur.
    public var macHomeDirectory: String? { components?.homeDirectory }

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
        searchTask?.cancel()
        searchTask = nil
        searchExpired = false
        discovery.stop()
        pathSource.stop()
    }

    /// Démarre le client s'il ne tourne pas (`start()`, idempotent), puis attend la
    /// fin de la première lecture du trousseau. Rend `.paired`, `.unpaired` ou
    /// `.refused`, JAMAIS `.restoring`. N'attend ni la découverte du Mac ni la
    /// connexion ; ne déclenche aucune lecture du trousseau en plus de celle que
    /// `start()` lance, et aucune requête. L'annulation de la tâche appelante est
    /// ignorée : la lecture est locale et bornée, l'attente se termine avec elle.
    public func awaitPairingRestored() async -> ClientPairingStatus {
        start()
        guard pairing == .restoring else { return pairing }
        return await withCheckedContinuation { continuation in
            pairingWaiters.append(continuation)
        }
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

    // MARK: - Attente « prêt à émettre »

    /// Attend, au plus `ClientRetry.readinessTimeout` (démarrage à froid compris),
    /// que le client puisse émettre, et rend le verdict.
    ///
    /// - Démarre le modèle s'il ne l'est pas (`start()`, idempotent) : la relecture
    ///   du trousseau ne fait jamais échouer l'attente.
    /// - Après un échec (`.macAbsent`, relance automatique en attente), une
    ///   tentative neuve part AUSSITÔT, sans subir le délai de relance ; dans tout
    ///   autre état, aucune tentative n'est ajoutée.
    /// - Seule l'adresse manuelle est essayée quand il y en a une, le Mac découvert
    ///   par Bonjour sinon (règle de `effectiveEndpoint`, inchangée).
    /// - « Prêt » exige le Mac confirmé : flux ouvert ET trame `hello` de la version
    ///   locale reçue sur ce flux. Sinon : `.pairingRefused`, `.incompatibleVersion`,
    ///   `.notPaired` dès qu'ils sont publiés, `.macUnreachable` à l'échéance ou si
    ///   la tâche appelante est annulée.
    /// - Ne lève ni le verrou de version ni le refus d'appairage, ne publie rien de
    ///   neuf et ne coupe rien en rendant son verdict.
    public func waitUntilReady() async -> ClientReadiness {
        if Task.isCancelled { return .macUnreachable }
        if !running { start() }
        if case .macAbsent = state { beginConnection(resetCounter: true) }
        if let verdict = readinessVerdict { return verdict }
        let id = UUID()
        let deadline = Task { @MainActor [weak self, pacer = readinessPacer] in
            do {
                try await pacer.sleep(seconds: ClientRetry.readinessTimeout)
            } catch {
                return
            }
            self?.finishReadiness(id, .macUnreachable)
        }
        // Tâche déjà annulée : `onCancel` s'exécute AVANT l'opération, mais la tâche
        // `@MainActor` qu'il crée passe après l'enregistrement de la continuation.
        let verdict = await withTaskCancellationHandler {
            await withCheckedContinuation { readinessWaiters[id] = $0 }
        } onCancel: {
            Task { @MainActor [weak self] in self?.finishReadiness(id, .macUnreachable) }
        }
        deadline.cancel()
        return verdict
    }

    /// Le verdict des faits publiés, dans cet ordre : refus, verrou de version,
    /// absence de jeton (lue sur `pairing`, jamais sur `state`, qui vaut aussi
    /// `.unpaired` pendant la relecture du trousseau), Mac confirmé ; `nil` : on
    /// continue d'attendre.
    private var readinessVerdict: ClientReadiness? {
        if case .refused = pairing { return .pairingRefused }
        if case .incompatibleProtocol(let local, let remote) = state {
            return .incompatibleVersion(local: local, remote: remote)
        }
        if pairing == .unpaired { return .notPaired }
        if case .connected(let endpoint) = state, macConfirmed { return .ready(endpoint: endpoint) }
        return nil
    }

    /// Rend le verdict, s'il y en a un, à TOUTES les attentes en cours : la table
    /// est vidée avant toute reprise.
    private func settleReadiness() {
        guard !readinessWaiters.isEmpty, let verdict = readinessVerdict else { return }
        let waiters = readinessWaiters
        readinessWaiters.removeAll()
        for waiter in waiters.values { waiter.resume(returning: verdict) }
    }

    /// Reprend une attente précise ; ne fait rien si elle a déjà été reprise.
    private func finishReadiness(_ id: UUID, _ verdict: ClientReadiness) {
        guard let waiter = readinessWaiters.removeValue(forKey: id) else { return }
        waiter.resume(returning: verdict)
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

    /// Appaire par le code affiché par le Mac (avec ou sans tiret, toute casse).
    /// Un refus laisse l'état `unpaired`, n'écrit AUCUN jeton et ne programme
    /// AUCUN réessai. Chaque appairage porte l'identité de l'installation : le
    /// Mac remplace la ligne de cet appareil au lieu d'en ajouter une.
    public func pair(code: String, deviceName: String) async throws {
        let normalized = PairingCodeFormat.normalize(code)
        guard PairingCodeFormat.isWellFormed(normalized) else {
            pairingFailure = .malformedCode
            return
        }
        let endpoint = try pairingEndpoint()
        let name = ClientPairing.normalizeDeviceName(deviceName)
        guard let body = try? JSONEncoder().encode(
            RemotePairRequest(code: normalized, name: name, deviceKey: installationId(), protocolVersion: nil)
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
        refusedEndpoint = nil
        beginConnection(resetCounter: true)
    }

    /// L'identité de l'installation : relue, ou créée (UUID minuscule) au premier
    /// appairage. Rien ne l'efface — la révocation n'oublie que `deviceId`.
    private func installationId() -> String {
        if let known = preferences.string(forKey: ClientPreferenceKey.installationId), !known.isEmpty {
            return known
        }
        let created = UUID().uuidString.lowercased()
        preferences.set(created, forKey: ClientPreferenceKey.installationId)
        return created
    }

    /// « Oublier ce Mac » : révocation tentée AU MIEUX sur le Mac, puis oubli local
    /// quelle que soit l'issue. Ne lève jamais.
    ///
    /// La requête `DELETE /v1/devices/self` part UNIQUEMENT si l'appareil est
    /// appairé ET connecté, vers l'endpoint connecté ; son issue (2xx, 401, autre
    /// statut, panne, délai) est ignorée. Le jeton est retiré de la mémoire AVANT
    /// l'envoi : aucun 401 reçu pendant ou après l'oubli n'est absorbé comme un
    /// refus. L'adresse manuelle et le Mac découvert sont conservés.
    public func forget() async {
        let oldToken = token
        let oldDeviceId = deviceId
        var target: ClientEndpoint?
        if pairing == .paired, case .connected(let endpoint) = state { target = endpoint }

        connection?.cancel()
        connection = nil
        connectedEndpoint = nil
        connectingEndpoint = nil
        lastFailure = nil
        token = nil

        if let target, let oldToken {
            // `transport.send` et jamais `perform` : `perform` absorberait le 401.
            _ = try? await transport.send(
                ClientHTTPRequest(method: "DELETE", path: ConsoleAPI.Service.basePath + "/devices/self"),
                to: target,
                token: oldToken
            )
        }

        if let oldDeviceId {
            try? await tokens.remove(deviceId: oldDeviceId)
        }
        deviceId = nil
        preferences.set(nil, forKey: ClientPreferenceKey.deviceId)
        revoked = false
        refusedEndpoint = nil
        pairingFailure = nil
        publishState()
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

    public func devices() async throws -> RemoteDevicesPayload {
        try await perform(ClientHTTPRequest(method: "GET", path: "/v1/devices"), as: RemoteDevicesPayload.self)
    }

    public func components() async throws -> RemoteComponentsPayload {
        try await perform(ClientHTTPRequest(method: "GET", path: "/v1/components"), as: RemoteComponentsPayload.self)
    }

    /// Une page du sommaire d'une portée (`GET /v1/memory/page`) : `offset`
    /// toujours transmis, `scope` et `limit` seulement quand ils sont posés.
    public func memoryPage(scope: String?, offset: Int, limit: Int?) async throws -> RemoteMemoryPagePayload {
        var query: [String] = []
        if let scope { query.append("scope=" + encode(scope)) }
        query.append("offset=\(offset)")
        if let limit { query.append("limit=\(limit)") }
        let path = "/v1/memory/page?" + query.joined(separator: "&")
        return try await perform(
            ClientHTTPRequest(method: "GET", path: path, profile: .memory),
            as: RemoteMemoryPagePayload.self
        )
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
        return try await perform(
            ClientHTTPRequest(method: "GET", path: path, profile: .memory),
            as: RemoteMemoryGraphPayload.self
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
        guard let endpoint = effectiveEndpoint ?? refusedEndpoint else { throw ClientError.notConnected }
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
                // L'endpoint refusé est capturé AVANT la remise à `nil` : connecté,
                // sinon en cours de connexion, sinon l'endpoint en vigueur.
                let refused = connectedEndpoint ?? connectingEndpoint ?? effectiveEndpoint
                connection?.cancel()
                connection = nil
                connectedEndpoint = nil
                connectingEndpoint = nil
                lastFailure = nil
                Task { [weak self] in await self?.revoke(endpoint: refused) }
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

    /// Ne fait RIEN si le jeton est déjà `nil` quand la tâche s'exécute : deux 401
    /// concurrents ne donnent qu'un passage à `.refused`, et un 401 reçu pendant ou
    /// après `forget()` (qui retire le jeton d'abord) est ignoré.
    private func revoke(endpoint: ClientEndpoint?) async {
        guard token != nil else { return }
        let id = deviceId
        token = nil
        deviceId = nil
        revoked = true
        refusedEndpoint = endpoint
        connectedEndpoint = nil
        connectingEndpoint = nil
        lastFailure = nil
        connection?.cancel()
        connection = nil
        if let id {
            try? await tokens.remove(deviceId: id)
        }
        preferences.set(nil, forKey: ClientPreferenceKey.deviceId)
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
        case .unexpectedStatus(let status): return .unavailable("statut \(status)")
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
            // est requis. Une erreur de lecture du trousseau compte comme une absence.
            token = nil
        }
        tokenRead = true
        beginConnection(resetCounter: true)
        // L'état est publié : chaque attente reprend une fois, avec le même statut.
        let waiters = pairingWaiters
        pairingWaiters = []
        for waiter in waiters { waiter.resume(returning: pairing) }
    }

    private func beginConnection(resetCounter: Bool) {
        if resetCounter { attempt = 0 }
        connection?.cancel()
        connection = nil
        searchTask?.cancel()
        searchTask = nil
        searchExpired = false
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
            if hasNetwork { startSearchGrace() }
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

    /// `.searching` (jeton, réseau, ni révoqué ni verrouillé, aucun Mac) : passé
    /// `ClientRetry.searchGrace`, la recherche compte comme un échec. Un sommeil
    /// interrompu (annulation ou autre) ne change rien.
    private func startSearchGrace() {
        let pacer = searchPacer
        searchTask = Task { @MainActor [weak self] in
            do {
                try await pacer.sleep(seconds: ClientRetry.searchGrace)
            } catch {
                return
            }
            guard let self, !Task.isCancelled, self.effectiveEndpoint == nil else { return }
            self.searchExpired = true
            self.publishState()
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
        macConfirmed = false
        publishState()
        refreshHomeFacts()
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
            } else {
                macConfirmed = true
                settleReadiness()
            }
        case .devices(let event):
            devices = event.devices
        case .components(let payload):
            components = payload
        case .unknown:
            break
        }
    }

    // MARK: - Composants

    /// Rafraîchit l'état des composants à la connexion. L'appel est TOLÉRANT : une
    /// erreur n'est jamais propagée (l'état reste inconnu).
    private func refreshHomeFacts() {
        Task { [weak self] in
            guard let self else { return }
            await self.loadHomeFacts()
        }
    }

    private func loadHomeFacts() async {
        if let payload = try? await components() { components = payload }
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
        if case .connected = state {
            attemptFollowsFailure = false
        } else {
            attemptFollowsFailure = lastFailure != nil || searchExpired
        }
        // Le statut d'appairage n'est republié qu'à son CHANGEMENT : la feuille
        // Connexion s'ouvre sur un passage, jamais sur une republication.
        let status = resolvedPairing
        if status != pairing { pairing = status }
        settleReadiness()
    }

    /// Le refus prime ; un jeton détenu vaut `.paired` (même avant la fin de la
    /// lecture du trousseau, cas d'un appairage déjà réussi) ; avant la lecture,
    /// `.restoring` ; sinon `.unpaired`.
    private var resolvedPairing: ClientPairingStatus {
        if revoked { return .refused(endpoint: refusedEndpoint) }
        if token != nil { return .paired }
        if !tokenRead { return .restoring }
        return .unpaired
    }
}
