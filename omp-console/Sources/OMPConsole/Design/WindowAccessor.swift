// Le pont SwiftUI → AppKit : il livre la `NSWindow` d'une vue (le terminal y lit
// sa fenêtre).
//
// `DispatchQueue.main.async` : au moment de `makeNSView`, la vue n'est pas encore
// installée dans sa fenêtre (`view.window` est `nil`) ; le tour de boucle suivant
// l'y trouve.

import AppKit
import SwiftUI

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
