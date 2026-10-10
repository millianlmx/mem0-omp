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
    /// Le `TMPDIR` privé attendu (S-1) : sa présence à la PREMIÈRE invocation est
    /// consignée, comme celle du `containers.conf`.
    var tmpPath: String?
    private(set) var tmpExistedAtFirstCall: Bool?
    /// L'API de la machine (S-3) : `info` échoue aussitôt.
    var infoFails = false
    /// `info` échoue tant que la machine TOURNE — le cas « VM vivante, forwarder
    /// mort » (S-3) ; un `machine stop` réussi le lève, comme le vrai forwarder.
    var infoFailsWhileRunning = false
    var networks: Set<String> = []
    var images: Set<String> = []
    var containers: [String: (image: String, running: Bool)] = [:]
    /// L'environnement (`KEY=VALUE`) de chaque conteneur, alimenté par `run` et
    /// relu par `container inspect` (S-4).
    var containerEnvironment: [String: [String]] = [:]
    var runFailures: [String: String] = [:]
    /// Les enregistrements `lsof -F pcn` par port (S-2) ; un port absent n'est
    /// écouté par personne.
    var lsofRecords: [Int: String] = [:]
    /// Les lignes `ps -p <pid> -o command=` par PID (S-2).
    var processCommands: [Int32: String] = [:]
    /// La charge de `GET /containers/json?all=true` rendue par le socket Docker
    /// (S-2/S-6) ; `nil` = aucun socket ne répond.
    var dockerContainersJSON: String?
    private(set) var calls: [(arguments: [String], environment: [String: String])] = []
    private(set) var machineInitCount = 0
    private(set) var machineRemoveCount = 0
    private(set) var machineStopCount = 0
    private(set) var containerRunCount = 0
    private(set) var containerRemoveCount = 0

    /// Le texte MESURÉ d'une API injoignable (Documentation podman 6.1.3).
    static let infoUnreachable = """
    Cannot connect to Podman. Please verify your connection to the Linux system using `podman system connection list`, or try `podman machine init` and `podman machine start` to manage a new Linux VM
    Error: unable to connect to Podman socket: Get "http://d/v6.1.3/libpod/_ping": dial unix /tmp/nonexistent.sock: connect: no such file or directory
    """

    func runner() -> CommandRunner {
        CommandRunner { [self] binary, arguments, environment, _ in
            handle(binary: binary, arguments: arguments, environment: environment)
        }
    }

    /// Vrai si la séquence des commandes contient ce préfixe.
    func contains(_ prefix: [String]) -> Bool {
        calls.contains { Array($0.arguments.prefix(prefix.count)) == prefix }
    }

    /// Les invocations PODMAN seules : `lsof`, `ps` et `curl` passent par le même
    /// `CommandRunner` mais ne portent ni l'`argv` podman ni son environnement.
    var podmanCalls: [(arguments: [String], environment: [String: String])] {
        calls.filter { !($0.arguments.first ?? "").hasPrefix("-") }
    }

    /// Oublie les commandes déjà émises (pour observer un passage seul).
    func resetCalls() {
        calls.removeAll()
    }

    private func handle(binary: URL, arguments: [String], environment: [String: String]) -> ProcessRun {
        if confExistedAtFirstCall == nil, let confPath {
            confExistedAtFirstCall = FileManager.default.fileExists(atPath: confPath)
        }
        if tmpExistedAtFirstCall == nil, let tmpPath {
            tmpExistedAtFirstCall = FileManager.default.fileExists(atPath: tmpPath)
        }
        calls.append((arguments, environment))
        // Les sondes S-2/S-6 passent par le même runner : elles sont reconnues par
        // le CHEMIN du binaire, comme en production (constantes absolues).
        if binary.path == "/usr/sbin/lsof" { return lsof(arguments) }
        if binary.path == "/bin/ps" { return ps(arguments) }
        if arguments.first == "--silent" { return curl(arguments) }
        switch arguments.first {
        case "machine": return machine(arguments)
        case "network": return network(arguments)
        case "image": return image(arguments)
        case "container": return container(arguments)
        case "run": return runContainer(arguments)
        case "info": return info()
        default: return ok()
        }
    }

    /// `lsof -nP -iTCP:<port> -sTCP:LISTEN -F pcn` : un enregistrement par port,
    /// sortie 1 si personne n'écoute (ce n'est pas une erreur pour l'appelant).
    private func lsof(_ arguments: [String]) -> ProcessRun {
        for argument in arguments where argument.hasPrefix("-iTCP:") {
            let port = Int(argument.dropFirst("-iTCP:".count)) ?? 0
            if let record = lsofRecords[port] { return ok(record) }
            return fail(1, "")
        }
        return fail(1, "")
    }

    private func ps(_ arguments: [String]) -> ProcessRun {
        guard let index = arguments.firstIndex(of: "-p"), index + 1 < arguments.count,
              let pid = Int32(arguments[index + 1])
        else { return fail(1, "") }
        guard let command = processCommands[pid] else { return fail(1, "") }
        return ok(command + "\n")
    }

    /// `curl … <url>` : seul `GET /containers/json?all=true` est scriptable.
    private func curl(_ arguments: [String]) -> ProcessRun {
        if let json = dockerContainersJSON, arguments.last?.contains("/containers/json") == true {
            return ok(json)
        }
        return ok()
    }

    /// `info` : joignable SEULEMENT si la machine tourne et que rien ne le fait
    /// échouer (S-3).
    private func info() -> ProcessRun {
        if infoFails { return fail(125, Self.infoUnreachable) }
        if infoFailsWhileRunning, machineRunning { return fail(125, Self.infoUnreachable) }
        return machineRunning ? ok("{\"host\":{}}") : fail(125, Self.infoUnreachable)
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
        case "stop":
            // L'arrêt de la RÉPARATION (S-3) : la VM s'éteint, le forwarder aussi.
            machineRunning = false
            machineStopCount += 1
            infoFailsWhileRunning = false
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
            let env = (containerEnvironment[name] ?? []).map { "\"\($0)\"" }.joined(separator: ",")
            return ok("""
            [{"Name":"\(name)","State":{"Running":\(container.running),"Status":"\(status)"},"ImageName":"\(container.image)","Config":{"Image":"\(container.image)","Env":[\(env)]}}]
            """)
        case "rm":
            containers.removeValue(forKey: arguments[3])
            containerEnvironment.removeValue(forKey: arguments[3])
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
        // L'environnement du conteneur naît de ses `-e` : c'est lui que `inspect`
        // relira (S-4), donc un conteneur créé par `run` porte bien son jeton.
        var environment: [String] = []
        var cursor = 0
        while cursor < arguments.count {
            if arguments[cursor] == "-e", cursor + 1 < arguments.count {
                environment.append(arguments[cursor + 1])
                cursor += 2
                continue
            }
            cursor += 1
        }
        containers[name] = (image: arguments.last ?? "", running: true)
        containerEnvironment[name] = environment
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

struct StackSandbox {
    let root: URL
    let paths: AppPaths
    let buildContext: URL

    /// Le jeton d'installation FIGÉ du bac à sable (S-4) : la doublure `/health`
    /// le rend tel quel, donc la pile y est reconnue.
    static let token = String(repeating: "a", count: 64)
    /// L'empreinte des sources embarquées FIGÉE (S-7) : l'étiquette de l'image en
    /// dérive.
    static let fingerprint = String(repeating: "c", count: 64)

    /// L'étiquette d'image attendue pour l'empreinte du bac à sable.
    var stackTag: String {
        ComponentManifest.current.stackImageTag(fingerprint: Self.fingerprint)
    }

    init() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("omp-stack-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let context = root.appendingPathComponent("build-context", isDirectory: true)
        try FileManager.default.createDirectory(at: context, withIntermediateDirectories: true)
        self.root = root
        self.paths = AppPaths(supportRoot: root)
        self.buildContext = context
        // L'empreinte embarquée : sans elle, la préparation refuse de construire
        // (S-7).
        try Data((Self.fingerprint + "\n").utf8)
            .write(to: context.appendingPathComponent(StackSources.fingerprintFileName))
        // Le jeton d'installation : écrit AVANT toute préparation, comme le ferait
        // un premier passage.
        try FileManager.default.createDirectory(at: paths.stackRoot, withIntermediateDirectories: true)
        try Data((Self.token + "\n").utf8).write(to: paths.installationToken)
    }

    @MainActor
    func stack(run: CommandRunner, session: URLSession) -> MemoryStack {
        let stack = MemoryStack(paths: paths, buildContext: buildContext, session: session, run: run)
        stack.readyBudget = 2
        stack.healthBudget = 2
        stack.pollInterval = 0.01
        stack.apiBudget = 0.05
        // Le HOME du bac à sable : les replis disque (S-6/S-8) ne doivent JAMAIS
        // lire la machine de référence.
        stack.baseEnvironment = ["HOME": root.path]
        return stack
    }

    func remove() {
        try? FileManager.default.removeItem(at: root)
    }
}

/// La session HTTP dont `/readyz` et `/health` répondent ; un chemin non enregistré
/// échoue (connexion refusée simulée). Le corps `/health` par défaut porte le jeton
/// du bac à sable (S-4) : un `200` nu n'est plus accepté.
func stubSession(
    readyz: Int = 200,
    health: Int = 200,
    healthBody: String = "{\"ok\":true,\"installation\":\"\(StackSandbox.token)\"}"
) -> URLSession {
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

    #expect(steps == [.machine, .images, .containers, .health, .union])
    #expect(fake.machineInitCount == 1)
    #expect(fake.machineRunning)
    #expect(fake.networks.contains("omp-console-stack"))
    #expect(fake.images.contains(ComponentManifest.current.qdrantImage))
    #expect(fake.images.contains(sandbox.stackTag))
    #expect(fake.containers["omp-console-qdrant"]?.running == true)
    #expect(fake.containers["omp-console-mem0-http"]?.running == true)
    #expect(fake.contains(["machine", "inspect"]))
    #expect(fake.contains(["machine", "init"]))
    #expect(fake.contains(["machine", "start"]))
    #expect(fake.contains(["network", "create", "omp-console-stack"]))
    #expect(fake.contains(["image", "pull", ComponentManifest.current.qdrantImage]))
    #expect(fake.contains(["image", "build", "-t", sandbox.stackTag]))
    #expect(fake.contains(["run", "-d", "--name", "omp-console-qdrant"]))
    #expect(fake.contains(["run", "-d", "--name", "omp-console-mem0-http"]))
    // Le conteneur mem0 naît avec le jeton d'installation (S-4).
    #expect(
        fake.containerEnvironment["omp-console-mem0-http"]?
            .contains("OMP_INSTALLATION_TOKEN=\(StackSandbox.token)") == true
    )

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

    // Les sondes de la machine (`info`) et des ports (`lsof`) s'intercalent : on ne
    // compare que les invocations podman, dans leur ordre.
    let labels = fake.podmanCalls.map { $0.arguments.prefix(2).joined(separator: " ") }
    #expect(labels == [
        "machine inspect",
        "info",
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

    #expect(!fake.podmanCalls.isEmpty)
    for call in fake.podmanCalls {
        #expect(call.environment["XDG_CONFIG_HOME"] == sandbox.paths.configDir.path)
        #expect(call.environment["XDG_DATA_HOME"] == sandbox.paths.dataDir.path)
        #expect(call.environment["XDG_CONFIG_HOME"]?.hasPrefix(sandbox.paths.supportRoot.path) == true)
        #expect(call.environment["XDG_DATA_HOME"]?.hasPrefix(sandbox.paths.supportRoot.path) == true)
        // S-1 : le TMPDIR privé est ÉCRASÉ, jamais celui du process.
        #expect(call.environment["TMPDIR"] == sandbox.paths.tmpDir.path)
        #expect(call.environment["TMPDIR"] != ProcessInfo.processInfo.environment["TMPDIR"])
    }
}

