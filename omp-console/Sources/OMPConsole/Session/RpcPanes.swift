// Les trois volets RPC partagés par la fenêtre « Session OMP » et la fenêtre
// « Projet » (S-4, BR-3) : transcription, dialogue en attente, barre de prompt.
//
// Ils sont paramétrés par un `idPrefix` (`"session"` / `"projet"`) et par des
// `Binding`/callbacks : AUCUNE seconde implémentation du dialogue n'existe, et
// les règles de gating vivent dans les modèles, pas ici.

import SwiftUI

/// La transcription brute, défilante sur la dernière ligne.
struct RpcTranscriptPane: View {
    let idPrefix: String
    let lines: [TranscriptLine]
    var emptyText: String = "Aucun événement pour l'instant."

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

    private var optionSelection: Binding<Int?> {
        Binding(get: { selectedOptionIndex }, set: { selectedOptionIndex = $0 })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Dialogue en attente")
                .font(.headline)
            Text(dialog.title)
                .font(.system(.callout, design: .monospaced))
                .accessibilityIdentifier("\(idPrefix).dialog.title")
            if let message = dialog.message {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            switch dialog.method {
            case .select:
                if dialog.options.isEmpty {
                    Text("Aucune option proposée.")
                        .foregroundStyle(.secondary)
                } else {
                    List(selection: optionSelection) {
                        ForEach(Array(dialog.options.enumerated()), id: \.offset) { index, option in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(option)
                                if let description = description(at: index) {
                                    Text(description)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .tag(index)
                        }
                    }
                    .frame(height: 120)
                    .accessibilityIdentifier("\(idPrefix).dialog.options")
                }
                Button("Répondre") { onAnswerSelected() }
                    .disabled(!canAnswer)
                    .accessibilityIdentifier("\(idPrefix).dialog.answer")

            case .confirm:
                HStack(spacing: 8) {
                    Button("Confirmer") { onConfirm(true) }
                        .disabled(!canAnswer)
                        .accessibilityIdentifier("\(idPrefix).dialog.answer")
                    Button("Refuser") { onConfirm(false) }
                        .disabled(!canAnswer)
                }

            case .input:
                TextField(dialog.placeholder ?? "", text: $dialogText)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { onAnswerText() }
                Button("Répondre") { onAnswerText() }
                    .disabled(!canAnswer)
                    .accessibilityIdentifier("\(idPrefix).dialog.answer")

            case .editor:
                TextEditor(text: $dialogText)
                    .font(.system(.body, design: .monospaced))
                    .frame(height: 100)
                Button("Répondre") { onAnswerText() }
                    .disabled(!canAnswer)
                    .accessibilityIdentifier("\(idPrefix).dialog.answer")
            }

            Button("Annuler ce dialogue") { onCancel() }
                .keyboardShortcut(.escape, modifiers: [])
                .accessibilityIdentifier("\(idPrefix).dialog.cancel")
        }
        .onAppear { onAppeared(dialog) }
        .onChange(of: dialog.id) { _, _ in onAppeared(dialog) }
    }

    private func description(at index: Int) -> String? {
        guard dialog.optionDescriptions.indices.contains(index) else { return nil }
        return dialog.optionDescriptions[index]
    }
}

/// La barre de saisie libre. La règle de disponibilité vient du modèle : ici, on
/// n'affiche qu'un état et on remonte le geste.
struct RpcPromptBar: View {
    let idPrefix: String
    @Binding var prompt: String
    let placeholder: String
    let isEditable: Bool
    let canSend: Bool
    let blockedByDialog: Bool
    let blockedNote: String
    let onSend: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                TextField(placeholder, text: $prompt)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { onSend() }
                    .disabled(!isEditable || blockedByDialog)
                    .accessibilityIdentifier("\(idPrefix).prompt")
                Button("Envoyer") { onSend() }
                    .disabled(!canSend)
                    .keyboardShortcut(.return, modifiers: .command)
                    .accessibilityIdentifier("\(idPrefix).send")
            }
            if blockedByDialog {
                Text(blockedNote)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
