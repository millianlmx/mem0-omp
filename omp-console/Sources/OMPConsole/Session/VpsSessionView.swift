// La Session OMP du VPS (S-8 de orchestrator-living-in-a-vps) : le sélecteur « Mac | VPS »
// de la section, puis la conversation de la session hébergée sur le VPS, rendue par le fil
// partagé (`ConversationThread`), avec un composeur, un dialogue en feuille et le choix du
// modèle. Chaque état de S-8 a son rendu : non appairé, injoignable (saisie désactivée), aucune
// session (« Lancer… »), lancement, tour en cours, arrêt, session arrêtée ou interrompue.
//
// Aucun attribut macro SwiftUI : tout l'état vit dans les modèles.

import ConsoleCore
import SwiftUI

/// Le sélecteur « Mac | VPS » des écrans mono-machine : il n'apparaît que lorsqu'un VPS est
/// configuré ; le défaut est le Mac.
struct MachinePicker: View {
    @ObservedObject var hub: MachineHub

    var body: some View {
        if hub.vpsConfigured {
            Picker(
                ReposText.machinePickerLabel,
                selection: Binding(get: { hub.activeMachine }, set: { hub.select($0) })
            ) {
                ForEach(RepoMachine.allCases, id: \.self) { machine in
                    Text(machine.label).tag(machine)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(maxWidth: 220)
            .padding(.vertical, 8)
            .accessibilityLabel(ReposText.machinePickerLabel)
            .accessibilityIdentifier("machine.picker")
        }
    }
}

/// La section « Session OMP » : le Mac par défaut, le VPS quand le sélecteur le dit.
struct SessionMachineView: View {
    @ObservedObject var model: SessionConsoleModel
    @ObservedObject var hub: MachineHub

    var body: some View {
        VStack(spacing: 0) {
            MachinePicker(hub: hub)
            if hub.activeMachine == .vps {
                VpsSessionView(model: hub.session)
            } else {
                SessionConsoleView(model: model)
            }
        }
    }
}

struct VpsSessionView: View {
    @ObservedObject var model: VpsSessionModel

    var body: some View {
        VStack(spacing: 0) {
            if let error = model.error {
                Text(verbatim: error)
                    .consoleBanner(tint: .red)
                    .padding(.horizontal, 20)
                    .padding(.top, 10)
                    .accessibilityIdentifier("vps.session.error")
            }
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            composer
        }
        .frame(minWidth: 480, minHeight: 360)
        .navigationSubtitle(model.projectName ?? "")
        .toolbar { toolbarContent }
        .sheet(item: pendingDialog) { dialog in dialogSheet(dialog) }
        .onAppear { model.appeared() }
    }

    // MARK: - Contenu par état

    @ViewBuilder private var content: some View {
        switch model.surface {
        case .notPaired:
            message(ReposText.sessionNotPaired, systemImage: "link.badge.plus")
        case .unreachable:
            VStack(spacing: 0) {
                Text(verbatim: ReposText.sessionUnreachable)
                    .consoleBanner(tint: .orange)
                    .padding(.horizontal, 20)
                    .padding(.top, 10)
                    .accessibilityIdentifier("vps.session.unreachable")
                conversation
            }
        case .loading:
            progress(ReposText.sessionLoading)
        case .empty:
            ContentUnavailableView {
                Label(ReposText.sessionNone, systemImage: "bubble.left.and.bubble.right")
            } actions: {
                launchMenu
            }
        case .launching:
            progress(ReposText.sessionStarting)
        case .stopping:
            progress(ReposText.sessionStopping)
        case .live:
            conversation
        case .stopped:
            VStack(spacing: 0) {
                Text(verbatim: ReposText.sessionStopped).consoleBanner(tint: .secondary).padding(10)
                conversation
            }
        case .dead:
            VStack(spacing: 0) {
                Text(verbatim: ReposText.sessionDead).consoleBanner(tint: .red).padding(10)
                conversation
            }
        case .failed(let reason):
            ContentUnavailableView {
                Label(SessionConsoleText.failedTitle, systemImage: "exclamationmark.triangle")
            } description: {
                Text(verbatim: reason)
            } actions: {
                launchMenu
            }
        }
    }

    @ViewBuilder private var conversation: some View {
        if let conversation = model.conversation {
            ConversationThread(model: conversation, sessionEnded: model.surface == .stopped || model.surface == .dead)
                .id(conversation.target.sessionFile)
        } else {
            Spacer()
        }
    }

    private func message(_ text: String, systemImage: String) -> some View {
        ContentUnavailableView(text, systemImage: systemImage)
    }

    private func progress(_ text: String) -> some View {
        VStack(spacing: 10) {
            ProgressView()
            Text(verbatim: text).foregroundStyle(.secondary)
        }
    }

    /// « Lancer… » : les dépôts du VPS, un par entrée du menu.
    private var launchMenu: some View {
        Menu(ReposText.sessionLaunch) {
            if model.repos.isEmpty {
                Text(verbatim: ReposText.sessionNoRepos)
            }
            ForEach(model.repos, id: \.repoKey) { row in
                Button(row.name) { Task { _ = await model.launch(repoKey: row.repoKey) } }
            }
        }
        .menuStyle(.borderedButton)
        .disabled(!model.canLaunch)
        .onAppear { Task { await model.loadRepos() } }
        .accessibilityIdentifier("vps.session.launch")
    }

    // MARK: - Composeur

    private var composer: some View {
        HStack(spacing: 8) {
            modelMenu
            TextField(ReposText.sessionPromptPlaceholder, text: $model.prompt)
                .textFieldStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 18))
                .disabled(model.surface != .live)
                .onSubmit { Task { await model.sendPrompt() } }
                .accessibilityIdentifier("vps.session.prompt")
            if model.turnRunning {
                ProgressView().controlSize(.small)
                    .help(ReposText.sessionTurnRunning)
            }
            Button { Task { await model.sendPrompt() } } label: {
                Image(systemName: "arrow.up.circle.fill").font(.title)
            }
            .buttonStyle(.plain)
            .foregroundStyle(model.canSendPrompt ? Color.accentColor : Color.secondary)
            .disabled(!model.canSendPrompt)
            .accessibilityLabel(ReposText.sessionSend)
            .accessibilityIdentifier("vps.session.send")
        }
        .padding(12)
    }

