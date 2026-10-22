// Les menus contextuels de l'app iOS (ios-gestes-et-retours-natifs, S-4) : un
// appui long sur une rangée Mémoire ouvre le menu natif du système.
//
// Le contenu d'un menu est une FONCTION PURE de l'élément : une seule entrée
// « Copier » (le texte du souvenir). Une action indisponible est absente, jamais
// grisée (HIG Context menus).
//
// Aucune phrase n'est composée ici : les libellés sont les constantes des
// contrôles existants, les mots propres aux menus vivent dans `IOSMenuText`.

import ConsoleClient
import ConsoleCore
import Foundation
import SwiftUI
import UIKit

/// Une entrée de menu contextuel, dans l'ordre d'affichage du menu.
enum IOSMenuAction: Equatable {
    /// « Copier » : remplace le presse-papiers par ce texte.
    case copy(String)
}

enum IOSContextMenu {
    /// Une rangée Mémoire : « Copier » le texte brut du souvenir, seul.
    static func memory(_ row: RemoteMemoryRow) -> [IOSMenuAction] {
        let text = row.text
        return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? [] : [.copy(text)]
    }
}

/// Le presse-papiers général du système.
@MainActor
enum IOSPasteboard {
    /// Remplace le contenu du presse-papiers par ce texte (aucune confirmation
    /// visible : comportement système).
    static func copy(_ text: String) {
        UIPasteboard.general.string = text
    }
}

/// Les entrées d'un menu contextuel : un `Button` par action, dans l'ordre reçu.
/// Une liste vide ne rend rien : le système n'ouvre alors aucun menu.
struct IOSContextMenuItems: View {
    let actions: [IOSMenuAction]
    let perform: (IOSMenuAction) -> Void

    var body: some View {
        ForEach(Array(actions.enumerated()), id: \.offset) { _, action in
            switch action {
            case .copy:
                Button(MemoryText.copy, systemImage: IOSMenuText.copySymbol) { perform(action) }
            }
        }
    }
}
