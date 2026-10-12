// La recette RÉELLE de l'agent launchd mem0-rs (omp-console-sans-podman, S-2 ;
// AC-2, AC-3, AC-4, AC-5, AC-13) : hors suite, hors CI.
//
// Désactivée par défaut : ni `.github/workflows/check.yml` ni `scripts/check.sh` ni
// `scripts/swift-app.sh` ne posent `MEM0_AGENT_RECIPE`. Variable posée ⇒ chaque
// test lance le VRAI launchctl sur une racine jetable (label et plist isolés sous
// `<racine>/LaunchAgents`, jamais `~/Library/LaunchAgents`), sur un port libre
// choisi par la recette (jamais 8321), puis décharge le job et supprime la racine.
//
// Binaire : `MEM0_RS_BIN`, sinon `mem0-stack/mem0-rs/target/release/mem0-rs`, COPIÉ
// dans la racine (la recette AC-4 re-signe la copie, jamais l'original).
//
//   MEM0_AGENT_RECIPE=1 swift test --scratch-path .build-recipe --no-parallel --filter recette
//
// Le nom de chaque FONCTION porte « recette » : `swift test --filter` filtre sur
// l'identifiant du test, pas sur son titre affiché.

import CryptoKit
import Darwin
import Foundation
import Testing

@testable import OMPConsole

private let recipeEnabled = ProcessInfo.processInfo.environment["MEM0_AGENT_RECIPE"] != nil

/// La racine du dépôt, depuis ce fichier (Tests/OMPConsoleTests/<fichier>).
private let repositoryRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()

private enum RecipeError: Error, CustomStringConvertible {
    case missingBinary(String)
    case noPort
    var description: String {
        switch self {
        case .missingBinary(let path):
            return "mem0-rs introuvable (\(path)) : lance `cargo build --release --locked --manifest-path mem0-stack/mem0-rs/Cargo.toml` ou pose MEM0_RS_BIN"
        case .noPort:
            return "aucun port libre"
        }
    }
}

/// Une racine de recette : faux bundle avec la copie du binaire, `stack/env`, port libre.
@MainActor
private final class RecipeRoot {
    let root: URL
    let paths: AppPaths
    let executable: URL
    let port: Int
    let uid = getuid()

