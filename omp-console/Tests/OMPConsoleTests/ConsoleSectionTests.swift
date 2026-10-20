// Assertion de S-4 : le modèle des sections — sélectionner une section change la
// vue courante. L'ouverture sur l'Accueil est prouvée par ConsoleViewTests.

import Testing
@testable import OMPConsole
import ConsoleCore

@Test("socle-app-swift/AC-2 : sélectionner une section change la vue courante")
func selectingASectionChangesTheCurrentOne() {
    let model = ConsoleModel()
    #expect(model.selection == .home)
    for section in ConsoleSection.allCases {
        model.select(section)
        #expect(model.selection == section)
    }
}

@Test("audit-panel-in-omp-console-mac/S-9 : Pilotage regroupe les sections du serveur de pipelines, Consultation les sections locales")
func pilotageGroupsTheServerSections() {
    #expect(ConsoleSection.allCases == [
        .home, .kanban, .project, .audit, .stats, .terminal, .files, .memory,
    ])
    #expect(ConsoleSection.audit.title == "Audit")
    #expect(ConsoleSection.audit.systemImage == "checklist")
    #expect(ConsoleSectionGroup.pilotage.sections == [.home, .kanban, .project, .audit, .stats])
    #expect(ConsoleSectionGroup.consultation.sections == [.terminal, .files, .memory])
}
