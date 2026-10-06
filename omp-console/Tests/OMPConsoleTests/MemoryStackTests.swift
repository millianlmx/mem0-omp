// L'orchestration de la pile (BR-2, S-2) : reprise idempotente, recreate, erreurs
// typées — TOUT est joué par une doublure de `CommandRunner` et un `URLProtocol`
// stubé, aucun podman réel, aucune socket.
//
// La doublure est un podman SIMULÉ : il tient l'état de la machine, du réseau, des
// images et des conteneurs, et répond exactement comme le feraient les commandes
// dont `PodmanCommandTests` fige l'`argv`. C'est ce qui permet de prouver
// l'ENCHAÎNEMENT (inspect d'abord, agir ensuite) sans réseau ni VM.

import Foundation
import Testing

@testable import OMPConsole
import ConsoleCore

// MARK: - Podman simulé

/// Un podman en mémoire : les commandes de S-2 y changent un état observable.
final class FakePodman: @unchecked Sendable {
    var machinePresent = false
    var machineRunning = false
    var machineImage = ComponentManifest.current.machineImage
    var machineStartReportsAlreadyRunning = false
    /// Fait échouer l'`inspect` alors que la machine existe : le cas MESURÉ du
    /// 2026-10-05 (podman 6.1.3 rendait « json » sur `--format json`), que l'app
    /// doit surmonter au lieu d'échouer sur « machine already exists ».
    var machineInspectFails = false
    var machineInitStderr: String?
    var confPath: String?
    private(set) var confExistedAtFirstCall: Bool?
    var networks: Set<String> = []
    var images: Set<String> = []
    var containers: [String: (image: String, running: Bool)] = [:]
    var runFailures: [String: String] = [:]
    private(set) var calls: [(arguments: [String], environment: [String: String])] = []
    private(set) var machineInitCount = 0
    private(set) var machineRemoveCount = 0
    private(set) var containerRunCount = 0
    private(set) var containerRemoveCount = 0

    func runner() -> CommandRunner {
        CommandRunner { [self] _, arguments, environment, _ in
            handle(arguments: arguments, environment: environment)
        }
    }

    /// Vrai si la séquence des commandes contient ce préfixe.
    func contains(_ prefix: [String]) -> Bool {
        calls.contains { Array($0.arguments.prefix(prefix.count)) == prefix }
    }

    /// Oublie les commandes déjà émises (pour observer un passage seul).
    func resetCalls() {
        calls.removeAll()
    }

    private func handle(arguments: [String], environment: [String: String]) -> ProcessRun {
        if confExistedAtFirstCall == nil, let confPath {
            confExistedAtFirstCall = FileManager.default.fileExists(atPath: confPath)
        }
        calls.append((arguments, environment))
        switch arguments.first {
        case "machine": return machine(arguments)
        case "network": return network(arguments)
        case "image": return image(arguments)
        case "container": return container(arguments)
        case "run": return runContainer(arguments)
        default: return ok()
        }
    }

    private func machine(_ arguments: [String]) -> ProcessRun {
        switch arguments[1] {
        case "inspect":
            guard machinePresent, !machineInspectFails else { return fail(125, "Error: no such machine") }
            let state = machineRunning ? "running" : "stopped"
            return ok("""
            [{"Name":"omp-console","State":"\(state)","Running":\(machineRunning),"Image":"\(machineImage)"}]
            """)
        case "init":
            if let stderr = machineInitStderr { return fail(125, stderr) }
            machinePresent = true
            machineRunning = false
            if let index = arguments.firstIndex(of: "--image"), index + 1 < arguments.count {
                machineImage = arguments[index + 1]
            }
            machineInitCount += 1
            return ok()
        case "start":
            if machineStartReportsAlreadyRunning {
                machineRunning = true
                return fail(125, "Error: machine \"omp-console\" is already running")
            }
            machineRunning = true
            return ok()
        case "rm":
            machinePresent = false
            machineRunning = false
            machineRemoveCount += 1
            return ok()
        default:
            return ok()
        }
    }

    private func network(_ arguments: [String]) -> ProcessRun {
        switch arguments[1] {
        case "inspect":
            return networks.contains(arguments[2]) ? ok("[]") : fail(1, "Error: network not found")
        case "create":
            networks.insert(arguments[2])
            return ok()
        default:
            return ok()
        }
    }

