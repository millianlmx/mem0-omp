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

    // MARK: - mac-feuille-appairage-debordante : code groupé, identité d'appareil

    @Test("mac-feuille-appairage-debordante/AC-11 : le code affiché « XXXX-XXXX » est accepté tel quel, sans tiret ou en minuscules")
    func groupedAndLowercaseCodesArePaired() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let forms: [(String) -> String] = [
            { PairingPresentation.grouped($0) },
            { $0 },
            { PairingPresentation.grouped($0).lowercased() },
        ]
        for (index, form) in forms.enumerated() {
            let presented = form(try stack.registry.generateCode().value)
            let reply = try await stack.call("POST", "/v1/pair", json: ["code": presented, "name": "Téléphone \(index)"])
            #expect(reply.status == 200, "« \(presented) »")
        }
        #expect(stack.registry.devices.count == 3)
    }

    @Test("mac-feuille-appairage-debordante/AC-4 : un réappairage de la même clé remplace la ligne et révoque l'ancien jeton")
    func repairingSameKeyReplacesRowAndRevokesOldToken() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let first = try await pairReply(stack, name: "iPad Pro 13 pouces (M5)", deviceKey: "cle-tab-a")
        let firstId = try #require(UUID(uuidString: first.deviceId))
        #expect(stack.registry.devices.count == 1)

        stack.clock.advance(ms: 3_600_000)
        let second = try await pairReply(stack, name: "iPad Pro 13 pouces (M5)", deviceKey: "cle-tab-a")
        let secondId = try #require(UUID(uuidString: second.deviceId))

        // Même nombre de lignes ; la ligne est celle du nouvel appairage.
        #expect(stack.registry.devices.count == 1)
        #expect(stack.registry.devices.first?.id == secondId)
        #expect(secondId != firstId)
        #expect(stack.registry.devices.first?.pairedAtMs == stack.clock.nowMs)

        // L'ancien jeton est refusé, le nouveau accepté ; l'ancien article du trousseau est retiré.
        let refused = try await stack.call("GET", "/v1/devices", token: first.token)
        #expect(refused.status == 401)
        let accepted = try await stack.call("GET", "/v1/devices", token: second.token)
        #expect(accepted.status == 200)
        #expect(await stack.tokens.knownTokens[firstId.uuidString] == nil)
        #expect(await stack.tokens.knownTokens[secondId.uuidString] == second.token)

        // Le fichier relu ne garde que la nouvelle ligne.
        await stack.registry.load()
        #expect(stack.registry.devices.map(\.id) == [secondId])
    }

    @Test("mac-feuille-appairage-debordante/AC-5 : deux appareils distincts du même modèle gardent deux lignes révocables séparément")
    func twoKeysOfSameModelKeepTwoRows() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let tabA = try await pairReply(stack, name: "iPad Pro 13 pouces (M5)", deviceKey: "cle-tab-a")
        let tabB = try await pairReply(stack, name: "iPad Pro 13 pouces (M5)", deviceKey: "cle-tab-b")
        let idA = try #require(UUID(uuidString: tabA.deviceId))
        let idB = try #require(UUID(uuidString: tabB.deviceId))

        #expect(stack.registry.devices.count == 2)
        #expect(Set(stack.registry.devices.map(\.id)) == [idA, idB])
        #expect(stack.registry.devices.allSatisfy { $0.name == "iPad Pro 13 pouces (M5)" })

        await stack.registry.revoke(id: idA)
        #expect(stack.registry.devices.map(\.id) == [idB])
        #expect(try await stack.call("GET", "/v1/devices", token: tabA.token).status == 401)
        #expect(try await stack.call("GET", "/v1/devices", token: tabB.token).status == 200)
    }

    @Test("mac-feuille-appairage-debordante/AC-6 : les lignes héritées sans clé survivent au réappairage et restent révocables")
    func legacyRowsSurviveRepairingAndStayRevocable() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        // Deux lignes « iPhone » d'un client d'avant : aucune clé.
        try await stack.pair(name: "iPhone")
        try await stack.pair(name: "iPhone")
        let legacy = stack.registry.devices.map(\.id)
        #expect(stack.registry.devices.allSatisfy { $0.deviceKey == nil })

        _ = try await pairReply(stack, name: "iPhone 17e", deviceKey: "cle-tel")
        _ = try await pairReply(stack, name: "iPhone 17e", deviceKey: "cle-tel")
        #expect(stack.registry.devices.count == 3)
        #expect(Set(legacy).isSubset(of: Set(stack.registry.devices.map(\.id))))
        #expect(stack.registry.devices.filter { $0.name == "iPhone" }.count == 2)

        await stack.registry.revoke(id: legacy[0])
        #expect(stack.registry.devices.count == 2)
        #expect(!stack.registry.devices.contains { $0.id == legacy[0] })
        #expect(stack.registry.devices.contains { $0.id == legacy[1] })
    }

    @Test("mac-feuille-appairage-debordante/AC-4 : une clé blanche ou trop longue est refusée sans compter de tentative")
    func blankAndOverlongDeviceKeysAreRejected() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let code = try stack.registry.generateCode().value
        for key in ["   ", String(repeating: "k", count: 65)] {
            let reply = try await stack.call(
                "POST",
                "/v1/pair",
                json: ["code": code, "name": "Téléphone", "deviceKey": key]
            )
            #expect(reply.status == 400)
            #expect(reply.errorCode == "bad_request")
        }
        #expect(stack.registry.devices.isEmpty)
        #expect(stack.registry.pairing.current?.failedAttempts == 0)
        // Le code n'est pas consommé : une clé de 64 caractères passe.
        let ok = try await stack.call(
            "POST",
            "/v1/pair",
            json: ["code": code, "name": "Téléphone", "deviceKey": String(repeating: "k", count: 64)]
        )
        #expect(ok.status == 200)
    }

    @Test("mac-feuille-appairage-debordante/AC-4 : si le nouveau jeton ne peut être rangé, l'ancienne ligne et son jeton restent")
    func keychainFailureLeavesPreviousRowIntact() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("pairing-keychain-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SwitchableDeviceTokenStore()
        let registry = DeviceRegistry(file: root.appendingPathComponent("devices.json"), store: store)
        await registry.load()

        let first = try await registry.pair(
            code: try registry.generateCode().value, name: "iPhone 17e", deviceKey: "cle-tel"
        )
        await store.failSaves(true)
        var failed = false
        do {
            _ = try await registry.pair(code: try registry.generateCode().value, name: "iPhone 17e", deviceKey: "cle-tel")
        } catch {
            failed = true
        }
        #expect(failed)
        #expect(registry.devices == [first.device])
        #expect(registry.authenticate(first.token)?.id == first.device.id)
        #expect(await store.knownTokens == [first.device.id.uuidString: first.token])
    }
}

/// Un appairage HTTP avec une identité d'appareil.
@MainActor
private func pairReply(_ stack: RemoteStack, name: String, deviceKey: String) async throws -> RemotePairPayload {
    let code = try stack.registry.generateCode().value
    let reply = try await stack.call("POST", "/v1/pair", json: [
        "code": code,
        "name": name,
        "deviceKey": deviceKey,
        "protocolVersion": ConsoleAPI.protocolVersion,
    ])
    guard reply.status == 200 else { throw ConsoleAPIError.server("appairage refusé (\(reply.status))") }
    return try reply.json(RemotePairPayload.self)
}

/// Un trousseau dont l'écriture peut être mise en échec.
private actor SwitchableDeviceTokenStore: DeviceTokenStore {
    private var tokens: [String: String] = [:]
    private var failing = false

    func failSaves(_ value: Bool) { failing = value }

    func save(_ token: String, for deviceId: String) async throws {
        if failing { throw ConsoleAPIError.server("trousseau indisponible") }
        tokens[deviceId] = token
    }

    func token(for deviceId: String) async throws -> String? { tokens[deviceId] }

    func remove(deviceId: String) async throws { tokens[deviceId] = nil }

    var knownTokens: [String: String] { tokens }
}
