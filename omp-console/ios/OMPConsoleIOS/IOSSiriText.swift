// Les mots de Siri dans l’app iOS (feature client-ios-possede-par-la-vue, S-4) :
// les trois réponses de l’intent témoin, l’intent lui-même et son App Shortcut.
// Le titre, la description, les phrases,
// le titre court et le symbole sont des littéraux extraits AU BUILD par
// l’outillage App Intents : ils vivent donc ici, à la déclaration, et non dans
// des constantes d’un autre type.

import AppIntents
import ConsoleClient

/// Les mots de l’intent témoin.
enum IOSSiriText {
    static let unpaired = "Non appairé"
    static let pairedNotJoined = "Appairé, Mac non joint"
    static func connected(macName: String) -> String { "Connecté à \(macName)" }
}

/// L’intent témoin : lit l’état du client partagé, n’écrit rien. Il ouvre l’app
/// au premier plan et exige un appareil déverrouillé, le jeton étant illisible
/// appareil verrouillé.
struct IOSConnectionStatusIntent: AppIntent {
    static let title: LocalizedStringResource = "Statut de la connexion"
    static let description: IntentDescription? = IntentDescription("OMP Console s’ouvre et dit si cet appareil est appairé et connecté à un Mac.")
    static let supportedModes: IntentModes = .foreground
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @AppDependency var client: ConsoleClientModel

    init() {}

    /// Pour les tests : résout le client dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _client = AppDependency(manager: dependencies) }

    // Type concret, pas `some IntentResult & ProvidesDialog` : les tests exécutent
    // l’intent par `callAsFunction(donate:)`, qui refuse un résultat opaque.
    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        .result(dialog: IntentDialog(stringLiteral: await IOSSiriStatus.answer(for: client)))
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
            systemImageName: "macbook.and.iphone"
        )
    }
}
