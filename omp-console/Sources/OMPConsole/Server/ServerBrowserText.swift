// Les textes du NAVIGATEUR DU SERVEUR dans la section « Poste » du Mac : l'état des
// comptes (Slack, Google), la source de la copie continue du profil Chrome et la connexion
// interactive. Réservés à l'appareil approbateur : les gestes restent offerts à tout jeton
// qui peut agir, le serveur décide et son refus se dit par `HarnessFailure`.
//
// Les codes du serveur (domaine d'un compte, état) se traduisent ici ; un code inconnu de
// cette version se rend tel quel. Les mots qui existent ailleurs (Fermer) se reprennent de
// `PipelineServerText`.
//
// Fichier de VOCABULAIRE (`*Text.swift`) : typographie française (’, espace
// insécable avant ; : ! ?) et glossaire GLOSSAIRE.md.

import ConsoleClient
import ConsoleCore
import Foundation

enum ServerBrowserText {
    // MARK: - Section

    static let sectionTitle = L10n.text("Navigateur du serveur")
    static let sectionSymbol = "globe"
    static let online = L10n.text("En ligne")
    static let offline = L10n.text("Hors ligne")

    // MARK: - Comptes

    /// Le nom d'un compte d'après son domaine ; un domaine inconnu se rend tel quel.
    static func accountName(_ domain: String) -> String {
        switch domain {
        case "slack.com": L10n.text("Slack")
        case "google.com": L10n.text("Google")
        default: domain
        }
    }

    /// L'état d'un compte en un mot ; un état inconnu de cette version se rend tel quel.
    static func state(_ account: ServerBrowserAccount) -> String {
        switch account.phase {
        case .connected: L10n.text("Connecté")
        case .expired: L10n.text("Session expirée")
        case .blocked: L10n.text("Bloqué")
        case .disconnected: L10n.text("Non connecté")
        case nil: account.state
        }
    }

    /// Ce qu'on peut faire d'un compte expiré ou bloqué ; `nil` pour les autres états.
    static func stateHint(_ account: ServerBrowserAccount) -> String? {
        switch account.phase {
        case .expired: L10n.text("La session a expiré. La copie de Chrome la renouvelle, sinon reconnectez-vous ici.")
        case .blocked: L10n.text("Le site a refusé la session copiée. Connectez-vous ici.")
        case .connected, .disconnected, nil: nil
        }
    }

    /// « Mis à jour il y a 3 minutes ».
    static func changed(_ relative: String) -> String { L10n.format("Mis à jour %@", relative) }

    // MARK: - Copie du profil Chrome

    static let mirrorSource = L10n.text("Copie du profil Chrome")
    static let mirrorNone = L10n.text("Aucune copie")
    static let mirrorPending = L10n.text("Aucune copie reçue depuis le démarrage du serveur")
    /// « Dernière copie il y a 3 minutes ».
    static func mirroredAt(_ relative: String) -> String { L10n.format("Dernière copie %@", relative) }

    // MARK: - Connexion interactive

    static let loginAction = L10n.text("Se connecter")
    static let loginResume = L10n.text("Reprendre la connexion")
    static let loginFinish = L10n.text("Terminer")
    static let loginFinishHint = L10n.text("Terminer ferme la page du serveur et relit l’état du compte ; Fermer la laisse ouverte pour la reprendre.")
    static let loginLoading = L10n.text("Chargement de la page…")
    static let pageLabel = L10n.text("Page de connexion affichée par le serveur")
    static let clickHint = L10n.text("Cliquez sur l’image pour cliquer dans la page ; l’image se rafraîchit chaque seconde.")
    static let refused = L10n.text("Cette connexion est refusée : la page a quitté les domaines permis pour ce compte. Terminez-la, puis recommencez.")

    /// « Connexion à Slack ouverte sur le serveur ».
    static func loginOpen(_ account: String) -> String { L10n.format("Connexion à %@ ouverte sur le serveur", account) }
    /// « Connexion à Slack » : le titre de la feuille.
    static func loginTitle(_ account: String) -> String { L10n.format("Connexion à %@", account) }
    /// « Page affichée : accounts.google.com ».
    static func page(_ host: String) -> String { L10n.format("Page affichée : %@", host) }

    // MARK: - Saisie

    static let typeLabel = L10n.text("Texte à saisir")
    static let typeSend = L10n.text("Saisir")
    static let typeHidden = L10n.text("Masquer la saisie")
    static let scrollUp = L10n.text("Défiler vers le haut")
    static let scrollDown = L10n.text("Défiler vers le bas")

    /// Le nom d'une touche que la connexion accepte.
    static func key(_ key: ServerBrowserKey) -> String {
        switch key {
        case .enter: L10n.text("Entrée")
        case .tab: L10n.text("Tabulation")
        case .backspace: L10n.text("Retour arrière")
        }
    }
}
