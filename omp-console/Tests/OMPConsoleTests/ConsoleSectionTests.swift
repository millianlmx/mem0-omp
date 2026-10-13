// Assertion de S-4 : le modèle des sections — sélectionner une section change la
// vue courante. L'ouverture sur l'Accueil est prouvée par HomeTests
// (omp-console-redesign/AC-4).

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

@Test("audit-panel-in-omp-console-mac/S-9 : Audit est la quatrième section, dans Pilotage, après Projet")
func auditSectionFollowsProject() {
    #expect(ConsoleSection.allCases == [
        .home, .kanban, .project, .audit, .session, .terminal, .sessions, .files, .memory, .stats,
    ])
    #expect(ConsoleSection.audit.title == "Audit")
    #expect(ConsoleSection.audit.systemImage == "checklist")
    #expect(ConsoleSection.audit.group == .pilotage)
    #expect(ConsoleSectionGroup.pilotage.sections == [.home, .kanban, .project, .audit, .session, .terminal])
}
