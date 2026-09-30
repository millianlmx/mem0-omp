// Ce que la section « Mémoire » MONTRE, figé sans rendre de vue (BR-3, BR-4) : la
// règle d'aperçu et l'absence de tout vocabulaire d'écriture.
//
// SwiftUI ne s'inspecte pas depuis la suite : tout ce qui décide de ce qui s'affiche
// vit donc dans des fonctions pures que ce fichier confronte. Le contrat de section,
// lui, est vérifié par `ConsoleViewTests`.

import Foundation
import Testing

@testable import OMPConsole

@Test("memoire-mem0/AC-8 : l'état du service est écrit littéralement « disponible » ou « indisponible », avec l'adresse")
func ac8ServiceTextsAreLiteral() {
    #expect(MemoryText.serviceAvailable("http://localhost:8321") == "disponible — http://localhost:8321")
    #expect(MemoryText.serviceUnavailable("http://localhost:8321") == "indisponible — http://localhost:8321")
    #expect(MemoryText.unexpectedStatus(code: 503, detail: "en panne") == "réponse 503 du service (en panne)")
}

@Test("memoire-mem0/AC-3 : les messages de liste sont figés, et chacun dit ce qu'il doit dire")
func ac3ListTextsAreFrozen() {
    #expect(MemoryText.summaryCount(3) == "3 souvenir(s)")
    #expect(MemoryText.emptySummary("mem0-omp") == "Aucun souvenir dans la mémoire du projet « mem0-omp ».")
    #expect(
        MemoryText.belowThreshold(0.55)
            == "Aucun souvenir ne dépasse le seuil de pertinence (0,55) pour cette recherche."
    )
    #expect(MemoryText.searchResults("sujet") == "Résultats pour « sujet »")
}

@Test("memoire-mem0/AC-6 : la règle d'aperçu est figée")
func ac6PreviewIsFrozen() {
    // Première ligne seulement, détourée, tronquée à 99 caractères + `…`.
    #expect(MemoryText.preview("une ligne\nune autre") == "une ligne")
    #expect(MemoryText.preview("   espaces   ") == "espaces")
    let exactlyHundred = String(repeating: "a", count: 100)
    #expect(MemoryText.preview(exactlyHundred) == exactlyHundred)
    let hundredOne = String(repeating: "a", count: 101)
    #expect(MemoryText.preview(hundredOne).count == 100)
    #expect(MemoryText.preview(hundredOne).hasSuffix("…"))
}

@Test("memoire-mem0/AC-2 : la section n'offre AUCUN libellé d'écriture")
func ac2SectionHasNoWriteVocabulary() {
    let labels = [
        MemoryText.searchPlaceholder,
        MemoryText.searchButton,
        MemoryText.summaryButton,
        MemoryText.refresh,
        MemoryText.nothingSelected,
        MemoryText.emptyRow,
        MemoryText.noProjectTitle,
        MemoryText.unavailableTitle,
    ]
    for label in labels {
        let lowered = label.lowercased()
        #expect(!lowered.contains("ajout"))
        #expect(!lowered.contains("supprim"))
        #expect(!lowered.contains("modifi"))
        #expect(!lowered.contains("enregistrer"))
        #expect(!lowered.contains("éditer"))
    }
    // Les trois routes du client sont deux lectures et une recherche (S-2).
    #expect(MemoryRoute.allCases.count == 3)
}
