// Les textes de la feuille Contrat (S-5, S-7), en UN SEUL endroit : la vue ne
// compose aucune phrase, et chaque message se vérifie sans rendre de vue.
//
// Les libellés exacts sont figés par les specs : « Lire le contrat », « Fermer »,
// « Contrat — <slug> », et les messages d'absence ou d'illisibilité. Ces messages
// disent la conséquence et le geste, jamais le chemin, la taille ni l'erreur du
// système : ce brut part dans `diagnostic(path:unreadable:)`, que seul « Copier le
// diagnostic » emporte (S-9 de jargon-technique-expose-mac-et-ios).

import Foundation

public enum ContractText {
    // --- le chemin et le geste (S-6) ------------------------------------------

    /// Le SEUL littéral du chemin du contrat dans tout le paquet. `FilesModel`
    /// (coque macOS) et `ContractDocument.path(worktree:)` (noyau) le reprennent —
    /// un chemin, un seul endroit.
    public static let relativePath = ".omp/pipeline/contract.md"

    /// Ce qui est à valider, dans les mots des sections requises (S-2) : la liste
    /// des titres vient de `ContractDocument.titles(for:)`, jamais d'un second
    /// littéral.
    public static func subtitle(_ moment: ContractMoment) -> String {
        "À valider : \(ContractDocument.titles(for: moment).joined(separator: " et "))."
    }

    /// Fichier absent : la phrase ne cite pas le chemin, qui reste au diagnostic.
    public static let missingFile =
        "Cette feature n’a pas encore de contrat : il apparaîtra quand ses besoins seront validés."

    // --- le geste et la feuille (S-6, S-7) ------------------------------------

    /// Le geste d'ouverture, offert sur les trois surfaces de la demande.
    public static let open = "Lire le contrat"

    /// Le titre de la feuille.
    public static func title(slug: String) -> String {
        "Contrat — \(slug)"
    }

    /// Le bouton de fermeture (action par défaut, Échap et ↩).
    public static let close = "Fermer"

    // --- les états d'absence et d'illisibilité (S-5) --------------------------

    /// Fichier non textuel ou erreur système : une seule phrase, le brut reste au
    /// diagnostic.
    public static let unreadable = "Le contrat ne peut pas être affiché pour l’instant. Fermez-le, puis rouvrez-le."

    /// Le détail brut d'un contrat absent ou illisible : le chemin lu, puis la
    /// taille ou la raison du système.
    public static func diagnostic(path: String, unreadable: ContractUnreadable?) -> String {
        switch unreadable {
        case nil:
            return "\(path) : absent"
        case .notText(let bytes):
            return "\(path) : pas du texte UTF-8 (\(bytes) octets)"
        case .error(let reason):
            return "\(path) : \(reason)"
        }
    }

    /// Une section requise absente d'un fichier présent : le message prend sa
    /// place, les autres sections s'affichent normalement.
    public static func sectionMissing(title: String) -> String {
        "La section `## \(title)` est absente du contrat."
    }
}