    private func image(_ arguments: [String]) -> ProcessRun {
        switch arguments[1] {
        case "exists":
            return images.contains(arguments[2]) ? ok() : fail(1, "")
        case "pull":
            images.insert(arguments[2])
            return ok()
        case "build":
            if let index = arguments.firstIndex(of: "-t"), index + 1 < arguments.count {
                images.insert(arguments[index + 1])
            }
            return ok()
        default:
            return ok()
        }
    }

    private func container(_ arguments: [String]) -> ProcessRun {
        switch arguments[1] {
        case "inspect":
            let name = arguments[2]
            guard let container = containers[name] else { return fail(125, "Error: no such container") }
            let status = container.running ? "running" : "exited"
            return ok("""
            [{"Name":"\(name)","State":{"Running":\(container.running),"Status":"\(status)"},"ImageName":"\(container.image)"}]
            """)
        case "rm":
            containers.removeValue(forKey: arguments[3])
            containerRemoveCount += 1
            return ok()
        case "start":
            let name = arguments[2]
            guard var container = containers[name] else { return fail(125, "Error: no such container") }
            container.running = true
            containers[name] = container
            return ok()
        default:
            return ok()
        }
    }

    private func runContainer(_ arguments: [String]) -> ProcessRun {
        guard let index = arguments.firstIndex(of: "--name"), index + 1 < arguments.count else {
            return fail(125, "Error: --name manquant")
        }
        let name = arguments[index + 1]
        if let stderr = runFailures[name] { return fail(125, stderr) }
        containers[name] = (image: arguments.last ?? "", running: true)
        containerRunCount += 1
        return ok()
    }

    private func ok(_ stdout: String = "") -> ProcessRun {
        ProcessRun(code: 0, stdout: stdout, stderr: "", timedOut: false)
    }

    private func fail(_ code: Int32, _ stderr: String) -> ProcessRun {
        ProcessRun(code: code, stdout: "", stderr: stderr, timedOut: false)
    }
}

// MARK: - Bac à sable

private struct StackSandbox {
    let root: URL
    let paths: AppPaths
    let buildContext: URL

    init() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("omp-stack-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let context = root.appendingPathComponent("build-context", isDirectory: true)
        try FileManager.default.createDirectory(at: context, withIntermediateDirectories: true)
        self.root = root
        self.paths = AppPaths(supportRoot: root)
        self.buildContext = context
    }

    @MainActor
    func stack(run: CommandRunner, session: URLSession) -> MemoryStack {
        let stack = MemoryStack(paths: paths, buildContext: buildContext, session: session, run: run)
        stack.readyBudget = 2
        stack.healthBudget = 2
        stack.pollInterval = 0.01
        return stack
    }

    func remove() {
        try? FileManager.default.removeItem(at: root)
    }
}

/// La session HTTP dont `/readyz` et `/health` répondent ; un chemin non enregistré
/// échoue (connexion refusée simulée).
private func stubSession(readyz: Int = 200, health: Int = 200, healthBody: String = "{\"ok\":true}") -> URLSession {
    StubURLProtocol.reset()
    if readyz > 0 {
        StubURLProtocol.reply("/readyz", .init(status: readyz, body: Data("{}".utf8)))
    }
    if health > 0 {
        StubURLProtocol.reply("/health", .init(status: health, body: Data(healthBody.utf8)))
    }
    return StubURLProtocol.session()
}

// MARK: - AC-1 : orchestration

@MainActor
@Test("all-in-one-app/AC-1 : en partant de rien, la pile initialise la machine, crée le réseau, prépare les images, lance les conteneurs puis attend `readyz` et `/health`")
func freshRunBuildsTheWholeStack() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()
    fake.confPath = sandbox.paths.configDir.appendingPathComponent("containers/containers.conf").path
    let stack = sandbox.stack(run: fake.runner(), session: stubSession())
    var steps: [StackStep] = []

    try await stack.ensureRunning { steps.append($0) }

    #expect(steps == [.machine, .images, .containers, .health])
    #expect(fake.machineInitCount == 1)
    #expect(fake.machineRunning)
    #expect(fake.networks.contains("omp-console-stack"))
    #expect(fake.images.contains(ComponentManifest.current.qdrantImage))
    #expect(fake.images.contains(ComponentManifest.current.stackImageTag))
    #expect(fake.containers["omp-console-qdrant"]?.running == true)
    #expect(fake.containers["omp-console-mem0-http"]?.running == true)
    #expect(fake.contains(["machine", "inspect"]))
    #expect(fake.contains(["machine", "init"]))
    #expect(fake.contains(["machine", "start"]))
    #expect(fake.contains(["network", "create", "omp-console-stack"]))
    #expect(fake.contains(["image", "pull", ComponentManifest.current.qdrantImage]))
    #expect(fake.contains(["image", "build", "-t", ComponentManifest.current.stackImageTag]))
    #expect(fake.contains(["run", "-d", "--name", "omp-console-qdrant"]))
    #expect(fake.contains(["run", "-d", "--name", "omp-console-mem0-http"]))

    // Le `containers.conf` app-privé existait DÉJÀ à la première commande podman.
    #expect(fake.confExistedAtFirstCall == true)
    let conf = try String(
        contentsOf: sandbox.paths.configDir.appendingPathComponent("containers/containers.conf"),
        encoding: .utf8
    )
    let helper = sandbox.paths.podmanDir(ComponentManifest.current.podmanVersion)
        .appendingPathComponent("bin").path
    #expect(conf == "[engine]\nhelper_binaries_dir = [\"\(helper)\"]\n")

    // `machine.json` porte l'image et un horodatage ISO8601.
    let recorded = try JSONSerialization.jsonObject(
        with: Data(contentsOf: sandbox.paths.machineState)
    ) as? [String: Any]
    #expect(recorded?["image"] as? String == ComponentManifest.current.machineImage)
    let createdAt = recorded?["createdAt"] as? String ?? ""
    #expect(ISO8601DateFormatter().date(from: createdAt) != nil)
}

