// Tous les textes de la visionneuse, en UN endroit.
//
// Un message à un seul endroit, c'est ce qui permet à un test de le figer sans
// rendre une vue, et à la vue de ne jamais composer une phrase : chaque état de la
// section a son texte, et il n'existe qu'ici.

import Foundation

enum FilesText {
    // En-tête
    static let targetPicker = "Cible"
    static let contractButton = "Contrat"
    static let projectButton = "PROJECT.md"
    static let refresh = "Rafraîchir"

    // Badges
    static let trackedBadge = "suivi"
    static let untrackedBadge = "non suivi"
    static let deletedBadge = "supprimé"

    // États
    static let noProjectTitle = "Aucun projet ouvert"
    static let noProjectDescription = "Choisis-le dans la fenêtre « Session OMP » (⌘N)."
    static let errorTitle = "Lecture impossible"
    static let noFiles = "Aucun fichier suivi ni non suivi dans cette cible."
    static let nothingSelected = "Choisis un fichier dans l'arbre, ou ouvre le contrat ou PROJECT.md."
    static let missingFile = "Ce fichier n'existe plus sur le disque (suppression non commitée)."
    static let emptyFile = "Fichier vide."
    static let emptyNewFile = "Nouveau fichier vide."
    static let noContract = "Aucun contrat .omp/pipeline/contract.md dans cette cible."
    static let noProjectDocument = "Aucun PROJECT.md dans cette cible."

    static func loading(_ path: String) -> String {
        "Lecture de \(path)…"
    }

    static func noDifference(base: String) -> String {
        "Aucune différence avec \(base) pour ce fichier."
    }

    static func baseUnavailable(reason: String) -> String {
        "Base introuvable pour cette cible (\(reason)) — diff indisponible."
    }

    static func binary(bytes: Int) -> String {
        "Fichier binaire (\(bytes) octets) — affichage indisponible."
    }

    static func unreadable(reason: String) -> String {
        "Lecture impossible : \(reason)."
    }

    static func badge(for kind: FilesEntryKind) -> String {
        switch kind {
        case .tracked: trackedBadge
        case .untracked: untrackedBadge
        case .deleted: deletedBadge
        }
    }

    /// Le texte d'un accès dédié absent : jamais le contenu d'une autre cible, jamais
    /// un contenu vide muet.
    static func missingDedicatedDocument(_ relativePath: String) -> String {
        relativePath == FilesModel.contractRelativePath ? noContract : noProjectDocument
    }
}

extension FilesContent {
    /// Le message à afficher À LA PLACE du contenu, ou `nil` quand le contenu se rend
    /// tel quel. C'est la règle de la vue, en une fonction pure : un document dédié
    /// (contrat, `PROJECT.md`) a SON texte d'absence, un fichier de l'arbre a le sien.
    func message(dedicated: String?) -> String? {
        switch self {
        case let .text(text):
            text.isEmpty ? FilesText.emptyFile : nil
        case let .binary(bytes):
            FilesText.binary(bytes: bytes)
        case .missing:
            dedicated.map { FilesText.missingDedicatedDocument($0) } ?? FilesText.missingFile
        case let .unreadable(reason):
            FilesText.unreadable(reason: reason)
        }
    }
}