@MainActor
@Test("bug-embedded-podman-machine/AC-4 : `health()` accepte SEULEMENT la réponse qui porte le jeton d'installation — un 200 nu est refusé")
func healthIsTheMem0Probe() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()

    #expect(await sandbox.stack(run: fake.runner(), session: stubSession()).health())

    // Le `200` nu (sans champ `installation`) n'est PAS la pile de l'app (S-4).
    let bare = sandbox.stack(run: fake.runner(), session: stubSession(healthBody: "{\"ok\":true}"))
    #expect(await bare.health() == false)

    // Un jeton différent est un autre service.
    let foreign = sandbox.stack(
        run: fake.runner(),
        session: stubSession(healthBody: "{\"ok\":true,\"installation\":\"\(String(repeating: "b", count: 64))\"}")
    )
    #expect(await foreign.health() == false)

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
@Test("bug-embedded-podman-machine/AC-1 : un `run` refusé pour port occupé rend `portConflict` nommant le processus étranger (sonde lsof/ps)")
func busyPortIsNamedByTheProbe() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()
    // Le message cite 6334 : c'est CE port publié qui doit être nommé.
    fake.runFailures[MemoryStack.qdrantContainer] =
        "Error: cannot listen on the TCP port: listen tcp 127.0.0.1:6334: bind: address already in use"
    // La sonde S-2 désigne un vrai étranger : lsof donne le PID et le nom, ps la
    // ligne de commande complète (qui ne vit PAS sous la racine de l'app).
    fake.lsofRecords[6334] = "p4711\ncpython3\nf3\nn127.0.0.1:6334\n"
    fake.processCommands[4711] = "/usr/bin/python3 -m http.server 6334"
    let stack = sandbox.stack(run: fake.runner(), session: stubSession())

    await #expect(
        throws: MemoryStackError.portConflict(
            port: 6334,
            owner: .foreign(process: "python3", pid: 4711)
        )
    ) {
        try await stack.ensureRunning { _ in }
    }

    // Le diagnostic copiable nomme le propriétaire et le geste (S-2) ; la feuille,
    // elle, n'affiche que la conséquence (jargon-technique-expose-mac-et-ios S-5).
    let failure = SetupFailure.stack(.portConflict(port: 6334, owner: .foreign(process: "python3", pid: 4711)))
    let diagnostic = SetupText.failureDiagnostic(failure)
    #expect(diagnostic.contains("Le port 6334 est déjà tenu par un autre programme (python3, pid 4711)"))
    #expect(diagnostic.contains("Geste : arrêtez le programme qui tient le port"))
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

