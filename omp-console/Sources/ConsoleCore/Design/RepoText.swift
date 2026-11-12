// Le vocabulaire de l'écran « Dépôts », partagé par le Mac et l'iPhone/iPad : la liste des
// dépôts déclarés, l'ajout par adresse (et la clé de déploiement à poser), les réglages d'un
// dépôt et son retrait. Peu de mots : chaque réglage a son symbole.
//
// Fichier de VOCABULAIRE (`*Text.swift`) : typographie française et glossaire
// GLOSSAIRE.md. Chaque phrase passe par `L10n` : sa clé est le texte français, sa
// traduction anglaise vit dans `Resources/en.lproj/Localizable.strings`.

import Foundation

public enum RepoText {
    public static let title = L10n.text("Dépôts")
    public static let add = L10n.text("Ajouter un dépôt")
    public static let addTitle = L10n.text("Nouveau dépôt")
    public static let address = L10n.text("Adresse")
    public static let shortName = L10n.text("Nom court")
    public static let optional = L10n.text("Facultatif")
    public static let declare = L10n.text("Ajouter")
    public static let cancel = L10n.text("Annuler")
    public static let done = L10n.text("Terminé")
    public static let retry = L10n.text("Réessayer")
    public static let deployKey = L10n.text("Clé de déploiement")
    public static let deployKeyHint = L10n.text("Posez cette clé, en écriture, sur la forge, puis réessayez.")
    public static let copy = L10n.text("Copier")
    public static let openForge = L10n.text("Ouvrir la forge")
    public static let empty = L10n.text("Aucun dépôt")
    public static let emptyHint = L10n.text("Ajoutez-en un par son adresse.")
    public static let adminOnly = L10n.text("Réservé à l’administrateur")
    public static let pick = L10n.text("Choisissez un dépôt")
    public static let readOnly = L10n.text("Mettez le serveur à jour pour régler ce dépôt.")

    public static let general = L10n.text("Général")
    public static let branch = L10n.text("Branche")
    public static let memory = L10n.text("Mémoire")
    public static let parallel = L10n.text("En parallèle")
    public static let unlimited = L10n.text("Sans limite")
    public static let space = L10n.text("Espace")

    public static let forgeSection = L10n.text("Forge et fusion")
    public static let forge = L10n.text("Forge")
    public static let auto = L10n.text("Auto")
    public static let merge = L10n.text("Fusion")
    public static let mergeRequest = L10n.text("PR")
    public static let mergeLocal = L10n.text("Locale")

    public static let tests = L10n.text("Tests")
    public static let judge = L10n.text("Juge")
    public static let judgeServer = L10n.text("Serveur")
    public static let judgeCI = L10n.text("Intégration continue")
    public static let ciTimeout = L10n.text("Délai d’attente")
    public static let commands = L10n.text("Commandes")
    public static let touched = L10n.text("Tests touchés")
    public static let fullSuite = L10n.text("Suite complète")
    public static let pattern = L10n.text("Motif des tests")
    public static let testImage = L10n.text("Image de test")
    public static let preview = L10n.text("Prévisualisation")

    public static let privacySection = L10n.text("Confidentialité et modèles")
    public static let localOnly = L10n.text("Modèles locaux seulement")
    public static let providers = L10n.text("Fournisseurs")
    public static let models = L10n.text("Modèles")
    public static let serverDefault = L10n.text("Ceux du serveur")
    public static let useServerDefault = L10n.text("Revenir à ceux du serveur")

    public static let issues = L10n.text("Issues")
    public static let corporate = L10n.text("Issues d’entreprise")
    public static let atlassian = L10n.text("Atlassian")

    public static let gitSection = L10n.text("Identité Git")
    public static let gitName = L10n.text("Nom")
    public static let gitEmail = L10n.text("E-mail")
    public static let gitDefault = L10n.text("Celle du serveur")

    public static let access = L10n.text("Accès")
    public static let remote = L10n.text("Distant")

    public static let remove = L10n.text("Retirer le dépôt")
    public static let removeAction = L10n.text("Retirer")
    public static let removeMessage = L10n.text("Le clone et la clé restent sur le serveur.")

