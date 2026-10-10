// La feuille d'escalade de projet, les QUATRE formes (S-4, S-5, BR-5) : l'en-tête
// « OMP vous demande », le compteur « Question n sur m », la question, le corps
// Markdown de la revue du plan, puis la forme de réponse (`select`, `confirm`,
// `input`, `editor` prérempli).
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
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(SessionConsoleText.dialogTitle)
                            .font(.title3.bold())
                        if let counter = step.counter {
                            Text(counter)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .accessibilityIdentifier(ProjectAccessibility.dialogCounter)
                        }
                    }
                    Text(step.question)
                        .font(.headline)
                        .accessibilityIdentifier(ProjectAccessibility.dialogQuestion)
                    if let body = parts.body {
                        IOSMarkdownView(blocks: MarkdownDocument.blocks(body))
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 8))
                            .accessibilityIdentifier(ProjectAccessibility.dialogBody)
                    }
                    form
                    if let error {
                        Text(error)
                            .font(.callout)
                            .iosBanner(tone: .danger)
                            .accessibilityIdentifier(ProjectAccessibility.dialogError)
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
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

    @ViewBuilder private var form: some View {
        switch dialog.method {
        case .select:
            selectForm
        case .confirm:
            confirmForm
        case .input:
            TextField(dialog.placeholder ?? "", text: $text)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier(ProjectAccessibility.dialogInput)
        case .editor:
            TextEditor(text: $text)
                .frame(minHeight: 240)
                .accessibilityIdentifier(ProjectAccessibility.dialogInput)
        }
    }

    private var selectForm: some View {
        VStack(alignment: .leading, spacing: 6) {
            if dialog.options.isEmpty {
                Text(SessionConsoleText.noOption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(dialog.options.enumerated()), id: \.offset) { index, option in
                    Button { selectedIndex = index } label: {
                        HStack(alignment: .top, spacing: 8) {
                            Text(SessionConsoleText.optionLabel(option))
                                .multilineTextAlignment(.leading)
                            Spacer(minLength: 8)
                            if selectedIndex == index {
                                Text(ProjectText.selectedMark)
                            }
                        }
                    }
                    .accessibilityAddTraits(selectedIndex == index ? .isSelected : [])
                    .accessibilityIdentifier(ProjectAccessibility.option(index))
                    if dialog.optionDescriptions.indices.contains(index),
                       let description = dialog.optionDescriptions[index], !description.isEmpty {
                        Text(description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private var confirmForm: some View {
        HStack(spacing: 12) {
            Button(SessionConsoleText.decline) { confirm(false) }
                .disabled(submitting)
                .accessibilityIdentifier(ProjectAccessibility.dialogDecline)
            Button(SessionConsoleText.confirm) { confirm(true) }
                .disabled(submitting)
                .accessibilityIdentifier(ProjectAccessibility.dialogConfirm)
        }
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
