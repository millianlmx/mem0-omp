// Preuve de S-9 (audit-panel-in-omp-console) : le menu Présentation liste les huit
// sections, raccourcis ⌘1…⌘8.

import Testing
@testable import OMPConsole
import ConsoleCore

@Test("audit-panel-in-omp-console-mac/S-9 : 8 entrées, touches 1…8")
func sectionCommandsKeysRunOneToEight() {
    #expect(ConsoleSection.allCases.count == 8)
    let keys = ConsoleSection.allCases.indices.map { SectionCommands.key(at: $0) }
    #expect(keys == ["1", "2", "3", "4", "5", "6", "7", "8"])
}
