// Preuves de S-6 : les appareils appairés, le drapeau `connected` et la
// révocation — qui refuse la requête suivante ET coupe le flux SSE en cours.
//
// Le flux est un VRAI `URLSession.bytes(for:)` contre le vrai serveur : c'est ce
// que le client verra.

import ConsoleCore
import Foundation
import Testing

@testable import OMPConsole

@Suite("Remote appareils")
@MainActor
struct DeviceRegistryTests {
    @Test("api-distante-du-console/AC-5 : la révocation refuse la requête suivante et coupe le flux en cours")
    func revocationRefusesNextRequestAndCutsStream() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        wireRevocation(to: stack)

        let token = try await stack.pair(name: "Téléphone")
        let deviceId = try #require(stack.registry.devices.first?.id)

        let session = consoleStreamSession()
        defer { session.invalidateAndCancel() }
        let bytes = try await openConsoleStream(session, base: stack.base, token: token)
        var iterator = bytes.lines.makeAsyncIterator()

        // Les deux premières trames : `hello` puis l'instantané du magasin.
        var frames: [String] = []
        while let line = try await iterator.next() {
            if line.hasPrefix("event: ") { frames.append(line) }
            if frames.count >= 2 { break }
        }
        #expect(frames == ["event: hello", "event: store"])

        // Révocation pendant que le flux est ouvert.
        await stack.registry.revoke(id: deviceId)

        // (a) La requête suivante du jeton révoqué est refusée.
        let refused = try await stack.call("GET", "/v1/devices", token: token)
        #expect(refused.status == 401)
        #expect(refused.errorCode == "unauthorized")

        // (b) Le flux EN COURS se termine — et tout de suite, pas à l'échéance.
        let started = Date()
        do {
            while let _ = try await iterator.next() {}
        } catch {
            // Une fermeture peut aussi se manifester en erreur de lecture : c'est une fin.
        }
        #expect(Date().timeIntervalSince(started) < 4)
        #expect(stack.registry.devices.isEmpty)
    }

    // MARK: - Révocation : jeton, fichier, requête

    @Test func testRevokeRemovesTokenFileAndKeychainEntry() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }

        let token = try await stack.pair(name: "Téléphone")
        let deviceId = try #require(stack.registry.devices.first?.id)
        let file = stack.supportRoot.appendingPathComponent("remote/devices.json")
        let before = String(decoding: (try? Data(contentsOf: file)) ?? Data(), as: UTF8.self)
        #expect(before.contains(deviceId.uuidString))

        await stack.registry.revoke(id: deviceId)

        // Le jeton a quitté la doublure de trousseau…
        let stored = try await stack.tokens.token(for: deviceId.uuidString)
        #expect(stored == nil)
        // …la ligne a quitté le fichier…
        let after = String(decoding: (try? Data(contentsOf: file)) ?? Data(), as: UTF8.self)
        #expect(!after.contains(deviceId.uuidString))
        #expect(!after.contains(token))
        // …et la requête suivante est refusée.
        let refused = try await stack.call("GET", "/v1/devices", token: token)
        #expect(refused.status == 401)
    }

    // MARK: - Drapeau de connexion

    @Test func testConnectedFlagFollowsStreams() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        wireRevocation(to: stack)

        let token = try await stack.pair(name: "Téléphone")
        let session = consoleStreamSession()
        defer { session.invalidateAndCancel() }
        let bytes = try await openConsoleStream(session, base: stack.base, token: token)
        var iterator = bytes.lines.makeAsyncIterator()
        var frames = 0
        while let line = try await iterator.next() {
            if line.hasPrefix("event: ") { frames += 1 }
            if frames >= 2 { break }
        }

        // Flux ouvert : l'appareil est `connected`.
        let during = try await stack.call("GET", "/v1/devices", token: token)
        let duringPayload = try during.json(RemoteDevicesPayload.self)
        #expect(duringPayload.devices.first?.connected == true)

        // Flux fermé côté client : le drapeau retombe, sans redémarrer quoi que ce soit.
        session.invalidateAndCancel()
        var connected = true
        for _ in 0..<50 {
            let reply = try await stack.call("GET", "/v1/devices", token: token)
            let payload = try reply.json(RemoteDevicesPayload.self)
            connected = payload.devices.first?.connected ?? true
            if !connected { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        #expect(connected == false)
    }

    // MARK: - La route des appareils

    @Test func testDevicesRouteIsOrderedAndHidesTokens() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }

        let firstToken = try await stack.pair(name: "Premier")
        stack.clock.advance(ms: 1_000)
        let secondToken = try await stack.pair(name: "Second")

        let reply = try await stack.call("GET", "/v1/devices", token: secondToken)
        #expect(reply.status == 200)
        let payload = try reply.json(RemoteDevicesPayload.self)
        #expect(payload.devices.count == 2)
        #expect(payload.devices[0].name == "Second")
        #expect(payload.devices[1].name == "Premier")
        #expect(payload.devices[0].pairedAtMs > payload.devices[1].pairedAtMs)
        #expect(payload.devices[0].connected == false)

        // Aucun jeton, nulle part — ni sous une clé `token`, ni en clair.
        #expect(!reply.text.contains("\"token\""))
        #expect(!reply.text.contains(firstToken))
        #expect(!reply.text.contains(secondToken))
    }

    // MARK: - Relecture

    @Test func testReloadKeepsTokens() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let token = try await stack.pair(name: "Téléphone")

        // Un SECOND registre, même fichier, même trousseau : la relecture rend le
        // même jeton authentifiable.
        let file = stack.supportRoot.appendingPathComponent("remote/devices.json")
        let reloaded = DeviceRegistry(file: file, store: stack.tokens, clock: stack.clock.clock)
        await reloaded.load()
        #expect(reloaded.loadError == nil)
        #expect(reloaded.devices.count == 1)
        #expect(reloaded.authenticate(token) != nil)
        #expect(reloaded.authenticate("jeton-inconnu") == nil)
    }
}

// MARK: - Outils de flux

/// La révocation coupe le flux : c'est le câblage que le service réel (S-6) fait,
/// et que le harnais laisse à l'appelant.
@MainActor
private func wireRevocation(to stack: RemoteStack) {
    stack.registry.revokeHandler = { [streams = stack.streams] deviceId in
        streams.close(deviceId: deviceId)
    }
}

/// Une session à configuration éphémère, bornée dans le temps : le test ne peut
/// pas rester suspendu sur un flux qui ne finit pas.
func consoleStreamSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 5
    configuration.timeoutIntervalForResource = 20
    return URLSession(configuration: configuration)
}

/// Ouvre `GET /v1/stream` sur le vrai serveur et rend les octets SSE.
func openConsoleStream(_ session: URLSession, base: String, token: String) async throws -> URLSession.AsyncBytes {
    var request = URLRequest(url: URL(string: base + "/v1/stream")!)
    request.setValue(String(ConsoleAPI.protocolVersion), forHTTPHeaderField: ConsoleAPI.Service.protocolHeader)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    let (bytes, response) = try await session.bytes(for: request)
    #expect((response as? HTTPURLResponse)?.statusCode == 200)
    return bytes
}
