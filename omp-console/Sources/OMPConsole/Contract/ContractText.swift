// Les textes de la feuille Contrat (S-5, S-7), en UN SEUL endroit : la vue ne
// compose aucune phrase, et chaque message se vérifie sans rendre de vue.
//
// Les libellés exacts sont figés par les specs : « Lire le contrat », « Fermer »,
// « Contrat — <slug> », et les quatre messages d'absence ou d'illisibilité.

import Foundation

enum ContractText {
    // --- le geste et la feuille (S-6, S-7) ------------------------------------

    /// Le geste d'ouverture, offert sur les trois surfaces de la demande.
    static let open = "Lire le contrat"

    /// Le titre de la feuille.
    static func title(slug: String) -> String {
        "Contrat — \(slug)"
    }

    /// Ce qui est à valider, dans les mots des sections requises (S-2) : la liste
    /// des titres vient de `ContractDocument.titles(for:)`, jamais d'un second
    /// littéral.
    static func subtitle(_ moment: ContractMoment) -> String {
        "À valider : \(ContractDocument.titles(for: moment).joined(separator: " et "))."
    }

    /// Le bouton de fermeture (action par défaut, Échap et ↩).
    static let close = "Fermer"

    /// L'intitulé du chemin réellement lu (détail technique, toujours montré).
    static let pathLabel = "Chemin"

    // --- les états d'absence et d'illisibilité (S-5) --------------------------

    /// Fichier absent : le chemin relatif vient de `FilesModel`, jamais d'un
    /// second littéral.
    static let missingFile =
        "Aucun contrat pour cette feature : le fichier `\(FilesModel.contractRelativePath)` n'existe pas encore."

    /// Fichier non textuel (NUL ou UTF-8 invalide).
    static func notText(bytes: Int) -> String {
        "Contrat illisible : le fichier n'est pas du texte UTF-8 (\(bytes) octets)."
    }

    /// Erreur système : le message du système est conservé tel quel.
    static func unreadable(reason: String) -> String {
        "Contrat illisible : \(reason)"
    }

    /// Une section requise absente d'un fichier présent : le message prend sa
    /// place, les autres sections s'affichent normalement.
    static func sectionMissing(title: String) -> String {
        "La section `## \(title)` est absente du contrat."
    }
}
