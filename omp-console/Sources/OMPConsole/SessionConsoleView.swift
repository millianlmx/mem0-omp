// Fenêtre « Session OMP » (S-9, BR-4) : cinq zones — en-tête, transcription,
// journal, dialogue, barre de prompt.
//
// CHAQUE état du host a son rendu : project absent, `idle`, `launching`, `running`,
// dialogue en attente, `stopping`, `stopped`, `dead`, `failed`. Le statut, la
// disponibilité des boutons et le placeholder du champ changent avec lui, et
// aucun état n'est laissé sans texte.
//
// Aucun attribut macro SwiftUI (`@State`, `@Preview`, …) : sous les Command Line
// Tools seuls, ils échouent à la compilation (D5). Tout l'état mutable vit dans
// le modèle (`@ObservedObject`), donc la vue n'a jamais besoin de `@State`.
//
// Aucun design system dans ce dépôt : on réutilise les composants système déjà
// employés par la coque — `Label(systemImage:)`, la police monospacée des
// transcriptions, `.textSelection(.enabled)` et `PlaceholderPane` pour les états
// vides (`ConsoleRootView.swift`, `SectionViews.swift`).

import SwiftUI

struct SessionConsoleView: View {
    @ObservedObject var model: SessionConsoleModel
    // Le host est observé séparément du modèle : sa transcription, son journal et
    // sa file de dialogues changent sans que le modèle publie quoi que ce soit.
    @ObservedObject var host: SessionHost

    init(model: SessionConsoleModel) {
        self.model = model
        self.host = model.host
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SessionHeaderView(model: model, host: host)
            Divider()
            TranscriptPane(lines: host.transcript)
            JournalPane(entries: host.journal, expanded: $model.journalExpanded)
            if let dialog = host.dialogQueue.first {
                Divider()
                DialogPane(model: model, dialog: dialog)
            }
            Divider()
            PromptBar(model: model, host: host)
        }
        .padding(12)
        .frame(minWidth: 720, minHeight: 520)
    }
}

// MARK: - En-tête : projet, mode, actions, statut

struct SessionHeaderView: View {
    @ObservedObject var model: SessionConsoleModel
    @ObservedObject var host: SessionHost

