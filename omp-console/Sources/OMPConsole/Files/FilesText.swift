// Tous les textes de la visionneuse, en UN endroit.
//
// Un message à un seul endroit, c'est ce qui permet à un test de le figer sans
// rendre une vue, et à la vue de ne jamais composer une phrase : chaque état de la
// section a son texte, et il n'existe qu'ici.

import Foundation

enum FilesText {
    // Barre d'outils
    static let targetPicker = "Cible"
    static let openMenu = "Ouvrir"
    static let openHelp = "Ouvrir le contrat ou PROJECT.md"
    static let contractButton = "Contrat"
    static let projectButton = "PROJECT.md"
    static let refresh = "Rafraîchir"

    // Badges : un fichier suivi et inchangé n'en porte aucun.
    static let untrackedBadge = "Nouveau"
    static let deletedBadge = "Supprimé"

    // Comparaison (affichée seulement en mode Modifications)
    static let comparedToHead = "Comparé au dernier commit"
    static let comparedToBranchStart = "Comparé au départ de la branche"

    // États
    static let noProjectTitle = "Aucun projet ouvert"
    static let noProjectDescription = "Choisissez le projet dont vous voulez parcourir les fichiers."
    static let errorTitle = "Lecture impossible"
    static let noFiles = "Aucun fichier dans cette cible."
    static let nothingSelected = "Choisissez un fichier dans l'arborescence."
    static let missingFile = "Ce fichier a été supprimé du disque."
    static let emptyFile = "Fichier vide."
    static let emptyNewFile = "Nouveau fichier vide."
    static let noDifference = "Aucune modification dans ce fichier."
    static let noContract = "Aucun contrat .omp/pipeline/contract.md dans cette cible."
    static let noProjectDocument = "Aucun PROJECT.md dans cette cible."

    // Vues du document (S-18 R5)
    static let modePicker = "Affichage"
    static let renderedMode = "Rendu"
    static let sourceMode = "Source"
    static let contentMode = "Contenu"
    static let diffMode = "Modifications"

    static func loading(_ path: String) -> String {
        "Lecture de \(path)…"
    }

    static func baseUnavailable(reason: String) -> String {
        "Comparaison indisponible pour cette cible (\(reason))."
    }

    static func binary(bytes: Int) -> String {
        "Fichier binaire (\(bytes) octets) — affichage indisponible."
    }

    static func unreadable(reason: String) -> String {
        "Lecture impossible : \(reason)."
    }

    /// Le badge d'une entrée, ou `nil` pour un fichier suivi : seul ce qui diffère
    /// du dépôt mérite d'être signalé.
    static func badge(for kind: FilesEntryKind) -> String? {
        switch kind {
        case .tracked: nil
        case .untracked: untrackedBadge
        case .deleted: deletedBadge
        }
    }

    /// Ce à quoi le diff compare le fichier, en mots ; `nil` quand aucune base n'est
    /// calculable (le corps du document le dit déjà).
    static func comparison(_ base: FilesBase) -> String? {
        switch base {
        case .head: comparedToHead
        case .commit: comparedToBranchStart
        case .unavailable: nil
        }
    }

    /// Le texte d'un accès dédié absent : jamais le contenu d'une autre cible, jamais
    /// un contenu vide muet.
    static func missingDedicatedDocument(_ relativePath: String) -> String {
        relativePath == FilesModel.contractRelativePath ? noContract : noProjectDocument
    }

    /// Le nom d'un mode : le contenu d'un Markdown est son RENDU, celui d'un fichier
    /// de code est son contenu.
    static func title(of mode: FilesDocumentMode, isMarkdown: Bool) -> String {
        switch mode {
        case .content: isMarkdown ? renderedMode : contentMode
        case .source: sourceMode
        case .diff: diffMode
        }
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
