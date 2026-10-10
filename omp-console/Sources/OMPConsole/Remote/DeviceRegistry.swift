// Le registre des appareils appairés (S-2, S-6) : qui a le droit de parler à
// l'API, et avec quel jeton. Le fichier est versionné et TOLÉRANT (absent =
// registre vide, illisible = registre vide + une raison remontée à la surface) ;
// les jetons, eux, ne quittent jamais le trousseau.
//
// Tout est sur l'acteur principal : génération, tentative et consommation sont
// donc sérialisées — deux appairages simultanés avec le même code, le premier
// consomme, le second reçoit 401.

import ConsoleCore
import Foundation

/// Le contenu du fichier `<supportRoot>/remote/devices.json`.
struct DeviceFile: Codable, Equatable, Sendable {
    static let currentVersion = 1
    var version: Int = DeviceFile.currentVersion
    var devices: [DeviceRecord] = []
}

/// Un appareil appairé — jamais son jeton.
struct DeviceRecord: Identifiable, Equatable, Sendable, Codable {
    var id: UUID
    var name: String
    /// L'identité de l'installation cliente (`client.installationId`) : un
    /// réappairage de la même clé remplace la ligne. `nil` pour une ligne d'un
    /// client d'avant — jamais remplacée ni fusionnée. Omise du fichier quand nil.
    var deviceKey: String?
    var pairedAtMs: Double
    var lastSeenAtMs: Double
}

/// Un appareil neuf, avec le jeton qui vient de lui être délivré.
struct PairedDevice: Equatable, Sendable {
    var device: DeviceRecord
    var token: String
}

@MainActor
final class DeviceRegistry: ObservableObject {
    @Published private(set) var devices: [DeviceRecord] = []
    /// La raison d'un registre illisible, quand il l'est.
    @Published private(set) var loadError: String?
    /// Faux tant que le fichier et le trousseau n'ont pas été relus.
    @Published private(set) var isLoaded = false
    @Published private(set) var pairing = PairingState()

    /// Les appareils qui ont au moins un flux SSE ouvert (S-13).
    @Published private(set) var connected: Set<UUID> = []

    let clock: RemoteClock
    /// Appelée par `revoke(id:)` AVANT de rendre la main : elle coupe les flux
    /// ouverts de l'appareil (BR-8).
    var revokeHandler: ((UUID) -> Void)?
    /// Appelée quand ce que le flux `devices` publie change (dernière activité,
    /// connexion, appairage, révocation).
    var changeHandler: (() -> Void)?

    private var tokens: [String: UUID] = [:]
    private let file: URL?
    private let store: DeviceTokenStore
    private let fileManager: FileManager
    private var lastSavedMinute: Int?

    init(
        file: URL?,
        store: DeviceTokenStore = KeychainDeviceTokenStore(),
        clock: RemoteClock = .live,
        fileManager: FileManager = .default
    ) {
        self.file = file
        self.store = store
        self.clock = clock
        self.fileManager = fileManager
    }

    /// Charge le fichier puis les jetons du trousseau. Tolérant : un fichier
    /// illisible laisse un registre vide et une raison.
    func load() async {
        loadError = nil
        devices = []
        tokens = [:]
        if let file, fileManager.fileExists(atPath: file.path) {
            do {
                let data = try Data(contentsOf: file)
                devices = try JSONDecoder().decode(DeviceFile.self, from: data)
                    .devices
                    .sorted { $0.pairedAtMs > $1.pairedAtMs }
            } catch {
                loadError = "fichier illisible (\(file.lastPathComponent))"
                devices = []
            }
        }
        for device in devices {
            let stored: String?? = try? await store.token(for: device.id.uuidString)
            if let token = stored ?? nil { tokens[token] = device.id }
        }
        isLoaded = true
    }

    // MARK: - Appairage

    /// Génère un code neuf. Un registre illisible refuse de générer (S-2).
    @discardableResult
    func generateCode() throws -> PairingCode {
        if let loadError { throw ConsoleAPIError.unavailable(Self.loadMessage(loadError)) }
        return pairing.generate(at: clock.nowMs())
    }

