// Le modèle précis de l'appareil, transmis au Mac comme nom à l'appairage.
//
// Depuis iOS 16, le nom donné par l'utilisateur exige un droit accordé par Apple :
// on n'envoie JAMAIS de nom personnel, seulement le nom commercial du modèle,
// tiré de son identifiant (`iPad16,6` ⇒ « iPad Pro 13 pouces (M4) »). Aucune API
// publique ne rend ce nom : la table ci-dessous le porte (noms de l'Assistance
// Apple en français). Sans UIKit : l'identifiant vient de Darwin.

import Darwin
import Foundation

public enum ClientDeviceModel {
    /// L'identifiant du modèle : celui du simulateur quand l'app y tourne, sinon
    /// `uname` (iOS) ou `hw.model` (macOS, tests).
    public static func identifier(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> String {
        if let simulated = environment["SIMULATOR_MODEL_IDENTIFIER"]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !simulated.isEmpty {
            return simulated
        }
        #if os(macOS)
        return hardwareModel()
        #else
        return machine()
        #endif
    }

    /// Le nom commercial d'un identifiant ; un identifiant inconnu retombe sur
    /// la famille, jamais sur l'identifiant brut.
    public static func displayName(forIdentifier identifier: String) -> String {
        if let name = names[identifier] { return name }
        if identifier.hasPrefix("iPad") { return "iPad" }
        if identifier.hasPrefix("iPhone") { return "iPhone" }
        if identifier.hasPrefix("Mac") { return "Mac" }
        return "Appareil Apple"
    }

    /// Le nom de l'appareil courant, tel qu'envoyé au Mac.
    public static var current: String {
        displayName(forIdentifier: identifier())
    }

    // MARK: - Lecture de l'identifiant

    #if os(macOS)
    private static func hardwareModel() -> String {
        var size = 0
        guard sysctlbyname("hw.model", nil, &size, nil, 0) == 0, size > 0 else { return "" }
        var bytes = [CChar](repeating: 0, count: size)
        guard sysctlbyname("hw.model", &bytes, &size, nil, 0) == 0 else { return "" }
        return String(decoding: bytes.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }
    #else
    private static func machine() -> String {
        var system = utsname()
        uname(&system)
        return withUnsafeBytes(of: &system.machine) {
            String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self)
        }
    }
    #endif

    // MARK: - Table

    /// Chaque ligne : les identifiants d'un même modèle, puis son nom.
    private static let models: [([String], String)] = [
        (["iPhone12,1"], "iPhone 11"),
        (["iPhone12,3"], "iPhone 11 Pro"),
        (["iPhone12,5"], "iPhone 11 Pro Max"),
        (["iPhone12,8"], "iPhone SE (2e génération)"),
        (["iPhone13,1"], "iPhone 12 mini"),
        (["iPhone13,2"], "iPhone 12"),
        (["iPhone13,3"], "iPhone 12 Pro"),
        (["iPhone13,4"], "iPhone 12 Pro Max"),
        (["iPhone14,2"], "iPhone 13 Pro"),
        (["iPhone14,3"], "iPhone 13 Pro Max"),
        (["iPhone14,4"], "iPhone 13 mini"),
        (["iPhone14,5"], "iPhone 13"),
        (["iPhone14,6"], "iPhone SE (3e génération)"),
        (["iPhone14,7"], "iPhone 14"),
        (["iPhone14,8"], "iPhone 14 Plus"),
        (["iPhone15,2"], "iPhone 14 Pro"),
        (["iPhone15,3"], "iPhone 14 Pro Max"),
        (["iPhone15,4"], "iPhone 15"),
        (["iPhone15,5"], "iPhone 15 Plus"),
        (["iPhone16,1"], "iPhone 15 Pro"),
        (["iPhone16,2"], "iPhone 15 Pro Max"),
        (["iPhone17,1"], "iPhone 16 Pro"),
        (["iPhone17,2"], "iPhone 16 Pro Max"),
        (["iPhone17,3"], "iPhone 16"),
        (["iPhone17,4"], "iPhone 16 Plus"),
        (["iPhone17,5"], "iPhone 16e"),
        (["iPhone18,1"], "iPhone 17 Pro"),
        (["iPhone18,2"], "iPhone 17 Pro Max"),
        (["iPhone18,3"], "iPhone 17"),
        (["iPhone18,4"], "iPhone Air"),
        (["iPhone18,5"], "iPhone 17e"),
        (["iPhone19,2"], "iPhone 18 Pro"),
        (["iPhone19,3", "iPhone19,7"], "iPhone 18 Pro Max"),
        (["iPad8,1", "iPad8,2", "iPad8,3", "iPad8,4"], "iPad Pro 11 pouces (1re génération)"),
        (["iPad8,5", "iPad8,6", "iPad8,7", "iPad8,8"], "iPad Pro 12,9 pouces (3e génération)"),
        (["iPad8,9", "iPad8,10"], "iPad Pro 11 pouces (2e génération)"),
        (["iPad8,11", "iPad8,12"], "iPad Pro 12,9 pouces (4e génération)"),
        (["iPad11,1", "iPad11,2"], "iPad mini (5e génération)"),
        (["iPad11,3", "iPad11,4"], "iPad Air (3e génération)"),
        (["iPad11,6", "iPad11,7"], "iPad (8e génération)"),
        (["iPad12,1", "iPad12,2"], "iPad (9e génération)"),
        (["iPad13,1", "iPad13,2"], "iPad Air (4e génération)"),
        (["iPad13,4", "iPad13,5", "iPad13,6", "iPad13,7"], "iPad Pro 11 pouces (3e génération)"),
        (["iPad13,8", "iPad13,9", "iPad13,10", "iPad13,11"], "iPad Pro 12,9 pouces (5e génération)"),
        (["iPad13,16", "iPad13,17"], "iPad Air (5e génération)"),
        (["iPad13,18", "iPad13,19"], "iPad (10e génération)"),
        (["iPad14,1", "iPad14,2"], "iPad mini (6e génération)"),
        (["iPad14,3", "iPad14,4"], "iPad Pro 11 pouces (4e génération)"),
        (["iPad14,5", "iPad14,6"], "iPad Pro 12,9 pouces (6e génération)"),
        (["iPad14,8", "iPad14,9"], "iPad Air 11 pouces (M2)"),
        (["iPad14,10", "iPad14,11"], "iPad Air 13 pouces (M2)"),
        (["iPad15,3", "iPad15,4"], "iPad Air 11 pouces (M3)"),
        (["iPad15,5", "iPad15,6"], "iPad Air 13 pouces (M3)"),
        (["iPad15,7", "iPad15,8"], "iPad (A16)"),
        (["iPad16,1", "iPad16,2"], "iPad mini (A17 Pro)"),
        (["iPad16,3", "iPad16,4"], "iPad Pro 11 pouces (M4)"),
        (["iPad16,5", "iPad16,6"], "iPad Pro 13 pouces (M4)"),
        (["iPad16,8", "iPad16,9"], "iPad Air 11 pouces (M4)"),
        (["iPad16,10", "iPad16,11"], "iPad Air 13 pouces (M4)"),
        (["iPad17,1", "iPad17,2"], "iPad Pro 11 pouces (M5)"),
        (["iPad17,3", "iPad17,4"], "iPad Pro 13 pouces (M5)"),
    ]

    private static let names: [String: String] = {
        var table: [String: String] = [:]
        for (identifiers, name) in models {
            for identifier in identifiers { table[identifier] = name }
        }
        return table
    }()
}
