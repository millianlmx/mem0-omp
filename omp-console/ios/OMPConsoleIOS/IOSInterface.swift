import ConsoleClient
import Foundation

/// L'interface montrée par l'app iOS : la nouvelle (l'« OS agentique », le défaut) ou la
/// classique à sections. Le choix de l'humain — Savoir ▸ « Interface classique », Système ▸
/// « Nouvelle interface » — est gardé d'un lancement à l'autre (`ConsoleInterfacePreference`) ;
/// une demande sans équivalent dans la nouvelle interface (une page de Système) montre la
/// classique pour cette fois, sans rien garder. Les arguments de recette décident du
/// lancement (`IOSShellLaunch`).
@MainActor
final class IOSInterface: ObservableObject {
    @Published private(set) var classic: Bool
    /// Ce que les arguments de lancement demandent d'ouvrir dans la nouvelle interface.
    let launch: IOSShellLaunch
    private let preference: ConsoleInterfacePreference

    init(arguments: [String], preference: ConsoleInterfacePreference = ConsoleInterfacePreference()) {
        self.preference = preference
        launch = IOSShellLaunch.resolve(arguments, prefersClassic: preference.prefersClassic)
        classic = launch.classic
    }

    /// Le choix de l'humain : montré, et gardé pour les prochains lancements.
    func choose(classic: Bool) {
        self.classic = classic
        preference.choose(classic: classic)
    }

    /// Une section qui n'existe que dans l'interface classique : elle est montrée, le choix
    /// gardé ne change pas.
    func showClassic() {
        classic = true
    }
}
