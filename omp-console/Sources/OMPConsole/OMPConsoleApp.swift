// Point d'entrée de la coque. Le fichier NE s'appelle PAS main.swift : `@main`
// y est refusé (D5).
//
// UNE scène : la fenêtre principale à barre latérale. Session OMP, Terminal,
// Projet, Statistiques et la visionneuse en sont des sections (ou une vue
// poussée dans Sessions) — l'app reste utilisable en plein écran, où chaque
// fenêtre annexe partait dans son propre espace (2026-10-02). « Un seul
// terminal » et « jamais deux pilotages » (AC-2) tiennent par les modèles, à
// instance unique sur la structure `App`, et par leurs refus de second
// lancement.
//
// Barre des menus (HIG Keyboards : ⌘N crée l'objet principal de l'app, aucun
// raccourci standard n'est détourné) : Fichier ▸ « Nouvelle feature… » ⌘N,
// « Nouvelle session OMP » ⌥⌘N, « Piloter un projet… » ⇧⌘N ; Présentation ▸ les
// neuf sections ⌘1…⌘9.
//
// Les modèles de terminal, de session et de pilotage vivent sur la structure `App`
// (`@StateObject`), donc à l'échelle de l'app : fermer une fenêtre ne laisse pas un
// `omp` orphelin, et les accroches de terminaison existent avant la première
// ouverture.
//
// La terminaison passe par `applicationShouldTerminate` en DEUX temps (D3) : la
// première demande est annulée le temps d'ATTENDRE la sortie des process hébergés,
// puis la terminaison est redemandée et passe.

import AppKit
import ConsoleCore
import SwiftUI

@main
struct OMPConsoleApp: App {
    @StateObject private var model = ConsoleModel()
    @StateObject private var sessionModel = SessionConsoleModel()
    @StateObject private var terminalModel = TerminalConsoleModel()
    @StateObject private var filesModel = FilesModel()
    @StateObject private var kanbanModel = KanbanModel()
    @StateObject private var actionsModel: ActionsModel
    @StateObject private var projectModel = ProjectConsoleModel()
    @StateObject private var statsModel = StatsModel()
    @StateObject private var memoryModel = MemoryModel()
    /// Le modèle du mode graphe de la mémoire (S-1) : à l'échelle de l'app, comme
    /// les autres, pour que la bascule liste ⇄ graphe ne perde ni la position, ni la
    /// sélection, ni les filtres.
    @StateObject private var memoryGraphModel = MemoryGraphModel()
    @StateObject private var contractModel = ContractModel()
    @StateObject private var homeModel: HomeModel
    /// La préparation vit à l'échelle de l'app (S-5) : elle survit à la fermeture
    /// de sa feuille, et son `onReady` revérifie OMP.
    @StateObject private var setupModel: SetupModel
    /// L'état des composants embarqués (S-1/S-2) : le badge du pied de la barre
    /// latérale le montre, et ses deux veilles vivent tant que l'app vit — le
    /// badge se recalcule sans redémarrage.
    @StateObject private var componentsModel = ComponentPresenceModel()
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    /// UN `ConductorPool` pour l'app (S-7 de omp-console-redesign) : il fait
    /// conduire les dépôts sans pilote vivant, et ses accroches de terminaison
    /// sont posées dès sa construction.
    init() {
        let pool = ConductorPool()
        _actionsModel = StateObject(wrappedValue: ActionsModel(pilot: pool))
        // `onReady` revérifie OMP : le composant vient d'être installé par l'app
        // elle-même (S-4), et c'est ce binaire-là qu'elle hébergera désormais.
        let home = HomeModel()
        _homeModel = StateObject(wrappedValue: home)
        let setup = SetupModel.standard()
        setup.onReady = { home.recheck() }
        _setupModel = StateObject(wrappedValue: setup)
    }

