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
import ConsoleCore

@Test("memoire-mem0/AC-8 : l'indisponibilité garde l'adresse du service et la dernière erreur en détail secondaire")
func ac8UnavailableDetailKeepsAddressAndError() {
    #expect(MemoryText.unavailableDetail(address: "http://localhost:8321", error: "") == "http://localhost:8321")
    #expect(
        MemoryText.unavailableDetail(address: "http://localhost:8321", error: "jeton refusé (401)")
            == "http://localhost:8321\njeton refusé (401)"
    )
    #expect(MemoryText.unexpectedStatus(code: 503, detail: "en panne") == "réponse 503 du service (en panne)")
}

@Test("jargon-technique-expose-mac-et-ios/AC-7 : le diagnostic de « Mémoire indisponible » et de la pile étrangère porte l'adresse, le code et le geste shell")
func unavailableDiagnosticKeepsAddressAndCode() {
    let status = MemoryServiceError.unexpectedStatus(503, "en panne").userMessage
    let diagnostic = MemoryText.unavailableDetail(address: "http://localhost:8321", error: status)
    #expect(diagnostic.contains("http://localhost:8321"))
    #expect(diagnostic.contains("503"))
    #expect(diagnostic.contains("en panne"))

    let foreign = ForeignOwnership(
        address: "http://127.0.0.1:8321",
        owner: "un autre programme (python3, pid 4711)",
        gesture: "arrêtez le programme qui tient le port (lsof -nP -iTCP:<port> -sTCP:LISTEN)",
        isLegacy: false
    )
    let owned = MemoryText.foreignOwnershipDetail(foreign)
    #expect(owned.contains("http://127.0.0.1:8321"))
    #expect(owned.contains("pid 4711"))
    #expect(owned.contains("lsof"))
}

@Test("jargon-technique-expose-mac-et-ios/AC-6 : les textes affichés de la Mémoire en erreur (indisponible, pile étrangère, oMLX, écriture) ne portent ni URL, ni code, ni OMLX_API_TOKEN")
func memoryErrorTextsAreReadable() {
    let shown = [
        MemoryText.unavailableTitle,
        MemoryText.unavailableDescription,
        MemoryText.foreignTitle,
        MemoryText.foreignDescription,
        MemoryText.omlxUnreachable,
        MemoryText.omlxUnauthorized,
        MemoryText.saveFailed,
        MemoryText.linkNotSaved,
    ]
    for text in shown {
        #expect(forbiddenTokens(in: text).isEmpty, "« \(text) »")
    }
    // Chaque phrase d'erreur porte son geste : rafraîchir, ou réessayer.
    #expect(MemoryText.omlxUnreachable.contains("rafraîchissez"))
    #expect(MemoryText.omlxUnauthorized.contains("rafraîchissez"))
    #expect(MemoryText.saveFailed.contains("Réessayez"))
}

@Test("memoire-mem0/AC-3 : les messages de liste sont figés, et le compte prend un vrai pluriel")
func ac3ListTextsAreFrozen() {
    #expect(MemoryText.summaryCount(1) == "1 souvenir")
    #expect(MemoryText.summaryCount(3) == "3 souvenirs")
    #expect(MemoryText.emptySummary("mem0-omp") == "Aucun souvenir dans la mémoire du projet « mem0-omp ».")
    #expect(MemoryText.searchResults("sujet") == "Résultats pour « sujet »")
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

@Test("graph-based-memeries-view/AC-4 : la LISTE n'offre AUCUN libellé d'écriture, le GRAPHE les porte")
func ac4ListHasNoWriteVocabularyAndGraphDoes() {
    // Les libellés du mode LISTE : la fiche y reste en lecture seule (AC-4).
    let listLabels = [
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
        MemoryText.omlxUnauthorized,
        MemoryText.omlxUnreachable,
    ]
    for label in listLabels {
        let lowered = label.lowercased()
        #expect(!lowered.contains("ajout"))
        #expect(!lowered.contains("supprim"))
        #expect(!lowered.contains("modifi"))
        #expect(!lowered.contains("enregistrer"))
        #expect(!lowered.contains("éditer"))
    }
    // La bascule elle-même nomme le mode à atteindre, sans vocabulaire d'écriture.
    #expect(MemoryText.graphButton == "Graphe")
    #expect(MemoryText.listButton == "Liste")

    // Le MODE GRAPHE, lui, écrit : ses libellés le disent (S-8, S-9, S-10, S-11).
    #expect(MemoryText.edit.lowercased().contains("modifi"))
    #expect(MemoryText.delete.lowercased().contains("supprim"))
    #expect(MemoryText.save.lowercased().contains("enregistrer"))
    #expect(MemoryText.createMemory.lowercased().contains("nouveau"))
    #expect(MemoryText.deleteConfirm == "Supprimer")
    #expect(MemoryText.detach == "Détacher")

    // Quatre routes : deux lectures, une recherche, le graphe.
    #expect(MemoryRoute.allCases.count == 4)
}

@Test("all-in-one-app/AC-6 : les textes des prérequis systèmes manquants sont figés (S-6)")
func ac6PrerequisiteTextsAreFrozen() {
    // oMLX : les deux phrases EXACTES de S-6 de jargon-technique-expose-mac-et-ios
    // (conséquence + geste) ; le brut d'avant reste le diagnostic copiable.
    #expect(
        MemoryText.omlxUnreachable
            == "oMLX ne répond pas : la recherche de souvenirs est indisponible. Démarrez oMLX, puis rafraîchissez."
    )
    #expect(
        MemoryText.omlxUnreachableDiagnostic(url: "http://127.0.0.1:8000/models")
            == "oMLX est injoignable (http://127.0.0.1:8000/models) — la mémoire a besoin de ses vecteurs sémantiques pour chercher."
    )
    #expect(
        MemoryText.omlxUnauthorized
            == "oMLX refuse la clé d’accès configurée : la recherche de souvenirs est indisponible. Corrigez la clé d’accès d’oMLX dans la configuration de la mémoire, puis rafraîchissez."
    )
    #expect(
        MemoryText.omlxUnauthorizedDiagnostic(url: "http://127.0.0.1:8000/models")
            == "oMLX a refusé le jeton configuré (401) — vérifiez OMLX_API_TOKEN.\nhttp://127.0.0.1:8000/models"
    )

    // git et gh : la spec ne fait que FIGER que leurs messages existants nomment le
    // prérequis au moment de l'usage — aucun comportement nouveau ici.
    let git = FilesError.gitNotFound(searched: ["/nowhere/git"], override: nil, path: "/tmp/projet").diagnostic
    #expect(git.contains("git est introuvable"))
    #expect(git.contains("/tmp/projet"))

    let gh = GhError.ghNotFound(searched: ["/nowhere/gh"], override: nil).userMessage
    #expect(gh.contains("gh est introuvable"))
    // Un chemin imposé est nommé lui aussi, jamais avalé.
    let ghOverride = GhError.ghNotFound(searched: ["/nowhere/gh"], override: "/custom/gh").userMessage
    #expect(ghOverride.contains("OMP_CONSOLE_GH_BINARY"))
    #expect(ghOverride.contains("/custom/gh"))
}

