// Point d'entrée de la coque. Le fichier NE s'appelle PAS main.swift : `@main`
// y est refusé (D5).
//
// Deux scènes, deux usages : la coque à barre latérale existante, et la fenêtre
// « Session OMP » (S-9) qui héberge UNE session à la fois. `Window` — et non
// `WindowGroup` — rend structurellement vrai l'invariant « jamais deux `omp`
// hébergés » (AC-2) : la scène n'a qu'une instance, ouverte par ⌘N depuis le menu
// Fichier.
//
// Le modèle de session vit sur la structure `App` (`@StateObject`), donc à
// l'échelle de l'app et non de la fenêtre : fermer la fenêtre pendant une session
// ne laisse pas un `omp` orphelin, et l'accroche de terminaison existe avant la
// première ouverture.
//
// La terminaison passe par `applicationShouldTerminate` → `.terminateLater` (D3) :
// c'est le seul moyen d'ATTENDRE la sortie du process hébergé avant de quitter,
// au lieu de laisser un orphelin derrière soi (AC-16).

import AppKit
import SwiftUI

@main
struct OMPConsoleApp: App {
    @StateObject private var model = ConsoleModel()
    @StateObject private var sessionModel = SessionConsoleModel()
    @StateObject private var filesModel = FilesModel()
    @StateObject private var kanbanModel = KanbanModel()
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup("OMP Console") {
            ConsoleRootView(model: model, filesModel: filesModel, kanban: kanbanModel, alerts: appDelegate.alerts)
        }

        Window("Session OMP", id: "session") {
            SessionConsoleView(model: sessionModel)
        }
        .commands {
            SessionCommands()
        }

        // Troisième scène : la visionneuse de session. Elle présente une VALEUR
        // (`ViewerTarget`), donc deux runs différents ouvrent deux fenêtres, et
        // re-choisir un run déjà ouvert ramène SA fenêtre au premier plan
        // (Documentation §1 : le système dédoublonne par valeur). La scène « Session
        // OMP » (hébergement RPC, instance unique) reste distincte et n'est pas
        // touchée : deux usages, deux scènes.
        WindowGroup("Session", id: "viewer", for: ViewerTarget.self) { $target in
            SessionViewerView(target: $target)
        }
    }
}

/// Menu Fichier ▸ « Nouvelle session OMP » (⌘N) : ouvre la scène à instance
/// unique. `openWindow` est lu dans l'environnement de la commande (motif compilé
/// en D5).
struct SessionCommands: Commands {
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(after: .newItem) {
            Button("Nouvelle session OMP") { openWindow(id: "session") }
                .keyboardShortcut("n", modifiers: .command)
        }
    }
}

/// Délégué de terminaison : il ne connaît pas la session, il appelle l'accroche
/// que le modèle de session a posée. Sans session ouverte, le délégué laisse
/// l'app quitter immédiatement.
///
/// Il POSSÈDE aussi le modèle d'alertes et l'item de barre de menus (S-2, S-9) :
/// le modèle vit à l'échelle de l'app, et l'item est créé une seule fois au
/// lancement.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Posée par `SessionConsoleModel.init` ; `nil` tant qu'aucun modèle n'existe,
    /// auquel cas il n'y a aucun process à attendre.
    static var terminateSession: (() async -> Void)?

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

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let terminateSession = Self.terminateSession else { return .terminateNow }
        Task { @MainActor in
            await terminateSession()
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}
