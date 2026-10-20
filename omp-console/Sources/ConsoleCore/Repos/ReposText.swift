// TOUS les textes de la section « Dépôts », du client à deux machines et de la
// session du VPS, en UN endroit (convention `ActionsText`) : les deux coques les
// partagent, aucune vue ne compose une phrase (S-6, S-8, S-10 de
// orchestrator-living-in-a-vps).

import Foundation

public enum ReposText {
    // --- section --------------------------------------------------------------
    public static let title = "Dépôts"
    public static let loading = "Chargement des dépôts…"
    public static let empty = "Aucun dépôt connu."
    public static let macLabel = "Mac"
    public static let vpsLabel = "VPS"
    /// Le sélecteur des écrans mono-machine.
    public static let machinePickerLabel = "Machine"

    // --- états d'une ligne ----------------------------------------------------
    public static func unreachable(_ machine: RepoMachine) -> String { "\(machine.label) injoignable" }

    public static func handoverInProgress(to machine: RepoMachine) -> String {
        "Bascule vers le \(machine.label) en cours"
    }

    public static let cancelHandover = "Annuler la bascule"
    public static let handoverToFinish = "Bascule à terminer"
    public static let retryHandover = "Réessayer"
    public static let conflict = "Connu des deux machines sans bascule\u{00A0}: confiez-le à l’une d’elles."

    public static func finishing(_ count: Int, on machine: RepoMachine) -> String {
        "\(count) feature(s) finissent sur le \(machine.label)"
    }

    // --- geste « Confier » ----------------------------------------------------
    public static func handoverButton(to machine: RepoMachine) -> String { "Confier au \(machine.label)" }
    public static func notPaired(_ machine: RepoMachine) -> String { "Le \(machine.label) n’est pas appairé" }
    public static let noRemote = "Ce dépôt n’a pas de dépôt distant GitHub"
    public static let confirmButton = "Confier"
    public static let cancelButton = "Annuler"

    public static func confirmation(name: String, to machine: RepoMachine, pending: Int) -> String {
        "Confier \(name) au \(machine.label)\u{00A0}? Les features en cours finissent sur le \(machine.other.label)\u{00A0}; "
            + "\(pending) feature(s) pas encore démarrée(s) partent sur le \(machine.label)."
    }

    public static func success(name: String, to machine: RepoMachine, launched: Int) -> String {
        "\(name) est confié au \(machine.label)\u{00A0}: \(launched) feature(s) y démarrent."
    }

    /// Le libellé d'accessibilité d'un badge de machine : le texte visible puis la machine.
    public static func accessibility(_ text: String, machine: RepoMachine) -> String {
        "\(text), \(machine.label)"
    }

    // --- connexion à la machine ------------------------------------------------
    public static let vpsSectionTitle = "VPS"
    public static let macSectionTitle = "Mac"
    public static let vpsAddressLabel = "Adresse Tailscale du VPS"
    public static let pairingCodeLabel = "Code d’appairage"
    public static let pairButton = "Appairer"
    public static let forgetVps = "Oublier ce VPS"
    public static let vpsUnreachable = "VPS injoignable"

    public static func vpsUnreachable(address: String) -> String { "VPS injoignable — \(address)" }

    public static func incompatibleVersion(app: Int, vps: Int?) -> String {
        "Version de protocole incompatible (app \(app), VPS \(vps.map(String.init) ?? "inconnu"))"
    }

    /// L'adresse saisie est celle de l'autre machine.
    public static func wrongMachine(expected: RepoMachine, actual: RepoMachine) -> String {
        "Cette adresse est le \(actual.label), pas le \(expected.label)"
    }

    // --- bandeaux et badges des cartes ----------------------------------------
    public static func machineBanner(_ machine: RepoMachine) -> String { unreachable(machine) }

    // --- session OMP du VPS ---------------------------------------------------
    public static let sessionNotPaired = "Appairez le VPS dans Dépôts"
    public static let sessionUnreachable = "VPS injoignable — la session continue sur le VPS."
    public static let sessionNone = "Aucune session sur le VPS"
    public static let sessionLaunch = "Lancer…"
}