// MARK: - AC-1 (porte), AC-2 (réparation), AC-3 (TMPDIR), AC-4 (identité), AC-7/8 (empreinte)

@MainActor
@Test("bug-embedded-podman-machine/AC-1 : un port tenu par un étranger fait échouer la préparation — jamais « prêt » sans la pile")
func foreignPortBlocksReadiness() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()
    fake.lsofRecords[8321] = "p4711\ncpython3\nf4\nn127.0.0.1:8321\n"
    fake.processCommands[4711] = "/usr/bin/python3 -m http.server 8321"
    let stack = sandbox.stack(run: fake.runner(), session: stubSession())

    await #expect(
        throws: MemoryStackError.portConflict(
            port: 8321,
            owner: .foreign(process: "python3", pid: 4711)
        )
    ) {
        try await stack.ensureRunning { _ in }
    }
}

@MainActor
@Test("bug-embedded-podman-machine/AC-1 : un port tenu par un conteneur de l'ancienne pile est un conflit nommé, avec le geste exact")
func legacyContainerBlocksReadiness() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()
    fake.lsofRecords[8321] = "p900\ncgvproxy\nf7\nn127.0.0.1:8321\n"
    fake.processCommands[900] = "/opt/podman/bin/gvproxy -listen-vfkit unixgram:///tmp/x.sock"
    fake.dockerContainersJSON = """
    [{"Names":["/mem0-http"],"Id":"abc","State":"running","Ports":[{"IP":"127.0.0.1","PrivatePort":8321,"PublicPort":8321,"Type":"tcp"}]}]
    """
    let stack = sandbox.stack(run: fake.runner(), session: stubSession())

    await #expect(throws: MemoryStackError.portConflict(port: 8321, owner: .legacyStack(container: "mem0-http"))) {
        try await stack.ensureRunning { _ in }
    }

    let diagnostic = SetupText.failureDiagnostic(
        .stack(.portConflict(port: 8321, owner: .legacyStack(container: "mem0-http")))
    )
    #expect(diagnostic.contains("l'ancienne pile mémoire (conteneur mem0-http)"))
    #expect(diagnostic.contains("Geste : podman stop mem0-qdrant mem0-http"))
}

