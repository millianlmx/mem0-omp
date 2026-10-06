// Assertion 3 de S-4 : les vues de section déclarent chacune leur section.
//
// Le test nomme les neuf TYPES puis confronte l'ensemble des sections qu'ils
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
    let declared: Set<ConsoleSection> = [
        HomeView.section,
        KanbanView.section,
        ProjectView.section,
        SessionConsoleSectionView.section,
        TerminalSectionView.section,
        SessionsView.section,
        FilesView.section,
        MemoryView.section,
        StatsSectionView.section,
    ]
    #expect(declared == Set(ConsoleSection.allCases))
}

@Test("plein écran : ouvrir une session la pousse dans la section Sessions, une à la fois")
func openingASessionStaysInTheMainWindow() {
    let model = ConsoleModel()
    let first = ViewerTarget(sessionFile: "/a.jsonl", title: "a")
    let second = ViewerTarget(sessionFile: "/b.jsonl", title: "b")
    model.openSession(first)
    #expect(model.selection == .sessions)
    #expect(model.sessionsPath == [first])
    // Changer de section garde la session ouverte ; en ouvrir une autre la remplace.
    model.select(.home)
    #expect(model.sessionsPath == [first])
    model.openSession(second)
    #expect(model.sessionsPath == [second])
}
