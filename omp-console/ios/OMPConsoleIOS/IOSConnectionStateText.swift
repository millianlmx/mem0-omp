// Le vocabulaire des deux composants d'état de connexion des sept sections
// (feature etats-non-connecte-heterogenes-ios, S-2, S-3) : « non connecté », avec
// sa cause, et « connexion en cours ». Ces mots n'existent qu'ici : aucune autre
// copie dans l'app.
//
// Fichier de VOCABULAIRE de l'app (`*Text.swift`, garde design-ios/AC-5). Aucune
// phrase ne cite un numéro de version, un chemin, une adresse ou un endpoint.

enum IOSConnectionStateText {
    // --- « non connecté » (S-2) -----------------------------------------------

    static let title = "Pas de connexion au Mac"
    static let connect = "Se connecter"

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
