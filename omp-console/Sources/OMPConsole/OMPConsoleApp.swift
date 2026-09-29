// Point d'entrée de la coque. Le fichier NE s'appelle PAS main.swift : `@main`
// y est refusé (D5).
//
// Quatre scènes : la coque à barre latérale, la fenêtre « Session OMP » (S-9), la
// visionneuse par run, et la fenêtre « Projet » (conduite). `Window` — et non
// `WindowGroup` — rend structurellement vrai l'invariant « jamais deux conduites »
// (AC-2) : la scène n'a qu'une instance.
//
// Les modèles de session et de conduite vivent sur la structure `App`
// (`@StateObject`), donc à l'échelle de l'app : fermer une fenêtre ne laisse pas un
// `omp` orphelin, et l'accroche de terminaison existe avant la première ouverture.
//
// La terminaison passe par `applicationShouldTerminate` → `.terminateLater` (D3) :
// c'est le seul moyen d'ATTENDRE la sortie des process hébergés avant de quitter.

import AppKit
import SwiftUI

@main
struct OMPConsoleApp: App {
    @StateObject private var model = ConsoleModel()
    @StateObject private var sessionModel = SessionConsoleModel()
    @StateObject private var filesModel = FilesModel()
    @StateObject private var kanbanModel = KanbanModel()
    @StateObject private var projectModel = ProjectConsoleModel()
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup("OMP Console") {
            ConsoleRootView(
                model: model,
                filesModel: filesModel,
                kanban: kanbanModel,
                projectModel: projectModel
            )
        }

        Window("Session OMP", id: "session") {
            SessionConsoleView(model: sessionModel)
        }

        Window("Projet", id: "projet") {
            ProjectConsoleView(model: projectModel)
        }
        .commands {
            SessionCommands()
            ProjectCommands(model: projectModel)
        }

        // Dernière scène : la visionneuse de session. Elle présente une VALEUR
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

/// Menu Fichier ▸ « Conduire un projet… » (⌘⇧N) : ouvre la fenêtre « Projet » et
/// présente la feuille de choix (S-1). Si une conduite est en cours, le modèle pose
/// son refus (S-2) au lieu d'ouvrir la feuille.
struct ProjectCommands: Commands {
    @Environment(\.openWindow) private var openWindow
    @ObservedObject var model: ProjectConsoleModel

    var body: some Commands {
        CommandGroup(after: .newItem) {
            Button(ProjectViewText.startConduite) {
                openWindow(id: "projet")
                model.presentLaunchSheet()
            }
            .keyboardShortcut("n", modifiers: [.command, .shift])
        }
    }
}

/// Délégué de terminaison : il ne connaît pas les sessions, il appelle les
/// accroches que les modèles ont posées. Sans accroche, l'app quitte
/// immédiatement.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Posée par `SessionConsoleModel.init`.
    static var terminateSession: (() async -> Void)?
    /// Posée par `ProjectConsoleModel.init`.
    static var terminateProject: (() async -> Void)?

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard Self.terminateSession != nil || Self.terminateProject != nil else { return .terminateNow }
        Task { @MainActor in
            await Self.terminateSession?()
            await Self.terminateProject?()
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}
