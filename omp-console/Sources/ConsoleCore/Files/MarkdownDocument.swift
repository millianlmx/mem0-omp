// Un document Markdown découpé en blocs complets (S-18 R5) — fonction PURE,
// testable sans vue.
//
// Mesures qui gouvernent ce fichier (sonde swiftc du 2026-10-01, SDK 27.2) :
//   — en `.full`, le flux de caractères PERD les séparateurs de blocs : la
//     structure est portée par `presentationIntent` de chaque run ;
//   — `components` liste la pile du plus INTERNE au plus externe
//     (`paragraph > listItem > unorderedList`), et les identités sont attribuées
//     en préordre (un parent a toujours une identité plus petite que ses
//     enfants) : la pile est donc triée par identité pour lire du dehors au dedans ;
//   — `listItem(ordinal:)` porte le VRAI numéro (« 3. » donne 3) ;
//   — un bloc HTML n'a AUCUNE intention de présentation ;
//   — `codeBlock(languageHint:)` garde le saut de ligne final du bloc.
//
// Cible PARTAGÉE macOS/iOS : `PresentationIntent` est disponible dès iOS 15
// (Doc-5), donc ce parseur n'importe que Foundation et tourne aussi sur l'app.

import Foundation

/// Un bloc du document, prêt à rendre.
public enum MarkdownBlock: Equatable, Sendable {
    case heading(level: Int, text: AttributedString)
    case paragraph(AttributedString)
    /// Une liste à plat : les sous-listes sont dépliées en éléments plus profonds,
    /// dans l'ordre de lecture.
    case list([MarkdownListItem])
    case quote([MarkdownBlock])
    case code(language: String?, text: String)
    case table(MarkdownTable)
    case rule
}

public struct MarkdownListItem: Equatable, Sendable {
    /// 0 pour la liste extérieure, +1 par imbrication.
    public let depth: Int
    public let marker: MarkdownListMarker
    /// Le contenu propre de l'élément (paragraphes, code, citation) — jamais une
    /// sous-liste, dépliée à la suite.
    public let blocks: [MarkdownBlock]

    init(depth: Int, marker: MarkdownListMarker, blocks: [MarkdownBlock]) {
        self.depth = depth
        self.marker = marker
        self.blocks = blocks
    }
}

public enum MarkdownListMarker: Equatable, Sendable {
    case bullet
    case number(Int)

    /// La puce change avec la profondeur, comme dans un traitement de texte ; un
    /// numéro reste un numéro.
    public func label(depth: Int) -> String {
        switch self {
        case .bullet:
            ["•", "◦", "▪︎"][depth % 3]
        case let .number(value):
            "\(value)."
        }
    }
}

public enum MarkdownColumnAlignment: Equatable, Sendable {
    case leading
    case center
    case trailing
}

public struct MarkdownTable: Equatable, Sendable {
    public let alignments: [MarkdownColumnAlignment]
    public let headers: [AttributedString]
    /// Chaque ligne a exactement `alignments.count` cellules (une cellule absente
    /// est vide).
    public let rows: [[AttributedString]]

    init(alignments: [MarkdownColumnAlignment], headers: [AttributedString], rows: [[AttributedString]]) {
        self.alignments = alignments
        self.headers = headers
        self.rows = rows
    }
}

