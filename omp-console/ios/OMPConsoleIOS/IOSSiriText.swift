// Les mots de Siri dans l’app iOS : les réponses des intents, les intents eux-mêmes et
// leurs App Shortcuts (Siri, Raccourcis, bouton Action) — l’intent témoin, « Demander à
// l’OS », « Tout suspendre », « Reprendre » et « Décisions en attente ». Le titre, la
// description, les phrases, le titre court et le symbole sont des littéraux extraits AU
// BUILD par l’outillage App Intents : ils vivent donc ici, à la déclaration, et non dans
// des constantes d’un autre type. Ce que chaque intent fait et répond est décidé
// ailleurs (`IOSSiriStatus`, `IOSSiriRemote`).

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

    // MARK: - Demander à l’OS

    static let askEmpty = L10n.text("Dites ce que vous voulez demander")
    static let asked = L10n.text("Demande transmise à l’OS")

    // MARK: - Tout suspendre, reprendre

    static let suspendConfirm = L10n.text("Suspendre tous les agents ?")
    static let suspended = L10n.text("Tout est suspendu")
    static let resumed = L10n.text("Le travail reprend")
    static let alreadySuspended = L10n.text("Tout est déjà suspendu")
    static let notSuspended = L10n.text("Rien n’est suspendu")
    static let pauseAbsent = L10n.text("Ce serveur ne propose pas la pause")

    // MARK: - Décisions en attente

    static let nothingPending = L10n.text("Rien ne vous attend")
    static func pending(_ count: Int, list: String) -> String {
        count == 1 ? L10n.format("1 décision vous attend : %@", list) : L10n.format("%lld décisions vous attendent : %@", count, list)
    }
    /// « …, et 2 autres » : ce que la phrase ne détaille pas.
    static func others(_ count: Int) -> String {
        count == 1 ? L10n.text("et 1 autre") : L10n.format("et %lld autres", count)
    }
    static func question(_ title: String) -> String { L10n.format("une question sur « %@ »", title) }
    static func questions(_ count: Int, _ title: String) -> String { L10n.format("%lld questions sur « %@ »", count, title) }
    static func specs(_ title: String) -> String { L10n.format("les specs de « %@ »", title) }
    static func review(_ title: String) -> String { L10n.format("la revue de « %@ »", title) }
    static let send = L10n.text("un envoi du poste")
    static let intake = L10n.text("une demande à confirmer")
    static let jira = L10n.text("un commentaire Jira")
    /// Entre deux décisions de la phrase.
    static let separator = ", "
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

/// « Demander à l’OS » : une phrase libre devient une Demande, que le serveur classe.
/// Rien ne s’ouvre ; l’appareil est déverrouillé (le jeton est illisible verrouillé).
struct IOSAskIntent: AppIntent {
    static let title: LocalizedStringResource = "Demander à l’OS"
    static let description: IntentDescription? = IntentDescription("Transmet votre demande à l’OS, qui la classe et propose un plan.")
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Demande", requestValueDialog: "Que voulez-vous demander ?")
    var request: String

    @AppDependency var server: HarnessModel

    init() {}

    /// Pour les tests : résout le serveur dans `dependencies`, jamais dans `.shared`.
    init(request: String, dependencies: AppDependencyManager) {
        _server = AppDependency(manager: dependencies)
        self.request = request
    }

    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        .result(dialog: IntentDialog(stringLiteral: await IOSSiriRemote.ask(request, on: server)))
    }
}

/// « Tout suspendre » : la pause du serveur, après confirmation. Plus rien ne démarre,
/// rien n’est perdu.
struct IOSSuspendAllIntent: AppIntent {
    static let title: LocalizedStringResource = "Tout suspendre"
    static let description: IntentDescription? = IntentDescription("Suspend tous les agents du serveur, après votre confirmation. Rien n’est perdu.")
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @AppDependency var server: HarnessModel

    init() {}

    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        if let refusal = await IOSSiriPause.read(server).answer(wanted: true).phrase {
            return .result(dialog: IntentDialog(stringLiteral: refusal))
        }
        try await requestConfirmation(dialog: IntentDialog(stringLiteral: IOSSiriText.suspendConfirm))
        return .result(dialog: IntentDialog(stringLiteral: await IOSSiriPause.set(true, on: server)))
    }
}

/// « Reprendre » : lève la pause du serveur.
struct IOSResumeAllIntent: AppIntent {
    static let title: LocalizedStringResource = "Reprendre"
    static let description: IntentDescription? = IntentDescription("Lève la pause du serveur : les agents reprennent là où ils en étaient.")
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @AppDependency var server: HarnessModel

    init() {}

    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        if let refusal = await IOSSiriPause.read(server).answer(wanted: false).phrase {
            return .result(dialog: IntentDialog(stringLiteral: refusal))
        }
        return .result(dialog: IntentDialog(stringLiteral: await IOSSiriPause.set(false, on: server)))
    }
}

/// « Décisions en attente » : lit ce qui attend l’humain, n’écrit rien.
struct IOSPendingDecisionsIntent: AppIntent {
    static let title: LocalizedStringResource = "Décisions en attente"
    static let description: IntentDescription? = IntentDescription("Dit combien de décisions vous attendent, et lesquelles.")
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @AppDependency var server: HarnessModel

    init() {}

    /// Pour les tests : résout le serveur dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _server = AppDependency(manager: dependencies) }

    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        .result(dialog: IntentDialog(stringLiteral: await IOSSiriDecisions.answer(for: server)))
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
        AppShortcut(
            intent: IOSAskIntent(),
            phrases: [
                "Demander à \(.applicationName)",
                "Nouvelle demande dans \(.applicationName)",
            ],
            shortTitle: "Demander à l’OS",
            systemImageName: "text.bubble"
        )
        AppShortcut(
            intent: IOSPendingDecisionsIntent(),
            phrases: [
                "Décisions en attente dans \(.applicationName)",
                "Décisions de \(.applicationName)",
            ],
            shortTitle: "Décisions en attente",
            systemImageName: "tray.full"
        )
        AppShortcut(
            intent: IOSSuspendAllIntent(),
            phrases: [
                "Tout suspendre dans \(.applicationName)",
                "Suspendre \(.applicationName)",
            ],
            shortTitle: "Tout suspendre",
            systemImageName: "pause.circle"
        )
        AppShortcut(
            intent: IOSResumeAllIntent(),
            phrases: [
                "Reprendre le travail dans \(.applicationName)",
                "Reprendre \(.applicationName)",
            ],
            shortTitle: "Reprendre",
            systemImageName: "play.circle"
        )
    }
}
