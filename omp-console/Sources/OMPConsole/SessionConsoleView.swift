// Fenêtre « Session OMP » (S-9, BR-4) : en-tête, transcription, journal, dialogue,
// barre de prompt.
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
// La transcription, le dialogue et la barre de prompt viennent de `RpcPanes` :
// la fenêtre « Projet » rend EXACTEMENT les mêmes, avec `idPrefix: "projet"`.

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
            RpcTranscriptPane(idPrefix: "session", lines: host.transcript)
            JournalPane(entries: host.journal, expanded: $model.journalExpanded)
            if let dialog = host.dialogQueue.first {
                Divider()
                RpcDialogPane(
                    idPrefix: "session",
                    dialog: dialog,
                    dialogText: $model.dialogText,
                    selectedOptionIndex: $model.selectedOptionIndex,
                    canAnswer: model.canAnswerDialog,
                    onAnswerSelected: { model.answerSelectedOption() },
                    onAnswerText: { model.answerDialogText() },
                    onConfirm: { model.confirmDialog($0) },
                    onCancel: { model.cancelDialog() },
                    onAppeared: { model.dialogAppeared($0) }
                )
            }
            Divider()
            RpcPromptBar(
                idPrefix: "session",
                prompt: $model.prompt,
                placeholder: promptPlaceholder,
                isEditable: host.state == .running,
                canSend: model.canSendPrompt,
                blockedByDialog: !host.dialogQueue.isEmpty,
                blockedNote: "Répondez au dialogue en cours pour débloquer le tour.",
                onSend: { model.sendPrompt() }
            )
        }
        .padding(12)
        .frame(minWidth: 720, minHeight: 520)
    }

    private var promptPlaceholder: String {
        host.state != .running ? "Lancez une session pour saisir un prompt." : "Saisissez un prompt puis ↩."
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
