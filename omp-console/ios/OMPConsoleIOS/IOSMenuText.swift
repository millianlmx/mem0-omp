// Le vocabulaire PROPRE aux menus contextuels de l'app iOS
// (ios-gestes-et-retours-natifs, S-4) : le symbole système de « Copier » et les
// deux titres d'échec que l'Accueil n'a pas (« Lancer » et « Arrêter… » ne sont
// offerts que par les cartes Pipelines). Les libellés des entrées sont ceux des
// contrôles existants (`HomeText`, `KanbanText`, `ContractText`, `MemoryText`),
// jamais recopiés ici.
//
// Fichier de VOCABULAIRE de l'app (`*Text.swift`) : la garde `design-ios/AC-5`
// n'autorise un littéral alphabétique hors de ces fichiers que s'il commence par
// `ios.` ou `-`.

/// Les mots et le symbole des menus contextuels.
enum IOSMenuText {
    /// Le symbole système de « Copier » (HIG Context menus : « Use the same icons
    /// as the system to represent actions such as Copy »).
    static let copySymbol = "doc.on.doc"
    /// Le titre de l'alerte quand « Lancer » d'une carte Pipelines échoue.
    static let launchFailed = "La pipeline n’a pas été lancée."
    /// Le titre de l'alerte quand « Arrêter… » d'une carte Pipelines échoue.
    static let stopFailed = "Les pipelines n’ont pas été arrêtées."
}