@MainActor
@Test("bug-embedded-podman-machine/AC-2 : une VM qui tourne mais dont l'API ne répond pas est RÉPARÉE sans geste manuel (stop → start → sonde)")
func unreachableAPIIsRepaired() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()
    fake.machinePresent = true
    fake.machineRunning = true
    // « already running » au start ; l'API échoue tant que la machine n'a pas été
    // arrêtée (le forwarder mort, mesuré le 2026-10-06).
    fake.machineStartReportsAlreadyRunning = true
    fake.infoFailsWhileRunning = true
    let stack = sandbox.stack(run: fake.runner(), session: stubSession())

    try await stack.ensureRunning { _ in }

    let labels = fake.podmanCalls.map { $0.arguments.prefix(2).joined(separator: " ") }
    let stopIndex = labels.firstIndex(of: "machine stop") ?? -1
    let startIndex = labels.firstIndex(of: "machine start") ?? -1
    #expect(stopIndex >= 0)
    #expect(startIndex > stopIndex)
    if startIndex >= 0 {
        #expect(labels[(startIndex + 1)...].contains("info"))
    }
    #expect(fake.machineStopCount == 1)
    #expect(fake.containers[MemoryStack.mem0Container]?.running == true)
}

@MainActor
@Test("bug-embedded-podman-machine/AC-2 : une API qui ne revient jamais rend `machineFailed` avec le texte MESURÉ de `info`")
func unreachableAPIFailsWithMeasuredText() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()
    fake.machinePresent = true
    fake.machineRunning = true
    fake.infoFails = true
    let stack = sandbox.stack(run: fake.runner(), session: stubSession())

    do {
        try await stack.ensureRunning { _ in }
        Issue.record("attendu machineFailed")
    } catch let error as MemoryStackError {
        guard case .machineFailed(let detail) = error else {
            Issue.record("attendu machineFailed, obtenu \(error)")
            return
        }
        #expect(detail.contains("unable to connect to Podman socket"))
        #expect(MemoryStack.isApiUnreachable(detail))
    }
}

