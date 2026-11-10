// Les mots de l'APPAIRAGE PAR QR CODE, partagés par le Mac (qui affiche le code) et l'iPhone/iPad
// (qui le scanne avec l'appareil photo, puis confirme) : la feuille « Appairer un iPhone », la
// confirmation d'un lien `ompconsole://pair` et les causes d'un échec.
//
// Fichier de VOCABULAIRE (`*Text.swift`) : typographie française (’, espace insécable avant ; : ! ?,
// « » avec espaces insécables) et glossaire GLOSSAIRE.md. Chaque phrase passe par `L10n` : sa clé est
// le texte français, sa traduction anglaise vit dans `Resources/en.lproj/Localizable.strings`.

import Foundation

public enum PairingText {
    // MARK: - Mac : afficher le code

    /// La rangée de la feuille Serveur qui ouvre la feuille d'appairage.
    public static let open = L10n.text("Appairer un iPhone…")
    public static let title = L10n.text("Appairer un iPhone")
    public static let explanation =
        L10n.text("Scannez ce code avec l’appareil photo de l’iPhone. Il expire dans 10 minutes et ne sert qu’une fois.")
    public static let labelField = L10n.text("Nom de l’appareil")
    public static let defaultLabel = L10n.text("iPhone")
    public static let approverToggle = L10n.text("Cet iPhone approuve les envois du poste")
    public static let create = L10n.text("Afficher le code")
    public static let renew = L10n.text("Refaire un code")
    public static let creating = L10n.text("Création du code…")
    /// L'étiquette VoiceOver du code, et ce que fait le scanner.
    public static let codeLabel = L10n.text("Code d’appairage de l’iPhone")
    public static let codeHint = L10n.text("Scannez-le avec l’appareil photo de l’iPhone.")
    /// Le motif d'un refus d'appairer un approbateur : à la suite de « L'accès de cet appareil ne permet pas ce geste : ».
    public static let approverDenied = L10n.text("seul un appareil approbateur peut en appairer un autre comme approbateur")
    public static let expired = L10n.text("Ce code a expiré. Refaites-en un.")
    /// Le symbole SF de la rangée et de l'état vide.
    public static let codeSymbol = "qrcode"
    /// Le temps restant d'un code : « Expire dans 9 min 41 s », puis « Expire dans 41 s ».
    public static func remaining(seconds: Int) -> String {
        let left = max(0, seconds)
        if left < 60 { return L10n.format("Expire dans %lld s", left) }
        return L10n.format("Expire dans %lld min %lld s", left / 60, left % 60)
    }

    // MARK: - iPhone : confirmer le lien

    /// Le titre de la confirmation : il NOMME le serveur, jamais un lien ne relie l'appareil sans que l'humain le voie.
    public static func confirmTitle(address: String) -> String {
        L10n.format("Appairer cet appareil avec %@ ?", address)
    }
    public static let confirmMessage =
        L10n.text("Cet appareil sera relié à ce serveur et y recevra son propre accès. Ne continuez que si ce code vient de votre propre Mac.")
    public static let confirm = L10n.text("Appairer")
    public static let pairing = L10n.text("Appairage en cours…")
    public static let successTitle = L10n.text("Appareil appairé")
    public static func success(address: String) -> String {
        L10n.format("Cet appareil est relié à %@.", address)
    }
    public static let failureTitle = L10n.text("Appairage impossible")
    public static let acknowledge = L10n.text("OK")

    // MARK: - Les causes d'un échec

    public static let invalidLink = L10n.text("Ce lien d’appairage est incomplet ou illisible. Affichez un nouveau code sur le Mac.")
    public static let ticketRefused = L10n.text("Ce code n’est plus valable : il a expiré ou a déjà servi. Affichez-en un nouveau sur le Mac.")
    public static let tooManyAttempts = L10n.text("Trop de codes ont été refusés. Réessayez dans une minute.")
    public static let unsupported = L10n.text("Ce serveur ne sait pas encore appairer par code. Mettez-le à jour.")
    public static func serverRefused(_ motive: String) -> String {
        let reason = motive.trimmingCharacters(in: .whitespacesAndNewlines)
        if reason.isEmpty { return L10n.text("Le serveur ne peut pas créer d’accès pour cet appareil.") }
        return L10n.format("Le serveur ne peut pas créer d’accès pour cet appareil : %@", reason)
    }
    /// Le code a été accepté (donc consommé) mais l'appareil n'a pas pu rejoindre le serveur.
    public static let joinFailed =
        L10n.text("Le code a été accepté, mais l’appareil n’a pas pu rejoindre le serveur. Affichez un nouveau code sur le Mac.")
}
