// Les mots de la TÉLÉCOMMANDE iOS hors de l'app : l'extension de partage « Demander à
// l'OS » (une page ou un texte partagé devient une Demande). Les gestes des
// notifications et de la Live Activity (« Ouvrir », « Valider », « Prendre la
// recommandation », « Répondre… ») sont dans `NotificationText` ; les réponses de Siri,
// dans le vocabulaire de l'app iOS.
//
// Fichier de VOCABULAIRE (`*Text.swift`) : typographie française et glossaire
// GLOSSAIRE.md. Chaque phrase passe par `L10n` : sa clé est le texte français, sa
// traduction anglaise vit dans `Resources/en.lproj/Localizable.strings`.

import Foundation

public enum OSRemoteText {
    // MARK: - Extension de partage

    public static let shareTitle = L10n.text("Demander à l’OS")
    /// L'invite du champ de consigne, facultatif.
    public static let sharePrompt = L10n.text("Que faut-il en faire ?")
    public static let shareSend = L10n.text("Envoyer")
    public static let shareSending = L10n.text("Envoi…")
    public static let shareCancel = L10n.text("Annuler")
    public static let shareSent = L10n.text("Demande transmise à l’OS")
    /// Rien d'exploitable dans ce qui est partagé (ni page, ni texte).
    public static let shareNothing = L10n.text("Rien à demander avec ce contenu")
    /// L'app n'a relié aucun serveur (ou l'appareil n'a pas encore été déverrouillé).
    public static let shareNotLinked = L10n.text("Ouvrez OMP Console pour relier le serveur.")
    public static let sharePageSymbol = "link"
    public static let shareTextSymbol = "text.quote"
    public static let shareSentSymbol = "checkmark.circle.fill"

    /// La demande par défaut d'une page partagée sans consigne : « Traiter cette page : <titre> ».
    public static func sharePage(_ title: String) -> String {
        L10n.format("Traiter cette page : %@", title)
    }
}
