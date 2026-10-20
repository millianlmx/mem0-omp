// Preuve de S-9 (audit-panel-in-omp-console) : le menu Présentation liste les
// sections, raccourcis ⌘1…⌘9 puis ⌘0 pour la dixième, aucun pour la onzième.

import Testing
@testable import OMPConsole
import ConsoleCore

@Test("audit-panel-in-omp-console-mac/S-9 : 11 entrées, touches 1…9 puis 0, aucune pour la onzième")
func sectionCommandsKeysRunOneToNineThenZero() {
    #expect(ConsoleSection.allCases.count == 11)
    let keys = ConsoleSection.allCases.indices.map { SectionCommands.key(at: $0) }
    #expect(keys == ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", nil])
}
