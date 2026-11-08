// Le menu Présentation liste les sept sections de la barre latérale, raccourcis ⌘1…⌘7.

import Testing
@testable import OMPConsole
import ConsoleCore

@Test("refonte : 7 entrées, touches 1…7 ; rien au-delà de 9")
func sectionCommandsKeysRunOneToSeven() {
    #expect(ConsoleSection.allCases.count == 7)
    let keys = ConsoleSection.allCases.indices.map { SectionCommands.key(at: $0) }
    #expect(keys == ["1", "2", "3", "4", "5", "6", "7"])
    #expect(SectionCommands.key(at: 8) == "9")
    #expect(SectionCommands.key(at: 9) == nil)
}
