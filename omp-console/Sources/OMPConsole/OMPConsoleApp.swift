// Point d'entrée de la coque. Le fichier NE s'appelle PAS main.swift : `@main`
// y est refusé (D5).
//
// UNE scène : la fenêtre principale, qui montre l'« OS agentique » (le Radar, les fils,
// le centre : `OSRootView`). Les agents, les features et le Poste sont servis par le
// serveur de pipelines du VPS (omp-harness) ; la Mémoire est locale. L'app reste
// utilisable en plein écran : aucune fenêtre annexe.
//
// Barre des menus : Présentation ▸ les écrans de l'OS (⌘1…⌘6) et « Actualiser » (⌘R) ;
// Fichier ▸ « Nouvelle feature… » (⌘N), « Commandes… » (⌘K) et « Rechercher… » (⌘F).
//
// Les modèles vivent sur la structure `App` (`@StateObject`), donc à l'échelle de
// l'app : fermer la fenêtre ne perd ni la Mémoire ni la préparation.
//
// La terminaison passe par `applicationShouldTerminate` en DEUX temps (D3) : la
// première demande est annulée le temps de fermer les feuilles attachées, puis la
// terminaison est redemandée et passe.

import AppKit
import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

@main
struct OMPConsoleApp: App {
    /// Le serveur de pipelines du VPS : UN modèle et UN jeu de brouillons pour la
    /// fenêtre, partagés par les sections du serveur (le poste de travail est porté par
    /// ce même modèle, `server.workstation`).
    /// Un code d'appairage collé ici relie aussi omp et la mémoire de ce Mac (`~/.omp`).
    @StateObject private var server = HarnessModel.live(
        fallback: { HarnessPairing.sharedSettings(home: URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)) },
        onPaired: { try? $0.writeShared(home: URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)) }
    )
    @StateObject private var drafts = HarnessDrafts()
    @StateObject private var memoryModel = MemoryModel()
    /// Le modèle du mode graphe de la mémoire (S-1) : à l'échelle de l'app, pour que
    /// la bascule liste ⇄ graphe ne perde ni la position, ni la sélection.
    @StateObject private var memoryGraphModel = MemoryGraphModel()
    /// Le bandeau de nettoyage de l'ancien moteur (S-6 d'omp-console-sans-podman).
    @StateObject private var podmanCleanup: PodmanCleanupModel
    @StateObject private var presence: OmpPresenceModel
    /// La préparation vit à l'échelle de l'app (S-5) : elle survit à la fermeture
    /// de sa feuille, et son `onReady` revérifie OMP.
    @StateObject private var setupModel: SetupModel
    /// L'état des composants embarqués (S-1/S-2) : le badge au pied des fils le montre.
    @StateObject private var componentsModel: ComponentPresenceModel
    /// Le sélecteur de projet de l'état vide de la Mémoire.
    @StateObject private var projectChooser = ProjectChooserModel()
    /// Les notifications : locales tant que l'app tourne en arrière-plan, et leurs gestes.
    @StateObject private var notifications = HarnessNotificationCenter()
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    init() {
        let presence = OmpPresenceModel()
        _presence = StateObject(wrappedValue: presence)
        // OMP absent au lancement : rien ne se télécharge d'office, la feuille
        // bloquante attend « Installer ». Le crochet de recette `-setup.recipe`
        // (racine jetable seulement) remplace l'installateur par un script.
        let setup = SetupRecipe.current()?.model(autoPrepare: presence.canLaunch)
            ?? SetupModel.standard(autoPrepare: presence.canLaunch)
        let components = ComponentPresenceModel()
        _componentsModel = StateObject(wrappedValue: components)
        setup.refreshOmp = {
            presence.recheck()
            return presence.canLaunch
        }
        let cleanup = PodmanCleanupModel()
        _podmanCleanup = StateObject(wrappedValue: cleanup)
        setup.onReady = {
            presence.recheck()
            cleanup.refresh()
        }
        _setupModel = StateObject(wrappedValue: setup)
    }

    var body: some Scene {
        // Sans titre de scène : la fenêtre porte celui de l'écran montré
        // (`OSRootView`), jamais le nom de l'app. L'identifiant sert à
        // `MainWindow.reveal()` pour la retrouver.
        WindowGroup(id: MainWindow.sceneID) {
            ConsoleRootView(
                server: server,
                drafts: drafts,
                quit: appDelegate.quit,
                memory: OSMemoryModels(model: memoryModel, graph: memoryGraphModel, cleanup: podmanCleanup, chooser: projectChooser),
                presence: presence,
                setup: setupModel,
                components: componentsModel,
                notifications: notifications
            )
        }
        .commands {
            DestinationCommands()
            RefreshCommands()
            PaletteCommands(drafts: drafts)
            // Présentation ▸ « Afficher la barre d'outils » / « Personnaliser la
            // barre d'outils… ».
            ToolbarCommands()
            QuitCommands(quit: appDelegate.quit)
        }
    }
}

/// Menu Présentation ▸ les écrans de l'OS, dans l'ordre de la liste des fils : ⌘1…⌘6
/// (`OSMacDestinations`). Ramène la fenêtre principale, puis y montre l'écran.
struct DestinationCommands: Commands {
    @FocusedObject private var workspace: OSWorkspace?

