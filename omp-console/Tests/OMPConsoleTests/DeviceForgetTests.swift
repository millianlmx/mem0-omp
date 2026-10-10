// « Oublier ce Mac » contre la VRAIE pile (S-4 de connexion-ios-feuille-intrusive-et-sans) :
// `DELETE /v1/devices/self` révoque l'appareil porteur du jeton, et lui seul, par la
// révocation existante du registre.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

@MainActor
private final class ForgetDiscovery: DiscoverySource {
    var onChange: (([DiscoveredMac]) -> Void)?
    var onProtocolVersion: ((Int) -> Void)?
    var onDenied: ((Bool) -> Void)?
    func start(serviceType: String) {}
    func stop() {}
}

@MainActor
private final class ForgetPath: ClientPathSource {
    var onChange: ((Bool) -> Void)?
    func start() {}
    func stop() {}
}

@MainActor
@Suite("Oublier ce Mac (pile réelle)")
struct DeviceForgetTests {
    @Test("connexion-ios-feuille-intrusive-et-sans/AC-10 : l'appareil oublié disparaît du registre et de GET /v1/devices, son jeton rend 401")
    func forgetRevokesOnlyTheCaller() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        stack.registry.revokeHandler = { [streams = stack.streams] id in streams.close(deviceId: id) }

        // B : un autre appareil appairé, témoin de la liste.
        let tokenB = try await stack.pair(name: "Témoin")

        // A : le client réel, appairé puis connecté par son flux.
        let tokens = InMemoryTokenStore()
        let model = ConsoleClientModel(
            transport: ConsoleClient.URLSessionTransport(),
            discovery: ForgetDiscovery(),
            preferences: InMemoryClientPreferences(),
            tokens: tokens,
            pacer: LiveClientPacer(),
            pathSource: ForgetPath()
        )
        model.start()
        _ = model.setManualAddress("127.0.0.1:\(stack.port)")
        try await model.pair(code: try stack.registry.generateCode().value, deviceName: "Oublié")
        #expect(model.pairingFailure == nil)
        let endpoint = ClientEndpoint.manual(host: "127.0.0.1", port: Int(stack.port))
        #expect(await waitUntil { model.state == .connected(endpoint: endpoint) })
        #expect(stack.registry.devices.count == 2)
        let tokenA = try #require(await tokens.knownTokens.values.first)
        let idA = try #require(stack.registry.authenticate(tokenA)?.id)

        await model.forget()

        #expect(model.pairing == .unpaired)
        #expect(await tokens.knownTokens.isEmpty)
        // Le registre ne contient plus A ; B reste.
        #expect(!stack.registry.devices.contains { $0.id == idA })
        #expect(stack.registry.devices.count == 1)
        // B ne voit plus A dans la liste servie.
        let listed = try await stack.call("GET", "/v1/devices", token: tokenB)
        #expect(listed.status == 200)
        let rows = try listed.json(OMPConsole.RemoteDevicesPayload.self).devices
        #expect(rows.map(\.name) == ["Témoin"])
        #expect(!rows.contains { $0.id == idA.uuidString.lowercased() })
        // Le jeton de A rend 401 sur toute route, et un second DELETE aussi.
        let read = try await stack.call("GET", "/v1/store", token: tokenA)
        #expect(read.status == 401)
        let again = try await stack.call("DELETE", "/v1/devices/self", token: tokenA)
        #expect(again.status == 401)
        #expect(String(decoding: again.body, as: UTF8.self).contains(#""code":"unauthorized""#))
        model.stop()
    }

    @Test("connexion-ios-feuille-intrusive-et-sans/AC-10 : DELETE /v1/devices/self rend 200 {accepted:true} au porteur, 401 sans jeton")
    func routeContract() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let token = try await stack.pair(name: "Seul")
        let other = try await stack.pair(name: "Autre")

        let anonymous = try await stack.call("DELETE", "/v1/devices/self")
        #expect(anonymous.status == 401)
        #expect(String(decoding: anonymous.body, as: UTF8.self).contains(#""code":"unauthorized""#))
        #expect(stack.registry.devices.count == 2, "aucun effet sans jeton")

        let accepted = try await stack.call("DELETE", "/v1/devices/self", token: token)
        #expect(accepted.status == 200)
        #expect(try accepted.json(OMPConsole.RemoteAcceptedPayload.self) == OMPConsole.RemoteAcceptedPayload(accepted: true))
        #expect(stack.registry.devices.map(\.name) == ["Autre"], "seul le porteur du jeton est révoqué")
        #expect(try await stack.call("GET", "/v1/devices", token: other).status == 200)

        // Le fichier du registre ne le porte plus.
        let file = stack.supportRoot.appendingPathComponent("remote/devices.json")
        let saved = String(decoding: try Data(contentsOf: file), as: UTF8.self)
        #expect(!saved.contains("Seul"))
        #expect(saved.contains("Autre"))
    }
}

/// Attend qu'une condition devienne vraie (serveur réel : délai généreux).
@MainActor
private func waitUntil(timeout: Double = 10, _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return condition()
}
