// L'agent launchd mem0-rs (omp-console-sans-podman, S-2/S-3 ; AC-2, AC-4, AC-5,
// AC-12). Aucun launchctl, lsof ni ps réel : la doublure `AgentDouble` route par
// binaire ABSOLU et joue un launchd minimal (job chargé ou non, pid, bootout lent,
// bootstrap en EIO), et la sonde `/health` est scriptée. La racine est jetable :
// label et plist isolés sous `<racine>/LaunchAgents`.

import CryptoKit
import Foundation
import Testing

@testable import OMPConsole

// MARK: - La doublure

/// Un launchd, un lsof et un ps scriptés. `@unchecked Sendable` : tous les accès
/// viennent du MainActor (les tests y vivent).
final class AgentDouble: @unchecked Sendable {
    struct Call: Equatable {
        var binary: String
        var arguments: [String]
    }

    private(set) var calls: [Call] = []

    /// Le job est-il chargé, et sous quel pid ?
    var loaded = false
    var jobPid: Int32? = 900
    /// Après un `bootout`, nombre de `print` qui montrent ENCORE le job (DOC-2).
    var printsBeforeUnload = 0
    /// Nombre de `bootstrap` qui échouent en EIO avant le succès.
    var bootstrapFailures = 0
    /// Le pid du job créé par le prochain `bootstrap` réussi.
    var nextPid: Int32 = 901

    /// Qui écoute le port : (pid, nom court lsof, ligne de commande ps). nil ⇒ personne.
    var portHolder: (pid: Int32, command: String, commandLine: String)?

    /// Le corps rendu par `/health` quand le job est chargé ; nil ⇒ aucune réponse.
    var healthBody: (() -> Data?)?

    private var unloading: Int?

    var runner: CommandRunner {
        CommandRunner { [self] binary, arguments, _, _ in
            calls.append(Call(binary: binary.path, arguments: arguments))
            switch binary.path {
            case "/bin/launchctl":
                return launchctl(arguments)
            case "/usr/sbin/lsof":
                guard let holder = portHolder else { return ProcessRun(code: 1, stdout: "", stderr: "", timedOut: false) }
                return ProcessRun(code: 0, stdout: "p\(holder.pid)\nc\(holder.command)\nf3\nn127.0.0.1:8321\n", stderr: "", timedOut: false)
            case "/bin/ps":
                return ProcessRun(code: 0, stdout: (portHolder?.commandLine ?? "") + "\n", stderr: "", timedOut: false)
            default:
                Issue.record("binaire inattendu : \(binary.path)")
                return ProcessRun(code: 127, stdout: "", stderr: "", timedOut: false)
            }
        }
    }

    var healthProbe: @Sendable (URL) async -> (status: Int, body: Data)? {
        { [self] _ in
            guard loaded, let body = healthBody?() else { return nil }
            return (200, body)
        }
    }

    /// Les sous-commandes launchctl, dans l'ordre (`print`, `bootout`, `bootstrap`).
    var launchctlVerbs: [String] {
        calls.filter { $0.binary == "/bin/launchctl" }.compactMap(\.arguments.first)
    }

    private func launchctl(_ arguments: [String]) -> ProcessRun {
        switch arguments.first {
        case "print":
            if let remaining = unloading {
                if remaining > 0 {
                    unloading = remaining - 1
                } else {
                    unloading = nil
                    loaded = false
                }
            }
            guard loaded else {
                return ProcessRun(code: 113, stdout: "", stderr: "Could not find service", timedOut: false)
            }
            let pidLine = jobPid.map { "\tpid = \($0)\n" } ?? ""
            return ProcessRun(
                code: 0,
                stdout: "\(arguments[1]) = {\n\tstate = running\n\tprogram = /x/mem0-rs\n\(pidLine)\t\tstate = active\n}\n",
                stderr: "",
                timedOut: false
            )
        case "bootout":
            if printsBeforeUnload > 0 {
                unloading = printsBeforeUnload
            } else {
                loaded = false
            }
            return ProcessRun(code: 0, stdout: "", stderr: "", timedOut: false)
        case "bootstrap":
            if loaded || bootstrapFailures > 0 {
                bootstrapFailures = max(0, bootstrapFailures - 1)
                return ProcessRun(code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error\n", timedOut: false)
            }
            loaded = true
            jobPid = nextPid
            return ProcessRun(code: 0, stdout: "", stderr: "", timedOut: false)
        default:
            return ProcessRun(code: 64, stdout: "", stderr: "usage", timedOut: false)
        }
    }
}

/// Une racine jetable avec un faux binaire mem0-rs exécutable.
struct AgentSandbox {
    let root: URL
    let paths: AppPaths
    let executable: URL

