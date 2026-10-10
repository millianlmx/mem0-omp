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
    @StateObject private var model: ConsoleModel
    @StateObject private var terminalModel = TerminalConsoleModel()
    @StateObject private var filesModel = FilesModel()
    @StateObject private var sessionModel: SessionConsoleModel
    @StateObject private var kanbanModel: KanbanModel
    @StateObject private var actionsModel: ActionsModel
    @StateObject private var projectModel: ProjectConsoleModel
    @StateObject private var statsModel: StatsModel
    @StateObject private var memoryModel: MemoryModel
    /// Le modèle du mode graphe de la mémoire (S-1) : à l'échelle de l'app, comme
    /// les autres, pour que la bascule liste ⇄ graphe ne perde ni la position, ni la
    /// sélection, ni les filtres.
    @StateObject private var memoryGraphModel = MemoryGraphModel()
    @StateObject private var contractModel: ContractModel
    @StateObject private var homeModel: HomeModel
    /// La préparation vit à l'échelle de l'app (S-5) : elle survit à la fermeture
    /// de sa feuille, et son `onReady` revérifie OMP.
    @StateObject private var setupModel: SetupModel
    /// L'état des composants embarqués (S-1/S-2) : le badge du pied de la barre
    /// latérale le montre, et ses deux veilles vivent tant que l'app vit — le
    /// badge se recalcule sans redémarrage. Le service d'API le sert aussi (S-4).
    @StateObject private var componentsModel: ComponentPresenceModel
    /// Le service d'API distante (BR-9) : à l'échelle de l'app, comme les autres —
    /// il possède le registre des appareils et l'interrupteur persistant, que
    /// montre l'onglet « Appareils » des Réglages.
    @StateObject private var remoteModel: RemoteServiceModel
    /// Le sélecteur de projet des états vides de Mémoire, Fichiers et Terminal
    /// (S-2 de mac-etats-vides-sans-issue) : à l'échelle de l'app, il écrit par
    /// la session et lit les projets connus dans le magasin du service d'API.
    @StateObject private var projectChooser: ProjectChooserModel
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    /// Un `ActionsModel` pour l'app : il poste au service les gestes des cartes
    /// (S-9), sans lancer aucun process. Les accroches de terminaison des modèles
    /// sont posées dès leur construction.
    init() {
        let console = ConsoleModel()
        _model = StateObject(wrappedValue: console)
        let contract = ContractModel()
        _contractModel = StateObject(wrappedValue: contract)
        let actions = ActionsModel()
        _actionsModel = StateObject(wrappedValue: actions)
        // Le crochet de recette `-home.recipe` (`HomeRecipe`) : nil hors recette,
        // donc le comportement de production.
        let kanban = KanbanModel(recipeBoard: HomeRecipe.current()?.board)
        _kanbanModel = StateObject(wrappedValue: kanban)
        let session = SessionConsoleModel()
        _sessionModel = StateObject(wrappedValue: session)
        // UN magasin pour la liste des projets connus : celui que le service
        // d'API sert par `GET /v1/repos`, donc le sélecteur des états vides
        // montre exactement la même liste, sans seconde veille.
        let storeHub = StoreHub()
        _projectChooser = StateObject(wrappedValue: ProjectChooserModel(
            session: session,
            knownRoots: { KnownProjects.roots(in: storeHub.current()) }
        ))
        let project = ProjectConsoleModel()
        _projectModel = StateObject(wrappedValue: project)
        let stats = StatsModel()
        _statsModel = StateObject(wrappedValue: stats)
        // `onReady` revérifie OMP : le composant vient d'être installé par l'app
        // elle-même (S-4), et c'est ce binaire-là qu'elle hébergera désormais.
        let home = HomeModel()
        _homeModel = StateObject(wrappedValue: home)
        // La préparation et la présence des composants sont construites AVANT le
        // service d'API : il les sert (`GET /v1/components`, évènement `components`).
        // OMP absent au lancement : rien ne se télécharge d'office, la feuille
        // bloquante attend « Installer ». Le crochet de recette `-setup.recipe`
        // (racine jetable seulement) remplace l'installateur par un script.
        let setup = SetupRecipe.current()?.model(autoPrepare: home.canLaunch)
            ?? SetupModel.standard(autoPrepare: home.canLaunch)
        let presence = ComponentPresenceModel()
        _componentsModel = StateObject(wrappedValue: presence)
        // Le service d'API distante partage les modèles de l'app : ce que l'API
        // sert à distance est l'état que la fenêtre montre. Il démarre à
        // l'apparition de la racine ET sur `onReady` (S-14).
        let remote = RemoteServiceModel(
            port: RemoteServiceModel.resolvedPort(environment: ProcessInfo.processInfo.environment),
            storeHub: storeHub,
            kanban: kanban,
            actions: actions,
            session: session,
            project: project,
            components: { [weak presence, weak setup] in
                let installed = presence.map { !$0.presence.missing.contains(.omp) } ?? false
                return RemoteComponentsPayload(
                    ompInstalled: installed,
                    ompPath: installed ? presence?.binaryPath(.omp) : nil,
                    setupBanner: setup.flatMap { SetupText.banner(state: $0.state, dismissed: true) }
                )
            },
            presenceChanges: presence.$presence.voidChanges(),
            setupChanges: setup.$state.voidChanges()
        )
        _remoteModel = StateObject(wrappedValue: remote)
        // L'annonce Bonjour ne survit pas au process (S-14) : l'accroche de
        // terminaison est posée dès la construction, comme celles des autres
        // modèles.
        AppDelegate.terminateRemoteService = { [weak remote] in
            remote?.stop()
        }
        // S-14 : le service ne démarre jamais tant que la préparation des composants
        // n'est pas terminée — `onReady` en fait le démarrage différé.
        remote.isSetupReady = { [weak setup] in setup?.state == .ready }
        setup.refreshOmp = {
            home.recheck()
            return home.canLaunch
        }
        setup.onReady = {
            home.recheck()
            Task { await remote.startIfEnabled() }
        }
        _setupModel = StateObject(wrappedValue: setup)
        // Le clic d'une notification (notifications-mac-lien-profond S-3/S-4) : le
        // routeur agit sur les modèles de la fenêtre et vit tant que cette accroche
        // le retient.
        let router = AlertRouter(console: console, home: home, kanban: kanban, contract: contract, actions: actions)
        AppDelegate.openAlert = { router.open($0) }
        // La section Mémoire reprend l'ancienne pile par LA MÊME action que la
        // feuille de préparation (S-6) : une seule implémentation.
        let memory = MemoryModel()
        memory.recoverOwnership = { await setup.takeOverLegacyStack() }
        _memoryModel = StateObject(wrappedValue: memory)
    }

    var body: some Scene {
        // La fenêtre principale : Session OMP, Terminal, Projet, Statistiques et
        // la visionneuse sont des sections (ou une vue poussée) de cette fenêtre
        // — en plein écran, une fenêtre annexe partait dans son propre espace
        // (demande du 2026-10-02). Sans titre de scène : la fenêtre porte celui
        // de la section courante (`ConsoleRootView`), jamais le nom de l'app.
        // L'identifiant sert à `MainWindow.reveal()` pour la retrouver.
        WindowGroup(id: MainWindow.sceneID) {
            ConsoleRootView(
                model: model,
                filesModel: filesModel,
                kanban: kanbanModel,
                alerts: appDelegate.alerts,
                quit: appDelegate.quit,
                actions: actionsModel,
                projectModel: projectModel,
                memoryModel: memoryModel,
                memoryGraph: memoryGraphModel,
                contract: contractModel,
                home: homeModel,
                setup: setupModel,
                components: componentsModel,
                remote: remoteModel,
                sessionModel: sessionModel,
                terminalModel: terminalModel,
                statsModel: statsModel,
                projectChooser: projectChooser
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
            RemoteCommands()
            QuitCommands(quit: appDelegate.quit)
        }
        // Le panneau Réglages (⌘, ou « Réglages… » du menu de l'app, créés par
        // SwiftUI) : un seul onglet, « Appareils ». SwiftUI garantit une seule
        // fenêtre : une nouvelle demande la ramène au premier plan.
        Settings {
            ConsoleSettingsView(remote: remoteModel)
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

/// Délégué de terminaison : il ne connaît pas les sessions, il appelle les
/// accroches que les modèles ont posées, par le déroulé unique `quit`
/// (mac-quitter-sans-confirmation, S-4/S-5) — tous les chemins de sortie y passent.
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
    /// Posée par `OMPConsoleApp.init` : arrête le service d'API distante et son
    /// annonce Bonjour (S-14).
    static var terminateRemoteService: (() async -> Void)?
    /// Posée par `OMPConsoleApp.init` : remet le clic d'une notification au
    /// routeur de la fenêtre (`nil` : payload absent ou illisible → Accueil).
    static var openAlert: (@MainActor (AlertOpening?) -> Void)?

    /// L'inventaire du Quitter (mac-quitter-sans-confirmation, S-1) : chaque modèle
    /// pose, dans son init, la lecture de SON activité, prise d'un trait à la
    /// demande de sortie. Posée par `SessionConsoleModel.init`.
    static var sessionQuitActivity: (@MainActor () -> QuitActivity?)?
    /// Posée par `TerminalConsoleModel.init`.
    static var terminalQuitActivity: (@MainActor () -> QuitActivity?)?
    /// Posée par `ProjectConsoleModel.init`.
    static var projectQuitActivity: (@MainActor () -> QuitActivity?)?

    /// Le superviseur de l'ownership des ports (S-5) : unique à l'app, démarré
    /// par `alerts.start()` — aucune autre surface ne le démarre.
    lazy var ownership = StackOwnershipModel()

    /// Le modèle d'alertes, créé à la demande (les tests du délégué ne le
    /// construisent donc pas). Sous `-home.recipe`, il suit l'ardoise de la
    /// recette, comme l'Accueil.
    lazy var alerts = AlertsModel(ownership: ownership, recipeBoard: HomeRecipe.current()?.board)

    private var statusItemController: StatusItemController?

    /// Le déroulé de la sortie (S-4) : instantané des activités, AU PLUS une
    /// alerte, puis accroches, fermeture des feuilles et terminaison redemandée.
    /// Les closures sont remplaçables par les tests.
    lazy var quit: QuitFlow = makeQuitFlow()

    private func makeQuitFlow() -> QuitFlow {
        QuitFlow(
            activities: { [weak self] in self?.quitActivities() ?? [] },
            confirm: QuitAlert.run,
            runHooks: { @MainActor in
                // Accroches INCHANGÉES (S-8 de terminal-integre) : indépendantes,
                // chacune bornée par sa propre escalade.
                await Self.terminateSession?()
                await Self.terminateProject?()
                await Self.terminateTerminal?()
                await Self.terminateRemoteService?()
            },
            closeAttachedSheets: Self.closeAttachedSheets,
            requestTermination: { NSApp.terminate(nil) }
        )
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // L'item de barre de menus, créé UNE fois (S-2), puis le modèle démarré :
        // son titre suivra l'état publié, et l'autorisation sera demandée. Le clic
        // est branché AVANT `start()`, qui pose le délégué du centre.
        statusItemController = StatusItemController(model: alerts)
        alerts.onOpen = { AppDelegate.openAlert?($0) }
        alerts.start()
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
    /// le Dock ne quitte pas, loginwindow interrompt la fermeture de session
    /// (Doc-2). Sinon la réponse reste un succès et la sortie suit son cours. La
    /// raison du quit n'est pas lue : même alerte, comme Terminal.app (Doc-3).
    @objc func handleQuitAppleEvent(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        if quit.request() == .cancelled {
            reply.setParam(NSAppleEventDescriptor(int32: Int32(userCanceledErr)), forKeyword: AEKeyword(keyErrorNumber))
        }
    }

    /// L'instantané de S-1, dans l'ordre session, Terminal, pilotage, pipelines.
    /// Les pipelines en cours sont la liste « En cours » de l'Accueil (comptes de
    /// `AlertsStatus`, source unique depuis accueil-en-cours-melange-pause-et-compte).
    private func quitActivities() -> [QuitActivity] {
        let busy = alerts.status.counts?.running ?? 0
        return [
            Self.sessionQuitActivity?(),
            Self.terminalQuitActivity?(),
            Self.projectQuitActivity?(),
            busy >= 1 ? .pipelines(count: busy) : nil,
        ].compactMap { $0 }
    }

    /// S-6 : fermer la fenêtre qui porte une feuille ferme les deux, verrouillée
    /// comprise, et laisse `NSApp.terminate` aboutir (mesuré, Doc-9). Aucune
    /// liaison ni `onDismiss` n'est appelé : la Bienvenue reparaîtra au prochain
    /// lancement.
    private static func closeAttachedSheets() {
        for window in NSApp.windows where window.attachedSheet != nil {
            window.close()
        }
    }

    /// B-7/AC-9 : fermer la fenêtre ne quitte PAS l'app (le comportement par défaut
    /// mesuré, Doc-6, est écrit explicitement ici pour être testé).
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    /// Toute demande à `NSApp.terminate` passe par le déroulé : seule la
    /// redemande finale, accroches faites, termine.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        quit.shouldTerminate()
    }
}