    /// Présente un code : succès ⇒ un jeton, l'appareil inscrit et le code consommé.
    /// Tout refus est un `401 unauthorized` indiscernable (S-2).
    ///
    /// Avec une `deviceKey`, les lignes qui portent la MÊME clé sont remplacées :
    /// leur jeton est refusé dès cet instant, leur article du trousseau retiré et
    /// leurs flux fermés. Si le nouveau jeton ne peut être rangé, rien ne change.
    func pair(code presented: String, name: String, deviceKey: String?) async throws -> PairedDevice {
        if let loadError { throw ConsoleAPIError.unavailable(Self.loadMessage(loadError)) }
        let outcome = pairing.attempt(presented, at: clock.nowMs())
        guard outcome == .paired else { throw ConsoleAPIError.unauthorized }

        let device = DeviceRecord(
            id: UUID(),
            name: name,
            deviceKey: deviceKey,
            pairedAtMs: clock.nowMs(),
            lastSeenAtMs: clock.nowMs()
        )
        let token = Self.makeToken()
        try await store.save(token, for: device.id.uuidString)

        // Évaluées APRÈS l'attente du trousseau : un appairage concurrent a pu
        // inscrire entre-temps une ligne de la même clé.
        let replaced = deviceKey.map { key in devices.filter { $0.deviceKey == key }.map(\.id) } ?? []
        let replacedSet = Set(replaced)
        tokens = tokens.filter { !replacedSet.contains($0.value) }
        devices.removeAll { replacedSet.contains($0.id) }
        connected.subtract(replacedSet)
        tokens[token] = device.id
        devices.insert(device, at: 0)
        persist()
        for id in replaced {
            try? await store.remove(deviceId: id.uuidString)
        }
        changeHandler?()
        for id in replaced {
            revokeHandler?(id)
        }
        return PairedDevice(device: device, token: token)
    }

    /// L'appareil d'un jeton, ou `nil`. La comparaison est à temps constant et
    /// parcourt TOUS les jetons connus.
    func authenticate(_ token: String) -> DeviceRecord? {
        var match: UUID?
        for (known, deviceId) in tokens where ConstantTime.equal(known, token) {
            match = deviceId
        }
        guard let match else { return nil }
        return devices.first { $0.id == match }
    }

    /// La dernière activité, en mémoire ; le fichier n'est réécrit que quand la
    /// minute change (S-2).
    func touch(id: UUID, at nowMs: Double) {
        guard let index = devices.firstIndex(where: { $0.id == id }) else { return }
        devices[index].lastSeenAtMs = nowMs
        let minute = Int(nowMs / 60_000)
        if minute != lastSavedMinute {
            lastSavedMinute = minute
            persist()
        }
        changeHandler?()
    }

    /// Un code expiré n'est plus actif (la surface le retire).
    func pruneExpiredCode(at nowMs: Double) {
        pairing.pruneExpired(at: nowMs)
    }

    /// Annule le code actif (service coupé). Rien n'est persisté : le code ne vit
    /// qu'en mémoire.
    func cancelCode() {
        pairing.cancel()
    }

    func markConnected(_ id: UUID, _ isConnected: Bool) {
        if isConnected { connected.insert(id) } else { connected.remove(id) }
        changeHandler?()
    }

    /// Révoque : jeton en mémoire, article du trousseau, ligne du fichier, PUIS les
    /// flux ouverts — la fermeture est observable avant que la révocation rende la
    /// main (AC-5).
    func revoke(id: UUID) async {
        tokens = tokens.filter { $0.value != id }
        devices.removeAll { $0.id == id }
        connected.remove(id)
        persist()
        try? await store.remove(deviceId: id.uuidString)
        changeHandler?()
        revokeHandler?(id)
    }

    // MARK: - Présentation

    static func loadMessage(_ reason: String) -> String {
        "Le registre des appareils est illisible : \(reason)"
    }

    private func persist() {
        guard let file else { return }
        do {
            try fileManager.createDirectory(
                at: file.deletingLastPathComponent(),
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(DeviceFile(devices: devices))
            try data.write(to: file, options: [.atomic])
            try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        } catch {
            loadError = "écriture impossible (\(file.lastPathComponent))"
        }
    }

    /// 32 octets aléatoires en base64url sans remplissage : 43 caractères.
    static func makeToken() -> String {
        var generator = SystemRandomNumberGenerator()
        let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
        return Data(bytes)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