    init() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("omp-agent-\(UUID().uuidString)", isDirectory: true)
        paths = AppPaths(supportRoot: root.appendingPathComponent("support", isDirectory: true))
        executable = root.appendingPathComponent("OMP Console.app/Contents/Resources/mem0-rs")
        try FileManager.default.createDirectory(
            at: executable.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try writeBinary("binaire v1")
    }

    func writeBinary(_ content: String) throws {
        try Data(content.utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
    }

    func sha() throws -> String {
        let digest = SHA256.hash(data: try Data(contentsOf: executable))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    func remove() {
        try? FileManager.default.removeItem(at: root)
    }
}

@MainActor
private func makeAgent(_ sandbox: AgentSandbox, _ double: AgentDouble) -> MemoryAgent {
    let agent = MemoryAgent(
        paths: sandbox.paths,
        executable: sandbox.executable,
        port: 8321,
        environment: [:],
        run: double.runner,
        uid: 501,
        healthProbe: double.healthProbe
    )
    agent.healthBudget = 0.2
    agent.portFreeBudget = 0.05
    agent.unloadBudget = 0.5
    agent.pollInterval = 0.01
    return agent
}

/// Le `/health` de NOTRE mem0-rs : il rend le jeton d'installation du disque.
private func ourHealth(_ paths: AppPaths) -> () -> Data? {
    {
        guard let token = InstallationTokenStore.load(at: paths.installationToken) else { return nil }
        return memoryJSON(["ok": true, "mem0": "mem0-rs 0.1.0", "user": "moi", "installation": token])
    }
}

private func plist(at url: URL) throws -> [String: Any] {
    let data = try Data(contentsOf: url)
    return try #require(try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
}

private func plistEnvironment(at url: URL) throws -> [String: String] {
    try #require(try plist(at: url)["EnvironmentVariables"] as? [String: String])
}

// MARK: - AC-2 : racine vierge

@MainActor
@Test("omp-console-sans-podman/AC-2 : sur une racine vierge, la préparation écrit le plist attendu (base sous la racine, jetons de stack/env et d'installation), bootstrap l'agent et ne crée jamais components/podman")
func ac2VirginRootWritesPlistAndBootstraps() async throws {
    let sandbox = try AgentSandbox()
    defer { sandbox.remove() }
    let double = AgentDouble()
    double.healthBody = ourHealth(sandbox.paths)
    let agent = makeAgent(sandbox, double)
    var steps: [AgentStep] = []

    try await agent.ensureRunning { steps.append($0) }

    #expect(steps == [.agent, .health])
    #expect(double.launchctlVerbs == ["print", "bootstrap"])
    let target = "gui/501/\(agent.label)"
    #expect(double.calls.first?.arguments == ["print", target])
    #expect(double.calls.last { $0.arguments.first == "bootstrap" }?.arguments == ["bootstrap", "gui/501", agent.plistURL.path])

    // Label et plist isolés sous la racine de test, jamais ~/Library/LaunchAgents.
    #expect(agent.label.hasPrefix("com.omp.console.mem0-rs."))
    #expect(agent.plistURL.path == sandbox.paths.supportRoot.appendingPathComponent("LaunchAgents/\(agent.label).plist").path)

    let token = try #require(InstallationTokenStore.load(at: sandbox.paths.installationToken))
    let written = try plist(at: agent.plistURL)
    let expected = try agent.expectedPlist(installationToken: token)
    #expect(NSDictionary(dictionary: written) == NSDictionary(dictionary: expected))
    #expect(written["Label"] as? String == agent.label)
    #expect(written["ProgramArguments"] as? [String] == [sandbox.executable.path, "--host", "127.0.0.1", "--port", "8321"])
    #expect(written["KeepAlive"] as? Bool == true)
    #expect(written["RunAtLoad"] as? Bool == true)
    #expect(written["ProcessType"] as? String == "Interactive")
    #expect(written["WorkingDirectory"] as? String == sandbox.paths.mem0Root.path)
    #expect(written["StandardOutPath"] as? String == sandbox.paths.mem0Log.path)
    #expect(written["StandardErrorPath"] as? String == sandbox.paths.mem0Log.path)

    let environment = try plistEnvironment(at: agent.plistURL)
    #expect(environment == [
        "MEM0_DB_PATH": sandbox.paths.supportRoot.appendingPathComponent("mem0-rs/mem0-rs.db").path,
        "EMBEDDING_DIMS": "1024",
        "OMLX_BASE_URL": "http://127.0.0.1:8000/v1",
        "OMLX_API_TOKEN": "",
        "OMLX_LLM_MODEL": "qwen3-8b",
        "OMLX_EMBED_MODEL": "bge-m3",
        "MEM0_HTTP_TOKEN": "",
        "OMP_INSTALLATION_TOKEN": token,
        "OMP_CONSOLE_MEM0_RS_SHA256": try sandbox.sha(),
    ])

