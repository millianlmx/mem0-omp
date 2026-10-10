// Le rendu d'UNE ligne du fil (S-6, S-7), réutilisable par n'importe quelle
// section (S-10) : bulle utilisateur, texte d'agent en blocs Markdown, réflexion
// repliable, appel d'outil (verbe, cible, arguments, résultat, diff), résultat
// autonome, marqueurs, et la question `ask` mise en évidence.
//
// Trois règles portées ici :
//   — la ligne n'observe PAS le modèle : elle reçoit ses plis et le geste de
//     repli, et se compare par valeur (`.equatable()`), donc une publication ne
//     réévalue que les lignes dont la valeur a changé ;
//   — les deux clés de pli sont INDÉPENDANTES : `row.id` pour la ligne,
//     `thinkingKey(of:)` pour la réflexion (S-6) ;
//   — la distinction des lignes de diff ne repose JAMAIS sur la seule couleur :
//     chaque ligne garde son marqueur d'origine ET porte le libellé partagé
//     `SessionDiffText.toneLabel(_:)` en valeur d'accessibilité.
//
// Aucun défilement horizontal : les lignes longues se replient sur plusieurs
// lignes (un `ScrollView` imbriqué aveuglerait `onScrollGeometryChange` sur iOS).
// Aucun littéral alphabétique : les mots viennent d'`IOSSessionText` ou du noyau.

import ConsoleCore
import SwiftUI

struct IOSSessionRowView: View, Equatable {
    let row: SessionRow
    /// La ligne est dépliée (appel d'outil, résultat, marqueur).
    let isOpen: Bool
    /// La réflexion du message de l'agent est dépliée.
    let isThinkingOpen: Bool
    /// Replie ou déplie la clé donnée (`row.id` ou `thinkingKey(of:)`).
    let onToggle: (String) -> Void

    /// La clé de pli de la réflexion d'une ligne, distincte de celle de la ligne.
    static func thinkingKey(of rowId: String) -> String { IOSSessionText.thinkingKey(rowId) }

    nonisolated static func == (lhs: IOSSessionRowView, rhs: IOSSessionRowView) -> Bool {
        lhs.row == rhs.row && lhs.isOpen == rhs.isOpen && lhs.isThinkingOpen == rhs.isThinkingOpen
    }

    var body: some View {
        switch row.kind {
        case .user(let content):
            user(content.text)
        case .assistant(let content):
            assistant(content)
        case .toolCall(let content):
            toolCall(content)
        case .toolResult(let content):
            standaloneResult(content)
        case .marker(let content):
            marker(content)
        }
    }

    // MARK: - Messages

