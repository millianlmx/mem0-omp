// L'item de la barre de menus (BR-5, S-2) : un titre qui suit les compteurs, et un
// clic qui ramène la fenêtre au premier plan.
//
// `StatusItemTitle.text(for:)` est PUR et testable sans rien construire d'AppKit :
// mesuré (Doc-9), instancier `NSStatusBar.system.statusItem(withLength:)` dans un
// processus de `swift test` lève une exception Objective-C non rattrapable et tue
// toute la suite. `StatusItemController` — SEUL type du dépôt qui touche
// `NSStatusBar` — n'est donc JAMAIS construit dans les tests ; son câblage AppKit est
// prouvé par la recette (S-10).

import AppKit
import Combine

/// Le titre de l'item : `""` (icône seule) tant que rien n'est connu ou que les deux
/// compteurs sont nuls, sinon `« occupés »·« en attente »` (U+00B7, deux entiers
/// décimaux, dans cet ordre).
enum StatusItemTitle {
    static func text(for status: AlertsStatus) -> String {
        guard let counters = status.counters, counters.busy != 0 || counters.waiting != 0 else {
            return ""
        }
        return "\(counters.busy)\u{00B7}\(counters.waiting)"
    }
}

/// La fenêtre principale : la ramener au premier plan est partagé par l'item de
/// barre de menus et par les commandes « Nouvelle feature… », les sections ⌘1…⌘6
/// et « Bienvenue » (S-4 de omp-console-redesign).
enum MainWindow {
    /// L'identifiant de la scène `WindowGroup` de la fenêtre principale.
    static let sceneID = "main"

    /// La fenêtre principale redevient visible et au premier plan. Elle se
    /// reconnaît à son identifiant AppKit, que SwiftUI dérive de celui de la scène
    /// (`main-AppWindow-1`, mesuré) — pas à son titre, qui suit la section courante,
    /// ni à son index dans `NSApp.windows`, qui contient aussi les fenêtres de l'item
    /// de barre (mesuré, Doc-5). Une fenêtre fermée reste dans `NSApp.windows`
    /// (invisible) : `makeKeyAndOrderFront` la ramène.
    @MainActor
    static func reveal() {
        let prefix = "\(sceneID)-"
        if let window = NSApp.windows.first(where: {
            $0.canBecomeMain && ($0.identifier?.rawValue.hasPrefix(prefix) ?? false)
        }) {
            window.makeKeyAndOrderFront(nil)
        }
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
        // Le titre suit l'état publié, sur le fil principal (S-2).
        subscription = model.statusPublisher
            .receive(on: RunLoop.main)
            .sink { [weak self] status in self?.apply(status) }
    }

    private func apply(_ status: AlertsStatus) {
        statusItem.button?.title = StatusItemTitle.text(for: status)
    }

    /// Un clic : la fenêtre principale redevient visible et au premier plan.
    @objc private func revealWindow() {
        MainWindow.reveal()
    }
}
