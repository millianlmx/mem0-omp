// La mémoire d'un serveur (memoire-du-serveur) : quand l'appairage a posé
// `~/.omp/mem0.json` vers un serveur, ou que MEM0_HTTP_URL désigne une adresse hors
// de ce Mac, la préparation arrête l'agent mem0-rs de l'app au lieu de le démarrer.
// Aucun launchctl réel : la doublure `AgentDouble` de MemoryAgentTests joue launchd.

import Foundation
import Testing

@testable import OMPConsole

/// Un HOME jetable, avec ou sans `.omp/mem0.json`.
private func home(settings: [String: Any]?) throws -> String {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("omp-console-home-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir.appendingPathComponent(".omp"), withIntermediateDirectories: true)
    if let settings {
        try JSONSerialization.data(withJSONObject: settings).write(to: dir.appendingPathComponent(".omp/mem0.json"))
    }
    return dir.path
}

@MainActor
private func agent(_ sandbox: AgentSandbox, _ double: AgentDouble) -> MemoryAgent {
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
    return agent
}

@Test("memoire-du-serveur/AC-1 : un mem0.json ou un MEM0_HTTP_URL hors de ce Mac désigne la mémoire d'un serveur ; sans fichier, ou vers ce Mac, la mémoire est celle de l'app")
func memoryHostingFollowsPairing() throws {
    let paired = try home(settings: ["url": "https://vps.tailnet.ts.net:8443", "token": "jeton-vps"])
    #expect(MemoryHosting.resolve(environment: ["HOME": paired]) == .server(URL(string: "https://vps.tailnet.ts.net:8443")!))

    let bare = try home(settings: nil)
    #expect(MemoryHosting.resolve(environment: ["HOME": bare]) == .local)
    #expect(
        MemoryHosting.resolve(environment: ["HOME": bare, "MEM0_HTTP_URL": "http://vps.example:8321"])
            == .server(URL(string: "http://vps.example:8321")!)
    )

    // Une pile sur ce Mac, même choisie dans le fichier, n'est pas un serveur.
    let localStack = try home(settings: ["url": "http://127.0.0.1:8322", "token": "jeton-pile"])
    #expect(MemoryHosting.resolve(environment: ["HOME": localStack]) == .local)
}

@MainActor
@Test("memoire-du-serveur/AC-2 : ensureStopped décharge un job chargé et retire son plist ; sans job ni plist, il ne fait qu'un print")
func ensureStoppedUnloadsAndRemovesPlist() async throws {
    let sandbox = try AgentSandbox()
    defer { sandbox.remove() }

    let double = AgentDouble()
    double.loaded = true
    double.printsBeforeUnload = 1
    let running = agent(sandbox, double)
    try FileManager.default.createDirectory(
        at: running.plistURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    try Data("<plist/>".utf8).write(to: running.plistURL)

    let wasLoaded = try await running.ensureStopped()
    #expect(wasLoaded)
    #expect(!double.loaded)
    #expect(double.launchctlVerbs.first == "print")
    #expect(double.launchctlVerbs.contains("bootout"))
    #expect(!double.launchctlVerbs.contains("bootstrap"))
    #expect(!FileManager.default.fileExists(atPath: running.plistURL.path), "un plist laissé serait relancé à la session suivante")

    let idle = AgentDouble()
    let stopped = agent(sandbox, idle)
    let again = try await stopped.ensureStopped()
    #expect(!again)
    #expect(idle.launchctlVerbs == ["print"])
}
