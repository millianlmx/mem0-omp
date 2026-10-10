// Les commandes clavier de l'iPad (ipad-clavier-et-largeur-de-lecture, S-2, S-3) :
// la table des dix raccourcis, leur routage vers l'écran courant, et les commandes
// de scène qui les posent dans la barre des menus de l'iPad (menus Présentation et
// Fichier), sur le patron des commandes du Mac (`SectionCommands`, `NewItemCommands`).
//
// Le routage passe par `@FocusedValue` : la racine publie la sélection de section et
// « Nouvelle feature », chaque écran publie son rafraîchissement et, s'il cherche,
// sa recherche (`.focusedSceneValue`). Une fermeture voyage dans une struct
// `Equatable` (jamais nue dans une entrée de `FocusedValues`, qui invaliderait ses
// lecteurs à chaque mise à jour).
//
// Aucun littéral ici : libellés et touches viennent de `ConsoleSection.title`,
// `NewFeatureText` et `IOSKeyboardText` ; les chiffres sont calculés.

import ConsoleClient
import ConsoleCore
import SwiftUI
import UIKit

/// Un raccourci de la barre des menus : son libellé français et sa touche. Le
/// modificateur est toujours ⌘ seul (`IOSKeyboard.modifiers`).
struct IOSShortcut: Equatable {
    let title: String
    let key: Character
}

/// La table des dix raccourcis de l'iPad.
enum IOSKeyboard {
    /// Le modificateur des dix raccourcis : ⌘ seul. Aucune touche nue, donc ⎋ et ↩
    /// restent aux feuilles.
    static let modifiers: EventModifiers = .command

    /// ⌘1…⌘7 : les sept sections, dans l'ordre affiché par la barre latérale.
    static var sections: [(section: ConsoleSection, shortcut: IOSShortcut)] {
        IOSSection.sidebarOrder.enumerated().map { index, section in
            (section, IOSShortcut(title: section.title, key: Character(String(index + 1))))
        }
    }

    /// ⌘R : relire les données de l'écran courant.
    static let refresh = IOSShortcut(title: IOSKeyboardText.refresh, key: IOSKeyboardText.refreshKey)
    /// ⌘F : activer le champ de recherche de l'écran courant.
    static let search = IOSShortcut(title: IOSKeyboardText.search, key: IOSKeyboardText.searchKey)
    /// ⌘N : basculer sur Pipelines et ouvrir « Nouvelle feature ».
    static let newFeature = IOSShortcut(title: NewFeatureText.command, key: IOSKeyboardText.newFeatureKey)

    /// Les dix raccourcis : les sections, puis Rafraîchir, Rechercher, Nouvelle feature.
    static var all: [IOSShortcut] {
        sections.map(\.shortcut) + [refresh, search, newFeature]
    }

    /// Le rafraîchissement des écrans nourris par le flux (Accueil, Pipelines,
    /// Sessions) : relire `GET /v1/store`, que le client republie en instantané et
    /// en ardoise. Actif seulement quand le client est connecté.
    @MainActor static func storeRefresh(client: ConsoleClientModel, owner: ConsoleSection) -> IOSCommandAction {
        let connected: Bool
        if case .connected = client.state { connected = true } else { connected = false }
        return IOSCommandAction(owner: owner, isEnabled: connected) {
            Task { _ = try? await client.store() }
        }
    }
}

/// Une action publiée par un écran pour une commande clavier. L'égalité ignore la
/// fermeture : seuls l'écran qui la publie et son activation comptent.
struct IOSCommandAction: Equatable {
    let owner: ConsoleSection
    let isEnabled: Bool
    let run: @MainActor () -> Void

    static func == (a: Self, b: Self) -> Bool { a.owner == b.owner && a.isEnabled == b.isEnabled }
}

/// La sélection de section publiée par la racine : la section affichée et le moyen
/// d'en changer.
struct IOSSectionSelector: Equatable {
    let current: ConsoleSection?
    let select: @MainActor (ConsoleSection) -> Void

    static func == (a: Self, b: Self) -> Bool { a.current == b.current }
}

extension FocusedValues {
    /// Publiée par `RootView` : la sélection de section (⌘1…⌘7).
    @Entry var iosSelectSection: IOSSectionSelector?
    /// Publiée par `RootView` : Pipelines puis la feuille « Nouvelle feature » (⌘N).
    @Entry var iosNewFeature: IOSCommandAction?
    /// Publiée par l'écran affiché : relire ses données (⌘R).
    @Entry var iosRefresh: IOSCommandAction?
    /// Publiée par l'écran affiché qui possède un champ de recherche (⌘F).
    @Entry var iosSearch: IOSCommandAction?
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

/// Les commandes de scène de l'app : menu Présentation (⌘1…⌘7, Rafraîchir ⌘R,
/// Rechercher ⌘F) et menu Fichier (Nouvelle feature… ⌘N, à la place de « Nouvelle
/// fenêtre » : l'app garde une seule fenêtre et un seul client).
struct IOSKeyboardCommands: Commands {
    @FocusedValue(\.iosSelectSection) private var selector
    @FocusedValue(\.iosNewFeature) private var newFeature
    @FocusedValue(\.iosRefresh) private var refresh
    @FocusedValue(\.iosSearch) private var search

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            command(IOSKeyboard.newFeature) { perform(newFeature) }
                .disabled(newFeature == nil)
        }
        CommandGroup(before: .sidebar) {
            ForEach(IOSKeyboard.sections, id: \.section) { entry in
                command(entry.shortcut) { select(entry.section) }
                    .disabled(selector == nil)
            }
            Divider()
        }
        CommandGroup(after: .sidebar) {
            command(IOSKeyboard.refresh) { perform(refresh) }
                .disabled(!(refresh?.isEnabled ?? false))
            command(IOSKeyboard.search) { perform(search) }
                .disabled(!(search?.isEnabled ?? false))
        }
    }

    private func command(_ shortcut: IOSShortcut, action: @escaping @MainActor () -> Void) -> some View {
        Button(shortcut.title, action: action)
            .keyboardShortcut(KeyEquivalent(shortcut.key), modifiers: IOSKeyboard.modifiers)
    }

    @MainActor private func select(_ section: ConsoleSection) {
        guard !IOSModalPresence.isPresenting(), let selector, selector.current != section else { return }
        selector.select(section)
    }

    @MainActor private func perform(_ action: IOSCommandAction?) {
        guard !IOSModalPresence.isPresenting(), let action, action.isEnabled else { return }
        action.run()
    }
}
