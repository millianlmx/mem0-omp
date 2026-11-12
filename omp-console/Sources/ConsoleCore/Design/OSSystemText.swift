// Les mots du hub « Système » de l'« OS agentique », partagés par le Mac et l'iPhone/iPad :
// ce qui se règle ou se consulte rarement, une tuile par écran. Les tuiles se lisent par
// leur symbole et leur pastille ; ces mots ne servent qu'à les nommer et à dire leur état
// à VoiceOver.
//
// Fichier de VOCABULAIRE (`*Text.swift`) : chaque phrase passe par `L10n`, sa traduction
// anglaise vit dans `Resources/en.lproj/Localizable.strings`.

import Foundation

public enum OSSystemText {
    public static let title = L10n.text("Système")
    public static let online = L10n.text("en ligne")
    public static let stopped = L10n.text("arrêté")
    public static let silent = L10n.text("muette")
    public static let watching = L10n.text("en veille")

    /// « 2 envois à approuver »
    public static func pending(_ count: Int) -> String {
        ConsoleFormat.count(count, L10n.text("envoi à approuver"), L10n.text("envois à approuver"))
    }

    /// « 4 dépôts »
    public static func repos(_ count: Int) -> String {
        ConsoleFormat.count(count, L10n.text("dépôt"), L10n.text("dépôts"))
    }

    /// « 3 planifications actives »
    public static func activeSchedules(_ count: Int) -> String {
        ConsoleFormat.count(count, L10n.text("planification active"), L10n.text("planifications actives"))
    }

    /// « 5 clients »
    public static func clients(_ count: Int) -> String {
        ConsoleFormat.count(count, L10n.text("client"), L10n.text("clients"))
    }
}
