// Assertion de S-4 : le modèle des sections — sélectionner une section change la
// vue courante. L'ouverture sur « À traiter » est prouvée par ConsoleViewTests.

import Testing
@testable import OMPConsole
import ConsoleCore

@MainActor
@Test("socle-app-swift/AC-2 : sélectionner une section change la vue courante")
func selectingASectionChangesTheCurrentOne() {
    let model = ConsoleModel()
    #expect(model.selection == .inbox)
    for section in ConsoleSection.allCases {
        model.select(section)
        #expect(model.selection == section)
    }
}

@Test("refonte : le travail, puis les outils, puis Système seul en bas de la barre latérale")
func sidebarGroupsWorkThenToolsThenSystem() {
    #expect(ConsoleSection.allCases == [.inbox, .runs, .workstation, .memory, .terminal, .files, .system])
    #expect(ConsoleSectionGroup.work.sections == [.inbox, .runs, .workstation])
    #expect(ConsoleSectionGroup.tools.sections == [.memory, .terminal, .files])
    #expect(ConsoleSectionGroup.system.sections == [.system])
    #expect(ConsoleSection.workstation.title == "Poste")
    #expect(ConsoleSection.workstation.systemImage == "desktopcomputer")
}
