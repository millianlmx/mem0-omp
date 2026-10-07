// Le modèle du service d'API distante (S-14, BR-9) : l'interrupteur persistant,
// l'état publié, et la composition de tout ce que le serveur sert — registre,
// flux, routeur, listener.
//
// La préférence `remote.enabled` est ACTIVE PAR DÉFAUT (absente = vrai) et n'est
// écrite QUE sur le geste. Un échec de démarrage laisse l'interrupteur sur ON et
// montre `échec` : jamais un retour silencieux à OFF qui mentirait sur la
// préférence.

import Combine
import ConsoleCore
import Foundation

@MainActor
final class RemoteServiceModel: ObservableObject {
    static let enabledKey = "remote.enabled"

    @Published private(set) var state: RemoteServiceState = .off
    @Published private(set) var enabled: Bool
    @Published var sheetShown = false
    private(set) var address: String?

    /// La préparation des composants est-elle terminée (S-14) ? Le service ne
    /// démarre JAMAIS tant que ce n'est pas vrai. La racine de l'app répond depuis
    /// `SetupModel.state` (une fermeture, pour qu'il n'y ait qu'une source de
    /// vérité), et `SetupModel.onReady` rappelle `startIfEnabled()`.
    var isSetupReady: @MainActor () -> Bool = { false }

    let registry: DeviceRegistry
    let pairing: PairingModel

    private let defaults: UserDefaults
    private let clock: RemoteClock
    private let port: Int
    private let makeListener: (@escaping RemoteServer.Handler) -> any RemoteListening
    private var listener: any RemoteListening
    private var streams: RemoteStreamHub?
    private var router: RemoteRouter?

    init(
        paths: AppPaths = .standard(),
        defaults: UserDefaults = .standard,
        clock: RemoteClock = .live,
        port: Int = ConsoleAPI.Service.defaultPort,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        storeHub: StoreHub,
        kanban: KanbanModel,
        actions: ActionsModel,
        session: SessionConsoleModel,
        project: ProjectConsoleModel,
        stats: StatsModel,
        registry: DeviceRegistry? = nil,
        makeListener: ((@escaping RemoteServer.Handler) -> any RemoteListening)? = nil
    ) {
        self.defaults = defaults
        self.clock = clock
        self.port = port
        self.enabled = defaults.object(forKey: Self.enabledKey) as? Bool ?? true
        self.registry = registry ?? DeviceRegistry(file: paths.devicesFile, clock: clock)
        self.pairing = PairingModel(registry: self.registry, clock: clock)
        let factory: (@escaping RemoteServer.Handler) -> any RemoteListening =
            makeListener ?? { RemoteServer(handler: $0) }
        self.makeListener = factory
        self.listener = factory { _, _ in .respond(HTTPResponse.error(.notFound("route inconnue"))) }

        let hub = RemoteStreamHub(storeHub: storeHub, registry: self.registry, session: session, project: project, clock: clock)
        let reads = RemoteReads(
            hub: storeHub,
            registry: self.registry,
            stats: stats,
            service: HTTPMemoryService(config: Self.memoryConfig(environment: environment, stackEnv: paths.stackEnv)),
            memoryConfig: Self.memoryConfig(environment: environment, stackEnv: paths.stackEnv),
            memoryLinks: paths.memoryLinks,
            environment: environment,
            clock: clock
        )
        let remoteActions = RemoteActions(
            kanban: kanban,
            actions: actions,
            session: session,
            project: project,
            hub: storeHub,
            environment: environment,
            clock: clock
        )
        let router = RemoteRouter(reads: reads, registry: self.registry, actions: remoteActions, streams: hub)
        self.streams = hub
        self.router = router

        self.listener = factory { [weak router] request, connection in
            guard let router else { return .respond(HTTPResponse.error(.unavailable("service arrêté"))) }
            return await router.handle(request, connection: connection)
        }
        self.listener.onState = { [weak self] newState in
            self?.apply(newState)
        }
        self.registry.revokeHandler = { [weak hub] deviceId in hub?.close(deviceId: deviceId) }
        self.registry.changeHandler = { [weak hub] in hub?.broadcastDevices() }
    }

