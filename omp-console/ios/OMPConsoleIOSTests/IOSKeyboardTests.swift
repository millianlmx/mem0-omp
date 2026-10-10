// Les preuves Swift des commandes clavier de l'iPad (ipad-clavier-et-largeur-de-lecture,
// S-2, S-8) : la table qui alimente la barre des menus (libellés, touches,
// modificateur) et le lecteur de fixture de la recette `-memoire.recipe clavier`.
// La barre des menus elle-même n'est pas capturée : depuis iPadOS 26 elle remplace
// la superposition ⌘, et ce qu'elle liste est exactement cette table.

import ConsoleClient
import ConsoleCore
import SwiftUI
import Testing

@testable import OMPConsoleIOS

@MainActor
@Suite("ipad-clavier-et-largeur-de-lecture — clavier de l'iPad")
struct IOSKeyboardTests {
    @Test("ipad-clavier-et-largeur-de-lecture/AC-4 : ⌘1…⌘7 suivent l'ordre affiché par la barre latérale")
    func keyboardShortcutsFollowTheSidebar() {
        let sidebar = ConsoleSectionGroup.allCases.flatMap(IOSSection.sections(of:))
        #expect(IOSSection.sidebarOrder == sidebar)
        #expect(IOSKeyboard.sections.map(\.section) == [.home, .kanban, .project, .session, .sessions, .memory, .stats])
        #expect(IOSKeyboard.sections.map(\.shortcut.key) == ["1", "2", "3", "4", "5", "6", "7"])
        for entry in IOSKeyboard.sections {
            #expect(entry.shortcut.title == entry.section.title)
        }
    }

    @Test("ipad-clavier-et-largeur-de-lecture/AC-9 : la barre des menus liste les dix commandes en français, avec ⌘")
    func keyboardShortcutsAreFrenchAndCommandOnly() {
        let expected: [(title: String, key: Character)] = [
            (ConsoleSection.home.title, "1"),
            (ConsoleSection.kanban.title, "2"),
            (ConsoleSection.project.title, "3"),
            (ConsoleSection.session.title, "4"),
            (ConsoleSection.sessions.title, "5"),
            (ConsoleSection.memory.title, "6"),
            (ConsoleSection.stats.title, "7"),
            ("Rafraîchir", "r"),
            ("Rechercher", "f"),
            (NewFeatureText.command, "n"),
        ]
        #expect(IOSKeyboard.all.count == 10)
        #expect(IOSKeyboard.all.map(\.title) == expected.map(\.title))
        #expect(IOSKeyboard.all.map(\.key) == expected.map(\.key))
        #expect(IOSKeyboard.modifiers == .command)
        #expect(NewFeatureText.command == "Nouvelle feature…")
    }

    @Test("ipad-clavier-et-largeur-de-lecture/AC-10 : aucune commande ne prend ⎋, ↩ ni une touche nue des feuilles")
    func keyboardShortcutsLeaveTheSheetKeysAlone() {
        let keys = IOSKeyboard.all.map(\.key)
        #expect(Set(keys).count == keys.count)
        #expect(!keys.contains(KeyEquivalent.escape.character))
        #expect(!keys.contains(KeyEquivalent.return.character))
        // ⌘ est obligatoire : une touche nue volerait ⎋/↩ aux feuilles.
        #expect(IOSKeyboard.modifiers.contains(.command))
        #expect(IOSKeyboard.modifiers == .command)
    }

    @Test("ipad-clavier-et-largeur-de-lecture/AC-5 : la recette clavier sert la fixture au modèle réel et la relit à chaque rafraîchissement")
    func listRecipeServesTheFixtureOnEveryRefresh() async {
        #expect(IOSMemoryGraphRecipe.resolve(["-memoire.recipe", "clavier"]) == .clavier)
        #expect(IOSMemoryGraphRecipe.resolve(["-memoire.recipe", "clavier", "-memoire.recipe", "graphe"]) == .graphe)
        // La recette `liste` (fiche ouverte depuis la liste) reste distincte.
        #expect(IOSMemoryGraphRecipe.resolve(["-memoire.recipe", "liste"]) == .liste)

        let reader = IOSMemoryRecipeReader()
        #expect(IOSMemoryModel.gesturesEnabled(reader.state))
        let model = IOSMemoryModel(client: reader)
        await model.refresh()
        guard case let .summary(_, total, rows, more) = model.state(connection: .connected) else {
            Issue.record("sommaire attendu, obtenu \(model.state(connection: .connected))")
            return
        }
        // Les huit souvenirs de la fixture qui portent un texte (m6 est vide), en une page.
        #expect(total == 8)
        #expect(rows.map(\.id) == ["m1", "m2", "m3", "m4", "m5", "m7", "m8", "m9"])
        #expect(more == .complete)
        #expect(model.canRefresh)

        await model.refresh()
        if case let .summary(_, again, _, _) = model.state(connection: .connected) {
            #expect(again == 8)
        } else {
            Issue.record("la relecture doit rendre le même sommaire")
        }

        let search = try? await reader.memorySearch(query: "DEUX", scope: nil, limit: nil)
        #expect(search?.rows.map(\.id) == ["m2"])
    }
}
