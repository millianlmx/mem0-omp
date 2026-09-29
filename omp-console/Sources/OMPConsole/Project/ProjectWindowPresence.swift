// La présence de la fenêtre « Projet » (S-9, BR-4) : la seule entrée de la
// décision d'attention que l'app puisse observer sans la demander à `NSApp` au
// moment du calcul.
//
// `isFrontmost` est recalculé sur les quatre notifications de S-9 — activation de
// l'app et changement de fenêtre clé — jamais par scrutation.

import AppKit
import Combine
import Foundation
import SwiftUI

/// Ce que le modèle a besoin de savoir de la présence : la valeur et ses
/// changements. Un protocole plutôt que le type concret, pour que la preuve de
/// S-9 puisse injecter un double (le contrat l'exige).
@MainActor
protocol WindowFrontmostReporting: AnyObject {
    var isFrontmost: Bool { get }
    var isFrontmostPublisher: AnyPublisher<Bool, Never> { get }
    /// Appelé par `WindowAccessor` ; sans effet pour un double de test.
    func attach(_ window: NSWindow?)
}

extension WindowFrontmostReporting {
    func attach(_ window: NSWindow?) {}
}

@MainActor
final class ProjectWindowPresence: ObservableObject, WindowFrontmostReporting {
    /// `NSApp.isActive && fenêtre « Projet » isKeyWindow`.
    @Published private(set) var isFrontmost: Bool = false

    var isFrontmostPublisher: AnyPublisher<Bool, Never> { $isFrontmost.eraseToAnyPublisher() }

    private weak var window: NSWindow?
    private var observers: [NSObjectProtocol] = []

    init() {
        let center = NotificationCenter.default
        let names: [Notification.Name] = [
            NSApplication.didBecomeActiveNotification,
            NSApplication.didResignActiveNotification,
            NSWindow.didBecomeKeyNotification,
            NSWindow.didResignKeyNotification,
        ]
        for name in names {
            let observer = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.recompute() }
            }
            observers.append(observer)
        }
    }

    /// Appelé par `WindowAccessor` quand la vue entre dans sa fenêtre (ou en sort).
    func attach(_ window: NSWindow?) {
        self.window = window
        recompute()
    }

    private func recompute() {
        let frontmost = NSApp.isActive && (window?.isKeyWindow == true)
        if frontmost != isFrontmost {
            isFrontmost = frontmost
        }
    }
}

/// Le pont SwiftUI → AppKit : il livre la `NSWindow` de la vue à la présence.
///
/// `DispatchQueue.main.async` : au moment de `makeNSView`, la vue n'est pas encore
/// installée dans sa fenêtre (`view.window` est `nil`) ; le tour de boucle suivant
/// l'y trouve.
struct WindowAccessor: NSViewRepresentable {
    let onWindow: (NSWindow?) -> Void

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async { onWindow(view.window) }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async { onWindow(nsView.window) }
    }
}
