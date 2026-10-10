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

    // MARK: - Identité d'appareil (mac-feuille-appairage-debordante)

    @Test("mac-feuille-appairage-debordante/AC-6 : un devices.json d'avant (sans deviceKey) se relit et se réécrit sans la clé")
    func legacyFileWithoutDeviceKeyIsReadAndRewrittenAsIs() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let file = stack.supportRoot.appendingPathComponent("remote/devices.json")
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let legacyId = UUID()
        try Data("""
        {"version":1,"devices":[{"id":"\(legacyId.uuidString)","name":"iPhone","pairedAtMs":1000,"lastSeenAtMs":2000}]}
        """.utf8).write(to: file)

        await stack.registry.load()
        #expect(stack.registry.loadError == nil)
        #expect(stack.registry.devices == [DeviceRecord(id: legacyId, name: "iPhone", pairedAtMs: 1000, lastSeenAtMs: 2000)])

        // Un appairage sans clé réécrit le fichier : aucune clé `deviceKey` n'apparaît.
        try await stack.pair(name: "Téléphone")
        let rewritten = try String(contentsOf: file, encoding: .utf8)
        #expect(!rewritten.contains("deviceKey"))
        #expect(rewritten.contains(legacyId.uuidString))

        // Une ligne qui porte une clé l'écrit, et seulement elle.
        let code = try stack.registry.generateCode().value
        let reply = try await stack.call("POST", "/v1/pair", json: ["code": code, "name": "iPhone 17e", "deviceKey": "cle-tel"])
        #expect(reply.status == 200)
        let keyed = try String(contentsOf: file, encoding: .utf8)
        #expect(keyed.components(separatedBy: "\"deviceKey\"").count == 2)
        await stack.registry.load()
        #expect(stack.registry.devices.count == 3)
        #expect(stack.registry.devices.first?.deviceKey == "cle-tel")
    }

    @Test("mac-feuille-appairage-debordante/AC-4 : le réappairage coupe le flux en cours de l'ancienne ligne")
    func repairingCutsTheReplacedDeviceStream() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        wireRevocation(to: stack)

        let first = try await keyedPair(stack, deviceKey: "cle-tab-a")
        let session = consoleStreamSession()
        defer { session.invalidateAndCancel() }
        let bytes = try await openConsoleStream(session, base: stack.base, token: first)
        var iterator = bytes.lines.makeAsyncIterator()
        var frames: [String] = []
        while let line = try await iterator.next() {
            if line.hasPrefix("event: ") { frames.append(line) }
            if frames.count >= 2 { break }
        }
        #expect(frames == ["event: hello", "event: store"])

        _ = try await keyedPair(stack, deviceKey: "cle-tab-a")
        let started = Date()
        do {
            while let _ = try await iterator.next() {}
        } catch {
            // Une fermeture peut aussi se manifester en erreur de lecture : c'est une fin.
        }
        #expect(Date().timeIntervalSince(started) < 4)
        #expect(stack.registry.devices.count == 1)
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

/// Un appairage HTTP portant une identité d'appareil ; rend le jeton.
@MainActor
private func keyedPair(_ stack: RemoteStack, deviceKey: String) async throws -> String {
    let code = try stack.registry.generateCode().value
    let reply = try await stack.call("POST", "/v1/pair", json: [
        "code": code,
        "name": "iPad Pro 13 pouces (M5)",
        "deviceKey": deviceKey,
    ])
    guard reply.status == 200 else { throw ConsoleAPIError.server("appairage refusé (\(reply.status))") }
    return try reply.json(RemotePairPayload.self).token
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
