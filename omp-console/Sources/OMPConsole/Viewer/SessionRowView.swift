// Le rendu d'UNE ligne de conversation (S-6 de la feature `visionneuse-de-session`).
//
// Chaque forme de fait a son aspect, et CHAQUE état est traité :
//   — un message porte son rôle (« vous », « agent ») et son texte ;
//   — une réflexion est une sous-ligne REPLIÉE d'un message assistant ;
//   — un appel d'outil a un en-tête cliquable (nom + cible + statut) et un corps
//     replié par défaut (arguments, résultat, diff) ;
//   — un résultat sans appel est un bloc autonome ;
//   — un appel `ask` est mis en évidence, déplié d'emblée, et n'offre AUCUN geste ;
//   — un marqueur (compaction, résumé de branche) est une ligne discrète.
//
// La distinction des lignes de diff ne repose pas sur la seule couleur : chaque
// ligne garde son marqueur d'origine ET porte une valeur d'accessibilité
// (« ligne ajoutée », « ligne supprimée », « contexte », « en-tête de diff »).
//
// Réutilisation exigée du dépôt : police monospacée `.system(.callout, design:
// .monospaced)`, `.textSelection(.enabled)` pour les corps, composants système —
// il n'existe aucun design system ici.

import SwiftUI

struct SessionRowView: View {
    let row: SessionRow
    @ObservedObject var model: SessionViewerModel

    var body: some View {
        switch row.kind {
        case .user(let content):
            message(role: "vous", text: content.text)
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

    private func message(role: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(role)
                .font(.caption)
                .foregroundStyle(.secondary)
            body(text)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(6)
        .background(Color.gray.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
    }

    private func assistant(_ content: AssistantRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let thinking = content.thinking, !thinking.isEmpty {
                thinkingRow(thinking)
            }
            message(role: "agent", text: content.text)
        }
    }

    /// Une sous-ligne repliable. Sa clé de pli est distincte de celle de la ligne
    /// (« … .thinking ») : replier la réflexion ne touche pas la ligne du message.
    private func thinkingRow(_ thinking: String) -> some View {
        let key = thinkingKey
        let isOpen = model.isExpanded(key)
        return VStack(alignment: .leading, spacing: 2) {
            Button {
                model.toggleFold(key)
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isOpen ? "chevron.down" : "chevron.right")
                        .font(.caption)
                    Text("Réflexion")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("viewer.thinking.\(row.id)")
            if isOpen { body(thinking) }
        }
        .padding(.leading, 8)
    }

    private var thinkingKey: String { "\(row.id).thinking" }

    // MARK: - Appels d'outil

    private func toolCall(_ content: ToolCallRow) -> some View {
        let isOpen = model.isExpanded(row.id)
        return VStack(alignment: .leading, spacing: 4) {
            Button {
                model.toggleFold(row.id)
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isOpen ? "chevron.down" : "chevron.right")
                        .font(.caption)
                    Text("\(content.name)(\(content.target))")
                        .font(.system(.callout, design: .monospaced))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .accessibilityIdentifier("viewer.toolcall.header.\(row.id)")
                    Spacer(minLength: 8)
                    Text(status(content))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("viewer.toolcall.\(row.id)")

            if isOpen {
                VStack(alignment: .leading, spacing: 6) {
                    if let ask = content.ask {
                        askBlock(ask)
                    }
                    section("Arguments") {
                        body(content.argumentsJSON)
                    }
                    if let result = content.result, hasResult(result) {
                        section("Résultat") { resultBody(result) }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 8)
                // Le corps est son PROPRE élément d'accessibilité : sans cela, son
                // identifiant se propage aux textes qu'il contient et masque ceux
                // des lignes de diff (« viewer.diff.<ligne>.<index> ») et du bloc
                // `ask` — mesuré par sonde AX.
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("viewer.toolcall.\(row.id).body")
            }
        }
    }

    /// Le statut de l'en-tête : « en attente » tant qu'aucun résultat n'est arrivé,
    /// puis le nombre de lignes du résultat — `0` pour un résultat vide.
    private func status(_ content: ToolCallRow) -> String {
        guard let result = content.result else { return "⇒ en attente" }
        let lines = lineCount(result.text)
        return result.isError ? "⇒ erreur · \(lines) lignes" : "⇒ ok · \(lines) lignes"
    }

    private func lineCount(_ text: String) -> Int {
        text.isEmpty ? 0 : text.split(separator: "\n", omittingEmptySubsequences: false).count
    }

    private func hasResult(_ result: ToolResultRow) -> Bool {
        !result.text.isEmpty || !(result.diff ?? "").isEmpty
    }

    private func standaloneResult(_ content: ToolResultRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(content.name ?? "outil") (sans appel)")
                .font(.system(.callout, design: .monospaced))
                .foregroundStyle(.secondary)
            if hasResult(content) {
                section("Résultat") { resultBody(content) }
                    .padding(.leading, 8)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
                            .font(.system(.callout, design: .monospaced))
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
        Text(markerText(content))
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 2)
    }

    private func markerText(_ content: MarkerRow) -> String {
        switch content {
        case .compaction(_, let tokensBefore):
            return tokensBefore.map { "Compaction — \($0) jetons avant" } ?? "Compaction"
        case .branchSummary(_, let fromId):
            return fromId.isEmpty
                ? "Résumé de branche — depuis la racine"
                : "Résumé de branche — depuis \(fromId)"
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

    /// Un corps monospacé et sélectionnable. Il ne se coupe PAS à la largeur de la
    /// fenêtre : un fait long fait défiler plutôt que d'être tronqué (AC-3).
    private func body(_ text: String) -> some View {
        Text(text)
            .font(.system(.callout, design: .monospaced))
            .textSelection(.enabled)
            .fixedSize(horizontal: true, vertical: false)
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
            body(text)
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

    private func diffView(_ lines: [NumberedDiffLine]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(lines) { numbered in
                Text(numbered.line.text)
                    .font(.system(.callout, design: .monospaced))
                    .foregroundStyle(color(of: numbered.line.tone))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: false)
                    .accessibilityIdentifier("viewer.diff.\(row.id).\(numbered.index)")
                    .accessibilityValue(toneLabel(numbered.line.tone))
            }
        }
    }

    private func color(of tone: DiffTone) -> Color {
        switch tone {
        case .added: return .green
        case .removed: return .red
        case .context: return .primary
        case .section: return .secondary
        }
    }

    /// La valeur d'accessibilité d'une ligne de diff : la distinction ne repose
    /// donc jamais sur la seule couleur.
    private func toneLabel(_ tone: DiffTone) -> String {
        switch tone {
        case .added: return "ligne ajoutée"
        case .removed: return "ligne supprimée"
        case .context: return "contexte"
        case .section: return "en-tête de diff"
        }
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
