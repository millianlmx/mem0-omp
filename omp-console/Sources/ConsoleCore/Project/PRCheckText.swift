// Les mots des trois contrôles requis d'une PR (S-3) : une seule table, partagée
// par les deux coques. `project.PRCheckState.label` (macOS) et
// `client.PRCheckState.label` (miroir) lisent d'ici — jamais deux tables.
//
// Cible PARTAGÉE macOS/iOS : rien à importer, purement des constantes.

public enum PRCheckText {
    public static let green = "vert"
    public static let red = "rouge"
    public static let pending = "en cours"
    public static let ignored = "ignoré"
}
