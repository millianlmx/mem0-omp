// Le rendu d'un Markdown en blocs complets (S-19 R1 de omp-console-redesign) :
// titres, paragraphes, listes, citations, blocs de code colorés, tableaux et
// séparateurs, tels que les découpe `MarkdownDocument.blocks`.
//
// Un composant partagé par Fichiers, la conversation, la Mémoire et Projet. Il n'a
// PAS de défilement vertical propre (le parent défile) et ne fixe pas de largeur
// de lecture (c'est au parent de la borner) ; le texte est sélectionnable. Seuls
// les blocs de code et les tableaux défilent horizontalement : une ligne longue
// n'élargit jamais le parent.

import AppKit
import SwiftUI

struct MarkdownBlocksView: View {
    let blocks: [MarkdownBlock]

    init(blocks: [MarkdownBlock]) {
        self.blocks = blocks
    }

    /// Analyse le texte à chaque construction : à réserver aux textes courts ou
    /// rendus une fois ; un texte réévalué souvent passe par un cache et `init(blocks:)`.
    init(markdown: String) {
        self.blocks = MarkdownDocument.blocks(markdown)
    }

    var body: some View {
        // Une `VStack`, pas une `LazyVStack` : MESURÉ (NSHostingView.fittingSize,
        // 2026-10-01), une pile paresseuse hors d'un défilement sous-estime sa
        // hauteur idéale (301 pt au lieu de 1 544) et tronque le contenu d'un
        // parent qui ne défile pas. Un long document qui veut la paresse empile
        // lui-même un `MarkdownBlocksView` par bloc dans sa `LazyVStack` (Fichiers).
        VStack(alignment: .leading, spacing: 14) {
            ForEach(blocks.indices, id: \.self) { index in
                MarkdownBlockView(block: blocks[index])
            }
        }
        .textSelection(.enabled)
    }
}

/// La palette « type Xcode », en couleurs système : chacune s'adapte au clair et
/// au sombre. Partagée par les blocs de code et la visionneuse de code de Fichiers.
enum CodePalette {
    static func color(_ kind: CodeTokenKind) -> Color? {
        switch kind {
        case .keyword: Color(nsColor: .systemPink)
        case .string: Color(nsColor: .systemRed)
        case .comment: Color(nsColor: .secondaryLabelColor)
        case .number: Color(nsColor: .systemBlue)
        case .type: Color(nsColor: .systemTeal)
        case .attribute: Color(nsColor: .systemOrange)
        case .plain: nil
        }
    }

    /// Une ligne colorée ; une ligne vide garde la hauteur d'une ligne.
    static func attributed(_ tokens: [CodeToken], size: Font.TextStyle) -> AttributedString {
        guard !tokens.isEmpty else { return AttributedString(" ") }
        var result = AttributedString()
        for token in tokens {
            var piece = AttributedString(token.text)
            if let color = color(token.kind) { piece.foregroundColor = color }
            if token.kind == .keyword {
                piece.font = .system(size, design: .monospaced, weight: .semibold)
            }
            result += piece
        }
        return result
    }
}

private struct MarkdownBlockView: View {
    let block: MarkdownBlock

    var body: some View {
        switch block {
        case let .heading(level, text):
            VStack(alignment: .leading, spacing: 6) {
                Text(text)
                    .font(Self.headingFont(level))
                    .fontWeight(level <= 3 ? .bold : .semibold)
                    .foregroundStyle(level == 6 ? .secondary : .primary)
                    .fixedSize(horizontal: false, vertical: true)
                if level <= 2 {
                    Divider()
                }
            }
            .padding(.top, level <= 2 ? 10 : 4)

        case let .paragraph(text):
            Text(text)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)

        case let .list(items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(items.indices, id: \.self) { index in
                    MarkdownListItemView(item: items[index])
                }
            }

        case let .quote(blocks):
            HStack(alignment: .top, spacing: 12) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(.quaternary)
                    .frame(width: 3)
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(blocks.indices, id: \.self) { index in
                        MarkdownBlockView(block: blocks[index])
                    }
                }
                .foregroundStyle(.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)

        case let .code(language, text):
            let tokens = CodeHighlighter.tokens(text, language: CodeLanguage.from(fence: language))
            ScrollView(.horizontal) {
                Text(CodePalette.attributed(tokens, size: .callout))
                    .font(.system(.callout, design: .monospaced))
                    .fixedSize()
                    .padding(12)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator))

        case let .table(table):
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 8) {
                    GridRow {
                        ForEach(table.headers.indices, id: \.self) { column in
                            Text(table.headers[column])
                                .fontWeight(.semibold)
                                .gridColumnAlignment(Self.alignment(table.alignments[column]))
                        }
                    }
                    Divider()
                    ForEach(table.rows.indices, id: \.self) { row in
                        GridRow {
                            ForEach(table.rows[row].indices, id: \.self) { column in
                                Text(table.rows[row][column])
                            }
                        }
                    }
                }
                .padding(12)
            }
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator))

        case .rule:
            Divider()
                .padding(.vertical, 6)
        }
    }

    private static func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .title
        case 2: .title2
        case 3: .title3
        case 4: .headline
        default: .subheadline
        }
    }

    private static func alignment(_ alignment: MarkdownColumnAlignment) -> HorizontalAlignment {
        switch alignment {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }
}

/// Un élément de liste : sa puce ou son numéro, indenté selon sa profondeur, puis
/// ses blocs.
private struct MarkdownListItemView: View {
    let item: MarkdownListItem

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(verbatim: item.marker.label(depth: item.depth))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(minWidth: 18, alignment: .trailing)
            VStack(alignment: .leading, spacing: 6) {
                ForEach(item.blocks.indices, id: \.self) { index in
                    MarkdownBlockView(block: item.blocks[index])
                }
            }
        }
        .padding(.leading, CGFloat(item.depth) * 22)
    }
}
