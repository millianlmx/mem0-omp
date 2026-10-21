// Point d'entrée de la coque. Le fichier NE s'appelle PAS main.swift : `@main`
// y est refusé (D5).
//
// UNE scène : la fenêtre principale à barre latérale. Les sections de pilotage
// (Accueil, Pipelines, Projet, Audit, Statistiques) sont servies par le serveur
// de pipelines du VPS (omp-harness) ; Terminal, Fichiers et Mémoire sont locaux.
// L'app reste utilisable en plein écran : aucune fenêtre annexe.
//
// Barre des menus : Présentation ▸ les huit sections (⌘1…⌘8).
//
// Les modèles vivent sur la structure `App` (`@StateObject`), donc à l'échelle de
// l'app : fermer la fenêtre ne laisse pas de shell orphelin, et les accroches de
// terminaison existent avant la première ouverture.
//
// La terminaison passe par `applicationShouldTerminate` en DEUX temps (D3) : la
// première demande est annulée le temps d'ATTENDRE la sortie des process hébergés,
// puis la terminaison est redemandée et passe.

import AppKit
import ConsoleClient
import ConsoleCore
import SwiftUI

@main
struct OMPConsoleApp: App {
    @StateObject private var model = ConsoleModel()
    /// Le serveur de pipelines du VPS : UN modèle et UN jeu de brouillons pour la
    /// fenêtre, partagés par les cinq sections de pilotage.
    /// Un code d'appairage collé ici relie aussi omp et la mémoire de ce Mac (`~/.omp`).
    @StateObject private var server = HarnessModel.live(
        fallback: { HarnessPairing.sharedSettings(home: URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)) },
        onPaired: { try? $0.writeShared(home: URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)) }
    )
    @StateObject private var drafts = HarnessDrafts()
    @StateObject private var terminalModel = TerminalConsoleModel()
    @StateObject private var filesModel = FilesModel()
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
    /// L'état des composants embarqués (S-1/S-2) : le badge du pied de la barre
    /// latérale le montre. Le service d'API le sert aussi (S-4).
    @StateObject private var componentsModel: ComponentPresenceModel
    /// Le service d'API distante (BR-9) : l'appairage de l'iPhone et la mémoire.
    @StateObject private var remoteModel: RemoteServiceModel
    /// Le sélecteur de projet des états vides de Mémoire, Fichiers et Terminal.
    @StateObject private var projectChooser = ProjectChooserModel()
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    init() {
        let presence = OmpPresenceModel()
        _presence = StateObject(wrappedValue: presence)
        // La préparation et la présence des composants sont construites AVANT le
        // service d'API : il les sert (`GET /v1/components`, évènement `components`).
        // OMP absent au lancement : rien ne se télécharge d'office, la feuille
        // bloquante attend « Installer ». Le crochet de recette `-setup.recipe`
        // (racine jetable seulement) remplace l'installateur par un script.
        let setup = SetupRecipe.current()?.model(autoPrepare: presence.canLaunch)
            ?? SetupModel.standard(autoPrepare: presence.canLaunch)
        let components = ComponentPresenceModel()
        _componentsModel = StateObject(wrappedValue: components)
        let remote = RemoteServiceModel(
            port: RemoteServiceModel.resolvedPort(environment: ProcessInfo.processInfo.environment),
            components: { [weak components, weak setup] in
                let installed = components.map { !$0.presence.missing.contains(.omp) } ?? false
                return RemoteComponentsPayload(
                    ompInstalled: installed,
                    ompPath: installed ? components?.binaryPath(.omp) : nil,
                    setupBanner: setup.flatMap { SetupText.banner(state: $0.state, dismissed: true) }
                )
            },
            presenceChanges: components.$presence.voidChanges(),
            setupChanges: setup.$state.voidChanges()
        )
        _remoteModel = StateObject(wrappedValue: remote)
        // L'annonce Bonjour ne survit pas au process (S-14).
        AppDelegate.terminateRemoteService = { [weak remote] in
            remote?.stop()
        }
        // S-14 : le service ne démarre jamais tant que la préparation des composants
        // n'est pas terminée — `onReady` en fait le démarrage différé.
        remote.isSetupReady = { [weak setup] in setup?.state == .ready }
        setup.refreshOmp = {
            presence.recheck()
            return presence.canLaunch
        }
        let cleanup = PodmanCleanupModel()
        _podmanCleanup = StateObject(wrappedValue: cleanup)
        setup.onReady = {
            presence.recheck()
            cleanup.refresh()
            Task { await remote.startIfEnabled() }
        }
        _setupModel = StateObject(wrappedValue: setup)
    }

    var body: some Scene {
        // Sans titre de scène : la fenêtre porte celui de la section courante
        // (`ConsoleRootView`), jamais le nom de l'app. L'identifiant sert à
        // `MainWindow.reveal()` pour la retrouver.
        WindowGroup(id: MainWindow.sceneID) {
            ConsoleRootView(
                model: model,
                server: server,
                drafts: drafts,
                filesModel: filesModel,
                quit: appDelegate.quit,
                memoryModel: memoryModel,
                memoryGraph: memoryGraphModel,
                podmanCleanup: podmanCleanup,
                presence: presence,
                setup: setupModel,
                components: componentsModel,
                remote: remoteModel,
                terminalModel: terminalModel,
                projectChooser: projectChooser
            )
        }
        .commands {
            SectionCommands(console: model)
            // Présentation ▸ « Afficher la barre d'outils » / « Personnaliser la
            // barre d'outils… ».
            ToolbarCommands()
            RemoteCommands()
            QuitCommands(quit: appDelegate.quit)
        }
        // Le panneau Réglages (⌘,) : un seul onglet, « Appareils ».
        Settings {
            ConsoleSettingsView(remote: remoteModel)
        }
    }
}

