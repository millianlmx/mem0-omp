// Ce que la section « Mémoire » MONTRE, figé sans rendre de vue (BR-3, BR-4,
// S-18 R7) : la ligne de contexte d'un souvenir et l'absence de tout vocabulaire
// d'écriture.
//
// SwiftUI ne s'inspecte pas depuis la suite : tout ce qui décide de ce qui s'affiche
// vit donc dans des fonctions pures que ce fichier confronte. Le contrat de section,
// lui, est vérifié par `ConsoleViewTests`.

import Foundation
import Testing

@testable import OMPConsole

@Test("memoire-mem0/AC-8 : l'indisponibilité garde l'adresse du service et la dernière erreur en détail secondaire")
func ac8UnavailableDetailKeepsAddressAndError() {
    #expect(MemoryText.unavailableDetail(address: "http://localhost:8321", error: "") == "http://localhost:8321")
    #expect(
        MemoryText.unavailableDetail(address: "http://localhost:8321", error: "jeton refusé (401)")
            == "http://localhost:8321\njeton refusé (401)"
    )
    #expect(MemoryText.unexpectedStatus(code: 503, detail: "en panne") == "réponse 503 du service (en panne)")
}

@Test("memoire-mem0/AC-3 : les messages de liste sont figés, et le compte prend un vrai pluriel")
func ac3ListTextsAreFrozen() {
    #expect(MemoryText.summaryCount(1) == "1 souvenir")
    #expect(MemoryText.summaryCount(3) == "3 souvenirs")
    #expect(MemoryText.emptySummary("mem0-omp") == "Aucun souvenir dans la mémoire du projet « mem0-omp ».")
    #expect(MemoryText.searchResults("sujet") == "Résultats pour « sujet »")
}

@Test("omp-console-redesign/S-18 : un souvenir se lit en un titre et une ligne de contexte (date · étiquettes)")
func s18MemoryRowReadsAsTextAndContext() throws {
    let stamp = "2026-10-01T11:50:31.746110+00:00"
    let ms = try #require(MemoryText.updatedAtMs(stamp))
    // La même seconde, écrite sans fraction et avec un autre décalage horaire.
    let sameSecond = try #require(MemoryText.updatedAtMs("2026-10-01T13:50:31+02:00"))
    #expect(abs(ms - sameSecond - 746.11) < 0.01)
    #expect(MemoryText.updatedAtMs("pas une date") == nil)
    #expect(MemoryText.updatedAtMs(nil) == nil)

    let nowMs = ms + 2 * 3_600_000
    let full = memoryRow(id: "m-1", text: "texte", updatedAt: stamp, tags: ["omp-console", "swiftui"])

    // Date relative à l'horloge de RENDU, puis étiquettes — dans cet ordre ; la
    // portée, commune à toute la liste, n'y figure pas.
    let segments = MemoryText.subtitle(row: full, nowMs: nowMs)
        .components(separatedBy: MemoryText.separator)
    #expect(segments == [ConsoleFormat.relative(ms: ms, nowMs: nowMs), "#omp-console #swiftui"])
    // La date suit l'instant de rendu, pas l'horloge du process.
    #expect(
        MemoryText.subtitle(row: full, nowMs: ms + 5_000)
            != MemoryText.subtitle(row: full, nowMs: ms + 3 * 86_400_000)
    )

    // Chaque segment absent de l'entrée est omis, jamais remplacé.
    let untagged = memoryRow(id: "m-2", text: "texte", updatedAt: stamp)
    #expect(MemoryText.subtitle(row: untagged, nowMs: nowMs) == ConsoleFormat.relative(ms: ms, nowMs: nowMs))

    let undated = memoryRow(id: "m-3", text: "texte", updatedAt: "illisible", tags: ["swiftui"])
    #expect(MemoryText.subtitle(row: undated, nowMs: nowMs) == "#swiftui")
    #expect(MemoryText.subtitle(row: memoryRow(id: "m-4", text: "texte"), nowMs: nowMs).isEmpty)
}

@Test("omp-console-redesign/S-19 : le titre d'un souvenir s'arrête au deux-points, sans code ni chemin complet")
func s19MemoryTitleStopsAtColonWithoutCodeOrFullPath() {
    // Deux-points français (blanc avant) : le titre s'y arrête ; « 11:50 » et
    // « http:// » ne coupent pas.
    #expect(
        MemoryText.title("omp-console / quitter l'app (bug mesuré le 2026-10-01 à 11:50) : avec `.terminateLater` l'app reste")
            == "omp-console / quitter l'app (bug mesuré le 2026-10-01 à 11:50)"
    )
    // Backticks et Markdown en ligne retirés, chemin réduit à son dernier composant.
    #expect(
        MemoryText.title("SwiftUI macOS 26 (mesuré, omp-console Files/FilesView.swift `CodeDocumentView`) : dans un ScrollView")
            == "SwiftUI macOS 26 (mesuré, omp-console FilesView.swift CodeDocumentView)"
    )
    #expect(MemoryText.title("**Décision** sur _le cache_ de `memory_type` : suite") == "Décision sur le cache de memory_type")
    #expect(MemoryText.title("Sonde /tmp/quitprobe et Sources/OMPConsole/Memory/ : relevé") == "Sonde quitprobe et Memory")
    // Ni un « / » isolé, ni « lecture/écriture », ni une URL ne sont des chemins.
    #expect(MemoryText.title("lecture/écriture via http://localhost:8321/memory : ok") == "lecture/écriture via http://localhost:8321/memory")

    // Sans deux-points : la première phrase, sans son point final ; une ligne
    // suivante n'entre jamais dans le titre.
    #expect(MemoryText.title("Le cache est borné. Il garde 64 entrées.") == "Le cache est borné")
    #expect(MemoryText.title("Pourquoi ? Parce que.") == "Pourquoi ?")
    #expect(MemoryText.title("# Titre de section\nCorps : détail") == "Titre de section")
    #expect(MemoryText.title("  plusieurs   blancs\tici  ") == "plusieurs blancs ici")

    // Au-delà de 90 caractères : borné, terminé par « … ».
    let long = MemoryText.title(String(repeating: "mot ", count: 60) + ": fin")
    #expect(long.count <= MemoryText.titleLimit)
    #expect(long.hasSuffix("…"))
    #expect(long.hasPrefix("mot mot"))

    // Vide pour un texte vide ou blanc, jamais vide sinon — même quand la coupe
    // ne laisse rien.
    #expect(MemoryText.title("").isEmpty)
    #expect(MemoryText.title(" \n\t ").isEmpty)
    #expect(MemoryText.title("`` : reste du souvenir").contains("reste du souvenir"))
    #expect(!MemoryText.title("``").isEmpty)
}

@Test("memoire-mem0/AC-2 : la section n'offre AUCUN libellé d'écriture")
func ac2SectionHasNoWriteVocabulary() {
    let labels = [
        MemoryText.searchPrompt,
        MemoryText.summaryButton,
        MemoryText.summaryHelp,
        MemoryText.refresh,
        MemoryText.refreshHelp,
        MemoryText.copy,
        MemoryText.copyHelp,
        MemoryText.retry,
        MemoryText.unavailableDescription,
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
