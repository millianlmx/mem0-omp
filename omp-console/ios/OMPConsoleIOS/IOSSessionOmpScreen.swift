// L'écran « Session OMP » de l'app iOS (BR-4) : piloter l'UNIQUE session
// hébergée du Mac — la même que la section « Session OMP » de la coque macOS.
//
// Un seul écran, quatre zones : en-tête (dépôt + pastille d'état), bandeau d'état,
// fil réutilisé `IOSSessionThreadView`, composeur et actions. Chaque état est
// couvert (dégradé, chargement, vide, lancement, arrêt, vivant, arrêtée,
// interrompue, échec) ; aucun `onTapGesture`, uniquement des contrôles système.
//
// Aucun littéral alphabétique (les mots viennent de `IOSSessionOmpText`,
// `SessionConsoleText`, `ProjectViewText` ou `ConnectionText`) ; la feuille de
// dialogue est `IOSProjectDialogSheet`, RÉUTILISÉE verbatim.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct IOSSessionOmpScreen: View {
    @ObservedObject var client: ConsoleClientModel
    @StateObject private var model: IOSSessionOmpModel

    @State private var showingLaunch = false
    @State private var showingStop = false
    @State private var draft = ""
    @FocusState private var composerFocused: Bool

    init(client: ConsoleClientModel) {
        self.client = client
        _model = StateObject(wrappedValue: IOSSessionOmpModel(client: client))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let error = model.error {
                Text(error)
                    .font(.callout)
                    .iosBanner(tone: .danger)
                    .accessibilityIdentifier(SessionOmpAccessibility.banner)
            }
            switch model.surface {
            case .degraded(let message):
                Text(message)
                    .font(.callout)
                    .iosBanner(tone: .attention)
                    .accessibilityIdentifier(SessionOmpAccessibility.banner)
            case .loading:
                HStack(spacing: 8) {
                    ProgressView()
                }
                .accessibilityIdentifier(SessionOmpAccessibility.loading)
            case .empty:
                emptyState
                actions
            case .launching:
                header
                startingState(ProjectViewText.sessionStarting, id: SessionOmpAccessibility.launching)
            case .stopping:
                header
                startingState(ProjectViewText.sessionClosing, id: SessionOmpAccessibility.stopping)
            case .live:
                sessionBody
                actions
            case .stopped:
                header
                Text(SessionConsoleText.Status.stopped)
                    .font(.callout)
                    .iosBanner(tone: .neutral)
                    .accessibilityIdentifier(SessionOmpAccessibility.banner)
                sessionBody
                actions
            case .dead:
                header
                Text(SessionConsoleText.interrupted)
                    .font(.callout)
                    .iosBanner(tone: .attention)
                    .accessibilityIdentifier(SessionOmpAccessibility.banner)
                sessionBody
                actions
            case .failed(let message):
                header
                Text(message)
                    .font(.callout)
                    .iosBanner(tone: .danger)
                    .accessibilityIdentifier(SessionOmpAccessibility.banner)
                actions
            }
        }
        .iosPanel()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .navigationTitle(ConsoleSection.session.title)
        .onAppear { model.appeared() }
        .onDisappear { model.disappeared() }
        .onChange(of: client.state) {
            if case .connected = client.state { model.refresh() }
        }
        .onChange(of: client.hosted) { model.syncThread() }
        .sheet(isPresented: $showingLaunch) {
            IOSSessionOmpLaunchSheet(client: client) { repoKey in
                await model.launch(repoKey: repoKey)
            }
        }
        .sheet(item: pendingDialogBinding) { dialog in
            IOSProjectDialogSheet(dialog: dialog) { request in
                await model.answer(request)
            }
        }
        .confirmationDialog(
            IOSSessionOmpText.stopConfirmTitle,
            isPresented: $showingStop,
            titleVisibility: .visible
        ) {
            Button(SessionConsoleText.stop, role: .destructive) {
                Task { await model.stop() }
            }
            Button(SessionConsoleText.cancel, role: .cancel) {}
        } message: {
            Text(IOSSessionOmpText.stopConfirmMessage)
        }
        .accessibilityIdentifier(SessionOmpAccessibility.screen)
    }

    // MARK: - États

    private var header: some View {
        HStack(spacing: 8) {
            Text(client.hosted?.projectName ?? SessionConsoleText.Status.idleNoProject)
                .font(.headline)
            Spacer(minLength: 8)
            if let label = client.hosted?.stateLabel {
                IOSStatusChip(status: ConsoleStatus(text: label, tone: statusTone))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .iosCard()
        .accessibilityIdentifier(SessionOmpAccessibility.header)
    }

    private var statusTone: ConsoleTone {
        switch HostedSessionWire(rawValue: client.hosted?.state ?? "") ?? .idle {
        case .running: return .success
        case .launching, .stopping: return .attention
        case .dead, .failed: return .danger
        case .idle, .stopped: return .neutral
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(client.hosted?.projectName == nil ? SessionConsoleText.noProjectTitle : SessionConsoleText.readyTitle)
                .font(.headline)
            Text(IOSSessionOmpText.emptyHelp)
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .iosCard()
        .accessibilityIdentifier(SessionOmpAccessibility.emptyCard)
    }

    private func startingState(_ text: String, id: String) -> some View {
        HStack(spacing: 8) {
            ProgressView()
            Text(text)
                .font(.callout)
        }
        .accessibilityIdentifier(id)
    }

    @ViewBuilder private var sessionBody: some View {
        if let thread = model.thread {
            IOSSessionThreadView(model: thread)
                .accessibilityIdentifier(SessionOmpAccessibility.thread)
        }
        composer
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                TextField(IOSSessionOmpModel.composerHint(state: client.hosted?.state, dialogs: dialogs), text: $draft)
                    .textFieldStyle(.roundedBorder)
                    .focused($composerFocused)
                    .onSubmit { submit() }
                    .accessibilityIdentifier(SessionOmpAccessibility.composer)
                Button(SessionConsoleText.send, action: submit)
                    .buttonStyle(.borderedProminent)
                    .disabled(!canSend)
                    .accessibilityIdentifier(SessionOmpAccessibility.send)
            }
            Text(IOSSessionOmpModel.composerHint(state: client.hosted?.state, dialogs: dialogs))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var actions: some View {
        HStack(spacing: 12) {
            if model.canLaunch {
                Button(SessionConsoleText.launch) { showingLaunch = true }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier(SessionOmpAccessibility.launch)
            }
            if model.canRelaunch {
                Button(SessionConsoleText.relaunch) {
                    Task { await model.relaunch() }
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier(SessionOmpAccessibility.relaunch)
            }
            if model.canStop {
                Button(SessionConsoleText.stop) { showingStop = true }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier(SessionOmpAccessibility.stop)
            }
        }
    }

    // MARK: - Faits dérivés

    private var dialogs: [RpcDialogRequest] { client.hosted?.dialogs ?? [] }

    private var canSend: Bool {
        IOSSessionOmpModel.canSendPrompt(state: client.hosted?.state, dialogs: dialogs, text: draft)
    }

    private var pendingDialogBinding: Binding<RpcDialogRequest?> {
        Binding(get: { dialogs.first }, set: { _ in })
    }

    private func submit() {
        guard canSend, !model.isSubmitting else { return }
        let text = draft
        model.isSubmitting = true
        Task {
            let sent = await model.sendPrompt(text)
            model.isSubmitting = false
            if sent { draft = "" }
        }
    }
}
