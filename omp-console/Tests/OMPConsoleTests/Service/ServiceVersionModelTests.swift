// Preuves de l'avertissement d'écart de version du service OMP (S-4 de
// service-version-drift-detection, BR-2) : le texte exact selon la version
// annoncée par le service, le silence sans écart ou sans service, et le retrait
// de l'avertissement à la republication de `service.json`.
//
// Aucun réseau ni FileWatcher : le transport scripté répond `GET /v1/health`, et
// le flux de réveil est injecté par le test.

import Darwin
import Foundation
import Testing
@testable import OMPConsole

@MainActor
private func waitUntil(timeout: Duration = .seconds(5), _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return condition()
}

/// Un magasin d'état et un HOME jetables : `service.json` y est publié par le
/// test, et le package.json du module installé sous le HOME.
private struct DriftFixture {
    let stateDir: URL
    let home: URL

    init() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("omp-service-version-\(UUID().uuidString)")
        stateDir = root.appendingPathComponent("state")
        home = root.appendingPathComponent("home")
        try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    }

    var installedPackagePath: String {
        ServiceVersionModel.installedPackagePath(home: home.path)
    }

    func install(version: String) throws {
        let url = URL(fileURLWithPath: installedPackagePath)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: ["name": "omp-mem0-req", "version": version], options: [.sortedKeys])
        try data.write(to: url)
    }

    /// Publie `service.json` pour un service vivant (pid du test) sur `port`.
    func publishService(port: Int) throws {
        let object: [String: Any] = [
            "version": 1, "pid": Int(getpid()), "port": port, "token": String(repeating: "a", count: 32),
            "startedAt": 1, "stateDir": stateDir.path, "sessionFile": NSNull(),
        ]
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        try data.write(to: stateDir.appendingPathComponent("service.json"), options: .atomic)
    }

    @MainActor
    func model(
        transports: [Int: ScriptedServiceTransport],
        changes: AsyncStream<Void>? = nil
    ) -> ServiceVersionModel {
        ServiceVersionModel(
            stateDir: stateDir.path,
            installedPackagePath: installedPackagePath,
            makeClient: { endpoint in
                ServiceClient(endpoint: endpoint, transport: transports[endpoint.port] ?? ScriptedServiceTransport())
            },
            changes: changes
        )
    }
}

/// Un transport dont `GET /v1/health` annonce `pluginVersion` (absent si `nil`).
private func healthTransport(pluginVersion: Any?, status: Int = 200) -> ScriptedServiceTransport {
    let transport = ScriptedServiceTransport()
    var health: [String: Any] = ["version": 1, "pid": Int(getpid()), "startedAt": 1, "sessions": 0, "lots": 0]
    if let pluginVersion { health["pluginVersion"] = pluginVersion }
    transport.stubJSON("GET", "/health", health, status: status)
    return transport
}

@MainActor
@Test("service-version-drift-detection/AC-9 : un service plus ancien, plus récent ou sans version affiche l’avertissement exact invitant à /service install")
func driftingServiceShowsTheWarning() async throws {
    let older = "Le service OMP exécute omp-mem0-req 0.0.1 alors que le module installé est en 1.2.3\u{00A0}: lancez /service install dans OMP."
    let newer = "Le service OMP exécute omp-mem0-req 999.0.0 alors que le module installé est en 1.2.3\u{00A0}: lancez /service install dans OMP."
    let silent = "Le service OMP n’annonce pas sa version alors que le module installé est en 1.2.3\u{00A0}: lancez /service install dans OMP."
    let cases: [(announced: Any?, expected: String)] = [
        ("0.0.1", older),
        ("999.0.0", newer),
        (nil, silent),
        (NSNull(), silent),
        ("", silent),
    ]
    for (announced, expected) in cases {
        let fixture = try DriftFixture()
        try fixture.install(version: "1.2.3")
        try fixture.publishService(port: 8788)
        let transport = healthTransport(pluginVersion: announced)
        let model = fixture.model(transports: [8788: transport])
        #expect(model.warning == nil)
        await model.check()
        #expect(model.warning == expected, "pluginVersion annoncé : \(String(describing: announced))")
        #expect(transport.requests.map { "\($0.method) \($0.path)" } == ["GET /v1/health"])
        #expect(transport.requests.first?.token == String(repeating: "a", count: 32))
    }
}

@MainActor
@Test("service-version-drift-detection/AC-9 : versions identiques, service arrêté, 401 ou module illisible : aucun avertissement")
func noDriftShowsNothing() async throws {
    // Versions identiques.
    let same = try DriftFixture()
    try same.install(version: "1.2.3")
    try same.publishService(port: 8788)
    let sameModel = same.model(transports: [8788: healthTransport(pluginVersion: "1.2.3")])
    await sameModel.check()
    #expect(sameModel.warning == nil)

    // Service arrêté : aucun service.json, donc aucune requête.
    let stopped = try DriftFixture()
    try stopped.install(version: "1.2.3")
    let stoppedTransport = healthTransport(pluginVersion: "0.0.1")
    let stoppedModel = stopped.model(transports: [8788: stoppedTransport])
    await stoppedModel.check()
    #expect(stoppedModel.warning == nil)
    #expect(stoppedTransport.requests.isEmpty)

    // Service qui répond 401 : l'erreur se tait.
    let refused = try DriftFixture()
    try refused.install(version: "1.2.3")
    try refused.publishService(port: 8788)
    let refusedModel = refused.model(transports: [8788: healthTransport(pluginVersion: "0.0.1", status: 401)])
    await refusedModel.check()
    #expect(refusedModel.warning == nil)

    // Module installé absent : rien à comparer.
    let unreadable = try DriftFixture()
    try unreadable.publishService(port: 8788)
    let unreadableModel = unreadable.model(transports: [8788: healthTransport(pluginVersion: "0.0.1")])
    await unreadableModel.check()
    #expect(unreadableModel.warning == nil)
}

@MainActor
@Test("service-version-drift-detection/AC-10 : la republication de service.json à la bonne version retire l’avertissement sans relancer l’app")
func republishedServiceClearsTheWarning() async throws {
    let fixture = try DriftFixture()
    try fixture.install(version: "1.2.3")
    try fixture.publishService(port: 8788)
    let (changes, continuation) = AsyncStream<Void>.makeStream()
    let stale = healthTransport(pluginVersion: "0.0.1")
    let fresh = healthTransport(pluginVersion: "1.2.3")
    let model = fixture.model(transports: [8788: stale, 8789: fresh], changes: changes)

    model.start()
    #expect(await waitUntil { model.warning != nil })
    #expect(model.warning == "Le service OMP exécute omp-mem0-req 0.0.1 alors que le module installé est en 1.2.3\u{00A0}: lancez /service install dans OMP.")

    // Le service relancé à la bonne version republie service.json (nouveau port).
    try fixture.publishService(port: 8789)
    continuation.yield(())
    #expect(await waitUntil { model.warning == nil })
    #expect(fresh.requests.map(\.path) == ["/v1/health"])
    continuation.finish()
}
