// Les textes de la section « Dépôts » propres à la coque Mac (S-6 de
// orchestrator-living-in-a-vps) : le bloc de connexion au VPS. Les textes partagés
// avec l'app iOS (titres, états des lignes, confirmation) vivent dans
// `ConsoleCore/Repos/ReposText.swift` ; aucune vue ne compose une phrase.

import ConsoleClient
import ConsoleCore

enum ReposViewText {
    static let addressPlaceholder = "Adresse Tailscale, par exemple 100.64.0.7"
    static let codePlaceholder = "ABCD-EFGH"
    static let pairing = "Appairage…"
    static let connecting = "Connexion au VPS…"
    static let handoverBusy = "Bascule en cours…"

    static func connected(address: String) -> String { "Connecté — \(address)" }

    /// Le chemin d'un dépôt sur une machine : « Mac : ~/… ».
    static func path(_ machine: RepoMachine, _ path: String) -> String { "\(machine.label)\u{00A0}: \(path)" }

    static let refused = "Le VPS a refusé cet appareil\u{00A0}: appairez-le de nouveau."
    static let revoked = "Le VPS a révoqué cet appareil\u{00A0}: appairez-le de nouveau."
    static let noNetwork = "Aucun réseau."

    // --- échecs d'appairage ---------------------------------------------------
    static let addressEmpty = "Saisissez l’adresse du VPS."
    static let addressInvalid = "Adresse invalide\u{00A0}: saisissez l’adresse Tailscale du VPS."
    static let codeMalformed = "Le code d’appairage compte 8 caractères."
    static let codeRefused = "Code expiré ou déjà utilisé."
    static let transport = "VPS injoignable."

    static func unavailable(_ reason: String) -> String { "VPS indisponible\u{00A0}: \(reason)" }

    static func addressFailure(_ failure: ClientAddressFailure) -> String {
        failure == .empty ? addressEmpty : addressInvalid
    }

    static func pairingFailure(_ failure: ClientPairingFailure) -> String {
        switch failure {
        case .malformedCode: codeMalformed
        case .refused: codeRefused
        case .unavailable(let reason): unavailable(reason)
        case .transport: transport
        case .incompatibleProtocol(let local, let remote): ReposText.incompatibleVersion(app: local, vps: remote)
        }
    }
}
