// Tous les textes de la visionneuse, en UN endroit.
//
// Un message à un seul endroit, c'est ce qui permet à un test de le figer sans
// rendre une vue, et à la vue de ne jamais composer une phrase : chaque état de la
// section a son texte, et il n'existe qu'ici.

import Foundation

enum FilesText {
    // Barre d'outils
    static let targetPicker = "Dossier"
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
    static let noFiles = "Aucun fichier dans ce dossier."
    static let nothingSelected = "Choisissez un fichier dans l'arborescence."
    static let missingFile = "Ce fichier a été supprimé du disque."
    static let emptyFile = "Fichier vide."
    static let emptyNewFile = "Nouveau fichier vide."
    static let noDifference = "Aucune modification dans ce fichier."
    static let noContract = "Aucun contrat dans ce dossier."
    static let noProjectDocument = "Aucun PROJECT.md dans ce dossier."

    // Vues du document (S-18 R5)
    static let modePicker = "Affichage"
    static let renderedMode = "Rendu"
    static let sourceMode = "Source"
    static let contentMode = "Contenu"
    static let diffMode = "Modifications"

    static func loading(_ path: String) -> String {
        "Lecture de \(path)…"
    }

    static let baseUnavailable = "Les différences ne peuvent pas être calculées pour ce dossier : sa version de départ est introuvable."
    static let binary = "Ce fichier n'est pas du texte : il ne peut pas être affiché."
    static let unreadable = "Ce fichier ne peut pas être lu : il a disparu ou son accès est refusé. Rafraîchissez pour réessayer."

    // Échecs de lecture (S-8) : la phrase affichée ; le brut est `FilesError.diagnostic`.
    static let gitNotFound = "Les outils de développement d'Apple sont introuvables : les fichiers ne peuvent pas être lus. Installez-les, puis rafraîchissez."
    static let notARepository = "Ce dossier n'est pas un projet suivi : ses fichiers ne peuvent pas être comparés. Choisissez un autre dossier dans la section « Session OMP »."
    static let commandFailed = "La lecture du projet a échoué : les fichiers ne peuvent pas être affichés. Rafraîchissez ; si l'échec revient, copiez le diagnostic."
    static let commandTimedOut = "La lecture du projet a pris trop de temps et a été abandonnée. Rafraîchissez pour réessayer."
    static let gitCommandRefused = "Une lecture non autorisée a été bloquée : rien n'a été modifié. Copiez le diagnostic pour le signaler."
    static let targetGone = "Ce dossier n'existe plus : choisissez-en un autre dans le menu « Dossier »."
    static let watchFailed = "Le suivi des modifications s'est arrêté : l'affichage ne se met plus à jour tout seul. Rafraîchissez pour le relancer."
    static let readFailed = "La lecture a échoué : les fichiers ne peuvent pas être affichés. Rafraîchissez ; si l'échec revient, copiez le diagnostic."

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
        case .binary:
            FilesText.binary
        case .missing:
            dedicated.map { FilesText.missingDedicatedDocument($0) } ?? FilesText.missingFile
        case .unreadable:
            FilesText.unreadable
        }
    }
}
