// La pile mémoire de l'app (S-2, BR-2) : une machine podman DÉDIÉE et deux
// conteneurs, garantis par l'app et survivant à sa fermeture.
//
// Tout ce que cette classe fait est déterministe et REPRENABLE : chaque étape
// inspecte d'abord, n'agit que si nécessaire, et une seconde exécution ne recrée
// rien (idempotence). Aucun site d'arrêt n'existe : ni la machine ni les
// conteneurs ne sont arrêtés — les conteneurs sont `restart unless-stopped` et les
// processus `krunkit`/`gvproxy` lancés par des invocations podman courtes
// survivent à l'app (AC-5, mesuré : la publication de port est tenue par gvproxy).
//
// L'ISOLATION est portée par deux choses, jamais optionnelles : l'environnement
// XDG privé de CHAQUE invocation (`PodmanCommand.environment`) et le
// `containers.conf` app-privé écrit AVANT toute commande machine. Sans elles,
// l'app toucherait la machine podman du système (mesuré : `machine list` ne voit
// aucune machine système quand les XDG sont dédiés).

import Foundation

/// L'étape en cours de `ensureRunning`, publiée à l'appelant (S-5 la traduit en
/// ligne de feuille).
enum StackStep: Equatable, Sendable {
    case machine
    case images
    case containers
    case health
}

/// Les échecs de la pile (S-2), chacun porteur de son contexte : le message
/// utilisateur est construit par `SetupText` (S-5), jamais ici.
enum MemoryStackError: Error, Equatable, Sendable {
    case podmanFailed(command: String, detail: String)
    case machineFailed(detail: String)
    case portBusy(port: Int)
    case containerFailed(name: String, detail: String)
    case healthTimeout(seconds: Int)
}

/// L'état décodé d'une machine, tolérant aux formes de `machine inspect`.
struct MachineState: Equatable, Sendable {
    var running: Bool
    var image: String?
}

/// L'état décodé d'un conteneur, tolérant aux formes de `container inspect`.
struct ContainerState: Equatable, Sendable {
    var running: Bool
    var image: String?
}

@MainActor
final class MemoryStack {
    nonisolated static let machineName = "omp-console"
    nonisolated static let networkName = "omp-console-stack"
    nonisolated static let qdrantContainer = "omp-console-qdrant"
    nonisolated static let mem0Container = "omp-console-mem0-http"

    /// La sonde de disponibilité de Qdrant (`GET /readyz`, S-2).
    nonisolated static var qdrantReadyURL: URL {
        URL(string: "http://127.0.0.1:\(PodmanCommand.qdrantHostPorts[0])/readyz")!
    }

    /// La sonde de disponibilité du service mem0 (`GET /health`, S-2).
    nonisolated static var mem0HealthURL: URL {
        URL(string: "http://127.0.0.1:\(PodmanCommand.mem0HostPort)/health")!
    }

    // MARK: - Réglages internes (les tests les raccourcissent)

    /// Budget d'attente de `/readyz` — 90 s en production (S-2).
    var readyBudget: Double = 90
    /// Budget d'attente de `/health` — 180 s en production (S-2).
    var healthBudget: Double = 180
    /// Intervalle entre deux sondes — 2 s en production (S-2).
    var pollInterval: Double = 2
    /// L'environnement de base de chaque invocation podman (`XDG_*` ajoutés).
    var baseEnvironment: [String: String] = ProcessInfo.processInfo.environment
    /// Délai maximal d'UNE invocation podman : `machine init` télécharge ~895 Mo
    /// (mesuré) et `image build` cuit un modèle — un plafond court les tuerait.
    var commandTimeout: Double = 3600
    /// Délai maximal d'UNE sonde HTTP.
    var probeTimeout: Double = 5

    private let paths: AppPaths
    private let manifest: ComponentManifest
    private let buildContext: URL
    private let session: URLSession
    private let run: CommandRunner
    private let fileManager = FileManager.default

    init(
        paths: AppPaths,
        manifest: ComponentManifest = .current,
        buildContext: URL,
        session: URLSession = .shared,
        run: CommandRunner = CommandRunner.live
    ) {
        self.paths = paths
        self.manifest = manifest
        self.buildContext = buildContext
        self.session = session
        self.run = run
    }

