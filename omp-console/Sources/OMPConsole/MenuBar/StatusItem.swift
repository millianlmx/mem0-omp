// L'item de la barre de menus (S-6, S-7 de accueil-en-cours-melange-pause-et-compte) :
// un titre = le nombre de lignes « À vous » de l'Accueil, une info-bulle et une
// description VoiceOver « N à vous · M en cours », et un clic qui ramène la fenêtre
// au premier plan.
//
// `StatusItemTitle` est PUR et testable sans rien construire d'AppKit : mesuré
// (Doc-9), instancier `NSStatusBar.system.statusItem(withLength:)` dans un
// processus de `swift test` lève une exception Objective-C non rattrapable et tue
// toute la suite. `StatusItemController` — SEUL type du dépôt qui touche
// `NSStatusBar` — n'est donc JAMAIS construit dans les tests : il se borne à
// recopier le titre et le résumé, et son câblage AppKit est prouvé par lecture AX
// dans la recette (`AXTitle`, `AXDescription`, `AXHelp`).

import AppKit
import Combine
import ConsoleCore

/// Ce que l'item affiche, en fonctions pures de l'état publié.
enum StatusItemTitle {
    /// Le titre : `""` (icône seule) tant que rien n'est connu ou que « À vous » est
    /// vide, sinon le nombre de lignes « À vous » en entier décimal.
    static func text(for status: AlertsStatus) -> String {
        guard let counts = status.counts, counts.attention != 0 else { return "" }
        return "\(counts.attention)"
    }

    /// L'info-bulle ET la description VoiceOver : « N à vous · M en cours », zéros
    /// écrits ; un état inconnu se lit comme deux zéros.
    static func summary(for status: AlertsStatus) -> String {
        HomeText.countsSummary(status.counts ?? .zero)
    }
}

/// La fenêtre principale : la ramener au premier plan est partagé par l'item de
/// barre de menus et par les commandes « Nouvelle feature… », les sections ⌘1…⌘6
/// et « Bienvenue » (S-4 de omp-console-redesign).
enum MainWindow {
    /// L'identifiant de la scène `WindowGroup` de la fenêtre principale.
    static let sceneID = "main"

    /// La fenêtre principale, visible ou fermée. Elle se reconnaît à son
    /// identifiant AppKit, que SwiftUI dérive de celui de la scène
    /// (`main-AppWindow-1`, mesuré) — pas à son titre, qui suit la section courante,
    /// ni à son index dans `NSApp.windows`, qui contient aussi les fenêtres de l'item
    /// de barre (mesuré, Doc-5). Une fenêtre fermée reste dans `NSApp.windows`
    /// (invisible).
    @MainActor
    static func window() -> NSWindow? {
        let prefix = "\(sceneID)-"
        return NSApp.windows.first {
            $0.canBecomeMain && ($0.identifier?.rawValue.hasPrefix(prefix) ?? false)
        }
    }

    /// Une feuille est attachée à la fenêtre principale : feuille racine, fiche,
    /// feuille de section ou dialogue de confirmation (un popover n'en est pas une).
    /// Elle le reste après la fermeture de la fenêtre (mesuré, mem0 6124fe7e).
    @MainActor
    static func hasAttachedSheet() -> Bool {
        window()?.attachedSheet != nil
    }

    /// La fenêtre principale redevient visible et au premier plan :
    /// `makeKeyAndOrderFront` ramène aussi une fenêtre fermée.
    @MainActor
    static func reveal() {
        window()?.makeKeyAndOrderFront(nil)
        // `activate(ignoringOtherApps:)` est DÉPRÉCIÉE avec le SDK du poste (Doc-7),
        // mais c'est la seule des deux formes dont l'effet est MESURÉ (fenêtre clé et
        // principale, app active) : `activate()` coopératif est refusé sans intention
        // utilisateur (Doc-5). La dépréciation est assumée.
        NSApp.activate(ignoringOtherApps: true)
    }
}

/// L'item UNIQUE de la barre de menus (créé une fois au lancement, jamais retiré).
@MainActor
final class StatusItemController: NSObject {
    private let statusItem: NSStatusItem
    private let model: AlertsModel
    private var subscription: AnyCancellable?

    init(model: AlertsModel) {
        self.model = model
        self.statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()
        let button = statusItem.button
        button?.image = NSImage(systemSymbolName: "square.grid.2x2", accessibilityDescription: "OMP Console")
        button?.imagePosition = .imageLeading
        // Pas de `statusItem.menu` : un menu demanderait DEUX clics, ce que B-7 refuse
        // (un clic doit ramener la fenêtre).
        button?.target = self
        button?.action = #selector(revealWindow)
        apply(model.status)
        // Le titre, l'info-bulle et la description suivent l'état publié, sur le fil
        // principal (S-6, S-7).
        subscription = model.statusPublisher
            .receive(on: RunLoop.main)
            .sink { [weak self] status in self?.apply(status) }
    }

    /// Recopie, sans rien calculer : le titre donne `AXTitle`, l'info-bulle
    /// `AXHelp` et le label `AXDescription` (D-1). L'image garde sa description
    /// « OMP Console ».
    private func apply(_ status: AlertsStatus) {
        guard let button = statusItem.button else { return }
        let summary = StatusItemTitle.summary(for: status)
        button.title = StatusItemTitle.text(for: status)
        button.toolTip = summary
        button.setAccessibilityLabel(summary)
    }

    /// Un clic : la fenêtre principale redevient visible et au premier plan.
    @objc private func revealWindow() {
        MainWindow.reveal()
    }
}