    var body: some Scene {
        // UNE seule scène : la fenêtre principale. Session OMP, Terminal, Projet,
        // Statistiques et la visionneuse sont des sections (ou une vue poussée)
        // de cette fenêtre — en plein écran, une fenêtre annexe partait dans son
        // propre espace (demande du 2026-10-02). Sans titre de scène : la fenêtre
        // porte celui de la section courante (`ConsoleRootView`), jamais le nom
        // de l'app. L'identifiant sert à `MainWindow.reveal()` pour la retrouver.
        WindowGroup(id: MainWindow.sceneID) {
            ConsoleRootView(
                model: model,
                filesModel: filesModel,
                kanban: kanbanModel,
                alerts: appDelegate.alerts,
                actions: actionsModel,
                projectModel: projectModel,
                memoryModel: memoryModel,
                memoryGraph: memoryGraphModel,
                contract: contractModel,
                home: homeModel,
                setup: setupModel,
                components: componentsModel,
                sessionModel: sessionModel,
                terminalModel: terminalModel,
                statsModel: statsModel
            )
        }
        .commands {
            NewItemCommands(console: model, actions: actionsModel, home: homeModel, project: projectModel)
            SectionCommands(console: model)
            // Présentation ▸ « Afficher la barre d'outils » / « Personnaliser la
            // barre d'outils… » : la barre de la fenêtre principale est
            // personnalisable.
            ToolbarCommands()
            WelcomeCommands(home: homeModel)
        }
    }
}

/// Menu Fichier, à la place de « Nouvelle fenêtre » (la fenêtre principale est
/// unique : une seconde n'aurait rien à montrer de plus). Chaque commande ramène
/// la fenêtre principale.
///
/// - « Nouvelle feature… » (⌘N, l'objet principal de l'app) : présente la feuille
///   de lancement. Inactive tant qu'OMP est introuvable.
/// - « Nouvelle session OMP » (⌥⌘N) : la section « Session OMP ».
/// - « Piloter un projet… » (⇧⌘N) : la section « Projet », puis la feuille de
///   choix (S-1). Si un pilotage est en cours, le modèle pose son refus (S-2) au
///   lieu d'ouvrir la feuille.
struct NewItemCommands: Commands {
    let console: ConsoleModel
    @ObservedObject var actions: ActionsModel
    @ObservedObject var home: HomeModel
    @ObservedObject var project: ProjectConsoleModel

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button(HomeText.newFeature) {
                MainWindow.reveal()
                actions.launchFormShown = true
            }
            .keyboardShortcut("n", modifiers: .command)
            .disabled(!home.canLaunch)
            Button("Nouvelle session OMP") {
                MainWindow.reveal()
                console.select(.session)
            }
            .keyboardShortcut("n", modifiers: [.command, .option])
            Button(ProjectViewText.startConduite) {
                MainWindow.reveal()
                console.select(.project)
                project.presentLaunchSheet()
            }
            .keyboardShortcut("n", modifiers: [.command, .shift])
        }
    }
}

/// Menu Présentation ▸ les neuf sections, dans l'ordre de la barre latérale
/// (⌘1…⌘9) : ramène la fenêtre principale, puis y sélectionne la section.
struct SectionCommands: Commands {
    let console: ConsoleModel

    var body: some Commands {
        CommandGroup(before: .sidebar) {
            ForEach(Array(ConsoleSection.allCases.enumerated()), id: \.element) { index, section in
                Button(section.title) {
                    MainWindow.reveal()
                    console.select(section)
                }
                .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
            }
            Divider()
        }
    }
}

/// Menu Aide ▸ « Bienvenue dans OMP Console » (S-4 de omp-console-redesign) : la
/// bienvenue vue une fois reste facile à retrouver (HIG Onboarding). Ramène la
/// fenêtre principale, puis redemande la feuille.
struct WelcomeCommands: Commands {
    @ObservedObject var home: HomeModel

    var body: some Commands {
        CommandGroup(replacing: .help) {
            Button(HomeText.welcomeMenuItem) {
                MainWindow.reveal()
                home.requestWelcome()
            }
        }
    }
}

