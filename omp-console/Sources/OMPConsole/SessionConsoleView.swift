// Section « Session OMP » de la fenêtre principale (S-9 ; S-15 de
// omp-console-redesign ; section et non plus fenêtre annexe depuis le
// 2026-10-02, pour le plein écran) : la conversation de la session hébergée,
// rendue par le fil partagé avec la visionneuse (`ConversationThread`, sur le
// fichier de session d'`omp`), et un composeur. La fenêtre porte le titre de la
// section, le nom du projet en sous-titre, l'état en pilule Liquid Glass ; les
// commandes vivent dans la barre d'outils, en groupes de verre séparés par des
// espaces fixes (S-18 R3) : le projet, UNE commande de vie de la session
// (Lancer, Relancer OU Arrêter), les options, les détails. Le dialogue d'OMP
// s'ouvre en feuille, et l'inspecteur « Détails techniques » est un formulaire
// groupé : la session, l'activité (les trames HUMANISÉES), le journal, et les
// trames brutes derrière un pli fermé (S-18 R8).
//
// CHAQUE état du host a son rendu : projet absent, `idle`, `launching`,
// `running`, dialogue en attente, `stopping`, `stopped`, `dead`, `failed`. Le
// sous-titre, la disponibilité des boutons et le texte du composeur changent avec
// lui, et aucun état n'est laissé sans texte.
//
// Aucun attribut macro SwiftUI (`@State`, `@Preview`, …) : sous les Command Line
// Tools seuls, ils échouent à la compilation (D5). Tout l'état mutable vit dans
// le modèle (`@ObservedObject`), donc la vue n'a jamais besoin de `@State`.
//
// La transcription et le dialogue viennent de `RpcPanes` : la fenêtre « Projet »
// rend EXACTEMENT les mêmes, avec `idPrefix: "projet"`.