    private func user(_ text: String) -> some View {
        HStack {
            Spacer(minLength: 40)
            Text(ConversationText.attributed(text))
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 14))
                .accessibilityIdentifier(IOSSessionsAccessibility.user(row.id))
        }
    }

    private func assistant(_ content: AssistantRow) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let thinking = content.thinking, !thinking.isEmpty {
                thinkingRow(thinking)
            }
            if !content.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                IOSMarkdownView(blocks: ConversationText.blocks(content.text))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier(IOSSessionsAccessibility.assistant(row.id))
            }
        }
    }

    /// La réflexion : une sous-ligne repliable, sous SA propre clé de pli.
    private func thinkingRow(_ thinking: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                onToggle(Self.thinkingKey(of: row.id))
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: IOSSessionText.chevron(isThinkingOpen))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Text(ConversationText.thinking)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, minHeight: IOSMetrics.minimumTarget, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(IOSSessionsAccessibility.thinking(row.id))
            if isThinkingOpen {
                Text(ConversationText.attributed(thinking))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    // MARK: - Appels d'outil

    private func toolCall(_ content: ToolCallRow) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                onToggle(row.id)
            } label: {
                toolHeader(
                    symbol: ToolVerb.symbol(content.name),
                    title: IOSSessionText.toolTitle(ToolVerb.title(content.name), content.target),
                    result: content.result
                )
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(IOSSessionsAccessibility.toolCall(row.id))

            if isOpen {
                VStack(alignment: .leading, spacing: 8) {
                    if let ask = content.ask {
                        askBlock(ask)
                    }
                    section(IOSSessionText.arguments) {
                        IOSToolArgumentsView(rowId: row.id, arguments: content.readableArguments)
                    }
                    if let result = content.result, hasResult(result) {
                        section(IOSSessionText.result) { resultBody(result) }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 8))
                // Le corps est son PROPRE élément d'accessibilité : sans cela son
                // identifiant masquerait ceux des lignes de diff et du bloc `ask`.
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier(IOSSessionsAccessibility.toolCallBody(row.id))
            }
        }
    }

    private func standaloneResult(_ content: ToolResultRow) -> some View {
        let name = content.name ?? IOSSessionText.unknownTool
        return VStack(alignment: .leading, spacing: 6) {
            Button {
                onToggle(row.id)
            } label: {
                toolHeader(
                    symbol: ToolVerb.symbol(name),
                    title: IOSSessionText.resultTitle(ToolVerb.title(name)),
                    result: content
                )
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(IOSSessionsAccessibility.toolResult(row.id))
            if isOpen, hasResult(content) {
                section(IOSSessionText.result) { resultBody(content) }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 8))
                    .accessibilityElement(children: .contain)
            }
        }
    }

    /// L'en-tête d'un appel : chevron, symbole, verbe (et cible), puis le statut.
    private func toolHeader(symbol: String, title: String, result: ToolResultRow?) -> some View {
        HStack(spacing: 8) {
            Image(systemName: IOSSessionText.chevron(isOpen))
                .font(.caption2)
                .foregroundStyle(.tertiary)
            Image(systemName: symbol)
                .foregroundStyle(.secondary)
            Text(title)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 8)
            toolStatus(result)
        }
        .frame(maxWidth: .infinity, minHeight: IOSMetrics.minimumTarget, alignment: .leading)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private func toolStatus(_ result: ToolResultRow?) -> some View {
        if let result {
            Image(systemName: result.isError ? IOSSessionText.errorSymbol : IOSSessionText.doneSymbol)
                .foregroundStyle(result.isError ? Color.red : Color.green)
                .accessibilityLabel(IOSSessionText.toolStatusLabel(result))
        } else {
            ProgressView()
                .controlSize(.mini)
                .accessibilityLabel(IOSSessionText.toolStatusLabel(nil))
        }
    }

    private func hasResult(_ result: ToolResultRow) -> Bool {
        !result.text.isEmpty || !(result.diff ?? "").isEmpty
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            content()
        }
    }

    // MARK: - Corps d'un résultat

    @ViewBuilder
    private func resultBody(_ result: ToolResultRow) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if !result.text.isEmpty {
                segments(result.text)
            }
            if let diff = result.diff, !diff.isEmpty {
                diffBlock(diffLines(in: diff))
            }
        }
    }

    /// Un texte quelconque : prose verbatim, ou blocs de diff unifié détectés.
    @ViewBuilder
    private func segments(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(bodySegments(in: text).enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .text(let plain):
                    IOSMonospacedText(plain)
                case .diff(let lines):
                    diffBlock(lines)
                }
            }
        }
    }

    /// Une ligne de diff : sa teinte ET son libellé d'accessibilité.
    private func diffBlock(_ lines: [DiffLine]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                Text(line.text)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(toneColor(line.tone))
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityValue(SessionDiffText.toneLabel(line.tone))
                    .accessibilityIdentifier(IOSSessionsAccessibility.diff(row.id, index))
            }
        }
    }

    private func toneColor(_ tone: DiffTone) -> Color {
        switch tone {
        case .added: return .green
        case .removed: return .red
        case .context: return .primary
        case .section: return .secondary
        }
    }

    // MARK: - Question `ask` (S-7)

    /// La question : un bloc distinct, déplié d'emblée, et SANS aucun geste — la
    /// visionneuse affiche, elle ne répond jamais (S-5).
    private func askBlock(_ ask: AskSpan) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Rectangle()
                .fill(Color.accentColor)
                .frame(width: 3)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(ask.questions.enumerated()), id: \.offset) { index, question in
                    VStack(alignment: .leading, spacing: 2) {
                        if let header = question.header {
                            Text(header)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Text(IOSSessionText.question)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(question.question)
                            .font(.body)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityIdentifier(
                                IOSSessionsAccessibility.askQuestion(row.id, index)
                            )
                        ForEach(Array(question.options.enumerated()), id: \.offset) { optionIndex, option in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(option.label)
                                    .multilineTextAlignment(.leading)
                                    .accessibilityIdentifier(
                                        IOSSessionsAccessibility.askOption(row.id, index, optionIndex)
                                    )
                                if let description = option.description {
                                    Text(description)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .padding(.leading, 8)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(8)
        .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSSessionsAccessibility.ask(row.id))
    }

    // MARK: - Marqueurs

    private func marker(_ content: MarkerRow) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                onToggle(row.id)
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: IOSSessionText.chevron(isOpen))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Text(markerTitle(content))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, minHeight: IOSMetrics.minimumTarget, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(IOSSessionsAccessibility.marker(row.id))
            if isOpen {
                Text(ConversationText.attributed(markerSummary(content)))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier(IOSSessionsAccessibility.markerBody(row.id))
            }
        }
    }

    private func markerTitle(_ marker: MarkerRow) -> String {
        switch marker {
        case .compaction: return ConversationText.compaction
        case .branchSummary: return ConversationText.branchSummary
        }
    }

    private func markerSummary(_ marker: MarkerRow) -> String {
        switch marker {
        case .compaction(let summary, _): return summary
        case .branchSummary(let summary, _): return summary
        }
    }
}

/// Un corps monospacé, partagé par le résultat d'un appel et la vue de ses
/// arguments : il se replie sur plusieurs lignes, sans défilement horizontal.
struct IOSMonospacedText: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.system(.callout, design: .monospaced))
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