    /// « Retirer demo ? »
    public static func removeConfirm(_ name: String) -> String {
        L10n.format("Retirer %@ ?", name)
    }

    /// Pourquoi le retrait est fermé : le dépôt est rangé dans un espace.
    public static func removeHeld(_ space: String) -> String {
        L10n.format("Retirez-le d’abord de l’espace « %@ ».", space)
    }

    /// Un dépôt retiré qui sert encore.
    public static func kept(_ name: String) -> String {
        L10n.format("%@ reste servi le temps de finir ses features.", name)
    }

    /// « Auto (GitHub) » : la forge déduite de l'adresse.
    public static func forgeAuto(_ inUse: String) -> String {
        L10n.format("Auto (%@)", forgeName(inUse))
    }

    /// L'attente de la CI : « 60 min ».
    public static func minutes(_ value: Int) -> String {
        L10n.format("%lld min", value)
    }

    /// Le nom d'une forge.
    public static func forgeName(_ raw: String) -> String {
        switch raw {
        case "github": L10n.text("GitHub")
        case "gitlab": L10n.text("GitLab")
        case "none": L10n.text("Aucune forge")
        default: raw
        }
    }

    /// Le sort des issues d'entreprise.
    public static func corporateName(_ raw: String) -> String {
        switch raw {
        case "forbid": L10n.text("Refusées")
        case "redacted": L10n.text("Caviardées")
        case "full": L10n.text("Complètes")
        default: raw
        }
    }

    /// Le juge des tests, pour VoiceOver et l'infobulle.
    public static func judgeName(_ raw: String) -> String {
        switch raw {
        case "ci": judgeCI
        default: judgeServer
        }
    }

    /// Le mode de fusion, pour VoiceOver et l'infobulle.
    public static func mergeName(_ raw: String) -> String {
        switch raw {
        case "gh": mergeRequest
        default: mergeLocal
        }
    }

    // MARK: - Symboles

    public static let addSymbol = "plus"
    public static let repoSymbol = "shippingbox"
    public static let lockedSymbol = "lock.shield"
    public static let branchSymbol = "arrow.triangle.branch"
    public static let pullRequestSymbol = "arrow.triangle.pull"
    public static let localMergeSymbol = "arrow.triangle.merge"
    public static let ciSymbol = "cloud"
    public static let serverJudgeSymbol = "server.rack"
    public static let localOnlySymbol = "lock.fill"
    public static let spaceSymbol = "square.stack.3d.up"
    public static let memorySymbol = "brain"
    public static let parallelSymbol = "square.stack"
    public static let testsSymbol = "checkmark.seal"
    public static let timeoutSymbol = "timer"
    public static let commandsSymbol = "terminal"
    public static let commandSymbol = "chevron.forward.2"
    public static let patternSymbol = "line.3.horizontal.decrease"
    public static let testImageSymbol = "cube"
    public static let previewSymbol = "macwindow"
    public static let providersSymbol = "building.2"
    public static let modelsSymbol = "cpu"
    public static let corporateSectionSymbol = "briefcase"
    public static let atlassianSymbol = "ticket"
    public static let gitNameSymbol = "person.crop.circle"
    public static let gitEmailSymbol = "envelope"
    public static let remoteSymbol = "link"
    public static let deployKeySymbol = "key"
    public static let copySymbol = "doc.on.doc"
    public static let copiedSymbol = "checkmark"
    public static let checkSymbol = "checklist"
    public static let openSymbol = "arrow.up.right.square"
    public static let removeSymbol = "trash"
    public static let retrySymbol = "arrow.clockwise"

    /// Le symbole d'une forge : aucune marque n'existe en SF Symbols, le nuage dit « hébergé
    /// sur une forge » (son nom en bulle d'aide), le disque « ce serveur seulement ».
    public static func forgeSymbol(_ raw: String) -> String {
        switch raw {
        case "github", "gitlab": "cloud"
        default: "externaldrive"
        }
    }

    /// Le symbole du sort des issues d'entreprise.
    public static func corporateSymbol(_ raw: String) -> String {
        switch raw {
        case "forbid": "nosign"
        case "full": "eye"
        default: "eye.slash"
        }
    }
}