@MainActor
@Test("bug-embedded-podman-machine/AC-4 : un conteneur mem0 existant qui ne porte pas le jeton courant est recréé")
func mem0ContainerWithoutTokenIsRecreated() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()
    let stack = sandbox.stack(run: fake.runner(), session: stubSession())
    try await stack.ensureRunning { _ in }

    // Jeton disparu du conteneur (fichier supprimé pendant qu'il tournait, ou
    // conteneur d'une version antérieure) : recréation, même chemin que « image
    // différente ».
    fake.containerEnvironment[MemoryStack.mem0Container] = ["MEM0_HTTP_TOKEN="]
    fake.resetCalls()
    try await stack.ensureRunning { _ in }

    #expect(fake.contains(["container", "rm", "-f", MemoryStack.mem0Container]))
    #expect(fake.contains(["run", "-d", "--name", MemoryStack.mem0Container]))
    #expect(
        fake.containerEnvironment[MemoryStack.mem0Container]?
            .contains("OMP_INSTALLATION_TOKEN=\(StackSandbox.token)") == true
    )
}

@MainActor
@Test("bug-embedded-podman-machine/AC-7 : une image déjà présente pour l'étiquette d'empreinte n'est JAMAIS reconstruite")
func existingFingerprintImageIsNotRebuilt() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()
    let stack = sandbox.stack(run: fake.runner(), session: stubSession())
    try await stack.ensureRunning { _ in }
    #expect(fake.images.contains(sandbox.stackTag))

    fake.resetCalls()
    try await stack.ensureRunning { _ in }

    #expect(!fake.contains(["image", "build"]))
    #expect(fake.containerRunCount == 2)
}

@MainActor
@Test("bug-embedded-podman-machine/AC-8 : une empreinte changée reconstruit l'image depuis ces sources, avec la nouvelle étiquette")
func changedFingerprintRebuildsImage() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()
    let stack = sandbox.stack(run: fake.runner(), session: stubSession())
    try await stack.ensureRunning { _ in }

    // Une source modifiée ⇒ une empreinte régénérée ⇒ une nouvelle étiquette.
    let newFingerprint = String(repeating: "d", count: 64)
    try Data((newFingerprint + "\n").utf8).write(
        to: sandbox.buildContext.appendingPathComponent(StackSources.fingerprintFileName)
    )
    fake.resetCalls()
    try await stack.ensureRunning { _ in }

    let tag = ComponentManifest.current.stackImageTag(fingerprint: newFingerprint)
    #expect(fake.contains(["image", "build", "-t", tag, sandbox.buildContext.path]))
    #expect(fake.containers[MemoryStack.mem0Container]?.image == tag)
    #expect(fake.contains(["container", "rm", "-f", MemoryStack.mem0Container]))
}

@MainActor
@Test("bug-embedded-podman-machine/AC-8 : une empreinte absente interrompt AVANT tout pull et tout build")
func missingFingerprintIsNamed() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()
    try FileManager.default.removeItem(
        at: sandbox.buildContext.appendingPathComponent(StackSources.fingerprintFileName)
    )
    let stack = sandbox.stack(run: fake.runner(), session: stubSession())

    do {
        try await stack.ensureRunning { _ in }
        Issue.record("attendu containerFailed")
    } catch let error as MemoryStackError {
        guard case .containerFailed(let name, let detail) = error else {
            Issue.record("attendu containerFailed, obtenu \(error)")
            return
        }
        #expect(name == MemoryStack.mem0Container)
        #expect(detail.hasPrefix("empreinte de la pile embarquée introuvable"))
    }
    #expect(!fake.contains(["image", "pull"]))
    #expect(!fake.contains(["image", "build"]))
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