    init(httpToken: String = "recette", environment: [String: String] = [:]) throws {
        let source = ProcessInfo.processInfo.environment["MEM0_RS_BIN"].flatMap { $0.isEmpty ? nil : $0 }
            .map { URL(fileURLWithPath: $0) }
            ?? repositoryRoot.appendingPathComponent("mem0-stack/mem0-rs/target/release/mem0-rs")
        guard FileManager.default.isExecutableFile(atPath: source.path) else {
            throw RecipeError.missingBinary(source.path)
        }
        // /tmp (et non $TMPDIR, très long) : chemins lisibles dans `ps` et le plist.
        root = URL(fileURLWithPath: "/tmp/omp-agent-recette-\(UUID().uuidString.prefix(8))", isDirectory: true)
        paths = AppPaths(supportRoot: root.appendingPathComponent("support", isDirectory: true))
        executable = root.appendingPathComponent("OMP Console.app/Contents/Resources/mem0-rs")
        try FileManager.default.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: source, to: executable)
        var config = StackConfig(mem0HttpToken: httpToken)
        let env = ProcessInfo.processInfo.environment.merging(environment) { $1 }
        if let base = env["OMLX_BASE_URL"], !base.isEmpty { config.omlxBaseURL = base }
        if let token = env["OMLX_API_TOKEN"] { config.omlxApiToken = token }
        if let model = env["OMLX_EMBED_MODEL"], !model.isEmpty { config.omlxEmbedModel = model }
        if let dims = env["EMBEDDING_DIMS"], let value = Int(dims) { config.embeddingDims = value }
        try StackEnvStore.write(config, to: paths.stackEnv)
        guard let free = Self.freePort() else { throw RecipeError.noPort }
        port = free
    }

    func agent() -> MemoryAgent {
        MemoryAgent(paths: paths, executable: executable, port: port)
    }

    var label: String { MemoryAgent.label(paths: paths) }

    /// Le pid servi, lu par `launchctl print` (nil si non chargé).
    func servingPid() async -> Int32? {
        let run = try? await CommandRunner.live(
            MemoryAgent.launchctl, ["print", "gui/\(uid)/\(label)"], ProcessInfo.processInfo.environment, 10
        )
        guard let run, run.code == 0 else { return nil }
        return MemoryAgent.jobPid(in: run.stdout)
    }

    func printCode() async -> Int32? {
        try? await CommandRunner.live(
            MemoryAgent.launchctl, ["print", "gui/\(uid)/\(label)"], ProcessInfo.processInfo.environment, 10
        ).code
    }

    /// Synchrone (appelé par `defer`) : `launchctl bootout gui/<uid> <plist>`, puis
    /// suppression de la racine.
    func cleanUp() {
        let bootout = Process()
        bootout.executableURL = MemoryAgent.launchctl
        bootout.arguments = ["bootout", "gui/\(uid)", paths.launchAgentPlist(label: label).path]
        bootout.standardOutput = FileHandle.nullDevice
        bootout.standardError = FileHandle.nullDevice
        if (try? bootout.run()) != nil { bootout.waitUntilExit() }
        try? FileManager.default.removeItem(at: root)
    }

    /// Un appel HTTP réel sur l'agent.
    func call(
        _ method: String,
        _ path: String,
        token: String? = "recette",
        body: [String: Any]? = nil
    ) async -> (status: Int, json: Any?) {
        guard let url = URL(string: "http://127.0.0.1:\(port)\(path)") else { return (0, nil) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        if let token { request.setValue(token, forHTTPHeaderField: "X-Mem0-Token") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse
        else { return (0, nil) }
        return (http.statusCode, try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]))
    }

    func healthy() async -> Bool {
        guard let token = InstallationTokenStore.load(at: paths.installationToken),
              let result = await MemoryAgent.liveHealthProbe(URL(string: "http://127.0.0.1:\(port)/health")!)
        else { return false }
        return MemoryAgent.isOurMem0(result, token: token)
    }

    /// Un port éphémère libre, attribué par le noyau puis relâché.
    static func freePort() -> Int? {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0 else { return nil }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        guard named == 0 else { return nil }
        return Int(UInt16(bigEndian: address.sin_port))
    }
}

/// Une route existe (ni 401, ni 405, ni le 404 de repli du routeur).
private func routeAnswered(_ reply: (status: Int, json: Any?)) -> Bool {
    guard reply.status != 0, reply.status != 401, reply.status != 405 else { return false }
    if reply.status == 404, (reply.json as? [String: Any])?["detail"] as? String == "Not Found" { return false }
    return true
}

private func sha256(_ url: URL) throws -> String {
    SHA256.hash(data: try Data(contentsOf: url)).map { String(format: "%02x", $0) }.joined()
}

private func ppid(of pid: Int32) async -> Int32? {
    let run = try? await CommandRunner.live(
        URL(fileURLWithPath: "/bin/ps"), ["-o", "ppid=", "-p", String(pid)], ProcessInfo.processInfo.environment, 10
    )
    return run.flatMap { Int32($0.stdout.trimmingCharacters(in: .whitespacesAndNewlines)) }
}

// MARK: - AC-2

