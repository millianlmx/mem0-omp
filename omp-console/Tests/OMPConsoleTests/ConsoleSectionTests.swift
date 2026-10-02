// Assertion de S-4 : le modèle des sections — sélectionner une section change la
// vue courante. L'ouverture sur l'Accueil est prouvée par HomeTests
// (omp-console-redesign/AC-4).

import Testing
@testable import OMPConsole

@Test("socle-app-swift/AC-2 : sélectionner une section change la vue courante")
func selectingASectionChangesTheCurrentOne() {
    let model = ConsoleModel()
    #expect(model.selection == .home)
    for section in ConsoleSection.allCases {
        model.select(section)
        #expect(model.selection == section)
    }
}