@MainActor
@Test("all-in-one-app/AC-1 : un second passage ne recrée rien — seules des inspections sont émises")
func secondPassIsIdempotent() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()
    let stack = sandbox.stack(run: fake.runner(), session: stubSession())
    try await stack.ensureRunning { _ in }

    fake.resetCalls()
    try await stack.ensureRunning { _ in }

    let labels = fake.calls.map { $0.arguments.prefix(2).joined(separator: " ") }
    #expect(labels == [
        "machine inspect",
        "network inspect",
        "image exists",
        "image exists",
        "container inspect",
        "container inspect",
    ])
    #expect(fake.machineInitCount == 1)
    #expect(fake.containerRunCount == 2)
    #expect(fake.containerRemoveCount == 0)
    #expect(fake.machineRemoveCount == 0)
}

@MainActor
@Test("all-in-one-app/AC-1 : un conteneur dont l'image a changé est recréé (`rm -f` puis `run`), les autres sont laissés")
func differentContainerImageIsRecreated() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()
    let stack = sandbox.stack(run: fake.runner(), session: stubSession())
    try await stack.ensureRunning { _ in }

    fake.resetCalls()
    fake.containers["omp-console-qdrant"] = (image: "docker.io/qdrant/qdrant:v1.18.0", running: true)
    try await stack.ensureRunning { _ in }

    #expect(fake.contains(["container", "rm", "-f", "omp-console-qdrant"]))
    #expect(fake.contains(["run", "-d", "--name", "omp-console-qdrant"]))
    #expect(!fake.contains(["container", "rm", "-f", "omp-console-mem0-http"]))
    #expect(!fake.contains(["run", "-d", "--name", "omp-console-mem0-http"]))
    #expect(fake.containers["omp-console-qdrant"]?.image == ComponentManifest.current.qdrantImage)
}

@MainActor
@Test("all-in-one-app/AC-1 : une machine dont l'image enregistrée diffère du manifeste est recréée (`machine rm -f` + init + start)")
func differentMachineImageIsRecreated() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()
    let stack = sandbox.stack(run: fake.runner(), session: stubSession())
    try await stack.ensureRunning { _ in }
    try Data("{\"image\":\"docker://quay.io/podman/machine-os:9.9\"}".utf8)
        .write(to: sandbox.paths.machineState)

    fake.resetCalls()
    try await stack.ensureRunning { _ in }

    #expect(fake.contains(["machine", "rm", "-f", "omp-console"]))
    #expect(fake.machineInitCount == 2)
    #expect(fake.machineRunning)
    let recorded = try JSONSerialization.jsonObject(
        with: Data(contentsOf: sandbox.paths.machineState)
    ) as? [String: Any]
    #expect(recorded?["image"] as? String == ComponentManifest.current.machineImage)
}

@MainActor
@Test("all-in-one-app/AC-1 : un `machine start` qui échoue « already running » est un succès, confirmé par l'état revérifié")
func alreadyRunningIsSuccess() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()
    fake.machinePresent = true
    fake.machineRunning = false
    fake.machineStartReportsAlreadyRunning = true
    let stack = sandbox.stack(run: fake.runner(), session: stubSession())

    try await stack.ensureRunning { _ in }

    #expect(fake.machineRunning)
    #expect(fake.machineInitCount == 0)
    #expect(fake.containers["omp-console-mem0-http"]?.running == true)
}

