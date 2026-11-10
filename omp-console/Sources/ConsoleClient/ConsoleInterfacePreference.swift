// Le choix d'interface gardé d'un lancement à l'autre : la nouvelle interface (l'« OS
// agentique », le défaut) ou l'interface classique à sections. L'app iOS le lit et l'écrit
// par ce type : ses sources ne nomment jamais le magasin (garde `coque-ios/AC-4`). La clé
// est celle que l'app Mac pose par `@AppStorage`.

import Foundation

public struct ConsoleInterfacePreference: Sendable {
    /// La clé du réglage : vrai (ou jamais posé), la nouvelle interface ; faux, la classique.
    public static let key = "ui.os"

    private let preferences: any ClientPreferences

    public init(preferences: any ClientPreferences = UserDefaultsClientPreferences()) {
        self.preferences = preferences
    }

    /// L'interface classique a été choisie ; jamais posé, c'est la nouvelle interface.
    public var prefersClassic: Bool {
        preferences.bool(forKey: Self.key) == false
    }

    /// Garde le choix pour les prochains lancements.
    public func choose(classic: Bool) {
        preferences.set(!classic, forKey: Self.key)
    }
}
