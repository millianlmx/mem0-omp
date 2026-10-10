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

/// Ce qu'un abonné reçoit du flux d'UNE session vivante (S-8) : les entrées
/// AJOUTÉES depuis la dernière trame, ou l'ordre de tout relire parce que le
/// fichier a été tronqué ou remplacé. Le fichier n'est jamais porté par l'item :
/// un abonné de `sessionFeed(forFile:)` ne reçoit QUE les trames de SON fichier.
public enum RemoteSessionFeedItem: Equatable, Sendable {
    case added([RemoteConversationEntry])
    case rewrote
}

@MainActor
public final class ConsoleClientModel: ObservableObject {
    // MARK: - État publié

    @Published public private(set) var state: ClientState = .unpaired
    @Published public private(set) var snapshot: StoreSnapshot?
    @Published public private(set) var devices: [RemoteDeviceRow] = []
    @Published public private(set) var sessionUpdates: [RemoteSessionsEvent] = []
    @Published public private(set) var hosted: RemoteHostedEvent?
    /// L'état RÉDUIT de la conduite (S-6/S-11) : posé par l'évènement `conduite`,
    /// remis à `nil` dès que l'état publié quitte `.connected`.
    @Published public private(set) var conduite: RemoteConduiteStatePayload?
    @Published public private(set) var discovered: DiscoveredMac?
    @Published public private(set) var manualAddress: ClientAddress?
    @Published public private(set) var pairingFailure: ClientPairingFailure?
    @Published public private(set) var localNetworkDenied = false

