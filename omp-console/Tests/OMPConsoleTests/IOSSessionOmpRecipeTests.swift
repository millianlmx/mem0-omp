// La recette OUTILLÉE de la feature ios-session-omp (S-8, AC-14) : piloter la
// session hébergée de bout en bout DEPUIS le client iOS, contre une coque réelle
// (pile locale sur un port éphémère, vraies routes, vrai registre, vrai flux).
//
// Elle est GATED par `MEM0_REMOTE_RECIPE=1` (patron `ProjectIOSRecipeTests.swift`) :
// sans la variable, elle rend la main sans rien éprouver — c'est le rejeu MANUEL
// de la recette pas à pas (README) qui reste la preuve d'écran.
//
// `swift test --filter iosSessionOmpRecipe` la cible ; son titre porte l'id.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

@MainActor
private final class SessionOmpRecipeDiscovery: DiscoverySource {
    var onChange: (([DiscoveredMac]) -> Void)?
    var onProtocolVersion: ((Int) -> Void)?
    var onDenied: ((Bool) -> Void)?
    func start(serviceType: String) {}
    func stop() {}
}

@MainActor
private final class SessionOmpRecipePath: ClientPathSource {
    var onChange: ((Bool) -> Void)?
    func start() {}
    func stop() {}
}

@MainActor
private func sessionOmpEventually(timeout: Double = 10, _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return condition()
}

@MainActor
@Suite("Recette ios-session-omp (coque réelle)")
struct IOSSessionOmpRecipeTests {
    @Test("ios-session-omp/AC-14 : recette réelle — lancer, écrire, répondre à un dialogue et arrêter depuis le client iOS")
    func iosSessionOmpRecipe() async throws {
        guard ProcessInfo.processInfo.environment["MEM0_REMOTE_RECIPE"] == "1" else { return }

        // Une coque réelle : un dépôt git jamais cadré, publié comme lot du magasin.
        let store = StoreFixture()
        let repoRoot = store.root + "/depot"
        try FileManager.default.createDirectory(atPath: repoRoot + "/.git", withIntermediateDirectories: true)
        store.publish(.lots, "\(fixtureId(0xF1)).json", object: lotObject(id: fixtureId(0xF1), repoRoot: repoRoot))

        let transport = ScriptedServiceTransport()
        let host = makeScriptedHostedHost(transport, sessionFile: store.root + "/session.jsonl", sessionId: "sess-recette")
        let stack = try await RemoteStack.make(
            stateDir: store.root,
            sessionModel: SessionConsoleModel(host: host)
        )
        defer { stack.stop() }

        // Le client iOS réel, branché sur l'adresse manuelle de la pile.
        let client = ConsoleClientModel(
            transport: ConsoleClient.URLSessionTransport(),
            discovery: SessionOmpRecipeDiscovery(),
            preferences: InMemoryClientPreferences(),
            tokens: InMemoryTokenStore(),
            pacer: LiveClientPacer(),
            pathSource: SessionOmpRecipePath()
        )
        defer { client.stop() }
        client.start()
        _ = client.setManualAddress("127.0.0.1:\(stack.port)")
        let code = try stack.registry.generateCode()
        try await client.pair(code: code.value, deviceName: "Recette iPad")
        #expect(await sessionOmpEventually { if case .connected = client.state { return true }; return false })

        // 1. GET /v1/repos — le dépôt est proposé AVEC sa clé.
        let repoRow = try #require(try await client.repos().rows.first { $0.repoRoot == realpathOr(repoRoot) })

        // 2. Lancement : l'état servi devient `running`.
        let launched = try await client.launchHostedSession(repoKey: repoRow.repoKey)
        #expect(launched.state == "running")
        #expect(launched.projectName == "depot")

        // 3. Un prompt atteint réellement la session (POSTÉ au service).
        _ = try await client.prompt(message: "bonjour depuis l'iPad")
        #expect(transport.requests.contains {
            $0.method == "POST" && $0.path.hasSuffix("/prompt") && ($0.body?["text"] as? String) == "bonjour depuis l'iPad"
        })

        // 4. Un dialogue poussé par le flux devient tranchable depuis le client.
        emitServiceDialog(transport, id: "recette-1", method: "select", title: "Choisir", options: ["a", "b"])
        #expect(await sessionOmpEventually { client.hosted?.dialogs.first?.id == "recette-1" })
        _ = try await client.answerHostedDialog(id: "recette-1", kind: "value", value: "b", confirmed: nil)
        #expect(await sessionOmpEventually { client.hosted?.dialogs.isEmpty == true })

        // 5. Arrêt : l'état servi passe à `stopped`.
        let stopped = try await client.stopHostedSession()
        #expect(stopped.state == "stopped")
    }
}