public enum MarkdownDocument {
    /// Le document en blocs. Un échec de parse rend le texte brut en un seul
    /// paragraphe ; un document vide rend une liste vide.
    public static func blocks(_ markdown: String) -> [MarkdownBlock] {
        let attributed: AttributedString
        do {
            attributed = try AttributedString(
                markdown: withoutHTMLComments(markdown),
                options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .full)
            )
        } catch {
            return markdown.isEmpty ? [] : [.paragraph(AttributedString(markdown))]
        }
        let runs = attributed.runs.map { run in
            var text = AttributedString(attributed[run.range])
            text.presentationIntent = nil
            let stack = (run.presentationIntent?.components ?? []).sorted { $0.identity < $1.identity }
            return MarkdownRun(text: text, stack: stack[...])
        }
        return blocks(from: runs[...])
    }

    // MARK: - Lecture de la pile d'intentions

    private struct MarkdownRun {
        let text: AttributedString
        /// Du plus externe au plus interne.
        let stack: ArraySlice<PresentationIntent.IntentType>

        var dropped: MarkdownRun { MarkdownRun(text: text, stack: stack.dropFirst()) }
    }

    /// Les runs consécutifs qui partagent leur intention EXTERNE forment un bloc.
    private static func groups(_ runs: ArraySlice<MarkdownRun>) -> [ArraySlice<MarkdownRun>] {
        var result: [ArraySlice<MarkdownRun>] = []
        var start = runs.startIndex
        while start < runs.endIndex {
            let identity = runs[start].stack.first?.identity
            var end = start + 1
            while end < runs.endIndex, runs[end].stack.first?.identity == identity {
                end += 1
            }
            result.append(runs[start..<end])
            start = end
        }
        return result
    }

    /// Les commentaires HTML (`<!-- … -->`) sont invisibles dans un rendu Markdown ;
    /// le parseur de Foundation les rend comme du texte (vu à la recette :
    /// `<!-- mem0:brief v5 -->` affiché en tête d'AGENTS.md). Ils sont retirés HORS
    /// des blocs de code clôturés, qui gardent leur texte exact.
    public static func withoutHTMLComments(_ markdown: String) -> String {
        guard markdown.contains("<!--") else { return markdown }
        var output = ""
        var inFence = false
        var inComment = false
        for line in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.drop(while: { $0 == " " })
            if !inComment, trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                inFence.toggle()
                output += line + "\n"
                continue
            }
            if inFence {
                output += line + "\n"
                continue
            }
            var rest = Substring(line)
            var kept = ""
            while !rest.isEmpty {
                if inComment {
                    guard let end = rest.range(of: "-->") else { rest = ""; break }
                    rest = rest[end.upperBound...]
                    inComment = false
                } else if let start = rest.range(of: "<!--") {
                    kept += rest[..<start.lowerBound]
                    rest = rest[start.upperBound...]
                    inComment = true
                } else {
                    kept += rest
                    rest = ""
                }
            }
            // Une ligne qui ne portait QUE du commentaire disparaît entière.
            if kept.trimmingCharacters(in: .whitespaces).isEmpty, line.contains("<!--") || line.contains("-->") {
                continue
            }
            if inComment, kept.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            output += kept + "\n"
        }
        if !markdown.hasSuffix("\n"), output.hasSuffix("\n") { output.removeLast() }
        return output
    }

    private static func blocks(from runs: ArraySlice<MarkdownRun>) -> [MarkdownBlock] {
        groups(runs).flatMap(block(for:))
    }

    private static func block(for group: ArraySlice<MarkdownRun>) -> [MarkdownBlock] {
        guard let head = group.first?.stack.first else {
            // Bloc HTML (ou texte sans intention) : rendu tel quel, sans le saut final.
            let raw = String(inline(group).characters).trimmingCharacters(in: .newlines)
            return raw.isEmpty ? [] : [.paragraph(AttributedString(raw))]
        }
        switch head.kind {
        case let .header(level):
            return [.heading(level: level, text: inline(group))]
        case .paragraph:
            return [.paragraph(inline(group))]
        case let .codeBlock(hint):
            var text = String(inline(group).characters)
            if text.hasSuffix("\n") { text.removeLast() }
            let language = hint.flatMap { $0.isEmpty ? nil : $0 }
            return [.code(language: language, text: text)]
        case .thematicBreak:
            return [.rule]
        case .blockQuote:
            return [.quote(blocks(from: dropped(group)))]
        case .orderedList, .unorderedList:
            return [.list(items(of: group, ordered: head.kind == .orderedList))]
        case let .table(columns):
            return [.table(table(of: group, columns: columns))]
        default:
            // Composant intérieur rencontré en tête (ne survient pas sur un
            // document bien formé) : on lit ce qu'il contient.
            return blocks(from: dropped(group))
        }
    }

    private static func dropped(_ group: ArraySlice<MarkdownRun>) -> ArraySlice<MarkdownRun> {
        group.map(\.dropped)[...]
    }

    private static func inline(_ group: ArraySlice<MarkdownRun>) -> AttributedString {
        group.reduce(into: AttributedString()) { $0 += $1.text }
    }

    /// Les éléments d'une liste, ses sous-listes dépliées un cran plus profond.
    private static func items(of group: ArraySlice<MarkdownRun>, ordered: Bool) -> [MarkdownListItem] {
        var result: [MarkdownListItem] = []
        for item in groups(dropped(group)) {
            var ordinal = 1
            if case let .listItem(value)? = item.first?.stack.first?.kind {
                ordinal = value
            }
            var own: [MarkdownBlock] = []
            var nested: [MarkdownListItem] = []
            for block in blocks(from: dropped(item)) {
                if case let .list(subItems) = block {
                    nested += subItems.map {
                        MarkdownListItem(depth: $0.depth + 1, marker: $0.marker, blocks: $0.blocks)
                    }
                } else {
                    own.append(block)
                }
            }
            result.append(MarkdownListItem(depth: 0, marker: ordered ? .number(ordinal) : .bullet, blocks: own))
            result += nested
        }
        return result
    }

    private static func table(
        of group: ArraySlice<MarkdownRun>,
        columns: [PresentationIntent.TableColumn]
    ) -> MarkdownTable {
        let width = columns.count
        var headers = Array(repeating: AttributedString(), count: width)
        var rows: [[AttributedString]] = []
        for row in groups(dropped(group)) {
            var cells = Array(repeating: AttributedString(), count: width)
            for cell in groups(dropped(row)) {
                guard case let .tableCell(column)? = cell.first?.stack.first?.kind,
                      cells.indices.contains(column) else { continue }
                cells[column] = inline(cell)
            }
            if row.first?.stack.first?.kind == .tableHeaderRow {
                headers = cells
            } else {
                rows.append(cells)
            }
        }
        let alignments = columns.map { column -> MarkdownColumnAlignment in
            switch column.alignment {
            case .center: .center
            case .right: .trailing
            default: .leading
            }
        }
        return MarkdownTable(alignments: alignments, headers: headers, rows: rows)
    }
}