    // Droits : le plist porte des jetons (0600), le dossier de travail est privé (0700).
    let fileManager = FileManager.default
    #expect(try fileManager.attributesOfItem(atPath: agent.plistURL.path)[.posixPermissions] as? Int == 0o600)
    #expect(try fileManager.attributesOfItem(atPath: sandbox.paths.mem0Root.path)[.posixPermissions] as? Int == 0o700)
    // Aucun podman : ni composant, ni configuration de machine.
    #expect(!fileManager.fileExists(atPath: sandbox.paths.componentsRoot.appendingPathComponent("podman").path))
    #expect(!fileManager.fileExists(atPath: sandbox.paths.configDir.path))
    #expect(!fileManager.fileExists(atPath: sandbox.paths.stackEnv.path))
}

@MainActor
@Test("omp-console-sans-podman/AC-2 : bootout lent — bootstrap n'est lancé qu'après un print en échec, et un bootstrap EIO est repris")
func ac2SlowBootoutThenRetriedBootstrap() async throws {
    let sandbox = try AgentSandbox()
    defer { sandbox.remove() }
    let double = AgentDouble()
    double.healthBody = ourHealth(sandbox.paths)
    // Un job chargé dont le plist n'est PAS celui attendu (absent du disque).
    double.loaded = true
    double.printsBeforeUnload = 2
    double.bootstrapFailures = 1
    let agent = makeAgent(sandbox, double)

    try await agent.ensureRunning { _ in }

    #expect(double.launchctlVerbs == ["print", "bootout", "print", "print", "print", "bootstrap", "bootstrap"])
    // Le premier bootstrap suit un print en échec (113), jamais un print qui montre le job.
    let launchctlCalls = double.calls.filter { $0.binary == "/bin/launchctl" }
    #expect(launchctlCalls.firstIndex { $0.arguments.first == "bootstrap" } == 5)
    #expect(double.loaded)
    #expect(double.jobPid == 901)
}

@MainActor
@Test("omp-console-sans-podman/AC-2 : un bootout qui ne décharge jamais, ou un bootstrap toujours en échec, est une erreur launchctl nommée")
func ac2LaunchctlFailuresAreNamed() async throws {
    let sandbox = try AgentSandbox()
    defer { sandbox.remove() }

    let stuck = AgentDouble()
    stuck.loaded = true
    stuck.printsBeforeUnload = 10_000
    let stuckAgent = makeAgent(sandbox, stuck)
    stuckAgent.unloadBudget = 0.05
    await #expect(throws: MemoryAgentError.launchctlFailed(command: "bootout", detail: "le service est toujours chargé")) {
        try await stuckAgent.ensureRunning { _ in }
    }
    #expect(!stuck.launchctlVerbs.contains("bootstrap"))

