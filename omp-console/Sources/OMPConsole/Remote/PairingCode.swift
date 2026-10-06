// Le code d'appairage (S-2) : huit caractères Crockford base32, une durée de vie
// courte, un compteur d'échecs — et le VERROUILLAGE au-delà du seuil. L'état est
// PUR (aucune E/S, aucune horloge implicite) : la route d'appairage ne fait que
// l'appeler, et les tests le font expirer ou verrouiller sans dormir.

import ConsoleCore
import Foundation

/// Le code actif et son compteur d'échecs.
struct PairingCode: Equatable, Sendable {
    let value: String
    let createdAtMs: Double
    let expiresAtMs: Double
    private(set) var failedAttempts: Int = 0

    var isLocked: Bool { failedAttempts > ConsoleAPI.Service.pairingAttemptLimit }

    func isExpired(at nowMs: Double) -> Bool { nowMs >= expiresAtMs }

    /// Le code est-il encore utilisable (ni expiré, ni verrouillé) ?
    func isActive(at nowMs: Double) -> Bool { !isExpired(at: nowMs) && !isLocked }

    /// Un échec de plus : au-delà du seuil, le code se verrouille.
    mutating func registerFailure() { failedAttempts += 1 }

    mutating func resetFailures() { failedAttempts = 0 }

    /// Une tentative : le code présenté est comparé APRÈS passage en majuscules
    /// (la saisie est insensible à la casse), et le résultat dit POURQUOI.
    mutating func attempt(_ presented: String, at nowMs: Double) -> PairingOutcome {
        if isLocked { return .refused }
        if isExpired(at: nowMs) { return .expired }
        if presented.uppercased() == value.uppercased() { return .paired }
        registerFailure()
        return isLocked ? .locked : .refused
    }

    /// Un code neuf, tiré par le générateur CRYPTOGRAPHIQUE du système (AC-25) :
    /// jamais `Int.random` d'une source non sûre.
    static func generate(
        at nowMs: Double,
        ttlSeconds: Double = Double(ConsoleAPI.Service.pairingCodeTTLSeconds),
        using generator: inout some RandomNumberGenerator
    ) -> PairingCode {
        let alphabet = Array(ConsoleAPI.Service.pairingCodeAlphabet)
        let symbols = (0..<ConsoleAPI.Service.pairingCodeLength).map { _ in
            alphabet.randomElement(using: &generator)!
        }
        return PairingCode(
            value: String(symbols),
            createdAtMs: nowMs,
            expiresAtMs: nowMs + ttlSeconds * 1000
        )
    }

    static func generate(at nowMs: Double) -> PairingCode {
        var generator = SystemRandomNumberGenerator()
        return generate(at: nowMs, using: &generator)
    }
}

/// Le verdict d'une tentative (S-2) : indiscernables pour le client, distincts ici.
enum PairingOutcome: Equatable, Sendable {
    case paired
    case refused
    case locked
    case expired
}

/// L'état d'appairage : le code actif (ou aucun), et lui seul.
struct PairingState: Equatable, Sendable {
    private(set) var active: PairingCode?

    var current: PairingCode? { active }

    /// Génère un code neuf : il REMPLACE l'ancien, qui devient inutilisable, et
    /// remet le compteur à zéro (seul déverrouillage).
    @discardableResult
    mutating func generate(at nowMs: Double) -> PairingCode {
        let code = PairingCode.generate(at: nowMs)
        active = code
        return code
    }

    /// Une tentative de l'appareil. Un succès CONSOMME le code.
    mutating func attempt(_ presented: String, at nowMs: Double) -> PairingOutcome {
        guard var code = active else { return .refused }
        let outcome = code.attempt(presented, at: nowMs)
        active = outcome == .paired ? nil : code
        return outcome
    }

    /// Un code expiré n'est plus actif : la surface le retire sans message d'erreur.
    mutating func pruneExpired(at nowMs: Double) {
        if let code = active, code.isExpired(at: nowMs) { active = nil }
    }
}

/// Les chaînes de présentation du code (pures).
enum PairingPresentation {
    /// `XXXX-XXXX` : le groupement qui rend le code lisible à voix haute.
    static func grouped(_ code: String, group: Int = 4) -> String {
        var groups: [String] = []
        var index = code.startIndex
        while index < code.endIndex {
            let end = code.index(index, offsetBy: group, limitedBy: code.endIndex) ?? code.endIndex
            groups.append(String(code[index..<end]))
            index = end
        }
        return groups.joined(separator: "-")
    }

    /// Le compte à rebours `mm:ss` restant avant l'échéance (`00:00` après).
    static func countdown(expiresAtMs: Double, nowMs: Double) -> String {
        let remaining = expiresAtMs - nowMs
        guard remaining > 0 else { return "00:00" }
        let totalSeconds = Int(remaining / 1000)
        let minutes = totalSeconds / 60
        let seconds = totalSeconds % 60
        return String(format: "%02d:%02d", minutes, seconds)
    }
}
