// Les volets RPC partagés par la fenêtre « Session OMP » et la vue « Projet »
// (S-4, BR-3) : transcription brute (inspecteur) et dialogue en attente.
//
// Ils sont paramétrés par un `idPrefix` (`"session"` / `"projet"`) et par des
// `Binding`/callbacks : AUCUNE seconde implémentation du dialogue n'existe, et
// les règles de gating vivent dans les modèles, pas ici.

import ConsoleCore
import SwiftUI

/// La transcription brute, défilante sur la dernière ligne.
struct RpcTranscriptPane: View {
    let idPrefix: String
    let lines: [TranscriptLine]
    var emptyText: String = SessionConsoleText.noEvent

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if lines.isEmpty {
                        Text(emptyText)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(lines) { line in
                        Text(line.text)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .id(line.id)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(6)
            }
            .accessibilityIdentifier("\(idPrefix).transcript")
            .onChange(of: lines.count) { _, _ in
                guard let last = lines.last else { return }
                proxy.scrollTo(last.id, anchor: .bottom)
            }
        }
        .frame(minHeight: 160)
        .background(Color.gray.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

/// Le dialogue en attente : le PREMIER de la file, avec sa forme de réponse.
/// « Session OMP » et « Projet » le montrent en feuille, sous leur propre titre
/// (S-15, S-19 R3 de omp-console-redesign) ; « Projet » rend lui-même le titre
/// du dialogue (`showsTitle: false`) pour en séparer le corps multi-lignes.
///
/// Les options d'un `select` sont une liste de boutons radio : chaque ligne
/// dit qu'elle se choisit, son libellé et sa description passent à la ligne
/// plutôt que d'être coupés, et la liste grandit avec son contenu jusqu'à une
/// hauteur maximale au-delà de laquelle elle défile. Les boutons tiennent sur
/// UNE rangée alignée à droite : l'annulation, puis l'action par défaut (↩, ou
/// ⌘↩ sous un éditeur multi-ligne), seule mise en avant.
struct RpcDialogPane: View {
    let idPrefix: String
    let dialog: RpcDialogRequest
    @Binding var dialogText: String
    @Binding var selectedOptionIndex: Int?
    let canAnswer: Bool
    let onAnswerSelected: () -> Void
    let onAnswerText: () -> Void
    let onConfirm: (Bool) -> Void
    let onCancel: () -> Void
    let onAppeared: (RpcDialogRequest) -> Void
    var showsHeader: Bool = false
    var showsTitle: Bool = true
    var cancelTitle: String = SessionConsoleText.cancel
    var cancelShortcut: KeyboardShortcut = KeyboardShortcut(.escape, modifiers: [])

    /// La hauteur au-delà de laquelle la liste des options défile.
    private static let optionsMaxHeight: CGFloat = 280

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if showsHeader {
                Text(SessionConsoleText.dialogTitle)
                    .font(.headline)
            }
            if showsTitle {
                Text(dialog.title)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("\(idPrefix).dialog.title")
            }
            if let message = dialog.message {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            answerField

            HStack(spacing: 8) {
                Spacer()
                Button(cancelTitle) { onCancel() }
                    .keyboardShortcut(cancelShortcut)
                    .accessibilityIdentifier("\(idPrefix).dialog.cancel")
                defaultActions
            }
        }
        .onAppear { onAppeared(dialog) }
        .onChange(of: dialog.id) { _, _ in onAppeared(dialog) }
    }

    // MARK: - Champ de réponse

    @ViewBuilder private var answerField: some View {
        switch dialog.method {
        case .select:
            if dialog.options.isEmpty {
                Text(SessionConsoleText.noOption)
                    .foregroundStyle(.secondary)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(dialog.options.enumerated()), id: \.offset) { index, option in
                            optionRow(index: index, option: option)
                        }
                    }
                    .padding(4)
                }
                .scrollIndicators(.visible)
                // La liste prend la hauteur de son contenu, plafonnée : au-delà,
                // elle défile au lieu de couper les dernières options.
                .frame(maxHeight: Self.optionsMaxHeight)
                .fixedSize(horizontal: false, vertical: true)
                .background(.background.secondary, in: RoundedRectangle(cornerRadius: 8))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("\(idPrefix).dialog.options")
            }
        case .confirm:
            EmptyView()
        case .input:
            // ↩ déclenche « Répondre », le bouton par défaut : aucun `onSubmit`,
            // qui enverrait la réponse une seconde fois.
            TextField(dialog.placeholder ?? "", text: $dialogText)
                .textFieldStyle(.roundedBorder)
        case .editor:
            TextEditor(text: $dialogText)
                .font(.system(.body, design: .monospaced))
                .frame(minHeight: 100, maxHeight: 200)
        }
    }

    /// Une option, en bouton radio : le rond plein marque l'option choisie.
    private func optionRow(index: Int, option: String) -> some View {
        let isSelected = selectedOptionIndex == index
        return Button {
            selectedOptionIndex = index
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: isSelected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(SessionConsoleText.optionLabel(option))
                        .fixedSize(horizontal: false, vertical: true)
                    if let description = description(at: index) {
                        Text(description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
        .accessibilityIdentifier("\(idPrefix).dialog.option.\(index)")
    }

    // MARK: - Actions

    /// L'action par défaut, après l'annulation : « Répondre », ou « Refuser »
    /// puis « Confirmer » pour une confirmation.
    @ViewBuilder private var defaultActions: some View {
        switch dialog.method {
        case .select:
            answerButton(action: onAnswerSelected, shortcut: .defaultAction)
        case .input:
            answerButton(action: onAnswerText, shortcut: .defaultAction)
        case .editor:
            // Sous un éditeur multi-ligne, ↩ est un saut de ligne : ⌘↩ répond.
            answerButton(action: onAnswerText, shortcut: KeyboardShortcut(.return, modifiers: .command))
        case .confirm:
            Button(SessionConsoleText.decline) { onConfirm(false) }
                .disabled(!canAnswer)
                .accessibilityIdentifier("\(idPrefix).dialog.decline")
            Button(SessionConsoleText.confirm) { onConfirm(true) }
                .keyboardShortcut(.defaultAction)
                .disabled(!canAnswer)
                .accessibilityIdentifier("\(idPrefix).dialog.answer")
        }
    }

    private func answerButton(action: @escaping () -> Void, shortcut: KeyboardShortcut) -> some View {
        Button(SessionConsoleText.answer, action: action)
            .buttonStyle(.borderedProminent)
            .keyboardShortcut(shortcut)
            .disabled(!canAnswer)
            .accessibilityIdentifier("\(idPrefix).dialog.answer")
    }

    private func description(at index: Int) -> String? {
        guard dialog.optionDescriptions.indices.contains(index) else { return nil }
        return dialog.optionDescriptions[index]
    }
}
