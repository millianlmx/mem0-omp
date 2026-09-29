// Le document `PROJECT.md` rendu en blocs (S-8, BR-2) — fonction PURE, testable
// sans UI.
//
// Mesures du contrat (`## Documentation` §5) qui gouvernent ce fichier :
//   — `.full` rend des `presentationIntent` exploitables (header, paragraph,
//     table/tableHeaderRow/tableRow/tableCell) ;
//   — en `.full`, le flux de caractères PERD les séparateurs de blocs : c'est
//     l'intention qui porte la structure, pas les blancs ;
//   — l'init peut lever : un échec n'est pas fatal, on replie sur `rawText`.

import Foundation

/// Un bloc du document, prêt à rendre.
enum ProjectDocBlock: Equatable {
    case heading(level: Int, text: String)
    case paragraph(AttributedString)
    case tableHeader(cells: [String])
    case tableRow(cells: [ProjectDocCell])
    case rawText(String)
}

/// Une cellule de donnée : l'en-tête de SA colonne et sa valeur formatée.
struct ProjectDocCell: Equatable {
    let header: String
    let value: AttributedString
}

extension ProjectDocCell {
    /// « <en-tête> : <valeur> », ou la valeur seule sans en-tête.
    var displayText: String {
        let text = String(value.characters)
        return header.isEmpty ? text : "« \(header) : \(text) »"
    }
}

/// Le rendu d'une ligne de tableau : chaque cellule « en-tête : valeur », ou les
/// cellules jointes par « · » quand la ligne n'a pas d'en-tête (S-8).
func projectDocRowText(_ cells: [ProjectDocCell]) -> String {
    let hasHeader = cells.contains { !$0.header.isEmpty }
    if hasHeader { return cells.map(\.displayText).joined(separator: "  ") }
    return cells.map { String($0.value.characters) }.joined(separator: " · ")
}

/// Le document en blocs. Repli `rawText` sur échec de parse, et jamais un tableau
/// vide : un document non vide produit au moins un bloc.
func projectDocBlocks(markdown: String) -> [ProjectDocBlock] {
    let attributed: AttributedString
    do {
        attributed = try AttributedString(
            markdown: markdown,
            options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .full)
        )
    } catch {
        return [.rawText(markdown)]
    }

    var blocks: [ProjectDocBlock] = []
    var headingText = ""
    var headingLevel: Int?
    var headingIdentity: Int?
    var paragraph = AttributedString()
    var paragraphIdentity: Int?
    var headerCells: [String] = []
    var rowCells: [ProjectDocCell] = []
    var lastHeader: [String] = []
    var currentRowIdentity: Int?

    func flushHeading() {
        if let level = headingLevel {
            blocks.append(.heading(level: level, text: headingText))
        }
        headingText = ""
        headingLevel = nil
        headingIdentity = nil
    }

    func flushParagraph() {
        if !paragraph.characters.isEmpty {
            blocks.append(.paragraph(paragraph))
        }
        paragraph = AttributedString()
        paragraphIdentity = nil
    }

    func flushHeaderRow() {
        if !headerCells.isEmpty {
            blocks.append(.tableHeader(cells: headerCells))
            lastHeader = headerCells
            headerCells = []
        }
    }

    func flushRow() {
        if !rowCells.isEmpty {
            blocks.append(.tableRow(cells: rowCells))
            rowCells = []
        }
    }

    for run in attributed.runs {
        let slice = AttributedString(attributed[run.range])
        switch docTag(for: run.presentationIntent) {
        case .heading(let level, let identity):
            flushParagraph()
            flushHeaderRow()
            flushRow()
            currentRowIdentity = nil
            if headingLevel != level || headingIdentity != identity {
                flushHeading()
                headingLevel = level
                headingIdentity = identity
            }
            headingText += String(slice.characters)

        case .paragraph(let identity):
            flushHeading()
            flushHeaderRow()
            flushRow()
            currentRowIdentity = nil
            if paragraphIdentity != identity {
                flushParagraph()
                paragraphIdentity = identity
            }
            paragraph += slice

        case .headerRow(let identity):
            flushHeading()
            flushParagraph()
            if currentRowIdentity != identity {
                flushHeaderRow()
                flushRow()
                currentRowIdentity = identity
            }
            headerCells.append(String(slice.characters))

        case .row(let identity, let column):
            flushHeading()
            flushParagraph()
            if currentRowIdentity != identity {
                flushHeaderRow()
                flushRow()
                currentRowIdentity = identity
            }
            let header = lastHeader.indices.contains(column) ? lastHeader[column] : ""
            rowCells.append(ProjectDocCell(header: header, value: slice))
        }
    }

    flushHeading()
    flushParagraph()
    flushHeaderRow()
    flushRow()

    if blocks.isEmpty {
        return [.rawText(markdown)]
    }
    return blocks
}

/// La classe d'un run, déduite de son intention de présentation.
private enum DocTag: Equatable {
    case heading(level: Int, identity: Int)
    case paragraph(identity: Int)
    case headerRow(identity: Int)
    case row(identity: Int, column: Int)
}

/// Le tag d'un run, et l'index de colonne quand c'est une cellule.
///
/// L'ordre des composants est du plus externe au plus interne (`table` puis
/// `tableRow` puis `tableCell`), donc une ligne d'en-tête doit être mémorisée AVANT
/// d'être écrasée par ses cellules.
private func docTag(for intent: PresentationIntent?) -> DocTag {
    guard let intent else { return .paragraph(identity: -1) }
    var inHeaderRow = false
    var inRow = false
    var rowIdentity = -1
    var column = 0
    var level: Int?
    var headingIdentity = -1
    var paragraphIdentity: Int?
    for component in intent.components {
        switch component.kind {
        case .header(let value):
            level = value
            headingIdentity = component.identity
        case .tableHeaderRow:
            inHeaderRow = true
            rowIdentity = component.identity
        case .tableRow:
            inRow = true
            rowIdentity = component.identity
        case .tableCell(let index):
            column = index
        case .paragraph:
            paragraphIdentity = component.identity
        default:
            break
        }
    }
    if inHeaderRow { return .headerRow(identity: rowIdentity) }
    if inRow { return .row(identity: rowIdentity, column: column) }
    if let level { return .heading(level: level, identity: headingIdentity) }
    return .paragraph(identity: paragraphIdentity ?? -1)
}
