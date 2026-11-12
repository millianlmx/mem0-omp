// Les commandes clavier de l'iPad (ipad-clavier-et-largeur-de-lecture, S-2, S-3) :
// la table des raccourcis, leur routage vers l'écran courant, et les commandes de
// scène qui les posent dans la barre des menus de l'iPad (menu Présentation).
//
// Le routage passe par `@FocusedValue` : la racine publie l'onglet montré,
// chaque écran publie son rafraîchissement et, s'il cherche, sa recherche
// (`.focusedSceneValue`). Une fermeture voyage dans une struct
// `Equatable` (jamais nue dans une entrée de `FocusedValues`, qui invaliderait ses
// lecteurs à chaque mise à jour).
//
// Aucun littéral ici : libellés et touches viennent de `IOSOSTab.title` et
// `IOSKeyboardText` ; les chiffres sont calculés.

import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI
import UIKit

/// Un raccourci de la barre des menus : son libellé français et sa touche. Le
/// modificateur est toujours ⌘ seul (`IOSKeyboard.modifiers`).
struct IOSShortcut: Equatable {
    let title: String
    let key: Character
}

/// La table des raccourcis de l'iPad.
enum IOSKeyboard {
    /// Le modificateur des raccourcis : ⌘ seul. Aucune touche nue, donc ⎋ et ↩
    /// restent aux feuilles.
    static let modifiers: EventModifiers = .command

    /// ⌘1…⌘5 : les onglets, dans l'ordre de la barre.
    static var tabs: [(tab: IOSOSTab, shortcut: IOSShortcut)] {
        IOSOSTab.allCases.enumerated().map { index, tab in
            (tab, IOSShortcut(title: tab.title, key: Character(String(index + 1))))
        }
    }

    /// ⌘R : relire les données de l'écran courant.
    static let refresh = IOSShortcut(title: IOSKeyboardText.refresh, key: IOSKeyboardText.refreshKey)
    /// ⌘F : activer le champ de recherche de l'écran courant.
    static let search = IOSShortcut(title: IOSKeyboardText.search, key: IOSKeyboardText.searchKey)

    /// ⌘K : la palette de commandes ; ⌘N : une nouvelle feature (ConsoleUI).
    static let palette = IOSShortcut(title: PipelineServerText.paletteMenu, key: IOSKeyboardText.paletteKey)
    static let newFeature = IOSShortcut(title: PipelineServerText.newFeature, key: IOSKeyboardText.newFeatureKey)

    /// Les raccourcis : les onglets, puis Actualiser, Rechercher.
    static var all: [IOSShortcut] {
        tabs.map(\.shortcut) + [refresh, search]
    }
}

/// Une action publiée par un écran pour une commande clavier. L'égalité ignore la
/// fermeture : seuls l'écran qui la publie (son identifiant d'accessibilité) et son
/// activation comptent.
struct IOSCommandAction: Equatable {
    let owner: String
    let isEnabled: Bool
    let run: @MainActor () -> Void

    static func == (a: Self, b: Self) -> Bool { a.owner == b.owner && a.isEnabled == b.isEnabled }
}

/// La palette publiée par la racine : ⌘K l'ouvre, ⌘N ouvre « Nouvelle feature », et
/// ⌘F l'ouvre en recherche globale quand l'écran n'a pas son propre champ.
struct IOSPaletteAction: Equatable {
    let drafts: HarnessDrafts
    let isEnabled: Bool

    static func == (a: Self, b: Self) -> Bool { a.drafts === b.drafts && a.isEnabled == b.isEnabled }
}

/// L'onglet publié par la racine : l'onglet montré et le moyen d'en changer.
struct IOSTabSelector: Equatable {
    let current: IOSOSTab
    let select: @MainActor (IOSOSTab) -> Void

    static func == (a: Self, b: Self) -> Bool { a.current == b.current }
}

extension FocusedValues {
    /// Publiée par `IOSOSRootView` : l'onglet montré (⌘1…⌘5).
    @Entry var iosSelectTab: IOSTabSelector?
    /// Publiée par l'écran affiché : relire ses données (⌘R).
    @Entry var iosRefresh: IOSCommandAction?
    /// Publiée par l'écran affiché qui possède un champ de recherche (⌘F).
    @Entry var iosSearch: IOSCommandAction?
    /// Publiée par `RootView` : la palette (⌘K, ⌘N, et ⌘F sans champ propre).
    @Entry var iosPalette: IOSPaletteAction?
}

/// La garde modale : une feuille, une alerte ou un `confirmationDialog` est-il
/// présenté sur la fenêtre au premier plan ? Les commandes de la fenêtre restent
/// actives sous une feuille, alors que ce que la feuille publierait n'est pas vu :
/// sans cette garde, ⌘R rafraîchirait l'écran caché et ⌘N fermerait la feuille.
/// Une recherche active ne présente rien : elle laisse les commandes actives.
enum IOSModalPresence {
    @MainActor static func isPresenting() -> Bool {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive }
            .contains { scene in
                let window = scene.keyWindow ?? scene.windows.first
                return window?.rootViewController?.presentedViewController != nil
            }
    }
}

/// Les commandes de scène de l'app : menu Présentation (⌘1…⌘5, Actualiser ⌘R,
/// Rechercher ⌘F) ; « Nouvelle fenêtre » est retirée (l'app garde une seule
/// fenêtre et un seul client).
struct IOSKeyboardCommands: Commands {
    @FocusedValue(\.iosSelectTab) private var selector
    @FocusedValue(\.iosRefresh) private var refresh
    @FocusedValue(\.iosSearch) private var search
    @FocusedValue(\.iosPalette) private var palette

    var body: some Commands {
        CommandGroup(replacing: .newItem) {}
        CommandGroup(before: .sidebar) {
            ForEach(IOSKeyboard.tabs, id: \.tab) { entry in
                command(entry.shortcut) { select(entry.tab) }
                    .disabled(selector == nil)
            }
            Divider()
        }
        CommandGroup(after: .sidebar) {
            command(IOSKeyboard.refresh) { perform(refresh) }
                .disabled(!(refresh?.isEnabled ?? false))
            command(IOSKeyboard.search) {
                if search?.isEnabled == true { perform(search) } else { openPalette(search: true) }
            }
            .disabled(!(search?.isEnabled ?? false) && palette == nil)
            command(IOSKeyboard.palette) { openPalette(search: false) }
                .disabled(palette == nil)
            command(IOSKeyboard.newFeature) {
                guard !IOSModalPresence.isPresenting(), let palette, palette.isEnabled else { return }
                palette.drafts.launchSheetShown = true
            }
            .disabled(!(palette?.isEnabled ?? false))
        }
    }

    private func command(_ shortcut: IOSShortcut, action: @escaping @MainActor () -> Void) -> some View {
        Button(shortcut.title, action: action)
            .keyboardShortcut(KeyEquivalent(shortcut.key), modifiers: IOSKeyboard.modifiers)
    }

    @MainActor private func select(_ tab: IOSOSTab) {
        guard !IOSModalPresence.isPresenting(), let selector, selector.current != tab else { return }
        selector.select(tab)
    }

    @MainActor private func openPalette(search: Bool) {
        guard !IOSModalPresence.isPresenting(), let palette else { return }
        palette.drafts.openPalette(search: search)
    }

    @MainActor private func perform(_ action: IOSCommandAction?) {
        guard !IOSModalPresence.isPresenting(), let action, action.isEnabled else { return }
        action.run()
    }
}
