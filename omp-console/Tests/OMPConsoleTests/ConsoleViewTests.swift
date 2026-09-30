// Assertion 3 de S-4 : les cinq vues attendues déclarent chacune leur section.
//
// Le test nomme les cinq TYPES puis confronte l'ensemble des sections qu'ils
// déclarent à `Set(ConsoleSection.allCases)` : une vue manquante rend l'ensemble
// plus petit, deux vues sur la même section le réduisent aussi — les deux
// scénarios rougissent sans seconde table à maintenir.

import Testing
@testable import OMPConsole

// `@MainActor` : les vues SwiftUI sont isolées au fil principal (Swift 6), donc
// lire leur `section` statique depuis un test non isolé avertirait à la compilation.
@MainActor
@Test("socle-app-swift/AC-2 : les cinq vues déclarent chacune leur section")
func theFiveViewsDeclareTheirSection() {
    let declared: Set<ConsoleSection> = [
        KanbanView.section,
        SessionsView.section,
        FilesView.section,
        ProjectView.section,
        MemoryView.section,
    ]
    #expect(declared == Set(ConsoleSection.allCases))
}
