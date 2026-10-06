// Preuves de S-2 : le code d'appairage, le jeton qu'il délivre et les refus.
//
// Tout passe par la pile RÉELLE du harnais (`RemoteStack`) : vrai serveur sur un
// port éphémère, vrai registre sur un fichier jetable, doublure de trousseau.

import ConsoleCore
import Foundation
import Testing

@testable import OMPConsole

@Suite("Remote appairage")
@MainActor
struct RemotePairingTests {
    @Test("api-distante-du-console/AC-2 : un code présenté délivre un jeton et inscrit l'appareil")
    func presentedCodeDeliversTokenAndRegistersDevice() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }

        let code = try stack.registry.generateCode().value
        let reply = try await stack.call("POST", "/v1/pair", json: [
            "code": code,
            "name": "Téléphone",
            "protocolVersion": ConsoleAPI.protocolVersion,
        ])

        #expect(reply.status == 200)
        let payload = try reply.json(RemotePairPayload.self)
        #expect(payload.token.count == 43)
        #expect(payload.protocolVersion == ConsoleAPI.protocolVersion)
        // Un UUID en MINUSCULES, qui se relit.
        #expect(payload.deviceId == payload.deviceId.lowercased())
        let deviceId = try #require(UUID(uuidString: payload.deviceId))

        // L'appareil est inscrit AUSSITÔT, sans relecture du fichier.
        #expect(stack.registry.devices.contains { $0.id == deviceId })
        #expect(stack.registry.devices.first?.name == "Téléphone")

        // Le jeton est bien celui rangé au trousseau, sous l'identifiant de l'appareil
        // (la clé du trousseau est l'`uuidString` canonique, comme à la révocation).
        let stored = try await stack.tokens.token(for: deviceId.uuidString)
        #expect(stored == payload.token)
    }

    @Test("api-distante-du-console/AC-3 : un code expiré ou consommé est refusé sans jeton")
    func expiredOrConsumedCodeIsRefusedWithoutToken() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }

        // (1) Expiration : l'horloge injectée dépasse le TTL, le registre ne bouge pas.
        let expiredCode = try stack.registry.generateCode().value
        stack.clock.advance(ms: Double(ConsoleAPI.Service.pairingCodeTTLSeconds) * 1000 + 1)
        let expired = try await stack.call("POST", "/v1/pair", json: ["code": expiredCode, "name": "Téléphone"])
        #expect(expired.status == 401)
        #expect(expired.errorCode == "unauthorized")
        #expect(stack.registry.devices.isEmpty)
        let knownAfterExpiry = await stack.tokens.knownTokens
        #expect(knownAfterExpiry.isEmpty)

        // (2) Consommation : un code présenté une fois ne sert plus.
        let code = try stack.registry.generateCode().value
        let first = try await stack.call("POST", "/v1/pair", json: ["code": code, "name": "Téléphone"])
        #expect(first.status == 200)
        let second = try await stack.call("POST", "/v1/pair", json: ["code": code, "name": "Téléphone"])
        #expect(second.status == 401)
        #expect(second.errorCode == "unauthorized")
        #expect(stack.registry.devices.count == 1)
    }

    @Test("api-distante-du-console/AC-24 : au-delà du seuil, même le bon code est refusé jusqu'à régénération")
    func pastTheThresholdEvenTheRightCodeIsRefused() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }

        let code = try stack.registry.generateCode().value
        let alphabet = Array(ConsoleAPI.Service.pairingCodeAlphabet)
        let last = try #require(alphabet.firstIndex(of: code.last!))
        let wrong = String(code.dropLast()) + String(alphabet[(last + 1) % alphabet.count])
        #expect(wrong != code)

        // Six refus : le seuil (5) est franchi à la sixième tentative.
        for attempt in 1...6 {
            let refused = try await stack.call("POST", "/v1/pair", json: ["code": wrong, "name": "Téléphone"])
            #expect(refused.status == 401, "tentative \(attempt)")
        }
        #expect(stack.registry.pairing.current?.failedAttempts == 6)

        // Même le BON code est refusé tant que rien n'a été regénéré.
        let locked = try await stack.call("POST", "/v1/pair", json: ["code": code, "name": "Téléphone"])
        #expect(locked.status == 401)
        #expect(stack.registry.devices.isEmpty)

        // Générer un NOUVEAU code est le seul déverrouillage.
        let fresh = try stack.registry.generateCode().value
        let paired = try await stack.call("POST", "/v1/pair", json: ["code": fresh, "name": "Téléphone"])
        #expect(paired.status == 200)
        #expect(stack.registry.devices.count == 1)
    }

    @Test("api-distante-du-console/AC-25 : l'espace des codes rend le balayage impraticable")
    func codeSpaceMakesScrubbingImpractical() throws {
        // L'espace est 32^8 = 2^40, le seuil 5 : 4,5·10⁻¹² de succès au mieux.
        let space = 1_099_511_627_776.0
        #expect(pow(32.0, 8.0) == space)
        #expect(ConsoleAPI.Service.pairingAttemptLimit == 5)
        #expect(Double(ConsoleAPI.Service.pairingAttemptLimit) / space < 1e-11)

        // Deux codes successifs diffèrent, et tous leurs caractères sont dans l'alphabet.
        let first = PairingCode.generate(at: 0).value
        let second = PairingCode.generate(at: 0).value
        #expect(first != second)
        let alphabet = Set(ConsoleAPI.Service.pairingCodeAlphabet)
        for code in [first, second] {
            #expect(code.count == ConsoleAPI.Service.pairingCodeLength)
            #expect(code.allSatisfy { alphabet.contains($0) })
        }
    }

    // MARK: - Refus du format

    @Test func malformedCodeIsRejectedWithoutCountingAnAttempt() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        _ = try stack.registry.generateCode()

        // Trop court, puis un caractère hors alphabet (le « I » de Crockford).
        let short = try await stack.call("POST", "/v1/pair", json: ["code": "ABC", "name": "Téléphone"])
        #expect(short.status == 400)
        #expect(short.errorCode == "bad_request")
        let stray = try await stack.call("POST", "/v1/pair", json: ["code": "IIIIIIII", "name": "Téléphone"])
        #expect(stray.status == 400)
        #expect(stray.errorCode == "bad_request")

        // Un format invalide n'est PAS un échec du compteur, et rien n'est inscrit.
        #expect(stack.registry.pairing.current?.failedAttempts == 0)
        #expect(stack.registry.devices.isEmpty)
    }

    @Test func blankAndOverlongNamesAreRejected() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let code = try stack.registry.generateCode().value

        let blank = try await stack.call("POST", "/v1/pair", json: ["code": code, "name": "   "])
        #expect(blank.status == 400)
        #expect(blank.errorCode == "bad_request")
        let overlong = try await stack.call(
            "POST",
            "/v1/pair",
            json: ["code": code, "name": String(repeating: "a", count: 65)]
        )
        #expect(overlong.status == 400)
        #expect(overlong.errorCode == "bad_request")
        #expect(stack.registry.devices.isEmpty)
        #expect(stack.registry.pairing.current?.failedAttempts == 0)
    }

    // MARK: - Le jeton ne fuit jamais

    @Test func devicesRouteNeverEchoesTheToken() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let token = try await stack.pair(name: "Téléphone")

        let reply = try await stack.call("GET", "/v1/devices", token: token)
        #expect(reply.status == 200)
        #expect(!reply.text.contains(token))
    }

    // MARK: - Le fichier du registre

    @Test func devicesFileIsWrittenPrivate() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        _ = try await stack.pair(name: "Téléphone")

        let directory = stack.supportRoot.appendingPathComponent("remote", isDirectory: true)
        let file = directory.appendingPathComponent("devices.json")
        let fileManager = FileManager.default
        #expect(fileManager.fileExists(atPath: file.path))

        let filePermissions = try #require(
            fileManager.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
        )
        #expect(filePermissions.intValue == 0o600)
        let directoryPermissions = try #require(
            fileManager.attributesOfItem(atPath: directory.path)[.posixPermissions] as? NSNumber
        )
        #expect(directoryPermissions.intValue == 0o700)
    }

    @Test func unreadableDevicesFileMakesPairingUnavailable() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }

        // On corrompt le fichier PUIS on relit : le registre retient la raison.
        let directory = stack.supportRoot.appendingPathComponent("remote", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("pas du JSON".utf8).write(to: directory.appendingPathComponent("devices.json"))
        await stack.registry.load()
        #expect(stack.registry.loadError != nil)

        var generationRefused = false
        do {
            _ = try stack.registry.generateCode()
        } catch {
            generationRefused = true
        }
        #expect(generationRefused)

        // Le code est bien formé : c'est le REGISTRE illisible qui refuse, en 503.
        let reply = try await stack.call("POST", "/v1/pair", json: ["code": "ABCDEFGH", "name": "Téléphone"])
        #expect(reply.status == 503)
        #expect(reply.errorCode == "unavailable")
    }
}
