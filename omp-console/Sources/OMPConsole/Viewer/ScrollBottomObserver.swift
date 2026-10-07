// La mesure de la DISTANCE AU BAS DU FIL (S-6 de la feature
// `visionneuse-de-session`).
//
// Pourquoi pas la recette prescrite par la Documentation §2 (`GeometryReader` en
// arrière-plan publiant par `PreferenceKey`) : MESURÉ le 2026-09-28 sur ce poste
// (sonde SwiftUI jetable, macOS 27 / Swift 6.4 CLT), elle délivre UN rapport
// (`gap = -hauteur du conteneur`, la géométrie n'étant pas encore résolue) puis
// **plus jamais** — ni au défilement, ni après. Un suivi qui ne voit pas le
// défilement ne peut pas se suspendre (AC-11).
//
// Le mécanisme retenu est celui d'AppKit, qui est aussi celui du défilement :
// `NSScrollView` poste `NSView.boundsDidChangeNotification` sur son clip view à
// CHAQUE déplacement. La vue ci-dessous se rattache à la `NSScrollView` qui la
// contient (elle est posée en arrière-plan du contenu), et rend une valeur
// MESURÉE : `hauteur du document - origine du clip - hauteur du clip`.

import AppKit
import ConsoleCore
import SwiftUI

/// Publie la géométrie du défilement (distance au bas et origine) à chaque
/// déplacement comme à chaque réévaluation du contenu, ET le sens des gestes de
/// défilement de l'utilisateur.
struct ScrollBottomObserver: NSViewRepresentable {
    let onGeometry: @MainActor (ViewerScrollGeometry) -> Void
    let onUserScroll: @MainActor (CGFloat) -> Void

    func makeNSView(context: Context) -> NSView {
        let view = ScrollObserverView()
        view.onGeometry = onGeometry
        view.onUserScroll = onUserScroll
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        // Appelé à chaque réévaluation de la vue, donc à chaque fois que des faits
        // sont ajoutés : la hauteur du document a pu changer sans qu'aucun
        // défilement n'ait eu lieu, et un rapport est alors nécessaire.
        guard let observer = nsView as? ScrollObserverView else { return }
        observer.onGeometry = onGeometry
        observer.onUserScroll = onUserScroll
        observer.attach()
    }

    static func dismantleNSView(_ nsView: NSView, coordinator: ()) {
        (nsView as? ScrollObserverView)?.detach()
    }
}

/// Le jeton d'abonnement, dans une boîte : un `deinit` non isolé ne peut pas
/// toucher un jeton (`NSObjectProtocol` n'est pas `Sendable`), et la boîte se
/// charge donc elle-même de désabonner — y compris quand la vue est libérée sans
/// que SwiftUI ait appelé `dismantleNSView`.
private final class ObserverBox: @unchecked Sendable {
    var token: NSObjectProtocol?
    var monitor: Any?

    deinit {
        if let token { NotificationCenter.default.removeObserver(token) }
        if let monitor { NSEvent.removeMonitor(monitor) }
    }
}

/// La vue invisible : elle ne fait que rattacher un observateur au `NSScrollView`
/// qui la contient et rendre la distance au bas.
final class ScrollObserverView: NSView {
    var onGeometry: (@MainActor (ViewerScrollGeometry) -> Void)?
    var onUserScroll: (@MainActor (CGFloat) -> Void)?

    private let box = ObserverBox()
    private var last: ViewerScrollGeometry?
    private var attempts = 0

    private var token: NSObjectProtocol? { box.token }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        attach()
    }

    /// Idempotent : le rattachement n'a lieu qu'une fois, chaque appel rend ensuite
    /// la mesure courante. Tant que la `NSScrollView` n'existe pas (la vue n'est pas
    /// encore dans la hiérarchie), on réessaie — l'attachement échoue sinon
    /// silencieusement, ce qui a été mesuré à l'écriture de cette sonde.
    func attach() {
        if token == nil {
            guard let scrollView = enclosingScrollView else {
                attempts += 1
                guard attempts < 40 else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                    MainActor.assumeIsolated { self?.attach() }
                }
                return
            }
            scrollView.contentView.postsBoundsChangedNotifications = true
            box.monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
                MainActor.assumeIsolated { self?.handleUserScroll(event) }
                return event
            }
            box.token = NotificationCenter.default.addObserver(
                forName: NSView.boundsDidChangeNotification,
                object: scrollView.contentView,
                queue: .main
            ) { [weak self] _ in
                // `queue: .main` : le bloc s'exécute sur le fil principal, ce que
                // `assumeIsolated` atteste pour le compilateur.
                MainActor.assumeIsolated { self?.report() }
            }
        }
        report()
    }

    func detach() {
        if let token { NotificationCenter.default.removeObserver(token) }
        if let monitor = box.monitor { NSEvent.removeMonitor(monitor) }
        box.token = nil
        box.monitor = nil
    }

    /// Le geste de l'utilisateur : un événement de molette destiné à la fenêtre et
    /// situé SUR ce défilement. Nos propres `scrollTo` n'en produisent pas.
    private func handleUserScroll(_ event: NSEvent) {
        guard let scrollView = enclosingScrollView, event.window === scrollView.window else { return }
        let point = scrollView.convert(event.locationInWindow, from: nil)
        guard scrollView.bounds.contains(point) || scrollView.bounds.insetBy(dx: -8, dy: -8).contains(point) else {
            return
        }
        onUserScroll?(event.scrollingDeltaY)
    }

    private func report() {
        guard let scrollView = enclosingScrollView else { return }
        let clip = scrollView.contentView
        let document = scrollView.documentView?.frame.height ?? 0
        let geometry = ViewerScrollGeometry(
            gap: document - clip.bounds.origin.y - clip.bounds.height,
            origin: clip.bounds.origin.y
        )
        guard geometry != last else { return }
        last = geometry
        onGeometry?(geometry)
    }
}
