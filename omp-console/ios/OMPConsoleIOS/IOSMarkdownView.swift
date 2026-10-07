// Le rendu iOS d'un document Markdown découpé par le noyau partagé (S-2, BR-4) :
// les SEPT cas de `MarkdownBlock`, `MarkdownTable` compris (vrais tableaux, via
// `Grid`/`GridRow` — Doc-4). Aucune vue n'est reconstruite depuis le plan.
//
// Contrôles SYSTÈME uniquement ; aucune phrase composée ici (garde
// `design-ios/AC-5`) : le contenu vient d'`AttributedString` ou de constantes.

import ConsoleCore
import SwiftUI

struct IOSMarkdownView: View {
    let blocks: [MarkdownBlock]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case let .heading(level, text):
            Text(text)
                .font(headingFont(level))
                .multilineTextAlignment(.leading)
        case let .paragraph(text):
            Text(text)
                .font(.body)
                .multilineTextAlignment(.leading)
        case let .list(items):
            list(items)
        case let .quote(inner):
            HStack(alignment: .top, spacing: 8) {
                Rectangle()
                    .fill(.quaternary)
                    .frame(width: 3)
                IOSMarkdownView(blocks: inner)
            }
        case let .code(_, text):
            Text(text)
                .font(.system(.callout, design: .monospaced))
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 8))
        case let .table(table):
            grid(table)
        case .rule:
            Divider()
        }
    }

    private func list(_ items: [MarkdownListItem]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .top, spacing: 8) {
                    Text(item.marker.label(depth: item.depth))
                        .font(.body)
                        .foregroundStyle(.secondary)
                    IOSMarkdownView(blocks: item.blocks)
                }
                .padding(.leading, CGFloat(item.depth) * 16)
            }
        }
    }

    private func grid(_ table: MarkdownTable) -> some View {
        Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
            GridRow {
                ForEach(Array(table.headers.enumerated()), id: \.offset) { index, cell in
                    Text(cell)
                        .font(.headline)
                        .gridColumnAlignment(column(alignment: table.alignments, index: index))
                }
            }
            Divider()
            ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                GridRow {
                    ForEach(Array(row.enumerated()), id: \.offset) { index, cell in
                        Text(cell)
                            .font(.body)
                            .gridColumnAlignment(column(alignment: table.alignments, index: index))
                    }
                }
            }
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .title2
        case 2: return .title3
        case 3: return .headline
        default: return .subheadline
        }
    }

    private func column(alignment: [MarkdownColumnAlignment], index: Int) -> HorizontalAlignment {
        switch alignment.indices.contains(index) ? alignment[index] : .leading {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }
}
