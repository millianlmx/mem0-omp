// Assertion 3 de S-4 : les vues de section déclarent chacune leur section.
//
// Le test nomme les sept TYPES puis confronte l'ensemble des sections qu'ils
// déclarent à `Set(ConsoleSection.allCases)` : une vue manquante rend l'ensemble
// plus petit, deux vues sur la même section le réduisent aussi — les deux
// scénarios rougissent sans seconde table à maintenir.

import Testing
@testable import OMPConsole
import ConsoleCore

// `@MainActor` : les vues SwiftUI sont isolées au fil principal (Swift 6), donc
// lire leur `section` statique depuis un test non isolé avertirait à la compilation.
@MainActor
@Test("socle-app-swift/AC-2 : chaque section a sa vue, dans la fenêtre principale")
func everySectionHasItsView() {
    let declared: [ConsoleSection] = [
        InboxSectionView.section,
        RunsSectionView.section,
        WorkstationSectionView.section,
        MemoryView.section,
        TerminalSectionView.section,
        FilesView.section,
        SystemSectionView.section,
    ]
    #expect(declared.count == ConsoleSection.allCases.count)
    #expect(Set(declared) == Set(ConsoleSection.allCases))
}

@MainActor
@Test("la coque s'ouvre sur « À traiter », et changer de section est idempotent")
func selectionStartsAtInbox() {
    let model = ConsoleModel()
    #expect(model.selection == .inbox)
    model.select(.system)
    model.select(.system)
    #expect(model.selection == .system)
}
