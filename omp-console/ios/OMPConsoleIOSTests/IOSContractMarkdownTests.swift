// Les preuves Swift de la feature contrat-ios-markdown-brut (S-6) : la feuille
// Contrat de l'Accueil iOS rend le corps de chaque section en Markdown, bloc par
// bloc, sans la ligne « ## Titre » qui doublait l'en-tête, et la recette
// `contractLong` nomme la feature en entier.
//
// Chaque test nomme l'id d'acceptation qu'il prouve. Le rendu visible (arbre
// d'accessibilité, captures) est prouvé par `scripts/ios-contrat-recette.sh`.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsoleIOS

@Suite("contrat-ios-markdown-brut — la feuille Contrat rendue en Markdown")
struct IOSContractMarkdownTests {
    // MARK: - Fixture

    /// Les sections du contrat d'une recette au moment `.specs`, telles que la
    /// feuille les reçoit.
    private static func sections(of recipe: IOSHomeRecipe) -> [ContractSection] {
        guard let payload = recipe.contractPayload else {
            Issue.record("la recette \(recipe) ne sert aucun contrat")
            return []
        }
        guard case .sections(let sections) = IOSHomeContent.contract(with: payload, moment: .specs) else {
            Issue.record("le contrat de la recette \(recipe) n'est pas découpé en sections")
            return []
        }
        return sections
    }

    /// Les sections du contrat de référence partagé (`HomeParity`) au moment `.specs`.
    private static var paritySections: [ContractSection] {
        let payload = RemoteContractPayload(document: RemoteDocument(
            name: IOSHomeText.contractName,
            state: IOSHomeText.documentText,
            content: HomeParity.contractMarkdown,
            reason: nil
        ))
        guard case .sections(let sections) = IOSHomeContent.contract(with: payload, moment: .specs) else {
            Issue.record("le contrat HomeParity n'est pas découpé en sections")
            return []
        }
        return sections
    }

    /// Les blocs du corps d'une section nommée, ou aucun.
    private static func body(_ title: String, in sections: [ContractSection]) -> [MarkdownBlock]? {
        sections.first { $0.title == title }.flatMap(IOSHomeContent.contractBlocks)
    }

    /// Le texte visible d'un bloc, récursivement (listes, citations, tableaux).
    private static func visibleText(_ block: MarkdownBlock) -> String {
        switch block {
        case .heading(_, let text), .paragraph(let text):
            return String(text.characters)
        case .list(let items):
            return items.flatMap(\.blocks).map(visibleText).joined(separator: " ")
        case .quote(let blocks):
            return blocks.map(visibleText).joined(separator: " ")
        case .code(_, let text):
            return text
        case .table(let table):
            let cells = table.headers + table.rows.flatMap { $0 }
            return cells.map { String($0.characters) }.joined(separator: " ")
        case .rule:
            return ""
        }
    }

    /// Les textes mis en forme d'un bloc qui peuvent porter du code en ligne.
    private static func inlineTexts(_ block: MarkdownBlock) -> [AttributedString] {
        switch block {
        case .heading(_, let text), .paragraph(let text):
            return [text]
        case .list(let items):
            return items.flatMap(\.blocks).flatMap(inlineTexts)
        case .quote(let blocks):
            return blocks.flatMap(inlineTexts)
        case .table(let table):
            return table.headers + table.rows.flatMap { $0 }
        case .code, .rule:
            return []
        }
    }