@MainActor
@Test("all-in-one-app/AC-1 : un `machine init` qui échoue « already exists » est un succès — la machine est gardée, enregistrée et démarrée")
func alreadyExistingIsSuccess() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()
    // La machine existe MAIS l'inspect ne la voit pas (le cas mesuré du
    // 2026-10-05 : `machine inspect --format json` rendait « json ») : l'app
    // tente `init`, qui répond « already exists » — elle doit poursuivre.
    fake.machinePresent = true
    fake.machineInspectFails = true
    fake.machineInitStderr = "Error: machine \"omp-console\" already exists"
    let stack = sandbox.stack(run: fake.runner(), session: stubSession())

    try await stack.ensureRunning { _ in }

    #expect(fake.contains(["machine", "init"]))
    #expect(fake.machineRunning)
    #expect(fake.machineInitCount == 0)
    #expect(fake.machineRemoveCount == 0)
    let recorded = try JSONSerialization.jsonObject(
        with: Data(contentsOf: sandbox.paths.machineState)
    ) as? [String: Any]
    #expect(recorded?["image"] as? String == ComponentManifest.current.machineImage)
    #expect(fake.containers[MemoryStack.mem0Container]?.running == true)
}

@MainActor
@Test("all-in-one-app/AC-1 : toute la séquence isole podman sous la racine de support (XDG privés sur CHAQUE invocation)")
func everyInvocationCarriesPrivateXDG() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()
    let stack = sandbox.stack(run: fake.runner(), session: stubSession())
    try await stack.ensureRunning { _ in }

    #expect(!fake.calls.isEmpty)
    for call in fake.calls {
        #expect(call.environment["XDG_CONFIG_HOME"] == sandbox.paths.configDir.path)
        #expect(call.environment["XDG_DATA_HOME"] == sandbox.paths.dataDir.path)
        #expect(call.environment["XDG_CONFIG_HOME"]?.hasPrefix(sandbox.paths.supportRoot.path) == true)
        #expect(call.environment["XDG_DATA_HOME"]?.hasPrefix(sandbox.paths.supportRoot.path) == true)
    }
}

@MainActor
@Test("all-in-one-app/AC-1 : `health()` est la seconde sonde seule — `{\"ok\":true}` en 200, sinon faux")
func healthIsTheMem0Probe() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()

    #expect(await sandbox.stack(run: fake.runner(), session: stubSession()).health())

    let falseBody = sandbox.stack(run: fake.runner(), session: stubSession(healthBody: "{\"ok\":false}"))
    #expect(await falseBody.health() == false)

    let serverError = sandbox.stack(run: fake.runner(), session: stubSession(health: 500))
    #expect(await serverError.health() == false)
}

// MARK: - AC-5 : aucune fermeture

@MainActor
@Test("all-in-one-app/AC-5 : la fermeture de l'app n'existe pas — aucun argv `machine stop`/`container stop` n'est jamais émis, sur toute la séquence")
func noStopCommandIsEverEmitted() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()
    let stack = sandbox.stack(run: fake.runner(), session: stubSession())
    // Premier passage, second passage (idempotent), puis recreate : la séquence
    // entière est couverte.
    try await stack.ensureRunning { _ in }
    try await stack.ensureRunning { _ in }
    fake.containers[MemoryStack.mem0Container] = (image: "autre:1", running: true)
    try await stack.ensureRunning { _ in }

    for call in fake.calls {
        #expect(!(call.arguments.count >= 2
            && ["machine", "container"].contains(call.arguments[0])
            && call.arguments[1] == "stop"))
        #expect(!call.arguments.contains("stop"))
    }
    // La pile est `restart unless-stopped` : c'est ce qui la fait survivre à ⌘Q.
    #expect(fake.calls.contains { $0.arguments.contains("unless-stopped") })
}

// MARK: - Erreurs

@MainActor
@Test("all-in-one-app/AC-1 : un `run` qui échoue « address already in use » rend `portBusy` avec le port de l'argv `-p`")
func busyPortIsReadFromArgv() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()
    // Le message cite 6334 : c'est CE port publié qui doit être nommé.
    fake.runFailures[MemoryStack.qdrantContainer] =
        "Error: cannot listen on the TCP port: listen tcp 127.0.0.1:6334: bind: address already in use"
    let stack = sandbox.stack(run: fake.runner(), session: stubSession())

    await #expect(throws: MemoryStackError.portBusy(port: 6334)) {
        try await stack.ensureRunning { _ in }
    }
}

