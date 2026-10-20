// Le vocabulaire des deux composants d'état de connexion des sept sections
// (feature etats-non-connecte-heterogenes-ios, S-2, S-3) : « non connecté », avec
// sa cause, et « connexion en cours ». Ces mots n'existent qu'ici : aucune autre
// copie dans l'app.
//
// Fichier de VOCABULAIRE de l'app (`*Text.swift`, garde design-ios/AC-5). Aucune
// phrase ne cite un numéro de version, un chemin, une adresse ou un endpoint.

import ConsoleCore

enum IOSConnectionStateText {
    // --- « non connecté » (S-2) -----------------------------------------------

    static let title = "Pas de connexion au Mac"
    static let titleVps = "Pas de connexion au VPS"
    static let connect = "Se connecter"

    /// Le titre d'un « non connecté » : la machine du slot y est nommée.
    static func title(for cause: IOSDisconnectCause) -> String {
        switch cause {
        case .onVps:
            titleVps
        case .wrongMachine(let expected, _):
            "Pas de connexion au \(expected.label)"
        default:
            title
        }
    }

    /// La phrase de cause, une par situation réelle.
    static func cause(_ cause: IOSDisconnectCause) -> String {
        switch cause {
        case .unpaired:
            "Cet appareil n’est appairé à aucun Mac."
        case .refused:
            "Le Mac a refusé ou révoqué l’appairage de cet appareil. Appairez-le de nouveau."
        case .unreachable:
            "Le Mac ne répond pas. Vérifiez qu’il est allumé, qu’OMP Console y est ouverte et que cet appareil est sur le même réseau."
        case .updateApp:
            "Le Mac utilise une version plus récente d’OMP Console. Mettez à jour l’app sur cet appareil."
        case .updateMac:
            "Le Mac utilise une version plus ancienne d’OMP Console. Mettez à jour OMP Console sur le Mac."
        case .wrongMachine(let expected, let actual):
            ReposText.wrongMachine(expected: expected, actual: actual)
        case .onVps(let base):
            vpsCause(base)
        }
    }

    /// La phrase de cause du slot VPS (adresse Tailscale saisie, jamais découverte).
    private static func vpsCause(_ cause: IOSDisconnectCause) -> String {
        switch cause {
        case .unpaired:
            "Cet appareil n’est appairé à aucun VPS."
        case .refused:
            "Le VPS a refusé ou révoqué l’appairage de cet appareil. Appairez-le de nouveau."
        case .unreachable:
            "Le VPS ne répond pas. Vérifiez qu’il est allumé et que cet appareil est connecté à Tailscale."
        case .updateApp:
            "Le VPS utilise une version plus récente du protocole. Mettez à jour l’app sur cet appareil."
        case .updateMac:
            "Le VPS utilise une version plus ancienne du protocole. Mettez à jour le VPS."
        case .wrongMachine(let expected, let actual):
            ReposText.wrongMachine(expected: expected, actual: actual)
        case .onVps(let inner):
            vpsCause(inner)
        }
    }

    // --- « connexion en cours » (S-3) -----------------------------------------

    static let connectingTitle = "Connexion au Mac…"
}

/// Les identifiants d'accessibilité des deux composants (tous préfixés
/// `ios.connexion.`).
enum IOSConnectionStateAccessibility {
    static let offlineScreen = "ios.connexion.horsLigne.ecran"
    static let offlineBanner = "ios.connexion.horsLigne.bandeau"
    static let connectingScreen = "ios.connexion.enCours.ecran"
    static let connectingBanner = "ios.connexion.enCours.bandeau"
    static let title = "ios.connexion.titre"
    static let cause = "ios.connexion.cause"
    static let message = "ios.connexion.message"
    static let connect = "ios.connexion.connect"
    static let progress = "ios.connexion.attente"

    /// Les neuf identifiants, dans l'ordre de déclaration.
    static let identifiers: [String] = [
        offlineScreen, offlineBanner, connectingScreen, connectingBanner,
        title, cause, message, connect, progress,
    ]
}