    /// Le binaire podman de l'app — jamais celui du système (B-3, S-1).
    private var podman: URL {
        paths.podmanDir(manifest.podmanVersion).appendingPathComponent("bin/podman")
    }

    // MARK: - Entrée

    /// Garantit que la pile tourne : dossiers et `containers.conf`, machine,
    /// réseau, images, conteneurs, puis disponibilité (`/readyz` et `/health`).
    func ensureRunning(progress: @escaping @MainActor (StackStep) -> Void) async throws {
        // 1. Le support d'abord : le `containers.conf` app-privé doit exister
        // AVANT toute commande machine (S-2), sinon `machine start` ne trouverait
        // ni gvproxy ni krunkit.
        try prepareSupportDirectories()
        let config = StackEnvStore.load(at: paths.stackEnv) ?? .defaults

        progress(.machine)
        try await ensureMachine()

        // Le réseau appartient à la préparation de l'infrastructure de la pile.
        progress(.images)
        try await ensureNetwork()
        try await ensureImages()

        progress(.containers)
        try await ensureContainers(config: config)

        progress(.health)
        try await awaitStackReady(config: config)
    }

    /// La seconde sonde de S-2 seule : `GET http://127.0.0.1:8321/health` →
    /// `{"ok":true}`. Un état, jamais une exception.
    func health() async -> Bool {
        guard let result = await probe(Self.mem0HealthURL, headers: [:]) else { return false }
        return Self.isMem0Healthy(result)
    }

    // MARK: - Dossiers et configuration

    private func prepareSupportDirectories() throws {
        do {
            try fileManager.createDirectory(at: paths.stackRoot, withIntermediateDirectories: true)
            let containersDir = paths.configDir
                .appendingPathComponent("containers", isDirectory: true)
            try fileManager.createDirectory(at: containersDir, withIntermediateDirectories: true)
            let helperBinariesDir = paths.podmanDir(manifest.podmanVersion)
                .appendingPathComponent("bin", isDirectory: true)
            let content = PodmanCommand.containersConf(helperBinariesDir: helperBinariesDir)
            try Data(content.utf8).write(
                to: containersDir.appendingPathComponent("containers.conf"),
                options: [.atomic]
            )
        } catch {
            // Aucune commande podman n'a encore été émise : le plus proche dans
            // l'enum figé est l'échec de la machine, qu'aucune configuration
            // valide ne permettrait de démarrer.
            throw MemoryStackError.machineFailed(
                detail: "configuration de podman non inscriptible : \(bounded(error.localizedDescription))"
            )
        }
    }

    // MARK: - Machine

    private func ensureMachine() async throws {
        if let state = await machineState() {
            let recorded = readRecordedMachineImage() ?? state.image
            let matches = recorded.map { PodmanCommand.sameImage($0, manifest.machineImage) } ?? false
            if !matches {
                // L'image du manifeste a changé (mise à jour de l'app) : la machine
                // est recréée — ses conteneurs sont recréés à l'étape suivante.
                try await performMachine(PodmanCommand.machineRemove(Self.machineName))
                try await initializeMachine()
            } else if !state.running {
                try await startMachine()
            }
            return
        }
        try await initializeMachine()
    }

    /// `machine init` puis l'état enregistré puis `machine start` : une machine
    /// initialisée est arrêtée, et les conteneurs ont besoin qu'elle tourne.
    ///
    /// Un `init` qui répond « already exists » n'est PAS un échec : la machine
    /// existe (créée par un autre passage, ou restée invisible pour l'`inspect`
    /// qui précède) et S-2 veut la garder — même tolérance que « already running »
    /// pour `start`. La suite décide à partir de l'état réel, pas du message.
    private func initializeMachine() async throws {
        let arguments = PodmanCommand.machineInit(Self.machineName, image: manifest.machineImage)
        let result: ProcessRun
        do {
            result = try await invoke(arguments)
        } catch {
            throw MemoryStackError.machineFailed(detail: bounded(error.localizedDescription))
        }
        if result.code != 0 {
            let detail = bounded(result.stderr.isEmpty ? result.stdout : result.stderr)
            guard Self.isAlreadyExisting(detail) else {
                throw MemoryStackError.machineFailed(detail: detail)
            }
        }
        try writeMachineState()
        try await startMachine()
    }

