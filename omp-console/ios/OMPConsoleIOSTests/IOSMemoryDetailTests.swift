// Les preuves Swift de la feuille de détail d'un souvenir (BR-3) : les cinq faits
// rendus sur une ligne complète, et une ligne pauvre qui n'en invente aucun.
//
// Les faits affichés sont des fonctions PURES de la vue : le test les confronte
// sans rendre l'écran — la preuve d'écran, elle, est la recette pas à pas du
// README.

import ConsoleClient
import ConsoleCore
import Testing

@testable import OMPConsoleIOS

@MainActor
@Suite("ios-memoire — la feuille d'un souvenir")
struct IOSMemoryDetailTests {
    /// Une ligne complète : texte Markdown (affiché tel quel), date lisible, cosinus, étiquettes, portée.
    private let full = RemoteMemoryRow(
        id: "m1",
        text: "# Titre du souvenir\n\nUn corps **gras** et un `code`.",
        updatedAt: "2026-10-01T11:50:31.746110+00:00",
        score: 0.92,
        tags: ["commun", "memoire"],
        agentId: "projet"
    )

    /// Une ligne pauvre : texte blanc, aucune date, aucun cosinus, aucune étiquette.
    private let poor = RemoteMemoryRow(
        id: "m2",
        text: " \n ",
        updatedAt: nil,
        score: nil,
        tags: [],
        agentId: nil
    )

    @Test("ios-memoire/AC-2 : la feuille rend les cinq faits, et une ligne pauvre n'en invente aucun")
    func detailRendersTheFiveFacts() {
        let nowMs = 1_760_000_000_000.0

        // (1) Le texte INTÉGRAL, tel qu'il est stocké.
        #expect(IOSMemoryDetailView.text(full) == full.text)

        // (2) La date de mise à jour RELATIVE, puis (3) les étiquettes.
        let subtitle = IOSMemoryDetailView.subtitle(full, nowMs: nowMs)
        #expect(!subtitle.isEmpty)
        #expect(subtitle.contains(MemoryText.tagList(full.tags)))
        #expect(subtitle.contains("#commun"))
        #expect(!subtitle.hasPrefix("#"))   // la date précède les étiquettes

        // (4) La portée : celle de la ligne, sinon celle du sommaire.
        #expect(IOSMemoryDetailView.scopeText(full, scope: nil) == "projet")
        #expect(IOSMemoryDetailView.scopeText(poor, scope: "sommaire") == "sommaire")
        #expect(IOSMemoryDetailView.scopeText(poor, scope: nil) == MemoryText.noProjectScope)

        // (5) La pertinence, seulement quand la ligne en porte une.
        #expect(IOSMemoryDetailView.scoreText(full) == MemoryText.decimal(0.92))
        #expect(IOSMemoryDetailView.scoreText(full) == "0,92")
        #expect(IOSMemoryDetailView.scoreText(poor) == nil)

        // Ligne pauvre : texte de repli, aucune date, aucune étiquette.
        #expect(IOSMemoryDetailView.text(poor) == MemoryText.emptyRow)
        #expect(IOSMemoryDetailView.subtitle(poor, nowMs: nowMs).isEmpty)
    }

    @Test("ios-memoire/AC-2 : les libellés de la feuille sont ceux du noyau partagé")
    func detailLabelsComeFromTheCore() {
        #expect(MemoryText.identifierLabel == "Identifiant")
        #expect(MemoryText.scopeLabel == "Portée")
        #expect(MemoryText.scoreLabel == "Pertinence")
        #expect(MemoryText.technicalDetails == "Détails techniques")
        #expect(MemoryText.noProjectScope == "Sans projet")
        #expect(IOSMemoryAccessibility.detail.hasPrefix("ios."))
        #expect(IOSMemoryAccessibility.row("m1") != IOSMemoryAccessibility.row("m2"))
    }
}