// MARK: - État « pas la pile d'OMP Console » (S-2, S-4, S-5, BR-9)

@Test("bug-embedded-podman-machine/AC-4 : les textes de l'état étranger sont FIGÉS (titre, description, détail, bouton)")
func ac4ForeignOwnershipTextsAreFrozen() {
    #expect(MemoryText.foreignTitle == "Ce n’est pas la pile d’OMP Console")
    #expect(
        MemoryText.foreignDescription
            == "Cette adresse répond, mais elle est tenue par un autre service : la mémoire du projet n’est pas celle d’OMP Console tant que sa pile n’occupe pas le port."
    )
    #expect(MemoryText.takeover == "Arrêter l’ancienne pile et reprendre")
    #expect(MemoryText.foreignService == "Ce service n’est pas la pile d’OMP Console : son jeton d’installation est absent ou différent.")

    // Le détail : adresse, propriétaire et geste, une ligne chacun.
    let legacy = ForeignOwnership(
        address: "http://localhost:8321",
        owner: "l'ancienne pile mémoire (conteneur mem0-http)",
        gesture: "podman stop mem0-qdrant mem0-http",
        isLegacy: true
    )
    #expect(
        MemoryText.foreignOwnershipDetail(legacy)
            == "http://localhost:8321\nTenu par l'ancienne pile mémoire (conteneur mem0-http).\nGeste : podman stop mem0-qdrant mem0-http"
    )

    let foreign = ForeignOwnership(
        address: "http://127.0.0.1:8321",
        owner: "un autre programme (python3, pid 4711)",
        gesture: "arrêtez le programme qui tient le port (lsof -nP -iTCP:<port> -sTCP:LISTEN)",
        isLegacy: false
    )
    #expect(MemoryText.foreignOwnershipDetail(foreign).contains("Tenu par un autre programme (python3, pid 4711)."))
    // Aucun bouton de reprise n'est offert quand le propriétaire n'est pas l'ancienne pile.
    #expect(!foreign.isLegacy)
    #expect(legacy.isLegacy)

    // Les textes de l'état étranger ne portent AUCUN vocabulaire d'écriture (AC-4).
    for label in [MemoryText.foreignTitle, MemoryText.foreignDescription, MemoryText.takeover, MemoryText.foreignService] {
        let lowered = label.lowercased()
        #expect(!lowered.contains("ajout"))
        #expect(!lowered.contains("supprim"))
        #expect(!lowered.contains("modifi"))
        #expect(!lowered.contains("enregistrer"))
        #expect(!lowered.contains("éditer"))
    }
}

@Test("bug-embedded-podman-machine/AC-4 : l'état d'écran `foreignOwned` se construit et s'égale (jamais un état disponible)")
func ac4ForeignOwnedStateCarriesItsOwner() {
    let ownership = ForeignOwnership(
        address: "http://localhost:8321",
        owner: "une autre pile (importée)",
        gesture: "arrêtez-la",
        isLegacy: false
    )
    let state = MemoryModel.State.foreignOwned(ownership)
    #expect(state == .foreignOwned(ownership))
    if case let .foreignOwned(carried) = state {
        #expect(carried.address == "http://localhost:8321")
        #expect(carried.owner == "une autre pile (importée)")
    } else {
        Issue.record("état attendu `foreignOwned`")
    }
}