    /// Le service démarre sur demande, jamais tant que la préparation n'est pas
    /// terminée : l'appelant appelle `startIfEnabled()` à l'ouverture de la racine
    /// ET sur `SetupModel.onReady`.
    func startIfEnabled() async {
        await registry.load()
        guard enabled else {
            state = .off
            return
        }
        await start()
    }

    func start() async {
        guard enabled, !state.isRunning else { return }
        // S-14 : le service ne démarre JAMAIS tant que la préparation des
        // composants n'est pas terminée. Le démarrage différé est laissé à
        // `SetupModel.onReady`, qui rappelle `startIfEnabled()`.
        guard isSetupReady() else { return }
        state = .starting
        do {
            try await listener.start(port: port)
        } catch {
            state = listener.state
            address = listener.address
            return
        }
        state = listener.state
        address = listener.address
    }

    func stop() {
        streams?.closeAll()
        listener.stop()
        state = .off
        address = nil
    }

    /// Le geste de l'interrupteur. Couper arrête le service et son annonce Bonjour ;
    /// rallumer repart sur le même port.
    func setEnabled(_ on: Bool) async {
        enabled = on
        defaults.set(on, forKey: Self.enabledKey)
        if on {
            await start()
        } else {
            stop()
        }
    }

    /// « Réessayer » après un échec.
    func retry() async {
        await start()
    }

    /// « Réessayer » du registre illisible : relit le fichier et le trousseau.
    func reloadRegistry() async {
        await registry.load()
        pairing.refresh()
    }

    func requestPairingSheet() {
        sheetShown = true
    }

    private func apply(_ newState: RemoteServiceState) {
        state = newState
        address = listener.address
    }

    /// La configuration de la pile mémoire : l'environnement d'abord, puis le
    /// `.env` de la pile de l'app pour le jeton.
    static func memoryConfig(environment: [String: String], stackEnv: URL) -> MemoryServiceConfig {
        var config = MemoryServiceConfig.fromEnvironment(environment)
        if config.token.isEmpty, let stack = StackEnvStore.load(at: stackEnv), !stack.mem0HttpToken.isEmpty {
            config.token = stack.mem0HttpToken
        }
        return config
    }
}

/// Le modèle de la zone d'appairage (S-5, S-6) : le code affiché, son compte à
/// rebours, et la révocation en cours.
@MainActor
final class PairingModel: ObservableObject {
    @Published private(set) var code: PairingCode?
    @Published private(set) var countdown: String?
    @Published private(set) var error: String?
    @Published private(set) var revoking: Set<UUID> = []

    private let registry: DeviceRegistry
    private let clock: RemoteClock
    private var timer: Timer?

    init(registry: DeviceRegistry, clock: RemoteClock) {
        self.registry = registry
        self.clock = clock
    }

    /// « Générer un code » : un nouvel appui REMPLACE le code précédent.
    func generate() {
        error = nil
        do {
            try registry.generateCode()
        } catch let failure as ConsoleAPIError {
            error = failure.message ?? DeviceRegistry.loadMessage("raison inconnue")
            code = nil
            countdown = nil
            stopTimer()
            return
        } catch {
            self.error = DeviceRegistry.loadMessage("raison inconnue")
            return
        }
        refresh()
        startTimer()
    }

    /// Relit le code actif : à l'échéance, le code et le compte à rebours
    /// disparaissent sans message d'erreur.
    func refresh() {
        let now = clock.nowMs()
        registry.pruneExpiredCode(at: now)
        guard let active = registry.pairing.current, !active.isExpired(at: now) else {
            code = nil
            countdown = nil
            stopTimer()
            return
        }
        code = active
        countdown = PairingPresentation.countdown(expiresAtMs: active.expiresAtMs, nowMs: now)
    }

    func revoke(_ id: UUID) async {
        revoking.insert(id)
        await registry.revoke(id: id)
        revoking.remove(id)
    }

    private func startTimer() {
        stopTimer()
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }
}