    private func startMachine() async throws {
        let arguments = PodmanCommand.machineStart(Self.machineName)
        let result: ProcessRun
        do {
            result = try await invoke(arguments)
        } catch {
            throw MemoryStackError.machineFailed(detail: bounded(error.localizedDescription))
        }
        if result.code == 0 { return }
        let detail = bounded(result.stderr.isEmpty ? result.stdout : result.stderr)
        // « already running » : un autre processus a démarré la machine — succès,
        // à condition que l'état REVÉRIFIÉ le confirme (S-2).
        if Self.isAlreadyRunning(detail), let state = await machineState(), state.running {
            return
        }
        throw MemoryStackError.machineFailed(detail: detail)
    }

    @discardableResult
    private func performMachine(_ arguments: [String]) async throws -> ProcessRun {
        let result: ProcessRun
        do {
            result = try await invoke(arguments)
        } catch {
            throw MemoryStackError.machineFailed(detail: bounded(error.localizedDescription))
        }
        guard result.code == 0 else {
            throw MemoryStackError.machineFailed(
                detail: bounded(result.stderr.isEmpty ? result.stdout : result.stderr)
            )
        }
        return result
    }

    private func machineState() async -> MachineState? {
        let arguments = PodmanCommand.machineInspect(Self.machineName)
        guard let result = try? await invoke(arguments), result.code == 0 else { return nil }
        return Self.decodeMachine(result.stdout)
    }