@MainActor
@Test("all-in-one-app/AC-1 : `/readyz` qui ne répond pas dans son budget rend `healthTimeout`")
func readyzTimeoutIsReported() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()
    let stack = sandbox.stack(run: fake.runner(), session: stubSession(readyz: 0))
    stack.readyBudget = 1
    stack.pollInterval = 0.02

    await #expect(throws: MemoryStackError.healthTimeout(seconds: 1)) {
        try await stack.ensureRunning { _ in }
    }
}

@MainActor
@Test("all-in-one-app/AC-1 : `/health` qui ne répond pas dans son budget rend `healthTimeout`")
func healthTimeoutIsReported() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()
    let stack = sandbox.stack(run: fake.runner(), session: stubSession(health: 0))
    stack.healthBudget = 1
    stack.pollInterval = 0.02

    await #expect(throws: MemoryStackError.healthTimeout(seconds: 1)) {
        try await stack.ensureRunning { _ in }
    }
}

@MainActor
@Test("all-in-one-app/AC-1 : un `machine init` qui échoue rend `machineFailed` avec la sortie d'erreur")
func machineInitFailureIsNamed() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()
    fake.machineInitStderr = "Error: unable to download the machine image"
    let stack = sandbox.stack(run: fake.runner(), session: stubSession())

    await #expect(throws: MemoryStackError.machineFailed(detail: "Error: unable to download the machine image")) {
        try await stack.ensureRunning { _ in }
    }
}

@MainActor
@Test("all-in-one-app/AC-1 : le détail d'un échec de machine est borné à 300 caractères")
func machineFailureDetailIsBounded() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()
    fake.machineInitStderr = String(repeating: "x", count: 700)
    let stack = sandbox.stack(run: fake.runner(), session: stubSession())

    do {
        try await stack.ensureRunning { _ in }
        Issue.record("attendu machineFailed")
    } catch let error as MemoryStackError {
        guard case .machineFailed(let detail) = error else {
            Issue.record("attendu machineFailed, obtenu \(error)")
            return
        }
        #expect(detail.count == 300)
    }
}

@MainActor
@Test("all-in-one-app/AC-1 : sans contexte de build, la préparation rend `containerFailed` nommant mem0-http")
func missingBuildContextIsNamed() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let missing = sandbox.root.appendingPathComponent("absent", isDirectory: true)
    let stack = MemoryStack(
        paths: sandbox.paths,
        buildContext: missing,
        session: stubSession(),
        run: FakePodman().runner()
    )

    do {
        try await stack.ensureRunning { _ in }
        Issue.record("attendu containerFailed")
    } catch let error as MemoryStackError {
        guard case .containerFailed(let name, let detail) = error else {
            Issue.record("attendu containerFailed, obtenu \(error)")
            return
        }
        #expect(name == MemoryStack.mem0Container)
        #expect(detail.hasPrefix("contexte de build introuvable"))
    }
}

// MARK: - Décodage tolérant

@Test("all-in-one-app/AC-1 : `machine inspect` se décode en tableau ou en objet, tableau vide et objet vide = absente")
func machineDecodeToleratesShapes() {
    #expect(
        MemoryStack.decodeMachine("[{\"State\":\"running\",\"Image\":\"img\"}]")
            == MachineState(running: true, image: "img")
    )
    #expect(MemoryStack.decodeMachine("{\"Running\":true}") == MachineState(running: true, image: nil))
    #expect(MemoryStack.decodeMachine("{\"State\":\"stopped\"}") == MachineState(running: false, image: nil))
    #expect(MemoryStack.decodeMachine("[]") == nil)
    #expect(MemoryStack.decodeMachine("{}") == nil)
    #expect(MemoryStack.decodeMachine("pas du json") == nil)
}

@Test("all-in-one-app/AC-1 : `container inspect` lit l'image (`ImageName`, `Config.Image`) et l'état")
func containerDecodeToleratesShapes() {
    #expect(
        MemoryStack.decodeContainer("[{\"State\":{\"Running\":true,\"Status\":\"running\"},\"ImageName\":\"img:1\"}]")
            == ContainerState(running: true, image: "img:1")
    )
    #expect(
        MemoryStack.decodeContainer("{\"State\":{\"Status\":\"exited\"},\"Config\":{\"Image\":\"cfg:1\"}}")
            == ContainerState(running: false, image: "cfg:1")
    )
    #expect(MemoryStack.decodeContainer("[]") == nil)
}
