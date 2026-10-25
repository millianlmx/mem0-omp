// Le vocabulaire des deux composants d'état de la mémoire du serveur : « mémoire
// non reliée », avec sa cause, et « lecture des réglages ». Ces mots n'existent
// qu'ici : aucune autre copie dans l'app.
//
// Fichier de VOCABULAIRE de l'app (`*Text.swift`, garde design-ios/AC-5). Aucune
// phrase ne cite un numéro de version, une adresse ou un endpoint.

import ConsoleCore

enum IOSConnectionStateText {
    // --- « mémoire non reliée » -----------------------------------------------

    static let title = L10n.text("Mémoire non reliée")
    static let connect = L10n.text("Relier le serveur")

    /// La phrase de cause, une par situation réelle.
    static func cause(_ cause: IOSDisconnectCause) -> String {
        switch cause {
        case .unpaired:
            L10n.text("Collez le code d’appairage affiché par le serveur dans la feuille Serveur : il porte aussi sa mémoire.")
        }
    }

    // --- « lecture des réglages » ---------------------------------------------

    static let connectingTitle = L10n.text("Lecture des réglages…")
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