    /// L'ardoise dérivée du dernier instantané reçu (S-8) : `.loading` tant
    /// qu'aucune trame `store` n'est arrivée, puis recalculée à chaque trame et
    /// après chaque lecture REST du magasin. La dérivation se fait ICI, jamais
    /// dans une vue.
    @Published public private(set) var board: KanbanBoardState = .loading
    /// L'état des composants du Mac (S-8), posé par la trame `components` et par
    /// la lecture `components()`.
    @Published public private(set) var components: RemoteComponentsPayload?
    /// Le journal des gestes (S-8), posé par la trame `journal` et par la lecture
    /// `journal()`.
    @Published public private(set) var journal: [ActionJournalEntry] = []
    /// La préférence de bienvenue (S-8), lue au `start()`.
    @Published public private(set) var welcomeSeen = false

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
    /// L'horloge injectée : la dérivation de l'ardoise lit `nowMs()` (S-8), pour
    /// que les tests soient déterministes. Défaut : l'horloge murale (ms epoch).
    private let nowMs: @Sendable () -> Double

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
    /// Les abonnés du flux d'une session vivante (S-8), par fichier. Un dictionnaire
    /// de continuateurs, pas un `@Published` : chacun ne voit QUE son fichier.
    private var sessionFeeds: [String: [UUID: AsyncStream<RemoteSessionFeedItem>.Continuation]] = [:]

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
        nowMs: @Sendable @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }
    ) {
        self.transport = transport
        self.discovery = discovery
        self.preferences = preferences
        self.tokens = tokens
        self.pacer = pacer
        self.pathSource = pathSource
        self.deviceName = deviceName
        self.localProtocolVersion = localProtocolVersion
        self.nowMs = nowMs
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

    /// OMP trouvé ou introuvable (S-8, S-10) : `.missing` est conclu SEULEMENT
    /// quand le Mac a répondu que le composant n'est pas installé ; tant que
    /// `components` est `nil`, on ne conclut JAMAIS à l'absence (l'Accueil reste
    /// en chargement/déconnecté, jamais « OMP absent »).
    public var omp: OmpStatus {
        if let components, components.ompInstalled == false { return .missing }
        return .available(URL(fileURLWithPath: components?.ompPath ?? ""))
    }

    /// La feuille de bienvenue a été vue : la préférence passe à `true` (S-8).
    public func closeWelcome() {
        guard !welcomeSeen else { return }
        welcomeSeen = true
        preferences.set(true, forKey: ClientPreferenceKey.welcomeSeen)
    }

    public func start() {
        guard !running else { return }
        running = true
        manualAddress = loadManualAddress()
        deviceId = preferences.string(forKey: ClientPreferenceKey.deviceId)
        welcomeSeen = preferences.bool(forKey: ClientPreferenceKey.welcomeSeen) ?? false
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
        let payload = try await perform(ClientHTTPRequest(method: "GET", path: "/v1/store"), as: RemoteStorePayload.self)
        applyStore(payload.snapshot)
        return payload
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

    // MARK: - Flux d'une session vivante

    /// Le flux MULTICAST des nouveautés d'UN fichier de session (S-8). Chaque abonné
    /// est indépendant : `AsyncStream` ne se consomme qu'une fois, donc la visionneuse
    /// en prend un, et l'abandon retiré sur `onTermination`. Une trame d'un AUTRE
    /// fichier n'est délivrée à personne.
    ///
    /// Le tampon est BORNÉ (`.bufferingNewest`) : un consommateur qui ne consomme plus
    /// — app en arrière-plan — garde les derniers lots au lieu d'accumuler, et une
    /// trame perdue de la sorte est rattrapée par la relecture qu'exige `.rewrote` ou
    /// par une réouverture (S-8 : le rattrapage du trou hors ligne n'est pas un
    /// objectif).
    public func sessionFeed(forFile file: String) -> AsyncStream<RemoteSessionFeedItem> {
        let (stream, continuation) = AsyncStream<RemoteSessionFeedItem>.makeStream(
            bufferingPolicy: .bufferingNewest(Self.sessionFeedBuffer)
        )
        let id = UUID()
        // Une itération annulée termine le flux : on retire alors le continuateur.
        // `onTermination` peut être appelé hors du fil principal — d'où le saut
        // explicite vers l'acteur du modèle.
        continuation.onTermination = { [weak self] _ in
            Task { @MainActor in self?.removeSessionFeed(file: file, id: id) }
        }
        sessionFeeds[file, default: [:]][id] = continuation
        return stream
    }

    // MARK: - Fait observé par les tests : les abonnés du flux de session

    /// Le nombre d'abonnés vivants, tous fichiers confondus. L'abandon d'un abonné
    /// doit retirer son continuateur : c'est le seul fait observable de ce nettoyage.
    var sessionFeedSubscriberCount: Int {
        sessionFeeds.values.reduce(0) { $0 + $1.count }
    }

    /// Le nombre de lots conservés pour un abonné en retard (borne du tampon).
    private static let sessionFeedBuffer = 64

    public func projects() async throws -> RemoteProjectsPayload {
        try await perform(ClientHTTPRequest(method: "GET", path: "/v1/projects"), as: RemoteProjectsPayload.self)
    }

    public func documents(repoKey: String) async throws -> RemoteDocumentsPayload {
        try await perform(
            ClientHTTPRequest(method: "GET", path: "/v1/projects/" + encode(repoKey) + "/documents"),
            as: RemoteDocumentsPayload.self
        )
    }

    /// Le tableau du projet demandé (S-1) : sans `project`, le Mac choisit le
    /// premier de son ordre ; avec, il sert ce projet-là (une clé inconnue
    /// retombe sur le premier, et la charge utile le dit).
    public func statistics(project: String? = nil) async throws -> RemoteStatsPayload {
        let path = project.map { "/v1/stats?project=" + encode($0) } ?? "/v1/stats"
        return try await perform(ClientHTTPRequest(method: "GET", path: path), as: RemoteStatsPayload.self)
    }

    public func devices() async throws -> RemoteDevicesPayload {
        try await perform(ClientHTTPRequest(method: "GET", path: "/v1/devices"), as: RemoteDevicesPayload.self)
    }

    /// Le catalogue des modèles du Mac (S-14). Une réponse 200 porte soit des
    /// sélecteurs, soit un motif d'échec — jamais une erreur de transport.
    public func models() async throws -> RemoteModelsPayload {
        try await perform(ClientHTTPRequest(method: "GET", path: "/v1/models"), as: RemoteModelsPayload.self)
    }

    public func components() async throws -> RemoteComponentsPayload {
        try await perform(ClientHTTPRequest(method: "GET", path: "/v1/components"), as: RemoteComponentsPayload.self)
    }

    public func journal() async throws -> RemoteJournalPayload {
        try await perform(ClientHTTPRequest(method: "GET", path: "/v1/journal"), as: RemoteJournalPayload.self)
    }

    public func contract(cardId: String) async throws -> RemoteContractPayload {
        try await perform(
            ClientHTTPRequest(method: "GET", path: "/v1/cards/" + encode(cardId) + "/contract"),
            as: RemoteContractPayload.self
        )
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
        return try await performGesture(
            ClientHTTPRequest(method: "POST", path: "/v1/cards/" + encode(cardId) + "/answer", body: body),
            as: RemoteAcceptedPayload.self
        )
    }

    public func reply(cardId: String, text: String) async throws -> RemoteAcceptedPayload {
        let body = try encode(RemoteTextRequest(text: text))
        return try await performGesture(
            ClientHTTPRequest(method: "POST", path: "/v1/cards/" + encode(cardId) + "/reply", body: body),
            as: RemoteAcceptedPayload.self
        )
    }

    public func text(cardId: String, text: String) async throws -> RemoteAcceptedPayload {
        let body = try encode(RemoteTextRequest(text: text))
        return try await performGesture(
            ClientHTTPRequest(method: "POST", path: "/v1/cards/" + encode(cardId) + "/text", body: body),
            as: RemoteAcceptedPayload.self
        )
    }

    public func verdict(cardId: String, verdict: String) async throws -> RemoteAcceptedPayload {
        let body = try encode(RemoteVerdictRequest(verdict: verdict))
        return try await performGesture(
            ClientHTTPRequest(method: "POST", path: "/v1/cards/" + encode(cardId) + "/verdict", body: body),
            as: RemoteAcceptedPayload.self
        )
    }

    public func resume(cardId: String) async throws -> RemoteAcceptedPayload {
        try await performGesture(
            ClientHTTPRequest(method: "POST", path: "/v1/cards/" + encode(cardId) + "/resume"),
            as: RemoteAcceptedPayload.self
        )
    }

    public func stop(cardId: String) async throws -> RemoteAcceptedPayload {
        try await performGesture(
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
        return try await performGesture(
            ClientHTTPRequest(method: "POST", path: "/v1/features", body: body),
            as: RemoteAcceptedPayload.self
        )
    }

    public func startConduite(repoKey: String, name: String) async throws -> RemoteConduitePayload {
        let body = try encode(RemoteConduiteRequest(name: name))
        return try await performGesture(
            ClientHTTPRequest(method: "POST", path: "/v1/projects/" + encode(repoKey) + "/conduite", body: body),
            as: RemoteConduitePayload.self
        )
    }

    public func closeConduite(repoKey: String) async throws -> RemoteConduitePayload {
        try await performGesture(
            ClientHTTPRequest(method: "DELETE", path: "/v1/projects/" + encode(repoKey) + "/conduite"),
            as: RemoteConduitePayload.self
        )
    }

    /// Les dépôts connus de la coque (S-8) : le client ne calcule jamais un `repoKey`.
    public func repos() async throws -> RemoteReposPayload {
        try await perform(ClientHTTPRequest(method: "GET", path: "/v1/repos"), as: RemoteReposPayload.self)
    }

    /// L'état réduit de la conduite (S-11), lu à la demande.
    public func conduiteState() async throws -> RemoteConduiteStatePayload {
        try await perform(ClientHTTPRequest(method: "GET", path: "/v1/conduite"), as: RemoteConduiteStatePayload.self)
    }

    /// La réponse à une escalade de la conduite (S-4/S-5) : `value` pour
    /// `editor`/`select`/`input`, `confirmed` pour `confirm`, `cancelled` pour annuler.
    public func answerProjectDialog(
        id: String,
        kind: String,
        value: String?,
        confirmed: Bool?
    ) async throws -> RemoteAcceptedPayload {
        let body = try encode(RemoteDialogAnswerRequest(kind: kind, value: value, confirmed: confirmed))
        return try await perform(
            ClientHTTPRequest(method: "POST", path: "/v1/conduite/dialogs/" + encode(id), body: body),
            as: RemoteAcceptedPayload.self
        )
    }

    /// Le projet du magasin pour ce `repoKey`, lu de l'instantané courant — l'app
    /// n'a jamais le type `StoreSnapshot` entre les mains.
    public func project(repoKey: String) -> Project? {
        snapshot?.projects.projects.first { $0.repoKey == repoKey }
    }

    public func hostedSession() async throws -> RemoteHostedSessionPayload {
        let payload = try await perform(
            ClientHTTPRequest(method: "GET", path: "/v1/session"),
            as: RemoteHostedSessionPayload.self
        )
        applyHosted(payload)
        return payload
    }

    /// Lance la session hébergée sur un dépôt CONNU du Mac (S-1) : le client ne
    /// calcule jamais la clé, il la reçoit de `GET /v1/repos`.
    public func launchHostedSession(repoKey: String) async throws -> RemoteHostedSessionPayload {
        let body = try encode(RemoteHostedLaunchRequest(repoKey: repoKey))
        let payload = try await perform(
            ClientHTTPRequest(method: "POST", path: "/v1/session/launch", body: body),
            as: RemoteHostedSessionPayload.self
        )
        applyHosted(payload)
        return payload
    }

    /// Relance une session `dead` (S-1) : la règle `canRelaunch` est celle du Mac.
    public func relaunchHostedSession() async throws -> RemoteHostedSessionPayload {
        let payload = try await perform(
            ClientHTTPRequest(method: "POST", path: "/v1/session/relaunch"),
            as: RemoteHostedSessionPayload.self
        )
        applyHosted(payload)
        return payload
    }

    /// Arrête la session hébergée (S-7) : idempotent côté coque.
    public func stopHostedSession() async throws -> RemoteHostedSessionPayload {
        let payload = try await perform(
            ClientHTTPRequest(method: "POST", path: "/v1/session/stop"),
            as: RemoteHostedSessionPayload.self
        )
        applyHosted(payload)
        return payload
    }

    /// Tranche un dialogue de la session hébergée (S-5) : mêmes `kind` que la
    /// conduite, appliqués à la file de `SessionConsoleModel`.
    public func answerHostedDialog(
        id: String,
        kind: String,
        value: String?,
        confirmed: Bool?
    ) async throws -> RemoteAcceptedPayload {
        let body = try encode(RemoteDialogAnswerRequest(kind: kind, value: value, confirmed: confirmed))
        return try await perform(
            ClientHTTPRequest(method: "POST", path: "/v1/session/dialogs/" + encode(id), body: body),
            as: RemoteAcceptedPayload.self
        )
    }

    public func prompt(message: String) async throws -> RemoteSentPayload {
        let body = try encode(RemotePromptRequest(message: message))
        return try await performGesture(
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
        return try await performGesture(
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

    /// Un geste : exécute la route puis rafraîchit les faits de l'Accueil (S-8).
    /// Le rafraîchissement n'est PAS attendu : le geste rend son résultat typé dès
    /// que la route réussit, et l'accusé arrive par le flux ou par ces lectures.
    private func performGesture<T: Decodable>(_ request: ClientHTTPRequest, as type: T.Type) async throws -> T {
        let value = try await perform(request, as: type)
        refreshHomeFacts()
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
            }
        case .store(let snapshot):
            applyStore(snapshot)
        case .devices(let event):
            devices = event.devices
        case .sessions(let event):
            sessionUpdates.insert(event, at: 0)
            if sessionUpdates.count > Self.sessionUpdateLimit {
                sessionUpdates.removeLast(sessionUpdates.count - Self.sessionUpdateLimit)
            }
            deliverSessionFeed(event)
        case .hosted(let event):
            hosted = event
        case .conduite(let payload):
            conduite = payload
        case .components(let payload):
            components = payload
        case .journal(let payload):
            journal = payload.entries
        case .unknown:
            break
        }
    }

    /// Livre une trame `sessions` aux abonnés de SON fichier (S-8) : un incident
    /// `truncated`/`replaced` commande une relecture complète, un `added` non vide
    /// porte les nouvelles entrées, tout le reste ne délivre rien. Un `added` vide et
    /// une trame d'un fichier sans abonné ne réveillent personne.
    private func deliverSessionFeed(_ event: RemoteSessionsEvent) {
        guard let subscribers = sessionFeeds[event.file], !subscribers.isEmpty else { return }
        if event.issue == "truncated" || event.issue == "replaced" {
            for continuation in subscribers.values { continuation.yield(.rewrote) }
            return
        }
        guard let added = event.added, !added.isEmpty else { return }
        for continuation in subscribers.values { continuation.yield(.added(added)) }
    }

    /// Retire le continuateur d'un abonné terminé. La clé du fichier disparaît avec
    /// son dernier abonné : le registre ne garde aucune trace d'un fichier fermé.
    private func removeSessionFeed(file: String, id: UUID) {
        guard var subscribers = sessionFeeds[file] else { return }
        subscribers[id] = nil
        if subscribers.isEmpty {
            sessionFeeds[file] = nil
        } else {
            sessionFeeds[file] = subscribers
        }
    }

    /// Pose l'état de la session hébergée servie par une lecture ou un geste (S-2) :
    /// le client publie UN SEUL `hosted`, alimenté par le GET, la trame SSE et la
    /// réponse des routes de geste. Le transcript de la charge utile n'est pas
    /// repris — le fil vient du fichier de session (S-4).
    private func applyHosted(_ payload: RemoteHostedSessionPayload) {
        hosted = RemoteHostedEvent(
            state: payload.state,
            stateLabel: payload.stateLabel,
            sessionFile: payload.sessionFile,
            projectName: payload.projectName,
            dialogs: payload.dialogs,
            added: []
        )
    }

    /// Pose l'instantané et recalcule l'ardoise (S-8). Une trame identique ne
    /// republie rien : l'égalité des `StoreSnapshot` est déjà `Equatable`.
    private func applyStore(_ snapshot: StoreSnapshot) {
        guard snapshot != self.snapshot else { return }
        self.snapshot = snapshot
        board = KanbanBoardState.derive(
            snapshot: snapshot,
            nowMs: nowMs(),
            stateDir: "",
            isAlive: .transported(snapshot)
        )
    }

    // MARK: - Faits de l'Accueil (S-8)

    /// Rafraîchit l'état des composants et le journal — à la connexion et après
    /// chaque geste émis. Les appels sont TOLÉRANTS : un Mac plus ancien rend 404,
    /// et une erreur n'est jamais propagée (les faits restent inconnus).
    private func refreshHomeFacts() {
        Task { [weak self] in
            guard let self else { return }
            await self.loadHomeFacts()
        }
    }

    private func loadHomeFacts() async {
        if let payload = try? await components() { components = payload }
        if let payload = try? await journal() { journal = payload.entries }
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
        // Hors `.connected`, la conduite poussée n'est plus la vérité affichable :
        // elle repasse à `nil` (S-6/S-7), jamais un état de repli local.
        if case .connected = state {} else { conduite = nil }
    }
}
