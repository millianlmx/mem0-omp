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

/// L'App Shortcut de l'intent sonde. Toute phrase doit contenir
/// `\(.applicationName)` : sans lui, le processeur de métadonnées sort en erreur.
struct ConsoleShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: OpenConsoleIntent(),
            phrases: ["Ouvre \(.applicationName)"],
            shortTitle: "Ouvrir OMP Console",
            systemImageName: "macwindow"
        )
    }
}
