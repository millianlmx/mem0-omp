// Les textes de la feuille « Nouvelle feature » (S-6 de omp-console-redesign),
// partagés par les DEUX coques : la feuille macOS (`NewFeatureSheet`) et la
// feuille iOS (`NewFeatureSheetView`) affichent les mêmes mots.
//
// VIT DANS `ConsoleCore` : la vue ne compose aucune phrase, et un libellé vit à un
// seul endroit — celui-ci.

public enum NewFeatureText {
    public static let title = "Nouvelle feature"
    /// Le libellé du geste d'ouverture de la feuille, dans la barre de navigation
    /// ou de menus.
    public static let command = "Nouvelle feature…"
    public static let repo = "Dépôt"
    public static let noRepo = "Aucun dépôt : choisissez un dossier."
    /// iOS : l'ardoise ne porte encore aucun dépôt connu du magasin — l'app ne
    /// peut pas en proposer un, et l'annonce plutôt que de laisser « Lancer »
    /// silencieusement inerte.
    public static let noKnownRepo = "Aucun dépôt connu du magasin pour l’instant."
    /// iOS : l'invite du sélecteur de dépôt tant qu'aucun dépôt n'est choisi.
    public static let repoPrompt = "Choisir un dépôt"
    public static let chooseFolder = "Choisir un dossier…"
    public static let panelPrompt = "Choisir"
    public static let panelMessage = "Choisissez la racine d’un dépôt Git"
    public static let notGitRoot =
        "Ce dossier n’est pas un dépôt Git (aucun .git) : choisissez la racine d’un dépôt."
    public static let featureTitle = "Titre"
    public static let titlePlaceholder = "ex. export-csv"
    public static let titleHelp = "Devient la branche feat/<titre>."
    public static let need = "Besoin"
    public static let needPlaceholder = "Décrivez ce que vous voulez obtenir…"
    public static let cancel = "Annuler"
    public static let launch = "Lancer"
}