    private static func hasInlineCode(_ text: AttributedString) -> Bool {
        text.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true }
    }

    private static func isList(_ block: MarkdownBlock) -> Bool {
        if case .list = block { return true }
        return false
    }

    private static func isHeading(_ block: MarkdownBlock) -> Bool {
        if case .heading = block { return true }
        return false
    }

    // MARK: - AC-1

    @Test("contrat-ios-markdown-brut/AC-1 : le contrat long se lit sans « ## », puce brute ni accent grave")
    func longContractRendersWithoutRawMarkdown() {
        let sections = Self.sections(of: .contractLong)
        #expect(!sections.isEmpty)
        let blocks = sections.flatMap { IOSHomeContent.contractBlocks($0) ?? [] }
        #expect(!blocks.isEmpty)
        for block in blocks {
            let text = Self.visibleText(block)
            #expect(!text.contains("##"), "un bloc affiche « ## » : \(text)")
            #expect(!text.contains("`"), "un bloc affiche un accent grave : \(text)")
        }
        // Les listes sont des blocs `.list` (puces séparées), et le code en ligne
        // est un run mis en forme, pas des accents graves.
        #expect(blocks.contains(where: Self.isList))
        #expect(blocks.flatMap(Self.inlineTexts).contains(where: Self.hasInlineCode))

        // Les messages d'état de la feuille n'ont aucune syntaxe Markdown visible.
        let missing = IOSHomeText.contractSectionMissing(title: "Lots")
        #expect(!missing.contains("##"))
        #expect(!missing.contains("`"))
        let missingFile = String(IOSHomeContent.inlineMarkdown(ContractText.missingFile).characters)
        #expect(!missingFile.contains("##"))
        #expect(!missingFile.contains("`"))
    }

    // MARK: - AC-2

    @Test("contrat-ios-markdown-brut/AC-2 : chaque section longue est découpée en plusieurs blocs")
    func sectionsSplitIntoBlocks() {
        let sections = Self.sections(of: .contractLong)
        let specs = Self.body("Spécifications", in: sections) ?? []
        let lots = Self.body("Lots", in: sections) ?? []
        #expect(specs.count >= 10, "Spécifications : \(specs.count) blocs")
        #expect(lots.count >= 4, "Lots : \(lots.count) blocs")
    }

    // MARK: - AC-3

    @Test("contrat-ios-markdown-brut/AC-3 : le corps d'une section perd sa ligne « ## Titre », pas son contenu")
    func contractSectionsDropTheirHeading() {
        let parity = Self.paritySections
        for title in ["Spécifications", "Lots"] {
            let blocks = Self.body(title, in: parity)
            #expect(blocks != nil, "section \(title) absente")
            let titled = (blocks ?? []).filter { Self.isHeading($0) && Self.visibleText($0) == title }
            #expect(titled.isEmpty, "la section \(title) répète son titre")
        }
        let specsText = (Self.body("Spécifications", in: parity) ?? []).map(Self.visibleText).joined()
        #expect(specsText.contains("HomePresentation"))

        let longSpecs = Self.body("Spécifications", in: Self.sections(of: .contractLong)) ?? []
        guard case .heading(let level, let text)? = longSpecs.first else {
            Issue.record("le corps de Spécifications ne commence pas par un sous-titre")
            return
        }
        #expect(level == 3)
        #expect(String(text.characters) == "S-1 — Rendu des sections par blocs")

        // Corps vide, titre seul en fin de fichier, section absente.
        #expect(IOSHomeContent.contractBlocks(ContractSection(title: "Lots", text: "## Lots\n\n")) == [])
        #expect(IOSHomeContent.contractBlocks(ContractSection(title: "Lots", text: "## Lots")) == [])
        #expect(IOSHomeContent.contractBlocks(ContractSection(title: "Lots", text: "## Lots\r\n")) == [])
        #expect(IOSHomeContent.contractBlocks(ContractSection(title: "Lots", text: nil)) == nil)
    }

    // MARK: - AC-4

    @Test("contrat-ios-markdown-brut/AC-4 : la recette contractLong ouvre la feuille sur le nom complet de la feature")
    func longRecipeNamesTheWholeFeature() {
        #expect(IOSHomeRecipe.resolve(["-home.recipe", "contractLong"]) == .contractLong)
        guard let card = IOSHomeRecipe.contractLong.sheetCard else {
            Issue.record("contractLong n'ouvre aucune carte")
            return
        }
        #expect(IOSHomeContent.contractSlug(card) == IOSHomeRecipeText.longSlug)
        #expect(ContractDocument.moment(for: card) == .specs)
        #expect(IOSHomeRecipeText.longSlug.count > 40)

        // La recette `contract` garde sa carte d'origine.
        let original = IOSHomeRecipe.contract.sheetCard
        #expect(original.map(IOSHomeContent.contractSlug) == "specs-a-valider")
    }
}
