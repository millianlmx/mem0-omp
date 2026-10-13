import AppIntents

/// L'intent sonde de la coque macOS (feature bundle-mac-sans-metadonnees-app-intents,
/// S-1) : il ramène la fenêtre principale au premier plan, même fermée.
///
/// Son identifiant `OpenConsoleIntent` et la phrase « Ouvre ${applicationName} » de
/// son App Shortcut sont le contrat du contrôle post-assemblage de
/// `scripts/swift-app.sh`, qui les cherche dans `extract.actionsdata` : les
/// renommer fait échouer l'assemblage.
struct OpenConsoleIntent: AppIntent {
    static let title: LocalizedStringResource = "Ouvrir OMP Console"
    static let description = IntentDescription("Ouvre la fenêtre principale d’OMP Console.")
    // `openAppWhenRun` est déprécié sous macOS 26 : `supportedModes` le remplace,
    // et le processeur de métadonnées en déduit `"openAppWhenRun":true`.
    static let supportedModes: IntentModes = .foreground

    @MainActor
    func perform() async throws -> some IntentResult {
        MainWindow.reveal()
        return .result()
    }
}

/// Les App Shortcuts de la coque : l'intent sonde, les deux intents vocaux des
/// demandes en attente (siri-mac-questions-en-attente, S-6), puis les cinq intents
/// de pilotage des pipelines (siri-mac-pilotage-pipelines, S-8), soit 8 App
/// Shortcuts sur les 10 qu'admet une app. Toute phrase doit contenir
/// `\(.applicationName)` : sans lui, le processeur de métadonnées sort en erreur.
struct ConsoleShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: OpenConsoleIntent(),
            phrases: ["Ouvre \(.applicationName)"],
            shortTitle: "Ouvrir OMP Console",
            systemImageName: "macwindow"
        )
        AppShortcut(
            intent: MacPendingIntent(),
            phrases: [
                "Qu’est-ce qui m’attend dans \(.applicationName)",
                "Ce qui m’attend dans \(.applicationName)",
                "Demandes en attente dans \(.applicationName)",
                "Questions en attente dans \(.applicationName)",
            ],
            shortTitle: "Ce qui m’attend",
            systemImageName: "tray.full"
        )
        AppShortcut(
            intent: MacAnswerIntent(),
            phrases: [
                "Réponds dans \(.applicationName)",
                "Répondre dans \(.applicationName)",
                "Répondre aux questions de \(.applicationName)",
            ],
            shortTitle: "Répondre",
            systemImageName: "text.bubble"
        )
        AppShortcut(
            intent: MacLaunchPipelineIntent(),
            phrases: [
                "Lancer une pipeline dans \(.applicationName)",
                "Lance une pipeline dans \(.applicationName)",
                "Nouvelle feature dans \(.applicationName)",
            ],
            shortTitle: "Lancer une pipeline",
            systemImageName: "play.fill"
        )
        AppShortcut(
            intent: MacResumeFeatureIntent(),
            phrases: [
                "Reprendre une pipeline dans \(.applicationName)",
                "Reprends une pipeline dans \(.applicationName)",
            ],
            shortTitle: "Reprendre",
            systemImageName: "arrow.clockwise"
        )
        AppShortcut(
            intent: MacStopFeatureIntent(),
            phrases: [
                "Arrêter une pipeline dans \(.applicationName)",
                "Arrête une pipeline dans \(.applicationName)",
            ],
            shortTitle: "Arrêter",
            systemImageName: "stop.fill"
        )
        AppShortcut(
            intent: MacValidateSpecsIntent(),
            phrases: [
                "Valider les specs dans \(.applicationName)",
                "Valide les specs dans \(.applicationName)",
            ],
            shortTitle: "Valider les specs",
            systemImageName: "checkmark.seal"
        )
        AppShortcut(
            intent: MacAcceptReviewIntent(),
            phrases: [
                "Accepter la revue dans \(.applicationName)",
                "Accepte la revue dans \(.applicationName)",
            ],
            shortTitle: "Accepter la revue",
            systemImageName: "checkmark.circle"
        )
    }
}