/// Menu Présentation ▸ les huit sections (⌘1…⌘8), dans l'ordre de la barre
/// latérale : ramène la fenêtre principale, puis y sélectionne la section.
struct SectionCommands: Commands {
    let console: ConsoleModel

    var body: some Commands {
        CommandGroup(before: .sidebar) {
            ForEach(Array(ConsoleSection.allCases.enumerated()), id: \.element) { index, section in
                Button(section.title) {
                    MainWindow.reveal()
                    console.select(section)
                }
                .keyboardShortcut(KeyEquivalent(Self.key(at: index)), modifiers: .command)
            }
            Divider()
        }
    }

    /// La touche du raccourci de la section à `index` : 1…9, puis 0 pour la
    /// dixième (comme la rangée des chiffres du clavier).
    static func key(at index: Int) -> Character {
        index == 9 ? "0" : Character(String(index + 1))
    }
}

/// Menu de l'application ▸ « Appairage… » (⌥⌘A) : ouvre le panneau Réglages sur
/// l'onglet « Appareils » (ou le ramène devant s'il est déjà ouvert). Aucune
/// feuille, et la fenêtre principale n'est ni ramenée ni modifiée.
struct RemoteCommands: Commands {
    var body: some Commands {
        CommandGroup(after: .appInfo) {
            SettingsLink {
                Text(PairingText.menuItem)
            }
            .keyboardShortcut("a", modifiers: [.command, .option])
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

/// Délégué de terminaison : il ne connaît pas les process, il appelle les
/// accroches que les modèles ont posées, par le déroulé unique `quit`
/// (mac-quitter-sans-confirmation, S-4/S-5) — tous les chemins de sortie y passent.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Posée par `TerminalConsoleModel.init` (S-8).
    static var terminateTerminal: (() async -> Void)?
    /// Posée par `OMPConsoleApp.init` : arrête le service d'API distante et son
    /// annonce Bonjour (S-14).
    static var terminateRemoteService: (() async -> Void)?
    /// L'activité du Terminal au moment du Quitter (S-1). Posée par
    /// `TerminalConsoleModel.init`.
    static var terminalQuitActivity: (@MainActor () -> QuitActivity?)?

    /// Les jetons des observateurs de `MainMenuSeparators.observe()` (S-1).
    private var menuObservers: [NSObjectProtocol] = []

    /// S-1 : aucune fenêtre ne se regroupe en onglets. Posé AVANT la première
    /// fenêtre (D-1).
    func applicationWillFinishLaunching(_ notification: Notification) {
        NSWindow.allowsAutomaticWindowTabbing = false
    }

    /// Le déroulé de la sortie (S-4) : instantané des activités, AU PLUS une
    /// alerte, puis accroches, fermeture des feuilles et terminaison redemandée.
    lazy var quit: QuitFlow = makeQuitFlow()

    private func makeQuitFlow() -> QuitFlow {
        QuitFlow(
            activities: { [Self.terminalQuitActivity?()].compactMap { $0 } },
            confirm: QuitAlert.run,
            runHooks: { @MainActor in
                await Self.terminateTerminal?()
                await Self.terminateRemoteService?()
            },
            closeAttachedSheets: Self.closeAttachedSheets,
            requestTermination: { NSApp.terminate(nil) }
        )
    }

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

    /// L'Apple Event de quit (S-5.2). Annuler répond `userCanceledErr` (-128) :
    /// le Dock ne quitte pas, loginwindow interrompt la fermeture de session.
    @objc func handleQuitAppleEvent(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        if quit.request() == .cancelled {
            reply.setParam(NSAppleEventDescriptor(int32: Int32(userCanceledErr)), forKeyword: AEKeyword(keyErrorNumber))
        }
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
    /// redemande finale, accroches faites, termine.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        quit.shouldTerminate()
    }
}
