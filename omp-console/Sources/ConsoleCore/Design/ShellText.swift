// Les gestes communs des écrans partagés par le Mac et l'iPhone/iPad : ouvrir une
// feature ou sa PR, créer une planification. Ce qui existe déjà ailleurs (états,
// étapes, gestes) se reprend de `PipelineServerText`, `MonitoringText` et `ControlText`.
//
// Fichier de VOCABULAIRE (`*Text.swift`) : typographie française (’, espace
// insécable avant ; : ! ?) et glossaire GLOSSAIRE.md.

public enum ShellText {
    public static let openRun = L10n.text("Ouvrir la feature")
    public static let openRunSymbol = "arrow.up.right.square"
    public static let openPR = L10n.text("Ouvrir la PR")
    public static let openPRSymbol = "arrow.triangle.pull"
    public static let newSchedule = L10n.text("Nouvelle planification…")
}