@MainActor
@Test(
    "omp-console-sans-podman/AC-2 : recette — racine vierge : l'agent sert les 9 routes avec le jeton, refuse sans jeton, base sous la racine",
    .enabled(if: recipeEnabled)
)
func recetteAgentRacineViergeServLesNeufRoutes() async throws {
    let recipe = try RecipeRoot()
    defer { recipe.cleanUp() }

    try await recipe.agent().ensureRunning { _ in }

    let health = await recipe.call("GET", "/health", token: nil)
    #expect(health.status == 200)
    #expect((health.json as? [String: Any])?["installation"] as? String
        == InstallationTokenStore.load(at: recipe.paths.installationToken))

    let unknown = UUID().uuidString.lowercased()
    for (method, path) in [
        ("GET", "/memory/all?agent_id=recette"),
        ("GET", "/memory/graph"),
        ("GET", "/memory/\(unknown)/history"),
    ] {
        let reply = await recipe.call(method, path)
        #expect(reply.json != nil, "\(method) \(path) : réponse non JSON")
        #expect(routeAnswered(reply), "\(method) \(path) : statut \(reply.status)")
    }
    // Les routes qui appellent oMLX : la route existe et le jeton passe (oMLX peut
    // être injoignable, d'où un statut quelconque hors 401/404/405). Un DELETE
    // d'id inconnu rend, par parité avec mem0 2.2.1, un 500 en texte brut : seul
    // son statut compte ici.
    for (method, path, body) in [
        ("POST", "/memory/add", ["text": "recette agent", "agent_id": "recette", "infer": false] as [String: Any]),
        ("POST", "/memory/add_procedure", ["text": "recette procédure", "agent_id": "recette"]),
        ("POST", "/memory/search", ["query": "recette", "agent_id": "recette"]),
        ("PUT", "/memory/\(unknown)", ["text": "recette"]),
        ("DELETE", "/memory/\(unknown)", nil),
    ] as [(String, String, [String: Any]?)] {
        let reply = await recipe.call(method, path, body: body)
        #expect(routeAnswered(reply) && reply.status != 404, "\(method) \(path) : statut \(reply.status)")
    }

    #expect(await recipe.call("GET", "/memory/all", token: nil).status == 401)
    #expect(FileManager.default.fileExists(atPath: recipe.paths.supportRoot.appendingPathComponent("mem0-rs/mem0-rs.db").path))
    #expect(!FileManager.default.fileExists(atPath: recipe.paths.componentsRoot.appendingPathComponent("podman").path))
}

// MARK: - AC-3

@MainActor
@Test(
    "omp-console-sans-podman/AC-3 : recette — le serveur a launchd pour parent, survit à la fin du propriétaire et revient après kill -9",
    .enabled(if: recipeEnabled)
)
func recetteAgentSurvitEtRevientApresKill() async throws {
    let recipe = try RecipeRoot()
    defer { recipe.cleanUp() }

    do {
        // Le propriétaire (l'objet de l'app) disparaît à la fin de ce bloc.
        try await recipe.agent().ensureRunning { _ in }
    }
    let pid = try #require(await recipe.servingPid())
    #expect(await ppid(of: pid) == 1)
    #expect(await recipe.healthy())

    #expect(kill(pid, SIGKILL) == 0)
    let deadline = Date().addingTimeInterval(30)
    var revived: Int32?
    while Date() < deadline {
        if let current = await recipe.servingPid(), current != pid, await recipe.healthy() {
            revived = current
            break
        }
        try await Task.sleep(for: .milliseconds(500))
    }
    let newPid = try #require(revived, "launchd n'a pas relancé mem0-rs en 30 s")
    #expect(newPid != pid)
    #expect(await ppid(of: newPid) == 1)
}

// MARK: - AC-4

