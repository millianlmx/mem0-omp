// Preuve de S-9 (audit-panel-in-omp-console) : le menu Présentation liste les neuf
// sections, raccourcis ⌘1…⌘9.

import Testing
@testable import OMPConsole
import ConsoleCore

@Test("audit-panel-in-omp-console-mac/S-9 : 9 entrées, touches 1…9")
func sectionCommandsKeysRunOneToNine() {
    #expect(ConsoleSection.allCases.count == 9)
    let keys = ConsoleSection.allCases.indices.map { SectionCommands.key(at: $0) }
    #expect(keys == ["1", "2", "3", "4", "5", "6", "7", "8", "9"])
}