/// Délégué de terminaison : il ne connaît pas les sessions, il appelle les
/// accroches que les modèles ont posées. Sans accroche, l'app quitte
/// immédiatement.
///
/// Il POSSÈDE aussi le modèle d'alertes et l'item de barre de menus (S-2, S-9) :
/// le modèle vit à l'échelle de l'app, et l'item est créé une seule fois au
/// lancement.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Posée par `SessionConsoleModel.init`.
    static var terminateSession: (() async -> Void)?
    /// Posée par `ProjectConsoleModel.init`.
    static var terminateProject: (() async -> Void)?
    /// Posée par `TerminalConsoleModel.init` (S-8).
    static var terminateTerminal: (() async -> Void)?
    /// Posée par `ConductorPool.init` : arrête tous les conducteurs.
    static var terminateConductors: (() async -> Void)?
    /// Posée par `ConductorPool.init` : vrai quand un conducteur mène des maillons
    /// en cours — quitter les interromprait.
    static var conductorsBusy: (() -> Bool)?

    /// Le modèle d'alertes, créé à la demande (les tests du délégué ne le
    /// construisent donc pas).
    lazy var alerts = AlertsModel()

    private var statusItemController: StatusItemController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // L'item de barre de menus, créé UNE fois (S-2), puis le modèle démarré :
        // son titre suivra l'état publié, et l'autorisation sera demandée.
        statusItemController = StatusItemController(model: alerts)
        alerts.start()
    }

    /// B-7/AC-9 : fermer la fenêtre ne quitte PAS l'app (le comportement par défaut
    /// mesuré, Doc-6, est écrit explicitement ici pour être testé).
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    /// Vrai une fois les accroches de fermeture exécutées : la seconde demande de
    /// terminaison passe alors sans attente.
    private(set) var hooksDone = false
    /// La seconde demande de terminaison, une fois les process arrêtés. Injectable :
    /// un test ne doit pas terminer le process qui l'exécute.
    var requestTermination: @MainActor () -> Void = { NSApp.terminate(nil) }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if hooksDone { return .terminateNow }
        // Des maillons conduits par l'app seraient interrompus : l'utilisateur
        // tranche (S-7 de omp-console-redesign).
        if Self.conductorsBusy?() == true, !Self.confirmQuitWhileConducting() {
            return .terminateCancel
        }
        guard Self.terminateSession != nil || Self.terminateProject != nil || Self.terminateTerminal != nil
            || Self.terminateConductors != nil else {
            return .terminateNow
        }
        // MESURÉ (2026-10-01, bundle lancé) : avec `.terminateLater`, une feuille
        // SwiftUI présentée (Bienvenue, OMP est requis, Nouvelle feature…) bloquait
        // la sortie — AppKit attendait la réponse dans `_shouldTerminate` et l'app
        // restait ouverte. Les accroches tournent donc HORS de cette attente :
        // la demande est annulée, les process sont arrêtés, puis la terminaison
        // est redemandée et passe aussitôt.
        Task { @MainActor in
            // Les accroches sont INDÉPENDANTES (S-8) : leur ordre n'a pas
            // d'importance, et chacune est bornée par sa propre escalade.
            await Self.terminateSession?()
            await Self.terminateProject?()
            await Self.terminateTerminal?()
            await Self.terminateConductors?()
            self.hooksDone = true
            self.requestTermination()
        }
        return .terminateCancel
    }

    /// La confirmation de fermeture : « Quitter » (premier bouton) rend `true`.
    private static func confirmQuitWhileConducting() -> Bool {
        let alert = NSAlert()
        alert.messageText = QuitText.title
        alert.informativeText = QuitText.body
        alert.addButton(withTitle: QuitText.quit)
        alert.addButton(withTitle: QuitText.cancel)
        return alert.runModal() == .alertFirstButtonReturn
    }
}

/// Les textes de la confirmation de fermeture (S-7 de omp-console-redesign).
enum QuitText {
    static let title = "Quitter OMP Console ?"
    static let body =
        "OMP Console pilote des pipelines en cours : quitter les interrompt. Vous pourrez les relancer avec « Reprendre » à la prochaine ouverture."
    static let quit = "Quitter"
    static let cancel = "Annuler"
}
