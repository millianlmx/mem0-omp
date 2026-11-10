// L'« OS agentique » : le presse-papiers, pour « Copier la commande de reprise » d'une
// session locale. SwiftUI n'écrit pas dans le presse-papiers : c'est le SEUL point de ce
// dossier qui touche AppKit (Mac) ou UIKit (iPhone/iPad), derrière une fonction.

#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

enum OSLocalSessionClipboard {
    /// Pose un texte dans le presse-papiers du système.
    @MainActor
    static func copy(_ text: String) {
        #if canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #elseif canImport(UIKit)
        UIPasteboard.general.string = text
        #endif
    }
}