    private var modeSelection: Binding<RpcMode> {
        Binding(get: { model.mode }, set: { model.setMode($0) })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(model.projectRoot?.path ?? "Aucun projet ouvert : choisissez un dossier pour lancer une session.")
                    .font(.system(.callout, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .accessibilityIdentifier("session.project")
                Spacer(minLength: 8)
                Button("Choisir un dossier…") { model.chooseProject() }
                    .keyboardShortcut("o", modifiers: .command)
                    .help("Choisissez un dossier…")
            }

            Picker("Mode", selection: modeSelection) {
                ForEach(RpcMode.allCases) { mode in
                    Text(mode.title).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .accessibilityIdentifier("session.mode")

            HStack(spacing: 8) {
                Button("Lancer la session") { model.launch() }
                    .disabled(!model.canLaunch)
                    .keyboardShortcut(model.canRelaunch ? nil : KeyboardShortcut("r", modifiers: .command))
                    .accessibilityIdentifier("session.launch")
                Button("Relancer") { model.relaunch() }
                    .disabled(!model.canRelaunch)
                    .keyboardShortcut(model.canRelaunch ? KeyboardShortcut("r", modifiers: .command) : nil)
                    .accessibilityIdentifier("session.relaunch")
                if model.canStop {
                    Button("Arrêter la session") { model.stop() }
                        // ⌘. n'arrête la session que s'il n'y a PAS de dialogue en
                        // attente ; pendant un dialogue il annule celui-ci (S-9),
                        // par le bouton « Annuler le dialogue » ci-dessous. Le clic
                        // souris sur CE bouton arrête la session dans les deux cas.
                        .keyboardShortcut(model.hasPendingDialog ? nil : KeyboardShortcut(".", modifiers: .command))
                        .accessibilityIdentifier("session.stop")
                }
                if model.hasPendingDialog {
                    Button("Annuler le dialogue") { model.performStopShortcut() }
                        .keyboardShortcut(".", modifiers: .command)
                        .accessibilityIdentifier("session.dialog.cancelShortcut")
                }
                if case .launching = host.state {
                    ProgressView().controlSize(.small)
                }
                Spacer(minLength: 0)
            }

            Text(model.statusMessage)
                .font(.system(.callout, design: .monospaced))
                .accessibilityIdentifier("session.status")
            if let note = model.relaunchNote {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: - Transcription brute

struct TranscriptPane: View {
    let lines: [TranscriptLine]

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if lines.isEmpty {
                        Text("Aucun événement pour l'instant.")
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
            .accessibilityIdentifier("session.transcript")
            // Défilement automatique sur la dernière ligne : `ScrollViewReader` +
            // `onChange(of:)` est le motif compilé en D5.
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

// MARK: - Journal repliable

struct JournalPane: View {
    let entries: [JournalEntry]
    @Binding var expanded: Bool

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if entries.isEmpty {
                        Text("Aucune entrée de journal.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(entries) { entry in
                        Text("[\(entry.kind.rawValue)] \(entry.message)")
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(6)
            }
            .frame(height: 100)
        } label: {
            Text("Journal")
        }
        .accessibilityIdentifier("session.journal")
    }
}

// MARK: - Dialogue en attente

struct DialogPane: View {
    @ObservedObject var model: SessionConsoleModel
    let dialog: RpcDialogRequest

    private var optionSelection: Binding<Int?> {
        Binding(get: { model.selectedOptionIndex }, set: { model.selectedOptionIndex = $0 })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Dialogue en attente")
                .font(.headline)
            Text(dialog.title)
                .font(.system(.callout, design: .monospaced))
                .accessibilityIdentifier("session.dialog.title")
            if let message = dialog.message {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            switch dialog.method {
            case .select:
                if dialog.options.isEmpty {
                    // `select` sans option : le dialogue est affiché, mais
                    // « Répondre » reste inactif (S-6).
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
                    .accessibilityIdentifier("session.dialog.options")
                }
                Button("Répondre") { model.answerSelectedOption() }
                    .disabled(!model.canAnswerDialog)
                    .accessibilityIdentifier("session.dialog.answer")

            case .confirm:
                HStack(spacing: 8) {
                    Button("Confirmer") { model.confirmDialog(true) }
                        .disabled(!model.canAnswerDialog)
                        .accessibilityIdentifier("session.dialog.answer")
                    Button("Refuser") { model.confirmDialog(false) }
                        .disabled(!model.canAnswerDialog)
                }

            case .input:
                TextField(dialog.placeholder ?? "", text: $model.dialogText)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { model.answerDialogText() }
                Button("Répondre") { model.answerDialogText() }
                    .disabled(!model.canAnswerDialog)
                    .accessibilityIdentifier("session.dialog.answer")

            case .editor:
                TextEditor(text: $model.dialogText)
                    .font(.system(.body, design: .monospaced))
                    .frame(height: 100)
                Button("Répondre") { model.answerDialogText() }
                    .disabled(!model.canAnswerDialog)
                    .accessibilityIdentifier("session.dialog.answer")
            }

            Button("Annuler ce dialogue") { model.cancelDialog() }
                .keyboardShortcut(.escape, modifiers: [])
                .accessibilityIdentifier("session.dialog.cancel")
        }
        .onAppear { model.dialogAppeared(dialog) }
        .onChange(of: dialog.id) { _, _ in model.dialogAppeared(dialog) }
    }

    private func description(at index: Int) -> String? {
        guard dialog.optionDescriptions.indices.contains(index) else { return nil }
        return dialog.optionDescriptions[index]
    }
}

// MARK: - Barre de prompt

struct PromptBar: View {
    @ObservedObject var model: SessionConsoleModel
    @ObservedObject var host: SessionHost

    private var placeholder: String {
        if host.state != .running { return "Lancez une session pour saisir un prompt." }
        return "Saisissez un prompt puis ↩."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                TextField(placeholder, text: $model.prompt)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { model.sendPrompt() }
                    .disabled(host.state != .running || !host.dialogQueue.isEmpty)
                    .accessibilityIdentifier("session.prompt")
                Button("Envoyer") { model.sendPrompt() }
                    .disabled(!model.canSendPrompt)
                    .keyboardShortcut(.return, modifiers: .command)
                    .accessibilityIdentifier("session.send")
            }
            if !host.dialogQueue.isEmpty {
                Text("Répondez au dialogue en cours pour débloquer le tour.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
