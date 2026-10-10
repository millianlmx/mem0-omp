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
        components: @escaping @MainActor () -> RemoteComponentsPayload = {
            RemoteComponentsPayload(ompInstalled: false, ompPath: nil, setupBanner: nil)
        },
        presenceChanges: AnyPublisher<Void, Never> = Empty<Void, Never>(completeImmediately: false).eraseToAnyPublisher(),
        setupChanges: AnyPublisher<Void, Never> = Empty<Void, Never>(completeImmediately: false).eraseToAnyPublisher(),
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

        let hub = RemoteStreamHub(
            storeHub: storeHub,
            registry: self.registry,
            session: session,
            project: project,
            clock: clock,
            components: components,
            journal: { actions.journal },
            // Un changement de la présence des composants OU de l'état de
            // préparation pousse le même évènement `components` (S-4).
            componentsChanges: presenceChanges.merge(with: setupChanges).eraseToAnyPublisher(),
            journalChanges: actions.$journal.voidChanges(),
            pullRequestStates: { kanban.pullRequestStatesPayload() },
            pullRequestStatesChanges: kanban.pullRequestStatesChanges()
        )
        let reads = RemoteReads(
            hub: storeHub,
            registry: self.registry,
            service: HTTPMemoryService(config: Self.memoryConfig(environment: environment, stackEnv: paths.stackEnv)),
            memoryConfig: Self.memoryConfig(environment: environment, stackEnv: paths.stackEnv),
            memoryLinks: paths.memoryLinks,
            environment: environment,
            clock: clock,
            kanban: kanban,
            actions: actions,
            components: components
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

    /// Le geste de l'interrupteur. Couper arrête le service et son annonce Bonjour,
    /// puis annule le code actif (il ne pourra plus être échangé, même après
    /// rallumage) ; rallumer repart sur le même port.
    func setEnabled(_ on: Bool) async {
        enabled = on
        defaults.set(on, forKey: Self.enabledKey)
        if on {
            await start()
        } else {
            stop()
            registry.cancelCode()
            pairing.refresh()
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

    /// La variable qui déplace le port d'écoute (S-10) : une instance de recette
    /// lancée à côté de celle de l'utilisateur ne peut pas écouter sur 8787.
    static let portEnvironmentKey = "OMP_CONSOLE_REMOTE_PORT"

    /// Le port d'écoute : la valeur de `OMP_CONSOLE_REMOTE_PORT` si, rognée, c'est
    /// un entier de 1 à 65535 ; sinon le port par défaut du service.
    static func resolvedPort(environment: [String: String]) -> Int {
        let raw = environment[portEnvironmentKey]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard let port = Int(raw), (1...65535).contains(port) else {
            return ConsoleAPI.Service.defaultPort
        }
        return port
    }
}

/// Le modèle de la zone d'appairage (S-5, S-6) : le code affiché, son compte à
/// rebours, son échéance atteinte, et la révocation en cours.
@MainActor
final class PairingModel: ObservableObject {
    @Published private(set) var code: PairingCode?
    @Published private(set) var countdown: String?
    /// Le code affiché a atteint son échéance (« Code expiré ») — jamais quand il a
    /// été consommé par un appairage avant elle.
    @Published private(set) var expired = false
    @Published private(set) var error: String?
    @Published private(set) var revoking: Set<UUID> = []

    private let registry: DeviceRegistry
    private let clock: RemoteClock
    private var timer: Timer?
    /// Le dernier code affiché, gardé après son échéance pour que les relectures
    /// suivantes disent encore « expiré » ; oublié quand il est consommé.
    private var shown: PairingCode?

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
            expired = false
            shown = nil
            stopTimer()
            return
        } catch {
            self.error = DeviceRegistry.loadMessage("raison inconnue")
            expired = false
            return
        }
        expired = false
        refresh()
        startTimer()
    }

    /// Relit le code actif. À l'échéance, le code et le compte à rebours cèdent la
    /// place à « Code expiré » ; consommé avant, il disparaît sans mot.
    func refresh() {
        let now = clock.nowMs()
        registry.pruneExpiredCode(at: now)
        guard let active = registry.pairing.current, !active.isExpired(at: now) else {
            if let shown, now >= shown.expiresAtMs {
                expired = true
            } else {
                expired = false
                shown = nil
            }
            code = nil
            countdown = nil
            stopTimer()
            return
        }
        shown = active
        expired = false
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

extension Publisher where Failure == Never {
    /// « Quelque chose a changé », sans la valeur. La fermeture est volontairement
    /// HORS acteur : écrite dans un contexte `@MainActor` elle en hériterait, or le
    /// flux SSE consomme ces éditeurs par `.values` depuis un fil du pool coopératif
    /// et l'abonnement émet la valeur courante sur ce fil — la vérification
    /// d'isolation de Swift Concurrency fait alors planter l'app dès qu'un
    /// appareil se connecte (`_dispatch_assert_queue_fail`).
    nonisolated func voidChanges() -> AnyPublisher<Void, Never> {
        map { _ in () }.eraseToAnyPublisher()
    }
}