    /// L'image de machine retenue au dernier `machine init` (S-2) ; `nil` si le
    /// fichier est absent ou illisible.
    private func readRecordedMachineImage() -> String? {
        guard let data = try? Data(contentsOf: paths.machineState),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any]
        else { return nil }
        return dictionary["image"] as? String
    }

    private func writeMachineState() throws {
        let object: [String: Any] = [
            "image": manifest.machineImage,
            "createdAt": Self.timestamp(),
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
            try fileManager.createDirectory(at: paths.stackRoot, withIntermediateDirectories: true)
            try data.write(to: paths.machineState, options: [.atomic])
        } catch {
            throw MemoryStackError.machineFailed(
                detail: "état de machine non inscriptible : \(bounded(error.localizedDescription))"
            )
        }
    }

    // MARK: - Réseau

    private func ensureNetwork() async throws {
        let inspect = PodmanCommand.networkInspect(Self.networkName)
        if let result = try? await invoke(inspect), result.code == 0 { return }
        try await runSucceeding(PodmanCommand.networkCreate(Self.networkName), toleratingAlreadyExists: true)
    }

    // MARK: - Images

    private func ensureImages() async throws {
        // Le contexte de build est embarqué dans le bundle (S-1) ; sans lui,
        // l'image mem0-http n'est pas constructible — on le dit AVANT de tirer ou
        // de construire quoi que ce soit.
        guard isDirectory(buildContext) else {
            throw MemoryStackError.containerFailed(
                name: Self.mem0Container,
                detail: "contexte de build introuvable (\(buildContext.path))"
            )
        }
        if !(await imageExists(manifest.qdrantImage)) {
            try await runSucceeding(PodmanCommand.imagePull(manifest.qdrantImage))
        }
        if !(await imageExists(manifest.stackImageTag)) {
            try await runSucceeding(
                PodmanCommand.imageBuild(tag: manifest.stackImageTag, context: buildContext)
            )
        }
    }

    private func imageExists(_ reference: String) async -> Bool {
        guard let result = try? await invoke(PodmanCommand.imageExists(reference)) else { return false }
        return result.code == 0
    }

    // MARK: - Conteneurs

    private func ensureContainers(config: StackConfig) async throws {
        try await ensureContainer(
            name: Self.qdrantContainer,
            image: manifest.qdrantImage,
            arguments: PodmanCommand.qdrantRun(
                name: Self.qdrantContainer,
                image: manifest.qdrantImage,
                network: Self.networkName,
                storage: paths.qdrantStorage,
                apiKey: config.qdrantApiKey
            )
        )
        try await ensureContainer(
            name: Self.mem0Container,
            image: manifest.stackImageTag,
            arguments: PodmanCommand.mem0Run(
                name: Self.mem0Container,
                image: manifest.stackImageTag,
                network: Self.networkName,
                qdrantHost: Self.qdrantContainer,
                config: config
            )
        )
    }

    private func ensureContainer(name: String, image: String, arguments: [String]) async throws {
        guard let state = await containerState(name) else {
            try await createContainer(name: name, arguments: arguments)
            return
        }
        if !PodmanCommand.sameImage(state.image ?? "", image) {
            // Image différente : recreate (S-2).
            try await runSucceeding(PodmanCommand.containerRemove(name))
            try await createContainer(name: name, arguments: arguments)
            return
        }
        if state.running { return }
        // Présent, arrêté, bonne image : `start` ; si `start` échoue, `run` neuf
        // après `rm -f` (S-2).
        if let result = try? await invoke(PodmanCommand.containerStart(name)), result.code == 0 { return }
        try await runSucceeding(PodmanCommand.containerRemove(name))
        try await createContainer(name: name, arguments: arguments)
    }

    private func createContainer(name: String, arguments: [String]) async throws {
        let result: ProcessRun
        do {
            result = try await invoke(arguments)
        } catch {
            throw MemoryStackError.containerFailed(name: name, detail: bounded(error.localizedDescription))
        }
        guard result.code != 0 else { return }
        let detail = bounded(result.stderr.isEmpty ? result.stdout : result.stderr)
        if Self.isAddressInUse(detail),
           let port = Self.busyPort(in: detail, ports: PodmanCommand.publishedPorts(in: arguments)) {
            throw MemoryStackError.portBusy(port: port)
        }
        throw MemoryStackError.containerFailed(name: name, detail: detail)
    }

    private func containerState(_ name: String) async -> ContainerState? {
        guard let result = try? await invoke(PodmanCommand.containerInspect(name)), result.code == 0 else {
            return nil
        }
        return Self.decodeContainer(result.stdout)
    }

    // MARK: - Attentes

    private func awaitStackReady(config: StackConfig) async throws {
        let ready = await waitUntil(
            url: Self.qdrantReadyURL,
            headers: ["api-key": config.qdrantApiKey],
            budget: readyBudget
        ) { $0.status == 200 }
        guard ready else {
            throw MemoryStackError.healthTimeout(seconds: Self.seconds(readyBudget))
        }

        let healthy = await waitUntil(
            url: Self.mem0HealthURL,
            headers: [:],
            budget: healthBudget,
            accept: Self.isMem0Healthy
        )
        guard healthy else {
            throw MemoryStackError.healthTimeout(seconds: Self.seconds(healthBudget))
        }
    }

    private func waitUntil(
        url: URL,
        headers: [String: String],
        budget: Double,
        accept: @escaping ((status: Int, body: Data)) -> Bool
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(budget)
        while true {
            if let result = await probe(url, headers: headers), accept(result) { return true }
            if Date() >= deadline { return false }
            try? await Task.sleep(for: .seconds(pollInterval))
        }
    }

    private func probe(_ url: URL, headers: [String: String]) async -> (status: Int, body: Data)? {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = probeTimeout
        for (key, value) in headers where !value.isEmpty {
            request.setValue(value, forHTTPHeaderField: key)
        }
        guard let (data, response) = try? await session.data(for: request),
              let http = response as? HTTPURLResponse
        else { return nil }
        return (http.statusCode, data)
    }

    // MARK: - Exécution podman

    private func invoke(_ arguments: [String]) async throws -> ProcessRun {
        let environment = PodmanCommand.environment(base: baseEnvironment, paths: paths)
        return try await run(podman, arguments, environment, commandTimeout)
    }

    @discardableResult
    private func runSucceeding(_ arguments: [String], toleratingAlreadyExists: Bool = false) async throws
        -> ProcessRun
    {
        let result: ProcessRun
        do {
            result = try await invoke(arguments)
        } catch {
            throw MemoryStackError.podmanFailed(
                command: PodmanCommand.label(of: arguments),
                detail: bounded(error.localizedDescription)
            )
        }
        guard result.code != 0 else { return result }
        let detail = bounded(result.stderr.isEmpty ? result.stdout : result.stderr)
        // « already exists » : un autre passage a créé la ressource — succès.
        if toleratingAlreadyExists, Self.isAlreadyExisting(detail) { return result }
        throw MemoryStackError.podmanFailed(command: PodmanCommand.label(of: arguments), detail: detail)
    }

    // MARK: - Décodage tolérant et petits utilitaires

    /// Décode `machine inspect` : tableau (forme réelle) ou objet, champs `State`,
    /// `Running`, `Image` ; un tableau vide ou un objet vide = machine ABSENTE
    /// (S-2 : « un exit ≠ 0 ou un tableau vide = absente »).
    nonisolated static func decodeMachine(_ text: String) -> MachineState? {
        guard let dictionary = firstObject(text) else { return nil }
        let running: Bool
        if let flag = dictionary["Running"] as? Bool {
            running = flag
        } else if let state = dictionary["State"] as? String {
            running = state.lowercased() == "running"
        } else {
            running = false
        }
        return MachineState(running: running, image: dictionary["Image"] as? String)
    }

    /// Décode `container inspect` : l'image peut vivre en `ImageName`,
    /// `Config.Image` ou `Image` selon la forme, l'état en `State.Running` ou
    /// `State.Status` (formes podman).
    nonisolated static func decodeContainer(_ text: String) -> ContainerState? {
        guard let dictionary = firstObject(text) else { return nil }
        let running: Bool
        if let state = dictionary["State"] as? [String: Any] {
            if let flag = state["Running"] as? Bool {
                running = flag
            } else if let status = state["Status"] as? String {
                running = status.lowercased() == "running"
            } else {
                running = false
            }
        } else if let status = dictionary["State"] as? String {
            running = status.lowercased() == "running"
        } else {
            running = false
        }
        let config = dictionary["Config"] as? [String: Any]
        let image = (dictionary["ImageName"] as? String)
            ?? (config?["Image"] as? String)
            ?? (dictionary["Image"] as? String)
        return ContainerState(running: running, image: image)
    }

    /// Le premier objet d'un JSON qui peut être un tableau ou un objet ; `nil` si
    /// la forme est vide ou illisible.
    nonisolated private static func firstObject(_ text: String) -> [String: Any]? {
        guard let raw = try? JSONSerialization.jsonObject(
            with: Data(text.utf8),
            options: [.fragmentsAllowed]
        ) else { return nil }
        let dictionary: [String: Any]?
        if let array = raw as? [Any] {
            dictionary = array.first as? [String: Any]
        } else {
            dictionary = raw as? [String: Any]
        }
        guard let result = dictionary, !result.isEmpty else { return nil }
        return result
    }

    nonisolated static func isAlreadyRunning(_ detail: String) -> Bool {
        detail.lowercased().contains("already running")
    }

    nonisolated static func isAlreadyExisting(_ detail: String) -> Bool {
        detail.lowercased().contains("already exists")
    }

    nonisolated static func isAddressInUse(_ detail: String) -> Bool {
        let lowered = detail.lowercased()
        return lowered.contains("address already in use") || lowered.contains("port is already allocated")
    }

    /// Le port à nommer : celui que le message cite s'il est l'un des ports
    /// publiés, sinon le premier publié (S-2 : « port lu de l'argv `-p` du
    /// conteneur concerné »).
    nonisolated static func busyPort(in detail: String, ports: [Int]) -> Int? {
        for port in ports where detail.contains(":\(port)") || detail.contains(" \(port)") {
            return port
        }
        return ports.first
    }

    nonisolated static func isMem0Healthy(_ result: (status: Int, body: Data)) -> Bool {
        guard result.status == 200,
              let raw = try? JSONSerialization.jsonObject(
                  with: result.body,
                  options: [.fragmentsAllowed]
              ),
              let object = raw as? [String: Any]
        else { return false }
        if let ok = object["ok"] as? Bool { return ok }
        if let ok = object["ok"] as? NSNumber { return ok.boolValue }
        return false
    }

    private func bounded(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.count <= 300 ? trimmed : String(trimmed.prefix(300))
    }

    private func isDirectory(_ url: URL) -> Bool {
        var flag: ObjCBool = false
        let exists = fileManager.fileExists(atPath: url.path, isDirectory: &flag)
        return exists && flag.boolValue
    }

    private static func seconds(_ budget: Double) -> Int {
        Int(budget.rounded(.up))
    }

    private static func timestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: Date())
    }
}