import ConsoleCore
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
        VStack(spacing: 0) {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            composer
        }
        .frame(minWidth: 480, minHeight: 360)
        .navigationSubtitle(model.projectRoot?.lastPathComponent ?? "")
        .toolbar { toolbarContent }
        .sheet(item: pendingDialog) { dialog in dialogSheet(dialog) }
        .inspector(isPresented: $model.technicalShown) { inspector }
    }

    private var modeSelection: Binding<RpcMode> {
        Binding(get: { model.mode }, set: { model.setMode($0) })
    }

    private var projectName: String {
        model.projectRoot?.lastPathComponent ?? ""
    }

    // MARK: - Contenu par état

    @ViewBuilder private var content: some View {
        if let conversation = model.conversation {
            VStack(spacing: 0) {
                if isInterrupted {
                    Text(SessionConsoleText.interrupted)
                        .consoleBanner(tint: .red)
                        .padding(.horizontal, 20)
                        .padding(.top, 10)
                }
                ConversationThread(model: conversation)
                    .id(conversation.target.sessionFile)
            }
        } else if model.projectRoot == nil {
            ContentUnavailableView {
                Label(SessionConsoleText.noProjectTitle, systemImage: "bubble.left.and.bubble.right")
            } description: {
                Text(SessionConsoleText.noProjectBody)
            } actions: {
                Button(SessionConsoleText.chooseFolder) { model.chooseProject() }
                    .buttonStyle(.borderedProminent)
            }
        } else if case .launching = host.state {
            VStack(spacing: 10) {
                ProgressView()
                Text(SessionConsoleText.starting)
                    .foregroundStyle(.secondary)
            }
        } else if case .failed(let message) = host.state {
            ContentUnavailableView {
                Label(SessionConsoleText.failedTitle, systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                launchButton
            }
        } else {
            ContentUnavailableView {
                Label(SessionConsoleText.readyTitle, systemImage: "play.circle")
            } description: {
                Text(projectName)
            } actions: {
                launchButton
            }
        }
    }

    private var isInterrupted: Bool {
        switch host.state {
        case .dead, .failed: return true
        default: return false
        }
    }

    private var launchButton: some View {
        Button(SessionConsoleText.launch) { model.launch() }
            .buttonStyle(.borderedProminent)
            .disabled(!model.canLaunch)
    }

    // MARK: - Composeur

    private var composer: some View {
        HStack(spacing: 8) {
            TextField(
                host.state == .running ? SessionConsoleText.composerRunning : SessionConsoleText.composerIdle,
                text: $model.prompt
            )
            .textFieldStyle(.plain)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 18))
            .disabled(host.state != .running)
            .onSubmit { if model.canSendPrompt { model.sendPrompt() } }
            .accessibilityIdentifier("session.prompt")
            Button { model.sendPrompt() } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title)
            }
            .buttonStyle(.plain)
            .foregroundStyle(model.canSendPrompt ? Color.accentColor : Color.secondary)
            .disabled(!model.canSendPrompt)
            .accessibilityLabel(SessionConsoleText.send)
            .accessibilityIdentifier("session.send")
        }
        .padding(12)
    }

    // MARK: - Dialogue en feuille

    /// Le PREMIER dialogue de la file ; la feuille ne se ferme que par une réponse
    /// ou une annulation, qui le retirent de la file.
    private var pendingDialog: Binding<RpcDialogRequest?> {
        Binding(get: { host.dialogQueue.first }, set: { _ in })
    }

    private func dialogSheet(_ dialog: RpcDialogRequest) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(SessionConsoleText.dialogTitle)
                .font(.title3.bold())
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
                onAppeared: { model.dialogAppeared($0) },
                // ⌘. pendant un dialogue l'annule (S-9 de client-rpc-omp).
                cancelShortcut: KeyboardShortcut(".", modifiers: .command)
            )
        }
        .padding(20)
        .frame(width: 480)
        .interactiveDismissDisabled(true)
        .onExitCommand { model.cancelDialog() }
    }

    // MARK: - Barre d'outils (S-12, S-15, S-18 R3)

    /// L'état en pilule, puis quatre groupes : le projet | la vie de la session
    /// | les options | les détails. Les commandes sans rapport sont séparées par
    /// un espace fixe. Aucun style de bouton : le système pose son verre neutre.
    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            StatusPill(status: .of(session: host.state, hasProject: model.projectRoot != nil))
                .accessibilityIdentifier("session.status")
        }
        .sharedBackgroundVisibility(.hidden)
        ToolbarItem(placement: .primaryAction) {
            projectControl
        }
        ToolbarSpacer(.fixed, placement: .primaryAction)
        ToolbarItemGroup(placement: .primaryAction) {
            if case .launching = host.state {
                ProgressView().controlSize(.small)
            }
            lifeControl
        }
        ToolbarSpacer(.fixed, placement: .primaryAction)
        ToolbarItem(placement: .primaryAction) {
            Menu {
                Picker(SessionConsoleText.modeLabel, selection: modeSelection) {
                    ForEach(RpcMode.allCases) { mode in
                        Text(SessionConsoleText.modeTitle(mode)).tag(mode)
                    }
                }
                .pickerStyle(.inline)
            } label: {
                Label(SessionConsoleText.options, systemImage: "ellipsis.circle")
            }
            .menuIndicator(.hidden)
            .accessibilityIdentifier("session.mode")
        }
        ToolbarItem(placement: .primaryAction) {
            Button { model.technicalShown.toggle() } label: {
                Label(SessionConsoleText.details, systemImage: "info.circle")
            }
            .help(SessionConsoleText.details)
            .accessibilityIdentifier("session.details")
        }
    }

    /// Le projet, nommé : un menu qui porte son nom et propose d'en choisir un
    /// autre ; sans projet, le bouton de choix lui-même.
    @ViewBuilder private var projectControl: some View {
        if let projectRoot = model.projectRoot {
            Menu {
                Button(SessionConsoleText.chooseFolder) { model.chooseProject() }
                    .keyboardShortcut("o", modifiers: .command)
            } label: {
                Label(projectRoot.lastPathComponent, systemImage: "folder")
                    .labelStyle(.titleAndIcon)
            }
            .help(ConsoleFormat.path(projectRoot.path))
            .accessibilityIdentifier("session.project.menu")
        } else {
            Button { model.chooseProject() } label: {
                Label(SessionConsoleText.chooseFolder, systemImage: "folder")
                    .labelStyle(.titleAndIcon)
            }
            .keyboardShortcut("o", modifiers: .command)
            .accessibilityIdentifier("session.project.menu")
        }
    }

    /// UNE commande de vie : « Arrêter » tant que la session vit, « Relancer »
    /// après une interruption, sinon « Lancer » — jamais un bouton grisé à côté
    /// d'un autre.
    @ViewBuilder private var lifeControl: some View {
        if model.canStop {
            Button { model.stop() } label: {
                Label(SessionConsoleText.stop, systemImage: "stop.fill")
            }
            // ⌘. n'arrête la session que s'il n'y a PAS de dialogue en
            // attente ; pendant un dialogue il annule celui-ci (S-9), par le
            // bouton « Annuler » de la feuille. Le clic souris sur CE bouton
            // arrête la session dans les deux cas.
            .keyboardShortcut(model.hasPendingDialog ? nil : KeyboardShortcut(".", modifiers: .command))
            .accessibilityIdentifier("session.stop")
        } else if model.canRelaunch {
            Button { model.relaunch() } label: {
                Label(SessionConsoleText.relaunch, systemImage: "arrow.clockwise")
            }
            .keyboardShortcut("r", modifiers: .command)
            .accessibilityIdentifier("session.relaunch")
        } else {
            Button { model.launch() } label: {
                Label(SessionConsoleText.launch, systemImage: "play.fill")
            }
            .disabled(!model.canLaunch)
            .keyboardShortcut("r", modifiers: .command)
            .accessibilityIdentifier("session.launch")
        }
    }

    // MARK: - Inspecteur « Détails techniques » (S-18 R8)

    private var inspector: some View {
        Form {
            Section(SessionConsoleText.sectionSession) {
                LabeledContent(SessionConsoleText.fieldProject) {
                    Text(model.projectRoot.map { ConsoleFormat.path($0.path) } ?? SessionConsoleText.noProjectTitle)
                        .textSelection(.enabled)
                        .truncationMode(.middle)
                        .accessibilityIdentifier("session.project")
                }
                LabeledContent(SessionConsoleText.fieldState, value: model.stateTitle)
                LabeledContent(
                    SessionConsoleText.fieldPid,
                    value: host.pid.map { String($0) } ?? SessionConsoleText.none
                )
                LabeledContent(SessionConsoleText.fieldSessionId) {
                    Text(host.sessionId ?? SessionConsoleText.none)
                        .font(.system(.callout, design: .monospaced))
                        .textSelection(.enabled)
                        .truncationMode(.middle)
                }
                LabeledContent(SessionConsoleText.fieldMode, value: SessionConsoleText.modeTitle(model.mode))
                // Le statut ne s'affiche que s'il dit autre chose que l'état
                // (l'échec d'une commande) : jamais un doublon de « État ».
                if let notice = model.statusNotice {
                    Text(notice)
                        .font(.callout)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("session.status")
                }
                if let note = model.relaunchNote {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }

            Section(SessionConsoleText.sectionActivity) {
                let activity = model.activity
                if activity.isEmpty {
                    Text(SessionConsoleText.noActivity)
                        .foregroundStyle(.secondary)
                }
                ForEach(activity) { line in
                    ActivityRow(line: line)
                }
            }
            .accessibilityIdentifier("session.activity")

            Section(SessionConsoleText.sectionJournal) {
                if host.journal.isEmpty {
                    Text(SessionConsoleText.noJournal)
                        .foregroundStyle(.secondary)
                }
                ForEach(host.journal.reversed()) { entry in
                    Text(SessionConsoleText.journalLine(entry))
                        .font(.caption)
                        .textSelection(.enabled)
                }
            }
            .accessibilityIdentifier("session.journal")

            Section {
                DisclosureGroup(SessionConsoleText.rawFrames, isExpanded: $model.rawFramesShown) {
                    RpcTranscriptPane(idPrefix: "session", lines: host.transcript)
                        .frame(minHeight: 240)
                }
                .accessibilityIdentifier("session.rawFrames")
            }
        }
        .formStyle(.grouped)
        .inspectorColumnWidth(min: 320, ideal: 420, max: 640)
    }
}

// MARK: - Une ligne de l'activité

/// Une trame humanisée : symbole, titre court, détail d'une ligne.
private struct ActivityRow: View {
    let line: RpcEventLine

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: line.symbol)
                .foregroundStyle(.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(line.title)
                    .font(.callout)
                if !line.detail.isEmpty {
                    Text(line.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}