    let refused = AgentDouble()
    refused.bootstrapFailures = 10
    let refusedAgent = makeAgent(sandbox, refused)
    await #expect(throws: MemoryAgentError.launchctlFailed(command: "bootstrap", detail: "Bootstrap failed: 5: Input/output error")) {
        try await refusedAgent.ensureRunning { _ in }
    }
    #expect(refused.launchctlVerbs.filter { $0 == "bootstrap" }.count == 3)
}

@MainActor
@Test("omp-console-sans-podman/AC-2 : un binaire embarqué absent est nommé, avant tout launchctl")
func ac2MissingBinaryIsNamed() async throws {
    let sandbox = try AgentSandbox()
    defer { sandbox.remove() }
    try FileManager.default.removeItem(at: sandbox.executable)
    let double = AgentDouble()
    let agent = makeAgent(sandbox, double)

    await #expect(throws: MemoryAgentError.binaryMissing(path: sandbox.executable.path)) {
        try await agent.ensureRunning { _ in }
    }
    #expect(double.calls.isEmpty)
}

@MainActor
@Test("omp-console-sans-podman/AC-2 : santé jamais acquise ⇒ healthTimeout portant la fin du journal ; un /health sans notre jeton n'est jamais accepté")
func ac2HealthTimeoutCarriesLogTail() async throws {
    let sandbox = try AgentSandbox()
    defer { sandbox.remove() }
    let double = AgentDouble()
    // Un service répond, mais sans le jeton d'installation : jamais « le nôtre ».
    double.healthBody = { memoryJSON(["ok": true, "mem0": "mem0-rs 0.1.0", "user": "moi"]) }
    try FileManager.default.createDirectory(at: sandbox.paths.mem0Root, withIntermediateDirectories: true)
    let lines = (1...30).map { "ligne \($0)" } + [
        "erreur : la base a été créée avec EMBEDDING_DIMS=768",
    ]
    try Data(lines.joined(separator: "\n").utf8).write(to: sandbox.paths.mem0Log)
    let agent = makeAgent(sandbox, double)

    do {
        try await agent.ensureRunning { _ in }
        Issue.record("la santé n'aurait pas dû être acquise")
    } catch let MemoryAgentError.healthTimeout(seconds, log) {
        #expect(seconds == 1)
        #expect(log.hasSuffix("erreur : la base a été créée avec EMBEDDING_DIMS=768"))
        #expect(log.contains("ligne 12"))
        #expect(!log.contains("ligne 11\n"))
        #expect(log.count <= 301)
    }
}

// MARK: - AC-4 : le binaire de la nouvelle version

@MainActor
@Test("omp-console-sans-podman/AC-4 : un plist chargé dont le SHA-256 diffère du binaire embarqué est déchargé, attendu déchargé, puis rechargé avec le nouveau SHA")
func ac4DifferentBinaryReloadsTheJob() async throws {
    let sandbox = try AgentSandbox()
    defer { sandbox.remove() }
    let double = AgentDouble()
    double.healthBody = ourHealth(sandbox.paths)
    try await makeAgent(sandbox, double).ensureRunning { _ in }
    let oldSha = try plistEnvironment(at: makeAgent(sandbox, double).plistURL)["OMP_CONSOLE_MEM0_RS_SHA256"]

    // Nouvelle version de l'app : le binaire embarqué change.
    try sandbox.writeBinary("binaire v2")
    double.printsBeforeUnload = 1
    double.nextPid = 1200
    let agent = makeAgent(sandbox, double)
    let before = double.calls.count

    try await agent.ensureRunning { _ in }

    let verbs = double.calls.dropFirst(before).filter { $0.binary == "/bin/launchctl" }.compactMap(\.arguments.first)
    #expect(verbs == ["print", "bootout", "print", "print", "bootstrap"])
    let newSha = try plistEnvironment(at: agent.plistURL)["OMP_CONSOLE_MEM0_RS_SHA256"]
    #expect(newSha == (try sandbox.sha()))
    #expect(newSha != oldSha)
    #expect(double.jobPid == 1200)
}