    private var modelMenu: some View {
        Menu(model.modelLabel) {
            ForEach(model.modelCatalog, id: \.self) { selector in
                Button(selector) { Task { await model.applyModel(selector) } }
            }
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(!model.canChangeModel)
        .onAppear { Task { await model.loadModels() } }
        .accessibilityIdentifier("vps.session.model")
    }

    // MARK: - Dialogue en feuille

    private var pendingDialog: Binding<RpcDialogRequest?> {
        Binding(get: { model.pendingDialog }, set: { _ in })
    }

    private func dialogSheet(_ dialog: RpcDialogRequest) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(SessionConsoleText.dialogTitle).font(.title3.bold())
            RpcDialogPane(
                idPrefix: "vps.session",
                dialog: dialog,
                dialogText: $model.dialogText,
                selectedOptionIndex: $model.selectedOptionIndex,
                canAnswer: model.canAnswerDialog,
                onAnswerSelected: { Task { await model.answerSelectedOption() } },
                onAnswerText: { Task { await model.answerDialogText() } },
                onConfirm: { confirmed in Task { await model.confirmDialog(confirmed) } },
                onCancel: { Task { await model.cancelDialog() } },
                onAppeared: { model.dialogAppeared($0) },
                cancelShortcut: KeyboardShortcut(".", modifiers: .command)
            )
        }
        .padding(20)
        .frame(width: 480)
        .interactiveDismissDisabled(true)
    }

    // MARK: - Barre d'outils

    /// UNE commande de vie : « Arrêter » tant que la session vit, « Relancer » après une
    /// interruption. Le lancement passe par le menu « Lancer… » de l'état vide.
    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            if model.canStop {
                Button { Task { await model.stop() } } label: {
                    Label(ReposText.sessionStop, systemImage: "stop.fill")
                }
                .accessibilityIdentifier("vps.session.stop")
            } else if model.canRelaunch {
                Button { Task { await model.relaunch() } } label: {
                    Label(ReposText.sessionRelaunch, systemImage: "arrow.clockwise")
                }
                .accessibilityIdentifier("vps.session.relaunch")
            }
        }
    }
}
