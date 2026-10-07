// Le rendu d'UNE ligne de conversation (S-6 de la feature `visionneuse-de-session`,
// restylé par S-15 de omp-console-redesign).
//
// Chaque forme de fait a son aspect, et CHAQUE état est traité :
//   — un message de l'utilisateur est une bulle alignée à droite, teintée de
//     l'accent ; un message de l'agent est un texte pleine largeur ; tous deux
//     rendent leur Markdown EN LIGNE ;
//   — une réflexion est une sous-ligne REPLIÉE d'un message de l'agent ;
//   — un appel d'outil a un en-tête cliquable (symbole, verbe, cible, statut) et
//     un corps replié par défaut (arguments, résultat, diff) dans un bloc opaque ;
//   — un résultat sans appel porte le même en-tête ;
//   — un appel `ask` est mis en évidence, déplié d'emblée, et n'offre AUCUN geste ;
//   — un marqueur (compaction, résumé de branche) est un séparateur centré qui
//     déplie son résumé.
//
// Le fil ne défile qu'en hauteur : chaque texte monospacé du corps défile en
// largeur dans son propre bloc, il n'est jamais tronqué.
//
// La distinction des lignes de diff ne repose pas sur la seule couleur : chaque
// ligne garde son marqueur d'origine ET porte une valeur d'accessibilité
// (« ligne ajoutée », « ligne supprimée », « contexte », « en-tête de diff »).
// Le statut d'un appel d'outil, montré par un symbole, porte de même un libellé
// d'accessibilité.

import AppKit
import ConsoleCore
import SwiftUI

/// La ligne n'observe PAS le modèle (S-18 R8) : elle reçoit ses plis et le geste
/// de repli, et se compare par valeur (`Equatable`, `.equatable()` côté fil). Une
/// publication du modèle — un fait ajouté, un pli, le suivi — ne réévalue donc
/// que les lignes dont la valeur a changé, pas toutes les lignes visibles.
struct SessionRowView: View, Equatable {
    let row: SessionRow
    /// La ligne est dépliée (appel d'outil, résultat, marqueur).
    let isOpen: Bool
    /// La réflexion d'un message de l'agent est dépliée.
    let isThinkingOpen: Bool
    /// Replie ou déplie la clé donnée (`row.id` ou `thinkingKey(of:)`).
    let onToggle: (String) -> Void

    /// La clé de pli de la réflexion d'une ligne, distincte de celle de la ligne :
    /// replier la réflexion ne touche pas la ligne du message.
    static func thinkingKey(of rowId: String) -> String { "\(rowId).thinking" }