@MainActor
@Test("omp-console-sans-podman/AC-4 : un plist à jour et un service sain ⇒ aucun appel bootout ni bootstrap")
func ac4UpToDateAgentIsLeftAlone() async throws {
    let sandbox = try AgentSandbox()
    defer { sandbox.remove() }
    let double = AgentDouble()
    double.healthBody = ourHealth(sandbox.paths)
    try await makeAgent(sandbox, double).ensureRunning { _ in }
    let plistURL = makeAgent(sandbox, double).plistURL
    let modified = try FileManager.default.attributesOfItem(atPath: plistURL.path)[.modificationDate] as? Date
    let before = double.calls.count

    try await makeAgent(sandbox, double).ensureRunning { _ in }

    let verbs = double.calls.dropFirst(before).filter { $0.binary == "/bin/launchctl" }.compactMap(\.arguments.first)
    #expect(verbs == ["print"])
    #expect(!double.calls.dropFirst(before).contains { $0.binary == "/usr/sbin/lsof" })
    #expect(try FileManager.default.attributesOfItem(atPath: plistURL.path)[.modificationDate] as? Date == modified)
}

@MainActor
@Test("omp-console-sans-podman/AC-4 : un stack/env modifié recharge l'agent avec la nouvelle configuration")
func ac4ChangedStackEnvReloads() async throws {
    let sandbox = try AgentSandbox()
    defer { sandbox.remove() }
    let double = AgentDouble()
    double.healthBody = ourHealth(sandbox.paths)
    try await makeAgent(sandbox, double).ensureRunning { _ in }
    try StackEnvStore.write(StackConfig(omlxEmbedModel: "bge-m3-mlx-8bit"), to: sandbox.paths.stackEnv)
    let before = double.calls.count

    let agent = makeAgent(sandbox, double)
    try await agent.ensureRunning { _ in }

    let verbs = double.calls.dropFirst(before).filter { $0.binary == "/bin/launchctl" }.compactMap(\.arguments.first)
    #expect(verbs == ["print", "bootout", "print", "bootstrap"])
    #expect(try plistEnvironment(at: agent.plistURL)["OMLX_EMBED_MODEL"] == "bge-m3-mlx-8bit")
}

// MARK: - AC-12 : mêmes jetons

@MainActor
@Test("omp-console-sans-podman/AC-12 : le plist porte MEM0_HTTP_TOKEN de stack/env et le jeton d'installation existant, inchangés, et OMLX_BASE_URL host.containers.internal devient 127.0.0.1")
func ac12PlistKeepsTokensAndTranslatesOMLX() async throws {
    let sandbox = try AgentSandbox()
    defer { sandbox.remove() }
    let existingToken = String(repeating: "ab", count: 32)
    try FileManager.default.createDirectory(at: sandbox.paths.stackRoot, withIntermediateDirectories: true)
    try Data((existingToken + "\n").utf8).write(to: sandbox.paths.installationToken)
    let stackEnv = """
    QDRANT_API_KEY=cle-qdrant
    MEM0_HTTP_TOKEN=jeton-iphone
    OMLX_BASE_URL=http://host.containers.internal:8000/v1
    OMLX_API_TOKEN=cle-omlx
    OMLX_LLM_MODEL=qwen3-8b
    OMLX_EMBED_MODEL=bge-m3-mlx-8bit
    EMBEDDING_DIMS=1024

    """
    try Data(stackEnv.utf8).write(to: sandbox.paths.stackEnv)
    let double = AgentDouble()
    double.healthBody = ourHealth(sandbox.paths)
    let agent = makeAgent(sandbox, double)

    try await agent.ensureRunning { _ in }

    let environment = try plistEnvironment(at: agent.plistURL)
    #expect(environment["MEM0_HTTP_TOKEN"] == "jeton-iphone")
    #expect(environment["OMP_INSTALLATION_TOKEN"] == existingToken)
    #expect(environment["OMLX_BASE_URL"] == "http://127.0.0.1:8000/v1")
    #expect(environment["OMLX_API_TOKEN"] == "cle-omlx")
    #expect(environment["OMLX_EMBED_MODEL"] == "bge-m3-mlx-8bit")
    #expect(environment["QDRANT_API_KEY"] == nil)
    // Ni le jeton d'installation ni stack/env ne sont réécrits.
    #expect(try String(contentsOf: sandbox.paths.installationToken, encoding: .utf8) == existingToken + "\n")
    #expect(try String(contentsOf: sandbox.paths.stackEnv, encoding: .utf8) == stackEnv)
}

