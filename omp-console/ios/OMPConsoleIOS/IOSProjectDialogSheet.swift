// La feuille d'escalade de projet, les QUATRE formes (S-4, S-5, BR-5) : le
// compteur « Question n sur m », la question, le corps Markdown de la revue du
// plan, puis la forme de réponse (`select`, `confirm`, `input`, `editor`
// prérempli). Le titre « OMP vous demande » n'est QUE celui de la barre.
//
// Rendu en formulaire groupé natif (ios-listes-groupees-natives, S-7) : le
// compteur est l'en-tête natif de la section de la question, chaque option et
// chaque bouton est une rangée (un geste par rangée).
//
// L'app ne retire jamais l'escalade de sa file : la file est celle que la coque
// pousse (`sheet(item:)` remplace la feuille quand l'item change — Doc-1).

import ConsoleClient
import ConsoleCore
import SwiftUI

struct IOSProjectDialogSheet: View {
    let dialog: RpcDialogRequest
    /// Rend `nil` sur succès, sinon le message d'échec à afficher DANS la feuille.
    let onAnswer: (RemoteDialogAnswerRequest) async -> String?

    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @State private var selectedIndex: Int?
    @State private var error: String?
    @State private var submitting = false

    init(dialog: RpcDialogRequest, onAnswer: @escaping (RemoteDialogAnswerRequest) async -> String?) {
        self.dialog = dialog
        self.onAnswer = onAnswer
        _text = State(initialValue: IOSDialogGating.initialText(dialog: dialog))
    }

    private var canAnswer: Bool {
        IOSDialogGating.canAnswer(dialog: dialog, text: text, selectedIndex: selectedIndex)
    }

    var body: some View {
        let parts = ProjectDialogText.split(dialog.title)
        let step = ProjectDialogText.step(parts.heading)
        NavigationStack {
            Form {
                if let counter = step.counter {
                    Section {
                        questionRows(step.question, body: parts.body)
                    } header: {
                        Text(counter)
                            .textCase(nil)
                            .accessibilityIdentifier(ProjectAccessibility.dialogCounter)
                    }
                } else {
                    Section {
                        questionRows(step.question, body: parts.body)
                    }
                }
                Section {
                    form
                }
                if let error {
                    Section {
                        Text(error)
                            .font(.callout)
                            .iosBanner(tone: .danger)
                            .iosBareListRow()
                            .accessibilityIdentifier(ProjectAccessibility.dialogError)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(SessionConsoleText.dialogTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    IOSSheetIconButton(role: .cancel, label: ProjectViewText.dialogCancel, action: cancelSent)
                        .keyboardShortcut(.cancelAction)
                        .disabled(submitting)
                        .accessibilityIdentifier(ProjectAccessibility.dialogCancel)
                }
                if dialog.method != .confirm {
                    ToolbarItem(placement: .confirmationAction) {
                        IOSSheetIconButton(role: .confirm, label: SessionConsoleText.answer, action: answerSent)
                            .keyboardShortcut(.defaultAction)
                            .disabled(!canAnswer || submitting)
                            .accessibilityIdentifier(ProjectAccessibility.dialogAnswer)
                    }
                }
            }
            .accessibilityIdentifier(ProjectAccessibility.dialogSheet)
            .interactiveDismissDisabled(true)
        }
    }

    /// La question, puis le corps Markdown de la revue du plan quand il y en a un.
    @ViewBuilder private func questionRows(_ question: String, body: String?) -> some View {
        Text(question)
            .font(.headline)
            .accessibilityIdentifier(ProjectAccessibility.dialogQuestion)
        if let body {
            IOSMarkdownView(blocks: MarkdownDocument.blocks(body))
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier(ProjectAccessibility.dialogBody)
        }
    }

    @ViewBuilder private var form: some View {
        switch dialog.method {
        case .select:
            selectForm
        case .confirm:
            confirmForm
        case .input:
            TextField(dialog.placeholder ?? "", text: $text)
                .accessibilityIdentifier(ProjectAccessibility.dialogInput)
        case .editor:
            TextEditor(text: $text)
                .frame(minHeight: 240)
                .accessibilityIdentifier(ProjectAccessibility.dialogInput)
        }
    }

    /// Une rangée par option : son libellé, sa description, et la coche de l'option choisie.
    @ViewBuilder private var selectForm: some View {
        if dialog.options.isEmpty {
            Text(SessionConsoleText.noOption)
                .foregroundStyle(.secondary)
        } else {
            ForEach(Array(dialog.options.enumerated()), id: \.offset) { index, option in
                Button { selectedIndex = index } label: {
                    HStack(alignment: .top, spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(SessionConsoleText.optionLabel(option))
                                .foregroundStyle(.primary)
                                .multilineTextAlignment(.leading)
                            if dialog.optionDescriptions.indices.contains(index),
                               let description = dialog.optionDescriptions[index], !description.isEmpty {
                                Text(description)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .multilineTextAlignment(.leading)
                            }
                        }
                        Spacer(minLength: 8)
                        if selectedIndex == index {
                            Text(ProjectText.selectedMark)
                        }
                    }
                }
                .accessibilityAddTraits(selectedIndex == index ? .isSelected : [])
                .accessibilityIdentifier(ProjectAccessibility.option(index))
            }
        }
    }

    /// Deux rangées : « Refuser » puis « Confirmer ».
    @ViewBuilder private var confirmForm: some View {
        Button(SessionConsoleText.decline) { confirm(false) }
            .disabled(submitting)
            .accessibilityIdentifier(ProjectAccessibility.dialogDecline)
        Button(SessionConsoleText.confirm) { confirm(true) }
            .disabled(submitting)
            .accessibilityIdentifier(ProjectAccessibility.dialogConfirm)
    }

    private func answerSent() {
        guard let request = IOSDialogGating.request(dialog: dialog, selectedIndex: selectedIndex, text: text) else { return }
        send(request)
    }

    private func confirm(_ value: Bool) {
        send(IOSDialogGating.confirmation(value))
    }

    private func cancelSent() {
        send(IOSDialogGating.cancellation())
    }

    private func send(_ request: RemoteDialogAnswerRequest) {
        guard !submitting else { return }
        submitting = true
        Task {
            let message = await onAnswer(request)
            submitting = false
            if let message {
                error = message
            } else {
                dismiss()
            }
        }
    }
}