    nonisolated static func == (lhs: SessionRowView, rhs: SessionRowView) -> Bool {
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
            Spacer(minLength: 80)
            Text(ConversationText.attributed(text))
                .textSelection(.enabled)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 14))
                .accessibilityIdentifier("viewer.user.\(row.id)")
        }
    }

    private func assistant(_ content: AssistantRow) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let thinking = content.thinking, !thinking.isEmpty {
                thinkingRow(thinking)
            }
            // Un message qui ne porte que de la réflexion a un texte blanc (souvent
            // des sauts de ligne) : le rendre creuserait un vide dans le fil. Le
            // texte de l'agent est rendu en BLOCS Markdown (S-19 R1), mémoïsés.
            if !content.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                MarkdownBlocksView(blocks: ConversationText.blocks(content.text))
                    .font(.body)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("viewer.assistant.\(row.id)")
            }
        }
    }

    /// Une sous-ligne repliable, sous sa propre clé de pli (`thinkingKey(of:)`).
    private func thinkingRow(_ thinking: String) -> some View {
        let isOpen = isThinkingOpen
        return VStack(alignment: .leading, spacing: 4) {
            Button {
                onToggle(Self.thinkingKey(of: row.id))
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isOpen ? "chevron.down" : "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Text(ConversationText.thinking)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("viewer.thinking.\(row.id)")
            if isOpen {
                Text(ConversationText.attributed(thinking))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    // MARK: - Appels d'outil

    private func toolCall(_ content: ToolCallRow) -> some View {
        let title = content.target.isEmpty
            ? ToolVerb.title(content.name)
            : "\(ToolVerb.title(content.name)) · \(content.target)"
        return VStack(alignment: .leading, spacing: 6) {
            Button {
                onToggle(row.id)
            } label: {
                toolHeader(
                    isOpen: isOpen,
                    symbol: ToolVerb.symbol(content.name),
                    title: title,
                    result: content.result,
                    headerId: "viewer.toolcall.header.\(row.id)"
                )
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("viewer.toolcall.\(row.id)")

            if isOpen {
                VStack(alignment: .leading, spacing: 8) {
                    if let ask = content.ask {
                        askBlock(ask)
                    }
                    section("Arguments") {
                        monospaced(content.argumentsJSON)
                    }
                    if let result = content.result, hasResult(result) {
                        section("Résultat") { resultBody(result) }
                    }
                }
                .toolBody()
                // Le corps est son PROPRE élément d'accessibilité : sans cela, son
                // identifiant se propage aux textes qu'il contient et masque ceux
                // des lignes de diff (« viewer.diff.<ligne>.<index> ») et du bloc
                // `ask` — mesuré par sonde AX.
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("viewer.toolcall.\(row.id).body")
            }
        }
    }

    /// L'en-tête d'un appel : chevron, symbole, verbe (et cible), puis le statut —
    /// en attente tant qu'aucun résultat n'est arrivé, terminé ou en erreur ensuite.
    private func toolHeader(
        isOpen: Bool,
        symbol: String,
        title: String,
        result: ToolResultRow?,
        headerId: String?
    ) -> some View {
        HStack(spacing: 8) {
            Image(systemName: isOpen ? "chevron.down" : "chevron.right")
                .font(.caption2)
                .foregroundStyle(.tertiary)
            Image(systemName: symbol)
                .foregroundStyle(.secondary)
            if let headerId {
                headerTitle(title).accessibilityIdentifier(headerId)
            } else {
                headerTitle(title)
            }
            Spacer(minLength: 8)
            toolStatus(result)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private func headerTitle(_ title: String) -> some View {
        Text(title)
            .font(.callout)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
    }

    @ViewBuilder
    private func toolStatus(_ result: ToolResultRow?) -> some View {
        if let result {
            if result.isError {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.red)
                    .accessibilityLabel("erreur")
            } else {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .accessibilityLabel("terminé")
            }
        } else {
            ProgressView()
                .controlSize(.mini)
                .accessibilityLabel("en cours")
        }
    }

    private func hasResult(_ result: ToolResultRow) -> Bool {
        !result.text.isEmpty || !(result.diff ?? "").isEmpty
    }

    private func standaloneResult(_ content: ToolResultRow) -> some View {
        let name = content.name ?? "outil"
        return VStack(alignment: .leading, spacing: 6) {
            Button {
                onToggle(row.id)
            } label: {
                toolHeader(
                    isOpen: isOpen,
                    symbol: ToolVerb.symbol(name),
                    title: "\(ToolVerb.title(name)) \(ConversationText.withoutCall)",
                    result: content,
                    headerId: nil
                )
            }
            .buttonStyle(.plain)
            if isOpen, hasResult(content) {
                section("Résultat") { resultBody(content) }
                    .toolBody()
                    .accessibilityElement(children: .contain)
            }
        }
    }

    // MARK: - Question `ask`

    /// Le bloc d'une question : mis en évidence, et SANS aucun geste — ni bouton,
    /// ni action : la visionneuse affiche, elle ne répond pas.
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
                        Text("Question")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(question.question)
                            .font(.body)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityIdentifier("viewer.ask.\(row.id).question.\(index)")
                        ForEach(Array(question.options.enumerated()), id: \.offset) { optionIndex, option in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(option.label)
                                    .textSelection(.enabled)
                                    .accessibilityIdentifier(
                                        "viewer.ask.\(row.id).option.\(index).\(optionIndex)"
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
        // Son propre élément d'accessibilité : l'identifiant du bloc ne doit pas
        // masquer ceux de ses questions et de ses options.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("viewer.ask.\(row.id)")
    }

    // MARK: - Marqueurs

    private func marker(_ content: MarkerRow) -> some View {
        let (title, summary): (String, String) = switch content {
        case .compaction(let summary, _): (ConversationText.compaction, summary)
        case .branchSummary(let summary, _): (ConversationText.branchSummary, summary)
        }
        return VStack(alignment: .leading, spacing: 6) {
            Button {
                onToggle(row.id)
            } label: {
                HStack(spacing: 8) {
                    Rectangle().fill(.quaternary).frame(height: 1)
                    Text(title)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize()
                    Rectangle().fill(.quaternary).frame(height: 1)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("viewer.marker.\(row.id)")
            if isOpen, !summary.isEmpty {
                Text(ConversationText.attributed(summary))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    // MARK: - Corps et diffs

    private func section<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Un corps monospacé et sélectionnable. Il ne se coupe PAS à la largeur du
    /// fil : une ligne longue défile en largeur dans son bloc plutôt que d'être
    /// tronquée (AC-3 de `visionneuse-de-session`).
    private func monospaced(_ text: String) -> some View {
        ScrollView(.horizontal) {
            Text(text)
                .font(.system(.callout, design: .monospaced))
                .textSelection(.enabled)
                .fixedSize(horizontal: true, vertical: false)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func resultBody(_ result: ToolResultRow) -> some View {
        let pieces = pieces(for: result)
        return VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(pieces.enumerated()), id: \.offset) { _, piece in
                pieceView(piece)
            }
        }
    }

    @ViewBuilder
    private func pieceView(_ piece: ResultPiece) -> some View {
        switch piece {
        case .text(let text):
            monospaced(text)
        case .diff(let lines):
            diffView(lines)
        }
    }

    /// Les morceaux d'un résultat, dans l'ordre : le texte découpé en segments
    /// (texte brut et blocs de diff DÉTECTÉS), puis le diff explicite de l'appel.
    /// L'index des lignes de diff court sur TOUTE la ligne, pour que deux blocs
    /// d'un même fait ne se disputent pas le même identifiant.
    private func pieces(for result: ToolResultRow) -> [ResultPiece] {
        var counter = 0
        var pieces: [ResultPiece] = []
        for segment in bodySegments(in: result.text) {
            switch segment {
            case .text(let text):
                if !text.isEmpty { pieces.append(.text(text)) }
            case .diff(let lines):
                let numbered = lines.map { line -> NumberedDiffLine in
                    defer { counter += 1 }
                    return NumberedDiffLine(index: counter, line: line)
                }
                pieces.append(.diff(numbered))
            }
        }
        if let diff = result.diff, !diff.isEmpty {
            let numbered = diffLines(in: diff).map { line -> NumberedDiffLine in
                defer { counter += 1 }
                return NumberedDiffLine(index: counter, line: line)
            }
            if !numbered.isEmpty { pieces.append(.diff(numbered)) }
        }
        return pieces
    }

    /// Un bloc de diff défile en largeur d'UN tenant : ses lignes restent alignées.
    private func diffView(_ lines: [NumberedDiffLine]) -> some View {
        ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(lines) { numbered in
                    Text(numbered.line.text)
                        .font(.system(.callout, design: .monospaced))
                        .foregroundStyle(color(of: numbered.line.tone))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: false)
                        .accessibilityIdentifier("viewer.diff.\(row.id).\(numbered.index)")
                        .accessibilityValue(SessionDiffText.toneLabel(numbered.line.tone))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func color(of tone: DiffTone) -> Color {
        switch tone {
        case .added: return .green
        case .removed: return .red
        case .context: return .primary
        case .section: return .secondary
        }
    }
}

private extension View {
    /// Le corps déplié d'un appel : un bloc OPAQUE (le contenu ne prend jamais le
    /// verre, Doc-1).
    func toolBody() -> some View {
        padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// Un morceau de résultat : du texte, ou un bloc de diff numéroté.
private enum ResultPiece {
    case text(String)
    case diff([NumberedDiffLine])
}

/// Une ligne de diff avec son rang DANS LA LIGNE affichée.
private struct NumberedDiffLine: Identifiable {
    let index: Int
    let line: DiffLine

    var id: Int { index }
}