@Test("omp-console-sans-podman/AC-12 : nativeOMLXBaseURL ne traduit QUE l'hôte host.containers.internal, en gardant schéma, port et chemin")
func ac12NativeOMLXBaseURL() {
    #expect(StackConfig.nativeOMLXBaseURL("http://host.containers.internal:8000/v1") == "http://127.0.0.1:8000/v1")
    #expect(StackConfig.nativeOMLXBaseURL("https://host.containers.internal:9443/api/v1") == "https://127.0.0.1:9443/api/v1")
    #expect(StackConfig.nativeOMLXBaseURL("http://192.168.1.10:8000/v1") == "http://192.168.1.10:8000/v1")
    #expect(StackConfig.nativeOMLXBaseURL("pas une url") == "pas une url")
}

@Test("omp-console-sans-podman/AC-12 : sans MEM0_HTTP_URL, le client vise localhost sur le port de l'agent (8321 hors recette)")
func ac12ClientDefaultsToAgentPort() {
    #expect(MemoryServiceConfig.fromEnvironment([:]).baseURL.absoluteString == "http://localhost:8321")
    #expect(MemoryServiceConfig.fromEnvironment(["OMP_CONSOLE_MEM0_PORT": "18321"]).baseURL.absoluteString == "http://localhost:18321")
    #expect(MemoryServiceConfig.fromEnvironment([
        "OMP_CONSOLE_MEM0_PORT": "18321",
        "MEM0_HTTP_URL": "http://127.0.0.1:9000",
    ]).baseURL.absoluteString == "http://127.0.0.1:9000")
}

// MARK: - Label, port, chemins

@Test("omp-console-sans-podman/AC-2 : racine réelle ⇒ label par défaut et ~/Library/LaunchAgents ; racine déplacée ⇒ label et plist isolés")
func ac2LabelAndPlistFollowTheRoot() {
    let real = AppPaths.standard(home: "/Users/x", environment: [:])
    #expect(!real.isOverridden)
    #expect(MemoryAgent.label(paths: real) == "com.omp.console.mem0-rs")
    #expect(real.launchAgentsDir.path.hasSuffix("/Library/LaunchAgents"))
    #expect(real.mem0Database.path == "/Users/x/Library/Application Support/com.omp.console/mem0-rs/mem0-rs.db")

    let moved = AppPaths.standard(environment: ["OMP_CONSOLE_SUPPORT_ROOT": "/tmp/recette"])
    #expect(moved.isOverridden)
    let label = MemoryAgent.label(paths: moved)
    #expect(label.count == "com.omp.console.mem0-rs.".count + 12)
    #expect(label.hasPrefix("com.omp.console.mem0-rs."))
    #expect(label.dropFirst("com.omp.console.mem0-rs.".count).allSatisfy { $0.isHexDigit && !$0.isUppercase })
    #expect(MemoryAgent.label(paths: AppPaths.standard(environment: ["OMP_CONSOLE_SUPPORT_ROOT": "/tmp/autre"])) != label)
    #expect(moved.launchAgentPlist(label: label).path == "/tmp/recette/LaunchAgents/\(label).plist")
}

