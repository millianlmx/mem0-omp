// Preuves du rendu du document (BR-2) : blocs purs de `projectDocBlocks`.

import Foundation
import Testing
@testable import OMPConsole

private func headingText(_ block: ProjectDocBlock) -> (Int, String)? {
    if case .heading(let level, let text) = block { return (level, text) }
    return nil
}

@Test("le document rend les titres, paragraphes et tableaux")
func docRendersHeadingsParagraphsTables() {
    let markdown = """
    # Projet — mem0-omp

    Une phrase d'introduction.

    ## Plan

    | Feature | État |
    | --- | --- |
    | socle | fusionnée |
    """
    let blocks = projectDocBlocks(markdown: markdown)

    let headings = blocks.compactMap(headingText)
    #expect(headings.contains { $0 == (1, "Projet — mem0-omp") })
    #expect(headings.contains { $0 == (2, "Plan") })

    #expect(blocks.contains { if case .paragraph = $0 { return true } else { return false } })

    guard let header = blocks.first(where: { if case .tableHeader = $0 { return true } else { return false } }),
          case .tableHeader(let headerCells) = header else {
        Issue.record("aucune ligne d'en-tête rendue")
        return
    }
    #expect(headerCells == ["Feature", "État"])

    guard let row = blocks.first(where: { if case .tableRow = $0 { return true } else { return false } }),
          case .tableRow(let cells) = row else {
        Issue.record("aucune ligne de données rendue")
        return
    }
    #expect(cells.count == 2)
    #expect(cells[0].header == "Feature")
    #expect(String(cells[0].value.characters) == "socle")
    #expect(cells[1].header == "État")
    #expect(String(cells[1].value.characters) == "fusionnée")
    #expect(projectDocRowText(cells) == "« Feature : socle »  « État : fusionnée »")
}

@Test("un document vide ne rend jamais un volet vide")
func docEmptyFallsBackToRawText() {
    let blocks = projectDocBlocks(markdown: "")
    #expect(blocks.count == 1)
    #expect(blocks.first == .rawText(""))
}

@Test("un tableau sans en-tête joint ses cellules par « · »")
func docHeaderlessTableJoinsCells() {
    let cells = [
        ProjectDocCell(header: "", value: AttributedString("a")),
        ProjectDocCell(header: "", value: AttributedString("b")),
    ]
    #expect(projectDocRowText(cells) == "a · b")
}
