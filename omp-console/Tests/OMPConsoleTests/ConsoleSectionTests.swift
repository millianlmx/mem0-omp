// Assertions 1, 2 et 4 de S-4 : le modèle des cinq sections.
//
// Les valeurs sont LUES au module (`allCases`, `title`) au lieu d'être
// recopiées dans une table parallèle : seule la liste ATTENDUE des titres est
// nommée, et elle est confrontée au modèle.

import Testing
@testable import OMPConsole

@Test("socle-app-swift/AC-2 : l'ordre des sections est Kanban, Sessions, Fichiers, Projet, Mémoire")
func sectionTitlesInOrder() {
    #expect(ConsoleSection.allCases.map(\.title) == ["Kanban", "Sessions", "Fichiers", "Projet", "Mémoire"])
}

@Test("socle-app-swift/AC-2 : sélectionner une section change la vue courante")
func selectingASectionChangesTheCurrentOne() {
    let model = ConsoleModel()
    #expect(model.selection == .kanban)
    for section in ConsoleSection.allCases {
        model.select(section)
        #expect(model.selection == section)
    }
}