@Test("omp-console-sans-podman/AC-2 : OMP_CONSOLE_MEM0_PORT n'est retenu que s'il est un entier décimal 1–65535")
func ac2PortOverride() {
    #expect(MemoryAgent.port(environment: [:]) == 8321)
    #expect(MemoryAgent.port(environment: ["OMP_CONSOLE_MEM0_PORT": "18321"]) == 18321)
    for invalid in ["", "0", "65536", "-1", "+80", "8321x", " 8321", "0x10"] {
        #expect(MemoryAgent.port(environment: ["OMP_CONSOLE_MEM0_PORT": invalid]) == 8321)
    }
}

@Test("omp-console-sans-podman/AC-2 : le pid du job vient de la ligne `\\tpid = n` à une tabulation, et son absence rend nil")
func ac2JobPidParsing() {
    #expect(MemoryAgent.jobPid(in: "x = {\n\tstate = running\n\tpid = 4242\n\t\tpid = 1\n}\n") == 4242)
    #expect(MemoryAgent.jobPid(in: "x = {\n\tstate = waiting\n\t\tpid = 7\n}\n") == nil)
}

// MARK: - AC-5 : port occupé

@MainActor
@Test("omp-console-sans-podman/AC-5 : moteur — un port tenu par un autre programme ⇒ portConflict nommant le programme, aucun bootstrap, et l'agent chargé est déchargé")
func ac5ForeignPortBlocksAndUnloads() async throws {
    let sandbox = try AgentSandbox()
    defer { sandbox.remove() }
    let double = AgentDouble()
    double.loaded = true
    double.jobPid = 900
    double.portHolder = (4711, "python3", "/usr/bin/python3 -m http.server 8321")
    let agent = makeAgent(sandbox, double)

    await #expect(throws: MemoryAgentError.portConflict(port: 8321, owner: .foreign(process: "python3", pid: 4711))) {
        try await agent.ensureRunning { _ in }
    }
    #expect(!double.launchctlVerbs.contains("bootstrap"))
    #expect(double.launchctlVerbs.contains("bootout"))
    #expect(!double.loaded)

    // Sans job chargé : rien à décharger, et toujours aucun bootstrap.
    let fresh = AgentDouble()
    fresh.portHolder = (4711, "nc", "nc -l 127.0.0.1 8321")
    await #expect(throws: MemoryAgentError.portConflict(port: 8321, owner: .foreign(process: "nc", pid: 4711))) {
        try await makeAgent(sandbox, fresh).ensureRunning { _ in }
    }
    #expect(fresh.launchctlVerbs == ["print"])
}

@MainActor
@Test("omp-console-sans-podman/AC-5 : moteur — Réessayer après libération du port charge l'agent et le rend sain")
func ac5RetryAfterPortFreed() async throws {
    let sandbox = try AgentSandbox()
    defer { sandbox.remove() }
    let double = AgentDouble()
    double.healthBody = ourHealth(sandbox.paths)
    double.portHolder = (4711, "nc", "nc -l 127.0.0.1 8321")

    await #expect(throws: MemoryAgentError.portConflict(port: 8321, owner: .foreign(process: "nc", pid: 4711))) {
        try await makeAgent(sandbox, double).ensureRunning { _ in }
    }
    double.portHolder = nil
    try await makeAgent(sandbox, double).ensureRunning { _ in }
    #expect(double.loaded)
    #expect(double.launchctlVerbs.last == "bootstrap")
}

@MainActor
@Test("omp-console-sans-podman/AC-5 : moteur — le port tenu par le job lui-même (pid du job) ou par le mem0-rs embarqué n'est pas un conflit")
func ac5OwnJobOrOurBinaryIsNotAConflict() async throws {
    let sandbox = try AgentSandbox()
    defer { sandbox.remove() }

    // Le job chargé tourne encore un ANCIEN binaire (autre chemin) : son pid fait foi.
    let ownJob = AgentDouble()
    ownJob.healthBody = ourHealth(sandbox.paths)
    ownJob.loaded = true
    ownJob.jobPid = 900
    ownJob.portHolder = (900, "mem0-rs", "/Applications/Ancienne.app/Contents/Resources/mem0-rs --host 127.0.0.1 --port 8321")
    try await makeAgent(sandbox, ownJob).ensureRunning { _ in }
    #expect(ownJob.launchctlVerbs.contains("bootstrap"))

    // Le mem0-rs embarqué tient le port (ligne de commande = son chemin).
    let ours = AgentDouble()
    ours.healthBody = ourHealth(sandbox.paths)
    ours.portHolder = (777, "mem0-rs", sandbox.executable.path + " --host 127.0.0.1 --port 8321")
    try await makeAgent(sandbox, ours).ensureRunning { _ in }
    #expect(ours.launchctlVerbs.contains("bootstrap"))
}

