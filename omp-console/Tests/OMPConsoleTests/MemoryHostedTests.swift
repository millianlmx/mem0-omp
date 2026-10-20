// La mémoire hébergée sur le VPS côté omp-console (S-7 de orchestrator-living-in-a-vps) :
// `mem0-remote.json` donne l'URL et le Bearer au client mémoire ; la préparation de
// l'app ne démarre plus l'agent mem0-rs local et le décharge ; l'écran Mémoire le dit.
// Aucun launchctl réel : `AgentDouble` joue launchd ; aucun réseau : un `URLProtocol`
// propre à ce fichier capture la requête.

import ConsoleCore
import Foundation
import Testing

@testable import OMPConsole

/// Un `URLProtocol` à stockage propre : il capture les requêtes et rend `{"ok":true}`.
private final class HostedProbeProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var recorded: [URLRequest] = []
    private static let lock = NSLock()

    static func reset() {
        lock.withLock { recorded = [] }
    }

    static var requests: [URLRequest] { lock.withLock { recorded } }

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HostedProbeProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.withLock { Self.recorded.append(request) }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"ok":true,"results":[]}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// Un dossier d'agent OMP jetable, avec (ou sans) `mem0-remote.json`.
private func agentDirectory(remote: String?) throws -> [String: String] {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("omp-hosted-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    if let remote {
        try Data(remote.utf8).write(to: directory.appendingPathComponent("mem0-remote.json"))
    }
    return ["PI_CODING_AGENT_DIR": directory.path, "HOME": directory.path]
}

private let validRemote = #"{"version":1,"url":"http://100.64.0.7:8787/v1/mem0","token":"jeton-appareil"}"#

@MainActor
@Test("orchestrator-living-in-a-vps/AC-7 : avec mem0-remote.json, omp-console lit l’URL et le Bearer du VPS, ne démarre plus l’agent local, le décharge et affiche « Mémoire hébergée sur le VPS »")
func hostedMemoryIsUsedAndTheLocalAgentIsUnloaded() async throws {
    // 1) La configuration : URL et jeton du fichier, marquée hébergée ; l'environnement prime.
    let environment = try agentDirectory(remote: validRemote)
    let config = try #require(MemoryServiceConfig.hosted(environment: environment))
    #expect(config.baseURL.absoluteString == "http://100.64.0.7:8787/v1/mem0")
    #expect(config.token == "jeton-appareil")
    #expect(config.hosted)
    let sandbox = try AgentSandbox()
    defer { sandbox.remove() }
    #expect(MemoryServiceConfig.resolved(environment: environment, paths: sandbox.paths) == config)
    #expect(RemoteServiceModel.memoryConfig(environment: environment, stackEnv: sandbox.root.appendingPathComponent("env")) == config)
    var withEnvironmentUrl = environment
    withEnvironmentUrl["MEM0_HTTP_URL"] = "http://localhost:9999"
    #expect(MemoryServiceConfig.hosted(environment: withEnvironmentUrl) == nil)
    #expect(MemoryServiceConfig.fromEnvironment(environment).hosted == false)

    // 2) Le client : Bearer au lieu d'`X-Mem0-Token`, chemins du proxy, `/health` sans jeton d'installation.
    HostedProbeProtocol.reset()
    let service = HTTPMemoryService(config: config, session: HostedProbeProtocol.session())
    let health = await service.health()
    #expect(health.isAvailable)
    #expect(health.isForeign == false)
    _ = try await service.all(scope: "mem0-omp")
    let requests = HostedProbeProtocol.requests
    #expect(requests.map { $0.url?.path } == ["/v1/mem0/health", "/v1/mem0/memory/all"])
    for request in requests {
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer jeton-appareil")
        #expect(request.value(forHTTPHeaderField: "X-Mem0-Token") == nil)
    }

    // 3) La préparation : l'agent local chargé est déchargé, jamais démarré.
    let double = AgentDouble()
    double.loaded = true
    let agent = MemoryAgent(
        paths: sandbox.paths,
        executable: sandbox.executable,
        port: 8321,
        environment: [:],
        run: double.runner,
        uid: 501,
        healthProbe: double.healthProbe
    )
    agent.unloadBudget = 0.5
    agent.pollInterval = 0.01
    var steps: [AgentStep] = []
    try await SetupModel.ensureAgentStep(agent: agent, hosted: { true })({ steps.append($0) })
    #expect(double.loaded == false)
    #expect(double.launchctlVerbs.contains("bootout"))
    #expect(!double.launchctlVerbs.contains("bootstrap"))
    #expect(steps.isEmpty)
    #expect(!FileManager.default.fileExists(atPath: agent.plistURL.path))
    // Déjà absent : rien à décharger, rien de démarré non plus.
    let absent = AgentDouble()
    let idle = MemoryAgent(
        paths: sandbox.paths, executable: sandbox.executable, port: 8321, environment: [:],
        run: absent.runner, uid: 501, healthProbe: absent.healthProbe
    )
    try await SetupModel.ensureAgentStep(agent: idle, hosted: { true })({ _ in })
    #expect(absent.launchctlVerbs == ["print"])

    // 4) L'écran : le modèle sait que la mémoire est hébergée, le texte est exact.
    let model = MemoryModel(service: ScriptedMemoryService(), scope: { "mem0-omp" }, environment: environment, paths: sandbox.paths)
    #expect(model.hostedOnVps)
    #expect(MemoryText.hostedOnVps == "Mémoire hébergée sur le VPS")
}

@Test("mémoire hébergée : un mem0-remote.json invalide ou absent est ignoré, la pile locale reste la source")
func invalidHostedFileIsIgnored() throws {
    for content in [
        nil,
        "pas du JSON",
        #"{"version":2,"url":"http://h:1/v1/mem0","token":"t"}"#,
        #"{"version":1,"url":"http://h:1/v1/mem0","token":""}"#,
        #"{"version":1,"url":"","token":"t"}"#,
        #"{"version":1,"url":"ftp://h/x","token":"t"}"#,
    ] as [String?] {
        let environment = try agentDirectory(remote: content)
        #expect(MemoryServiceConfig.hosted(environment: environment) == nil, "\(content ?? "absent")")
    }
}