@MainActor
@Test(
    "omp-console-sans-podman/AC-4 : recette — un binaire embarqué re-signé (codesign --force --sign - --identifier autre) remplace le process servant",
    .enabled(if: recipeEnabled)
)
func recetteAgentBinaireResigneRemplaceLeProcess() async throws {
    let recipe = try RecipeRoot()
    defer { recipe.cleanUp() }

    try await recipe.agent().ensureRunning { _ in }
    let before = try #require(await recipe.servingPid())

    let resign = try await CommandRunner.live(
        URL(fileURLWithPath: "/usr/bin/codesign"),
        ["--force", "--sign", "-", "--identifier", "autre", recipe.executable.path],
        ProcessInfo.processInfo.environment,
        60
    )
    #expect(resign.code == 0, "codesign : \(resign.stderr)")

    let agent = recipe.agent()
    try await agent.ensureRunning { _ in }
    let after = try #require(await recipe.servingPid())
    #expect(after != before)
    let data = try Data(contentsOf: agent.plistURL)
    let plist = try #require(try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
    let environment = try #require(plist["EnvironmentVariables"] as? [String: String])
    #expect(environment["OMP_CONSOLE_MEM0_RS_SHA256"] == (try sha256(recipe.executable)))
    #expect(await recipe.healthy())
}

// MARK: - AC-5

@MainActor
@Test(
    "omp-console-sans-podman/AC-5 : recette — un port tenu par un autre programme bloque sans démarrer l'agent, puis Réessayer le démarre une fois libéré",
    .enabled(if: recipeEnabled)
)
func recetteAgentPortTenuPuisReessayer() async throws {
    let recipe = try RecipeRoot()
    defer { recipe.cleanUp() }

    let holder = Process()
    holder.executableURL = URL(fileURLWithPath: "/usr/bin/nc")
    holder.arguments = ["-l", "127.0.0.1", String(recipe.port)]
    holder.standardInput = FileHandle.nullDevice
    holder.standardOutput = FileHandle.nullDevice
    try holder.run()
    defer { if holder.isRunning { holder.terminate() } }
    try await Task.sleep(for: .milliseconds(500))

    let blocked = recipe.agent()
    blocked.portFreeBudget = 1
    do {
        try await blocked.ensureRunning { _ in }
        Issue.record("le port tenu par nc aurait dû bloquer l'agent")
    } catch let MemoryAgentError.portConflict(port, owner) {
        #expect(port == recipe.port)
        guard case .foreign(let process, _) = owner else {
            Issue.record("propriétaire attendu : foreign, obtenu \(owner)")
            return
        }
        #expect(process == "nc")
    }
    #expect(await recipe.printCode() == 113)

    holder.terminate()
    holder.waitUntilExit()
    try await recipe.agent().ensureRunning { _ in }
    #expect(await recipe.healthy())
}

// MARK: - AC-13

private let omlxConfigured: Bool = {
    let environment = ProcessInfo.processInfo.environment
    return ["OMLX_BASE_URL", "OMLX_API_TOKEN", "OMLX_EMBED_MODEL"].allSatisfy { environment[$0] != nil }
}()

@MainActor
@Test(
    "omp-console-sans-podman/AC-13 : recette — liste, ajout, recherche et suppression par HTTPMemoryService contre l'agent",
    .enabled(if: recipeEnabled && omlxConfigured)
)
func recetteAgentVuesMemoireContreMem0Rs() async throws {
    let recipe = try RecipeRoot()
    defer { recipe.cleanUp() }
    try await recipe.agent().ensureRunning { _ in }

    let service = HTTPMemoryService(config: MemoryServiceConfig(
        baseURL: URL(string: "http://127.0.0.1:\(recipe.port)")!,
        token: "recette",
        installationToken: InstallationTokenStore.load(at: recipe.paths.installationToken) ?? ""
    ))
    #expect(await service.health().isAvailable)

    let scope = "recette-ac13"
    let text = "La recette AC-13 vérifie la section Mémoire contre mem0-rs."
    try await service.add(text: text, scope: scope, tags: [])
    let listed = try await service.all(scope: scope)
    let row = try #require(listed.rows.first { $0.text == text })

    let found = try await service.search(query: "recette section Mémoire", scope: scope, pool: 10)
    #expect(found.contains { $0.id == row.id })

    try await service.delete(id: row.id)
    #expect(try await service.all(scope: scope).rows.allSatisfy { $0.id != row.id })
}
