// Tous les textes de la visionneuse, en UN endroit.
//
// Un message à un seul endroit, c'est ce qui permet à un test de le figer sans
// rendre une vue, et à la vue de ne jamais composer une phrase : chaque état de la
// section a son texte, et il n'existe qu'ici.

import ConsoleCore
import Foundation

enum FilesText {
    // Barre d'outils
    static let targetPicker = L10n.text("Dossier")
    static let refresh = L10n.text("Rafraîchir")

    // Badges : un fichier suivi et inchangé n'en porte aucun.
    static let untrackedBadge = L10n.text("Nouveau")
    static let deletedBadge = L10n.text("Supprimé")

    // Comparaison (affichée seulement en mode Modifications)
    static let comparedToHead = L10n.text("Comparé à la dernière version validée")
    static let comparedToBranchStart = L10n.text("Comparé au départ de la branche")

    // États
    static let noProjectTitle = L10n.text("Aucun projet ouvert")
    static let noProjectDescription = L10n.text("Choisissez le projet dont vous voulez parcourir les fichiers.")
    static let errorTitle = L10n.text("Lecture impossible")
    static let noFiles = L10n.text("Aucun fichier dans ce dossier.")
    static let nothingSelected = L10n.text("Choisissez un fichier dans l’arborescence.")
    static let missingFile = L10n.text("Ce fichier a été supprimé du disque.")
    static let emptyFile = L10n.text("Fichier vide.")
    static let emptyNewFile = L10n.text("Nouveau fichier vide.")
    static let noDifference = L10n.text("Aucune modification dans ce fichier.")

    // Vues du document (S-18 R5)
    static let modePicker = L10n.text("Affichage")
    static let renderedMode = L10n.text("Rendu")
    static let sourceMode = L10n.text("Source")
    static let contentMode = L10n.text("Contenu")
    static let diffMode = L10n.text("Modifications")

    static func loading(_ path: String) -> String {
        L10n.format("Lecture de %@…", path)
    }

    static let baseUnavailable = L10n.text("Les différences ne peuvent pas être calculées pour ce dossier : sa version de départ est introuvable.")
    static let binary = L10n.text("Ce fichier n’est pas du texte : il ne peut pas être affiché.")
    static let unreadable = L10n.text("Ce fichier ne peut pas être lu : il a disparu ou son accès est refusé. Rafraîchissez pour réessayer.")

    // Échecs de lecture (S-8) : la phrase affichée ; le brut est `FilesError.diagnostic`.
    static let gitNotFound = L10n.text("Les outils de développement d’Apple sont introuvables : les fichiers ne peuvent pas être lus. Installez-les, puis rafraîchissez.")
    static let notARepository = L10n.text("Ce dossier n’est pas un projet suivi : ses fichiers ne peuvent pas être comparés. Choisissez un autre dossier dans la section « Session OMP ».")
    static let commandFailed = L10n.text("La lecture du projet a échoué : les fichiers ne peuvent pas être affichés. Rafraîchissez ; si l’échec revient, copiez le diagnostic.")
    static let commandTimedOut = L10n.text("La lecture du projet a pris trop de temps et a été abandonnée. Rafraîchissez pour réessayer.")
    static let gitCommandRefused = L10n.text("Une lecture non autorisée a été bloquée : rien n’a été modifié. Copiez le diagnostic pour le signaler.")
    static let targetGone = L10n.text("Ce dossier n’existe plus : choisissez-en un autre dans le menu « Dossier ».")
    static let watchFailed = L10n.text("Le suivi des modifications s’est arrêté : l’affichage ne se met plus à jour tout seul. Rafraîchissez pour le relancer.")
    static let readFailed = L10n.text("La lecture a échoué : les fichiers ne peuvent pas être affichés. Rafraîchissez ; si l’échec revient, copiez le diagnostic.")

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
    /// tel quel. C'est la règle de la vue, en une fonction pure.
    var message: String? {
        switch self {
        case let .text(text):
            text.isEmpty ? FilesText.emptyFile : nil
        case .binary:
            FilesText.binary
        case .missing:
            FilesText.missingFile
        case .unreadable:
            FilesText.unreadable
        }
    }
}
