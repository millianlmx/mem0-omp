// Les mots de la vue clé/valeur des arguments d'un appel d'outil
// (visionneuse-appels-outils-lisibles, S-3) : les états, les boutons, le rendu
// des valeurs simples et les LIBELLÉS FRANÇAIS des clés des six outils courants
// (read, write, edit, bash, grep, glob — schémas relevés dans le paquet omp
// installé, Doc D-3).
//
// PARTAGÉ : la coque macOS et l'app iOS lisent les mêmes mots. Le caractère
// « code » d'une valeur (chasse fixe) est de la LOGIQUE et vit dans
// `ToolArguments`, pas ici.

/// Le vocabulaire de la vue des arguments d'un appel d'outil.
public enum ToolArgumentsText {
    public static let none = "Aucun argument"
    public static let unreadable = "Arguments illisibles"
    public static let showMore = "Afficher plus"
    public static let showRaw = "Afficher le détail brut"
    public static let hideRaw = "Masquer le détail brut"

    public static let yes = "oui"
    public static let no = "non"
    public static let null = "—"
    public static let empty = "vide"
    public static let separator = " : "
    public static let ellipsis = "…"

    /// Le libellé d'une valeur « code », posée SOUS son libellé : `Commande :`.
    public static func codeLabel(_ label: String) -> String {
        label + " :"
    }

    /// Le libellé français de la clé `key` d'un appel de l'outil `tool`, à toute
    /// profondeur de l'appel ; `nil` pour un autre outil ou une clé sans libellé
    /// (la clé brute s'affiche alors). Le nom d'outil est comparé EXACTEMENT,
    /// casse comprise.
    public static func label(tool: String, key: String) -> String? {
        guard let keys = labels[tool] else { return nil }
        if key == "i" { return "Intention" }
        return keys[key]
    }

    /// Les libellés par outil (Doc D-3). Le champ d'intention `i`, commun aux
    /// six, est traité à part.
    private static let labels: [String: [String: String]] = [
        "read": [
            "path": "Fichier",
            "offset": "À partir de la ligne",
            "limit": "Nombre de lignes",
        ],
        "write": [
            "path": "Fichier",
            "content": "Contenu",
        ],
        "edit": [
            "path": "Fichier",
            "old_string": "Ancien texte",
            "new_string": "Nouveau texte",
            "replace_all": "Remplacer partout",
            "input": "Modifications",
            "edits": "Modifications",
            "op": "Opération",
            "rename": "Nouveau nom",
            "diff": "Différence",
        ],
        "bash": [
            "command": "Commande",
            "timeout": "Délai maximal (s)",
            "cwd": "Dossier",
            "pty": "Terminal interactif",
            "async": "En arrière-plan",
            "name": "Nom du service",
            "ready": "Prêt quand",
            "log": "Ligne attendue",
            "port": "Port",
            "host": "Hôte",
        ],
        "grep": [
            "pattern": "Motif",
            "path": "Emplacement",
            "paths": "Emplacements",
            "case": "Sensible à la casse",
            "gitignore": "Respecter .gitignore",
            "skip": "Résultats sautés",
        ],
        "glob": [
            "path": "Motif",
            "hidden": "Fichiers cachés",
            "gitignore": "Respecter .gitignore",
            "limit": "Nombre maximal",
        ],
    ]
}
