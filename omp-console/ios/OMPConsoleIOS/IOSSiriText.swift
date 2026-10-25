// Les mots de Siri dans l’app iOS : les trois réponses de l’intent témoin, l’intent
// lui-même et son App Shortcut. Le titre, la description, les phrases, le titre
// court et le symbole sont des littéraux extraits AU BUILD par l’outillage App
// Intents : ils vivent donc ici, à la déclaration, et non dans des constantes d’un
// autre type.

import AppIntents
import ConsoleClient
import ConsoleCore

/// Les mots de l’intent témoin.
enum IOSSiriText {
    static let unconfigured = L10n.text("Aucun serveur relié")
    static let unreachable = L10n.text("Serveur relié, injoignable")
    static func connected(pending: Int) -> String {
        pending == 0 ? L10n.text("Relié au serveur, rien en attente") : L10n.format("Relié au serveur, %lld en attente", pending)
    }
}

/// L’intent témoin : lit l’état du serveur de pipelines de l’app, n’écrit rien. Il
/// ouvre l’app au premier plan et exige un appareil déverrouillé, le jeton étant
/// illisible appareil verrouillé.
struct IOSConnectionStatusIntent: AppIntent {
    static let title: LocalizedStringResource = "Statut de la connexion"
    static let description: IntentDescription? = IntentDescription("OMP Console s’ouvre et dit si cet appareil est relié au serveur, et ce qui vous attend.")
    static let supportedModes: IntentModes = .foreground
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @AppDependency var server: HarnessModel

    init() {}

    /// Pour les tests : résout le serveur dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _server = AppDependency(manager: dependencies) }

    // Type concret, pas `some IntentResult & ProvidesDialog` : les tests exécutent
    // l’intent par `callAsFunction(donate:)`, qui refuse un résultat opaque.
    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        .result(dialog: IntentDialog(stringLiteral: await IOSSiriStatus.answer(for: server)))
    }
}

/// Les phrases Siri de l’app, toutes avec le nom de l’app.
struct OMPConsoleShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: IOSConnectionStatusIntent(),
            phrases: [
                "Statut de \(.applicationName)",
                "Connexion de \(.applicationName)",
                "Vérifier la connexion de \(.applicationName)",
            ],
            shortTitle: "Statut de la connexion",
            systemImageName: "server.rack"
        )
    }
}