    var body: some Commands {
        CommandGroup(before: .sidebar) {
            ForEach(Array(OSMacDestinations.shortcuts.enumerated()), id: \.offset) { index, destination in
                Button(destination.title) {
                    MainWindow.reveal()
                    workspace?.selection = destination.selection
                }
                .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
                .disabled(workspace == nil)
            }
            Divider()
        }
    }
}

/// L'actualisation de ce que l'OS montre : le menu Présentation ▸ « Actualiser » (⌘R)
/// l'appelle. La coque la publie pour la scène ; aucun bouton ne la répète à l'écran.
struct HarnessRefreshAction {
    let isEnabled: Bool
    let perform: @MainActor () async -> Void
}

private struct HarnessRefreshKey: FocusedValueKey {
    typealias Value = HarnessRefreshAction
}

extension FocusedValues {
    var harnessRefresh: HarnessRefreshAction? {
        get { self[HarnessRefreshKey.self] }
        set { self[HarnessRefreshKey.self] = newValue }
    }
}

/// Présentation ▸ « Actualiser » (⌘R) : relit ce que montre l'OS (la coque publie
/// l'action, `HarnessRefreshAction`). Aucun bouton ne la répète à l'écran.
struct RefreshCommands: Commands {
    @FocusedValue(\.harnessRefresh) private var refresh

    var body: some Commands {
        CommandGroup(before: .sidebar) {
            Button(PipelineServerText.refresh) {
                guard let refresh else { return }
                Task { await refresh.perform() }
            }
            .keyboardShortcut("r", modifiers: .command)
            .disabled(refresh?.isEnabled != true)
            Divider()
        }
    }
}

/// Fichier ▸ « Nouvelle feature… » (⌘N, à la place de « Nouvelle fenêtre » : l'app
/// garde une seule fenêtre), « Commandes… » (⌘K) et « Rechercher… » (⌘F) : la palette
/// partagée avec l'app iOS (ConsoleUI). Chacune ramène la fenêtre principale.
struct PaletteCommands: Commands {
    let drafts: HarnessDrafts

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button(PipelineServerText.newFeature) {
                MainWindow.reveal()
                drafts.launchSheetShown = true
            }
            .keyboardShortcut("n", modifiers: .command)
            Button(PipelineServerText.paletteMenu) {
                MainWindow.reveal()
                drafts.openPalette(search: false)
            }
            .keyboardShortcut("k", modifiers: .command)
            Button(PipelineServerText.searchMenu) {
                MainWindow.reveal()
                drafts.openPalette(search: true)
            }
            .keyboardShortcut("f", modifiers: .command)
        }
    }
}


/// Menu de l'application ▸ « Quitter OMP Console » (⌘Q, S-5.1) : remplace
/// l'élément standard, dont l'action n'est plus appelée quand une feuille est
/// attachée (mesuré, Doc-9). Il passe par le déroulé unique de la sortie.
struct QuitCommands: Commands {
    let quit: QuitFlow

    var body: some Commands {
        CommandGroup(replacing: .appTermination) {
            Button(QuitText.menuItem) { quit.request() }
                .keyboardShortcut("q", modifiers: .command)
        }
    }
}

/// Délégué de terminaison : tous les chemins de sortie passent par le déroulé unique
/// `quit` (mac-quitter-sans-confirmation, S-4/S-5).
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Les jetons des observateurs de `MainMenuSeparators.observe()` (S-1).
    private var menuObservers: [NSObjectProtocol] = []

    /// S-1 : aucune fenêtre ne se regroupe en onglets. Posé AVANT la première
    /// fenêtre (D-1).
    func applicationWillFinishLaunching(_ notification: Notification) {
        NSWindow.allowsAutomaticWindowTabbing = false
    }

    /// Le déroulé de la sortie (S-4) : fermeture des feuilles, puis terminaison redemandée.
    lazy var quit = QuitFlow(closeAttachedSheets: Self.closeAttachedSheets, requestTermination: { NSApp.terminate(nil) })

    func applicationDidFinishLaunching(_ notification: Notification) {
        // S-1 : plus de séparateur en tête, en fin ni en double dans la barre des
        // menus, au lancement puis à chaque mise à jour d'un menu.
        menuObservers = MainMenuSeparators.observe()
        if let mainMenu = NSApp.mainMenu { MainMenuSeparators.tidy(mainMenu) }
        // Le Quitter du Dock, `osascript … quit` et la fermeture de session macOS
        // arrivent en Apple Event : ce gestionnaire les reçoit même quand une
        // feuille est attachée, ce que `applicationShouldTerminate` ne fait pas
        // (mesuré, Doc-9).
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleQuitAppleEvent(_:withReplyEvent:)),
            forEventClass: AEEventClass(kCoreEventClass),
            andEventID: AEEventID(kAEQuitApplication)
        )
    }

    /// L'Apple Event de quit (S-5.2) : le Dock et la fermeture de session passent par le
    /// même déroulé.
    @objc func handleQuitAppleEvent(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        quit.request()
    }

    /// S-6 : fermer la fenêtre qui porte une feuille ferme les deux, et laisse
    /// `NSApp.terminate` aboutir (mesuré, Doc-9).
    private static func closeAttachedSheets() {
        for window in NSApp.windows where window.attachedSheet != nil {
            window.close()
        }
    }

    /// B-7/AC-9 : fermer la fenêtre ne quitte PAS l'app.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    /// Toute demande à `NSApp.terminate` passe par le déroulé : seule la
    /// redemande finale, feuilles fermées, termine.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        quit.shouldTerminate()
    }
}