@MainActor
@Test("omp-console-sans-podman/AC-5 : un programme qui prend le port pendant la santé ⇒ portConflict et l'agent est déchargé")
func ac5PortTakenDuringHealth() async throws {
    let sandbox = try AgentSandbox()
    defer { sandbox.remove() }
    let double = AgentDouble()
    // Jamais sain : quelqu'un d'autre a gagné le bind.
    double.healthBody = nil
    // Libre à la garde, pris ensuite : la doublure le prend après le bootstrap.
    let taker = double
    let wrapped = CommandRunner { binary, arguments, environment, timeout in
        let result = try await taker.runner(binary, arguments, environment, timeout)
        if arguments.first == "bootstrap", result.code == 0 {
            taker.portHolder = (5555, "python3", "/usr/bin/python3 serve.py")
        }
        return result
    }
    let racing = MemoryAgent(
        paths: sandbox.paths,
        executable: sandbox.executable,
        port: 8321,
        environment: [:],
        run: wrapped,
        uid: 501,
        healthProbe: double.healthProbe
    )
    racing.healthBudget = 0.05
    racing.unloadBudget = 0.5
    racing.pollInterval = 0.01

    await #expect(throws: MemoryAgentError.portConflict(port: 8321, owner: .foreign(process: "python3", pid: 5555))) {
        try await racing.ensureRunning { _ in }
    }
    #expect(double.launchctlVerbs.suffix(2) == ["bootout", "print"])
    #expect(!double.loaded)
}

@Test("omp-console-sans-podman/AC-5 : le processus du mem0-rs embarqué est « ours », un autre mem0-rs est « foreign »")
func ac5EmbeddedMem0IsOursAnotherIsForeign() async {
    let embedded = URL(fileURLWithPath: "/Applications/OMP Console.app/Contents/Resources/mem0-rs")
    let double = OwnershipDouble()
    double.lsofResult = ProcessRun(code: 0, stdout: "p321\ncmem0-rs\nf3\nn127.0.0.1:8321\n", stderr: "", timedOut: false)

    double.psResult = ProcessRun(code: 0, stdout: embedded.path + " --host 127.0.0.1 --port 8321\n", stderr: "", timedOut: false)
    #expect(await StackOwnership.holder(ofPort: 8321, ourExecutable: embedded, environment: [:], run: double.runner)
        == .ours(process: "mem0-rs", pid: 321))

    // La pile manuelle mem0-stack : un AUTRE binaire mem0-rs.
    double.psResult = ProcessRun(code: 0, stdout: "/usr/local/bin/mem0-rs --host 0.0.0.0\n", stderr: "", timedOut: false)
    #expect(await StackOwnership.holder(ofPort: 8321, ourExecutable: embedded, environment: [:], run: double.runner)
        == .foreign(process: "mem0-rs", pid: 321))

    // Un homonyme dont le chemin PROLONGE le nôtre n'est pas le nôtre.
    double.psResult = ProcessRun(code: 0, stdout: embedded.path + "-old --port 8321\n", stderr: "", timedOut: false)
    #expect(await StackOwnership.holder(ofPort: 8321, ourExecutable: embedded, environment: [:], run: double.runner)
        == .foreign(process: "mem0-rs", pid: 321))

    #expect(StackOwnership.isCommandLine(embedded.path, of: embedded))
    #expect(MemoryPortOwnership.ours(process: "mem0-rs", pid: 1).userDescription == "le service mémoire d'OMP Console")
}
