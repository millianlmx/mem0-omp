// L'écran « Session OMP » de l'app iOS (BR-4) : piloter l'UNIQUE session
// hébergée du Mac — la même que la section « Session OMP » de la coque macOS.
//
// Un seul écran, quatre zones : en-tête (dépôt + pastille d'état), bandeau d'état,
// fil réutilisé `IOSSessionThreadView`, composeur et actions. Chaque état est
// couvert (non connecté, chargement, vide, lancement, arrêt, vivant, arrêtée,
// interrompue, échec) ; aucun `onTapGesture`, uniquement des contrôles système.
//
// Hors connexion (etats-non-connecte-heterogenes-ios, S-4) : sans état servi reçu,
// le composant d'état de connexion partagé SEUL, hors du panneau ; avec un état
// conservé, le panneau garde son contenu sous le bandeau du composant.
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
    /// La feuille Connexion de la racine, ouverte par « Se connecter ».
    @Binding var showConnection: Bool

    @State private var showingLaunch = false
    @State private var showingStop = false
    @State private var draft = ""
    @FocusState private var composerFocused: Bool

    init(client: ConsoleClientModel, showConnection: Binding<Bool>) {
        self.client = client
        _showConnection = showConnection
        _model = StateObject(wrappedValue: IOSSessionOmpModel(client: client))
    }

    var body: some View {
        Group {
            switch model.surface {
            case .unavailable(let status):
                // Rien de reçu, Mac non connecté : le composant partagé SEUL, hors
                // du panneau (S-4).
                IOSConnectionStateView(status: status, layout: .screen, onConnect: { showConnection = true })
            case .loading:
                panel {
                    HStack(spacing: 8) {
                        ProgressView()
                    }
                    .accessibilityIdentifier(SessionOmpAccessibility.loading)
                }
            case .empty:
                panel {
                    emptyState
                    actions
                }
            case .launching:
                panel {
                    header
                    startingState(ProjectViewText.sessionStarting, id: SessionOmpAccessibility.launching)
                }
            case .stopping:
                panel {
                    header
                    startingState(ProjectViewText.sessionClosing, id: SessionOmpAccessibility.stopping)
                }
            case .live:
                panel {
                    sessionBody
                    actions
                }
            case .stopped:
                panel {
                    header
                    Text(SessionConsoleText.Status.stopped)
                        .font(.callout)
                        .iosBanner(tone: .neutral)
                        .accessibilityIdentifier(SessionOmpAccessibility.banner)
                    sessionBody
                    actions
                }
            case .dead:
                panel {
                    header
                    Text(SessionConsoleText.interrupted)
                        .font(.callout)
                        .iosBanner(tone: .attention)
                        .accessibilityIdentifier(SessionOmpAccessibility.banner)
                    sessionBody
                    actions
                }
            case .failed(let message):
                panel {
                    header
                    Text(message)
                        .font(.callout)
                        .iosBanner(tone: .danger)
                        .accessibilityIdentifier(SessionOmpAccessibility.banner)
                    actions
                }
            }
        }
        .navigationTitle(ConsoleSection.session.title)
        .onAppear { model.appeared() }
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
                guard model.connection.gesturesEnabled else { return }
                Task { await model.stop() }
            }
            Button(SessionConsoleText.cancel, role: .cancel) {}
        } message: {
            Text(IOSSessionOmpText.stopConfirmMessage)
        }
    }

    // MARK: - Panneau

    /// Le panneau de l'écran, ancré en haut : le bandeau de connexion en tête quand
    /// l'état conservé est affiché hors connexion (S-4) — sinon l'erreur de geste,
    /// tue hors connexion —, puis l'état.
    private func panel<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.connection != .connected {
                IOSConnectionStateView(status: model.connection, layout: .banner, onConnect: { showConnection = true })
            } else if let error = model.error {
                Text(error)
                    .font(.callout)
                    .iosBanner(tone: .danger)
                    .accessibilityIdentifier(SessionOmpAccessibility.banner)
            }
            content()
        }
        .iosPanel()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        // `.contain` : sans lui, l'identifiant d'écran écrase ceux des gestes
        // (composeur, « Envoyer », « Relancer »…), illisibles par la recette S-6.
        .accessibilityElement(children: .contain)
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
                    .disabled(!model.connection.gesturesEnabled)
                    .accessibilityIdentifier(SessionOmpAccessibility.composer)
                Button(SessionConsoleText.send, action: submit)
                    .buttonStyle(.borderedProminent)
                    .disabled(!model.connection.gesturesEnabled || !canSend)
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
                    .disabled(!model.connection.gesturesEnabled)
                    .accessibilityIdentifier(SessionOmpAccessibility.launch)
            }
            if model.canRelaunch {
                Button(SessionConsoleText.relaunch) {
                    Task { await model.relaunch() }
                }
                .buttonStyle(.bordered)
                .disabled(!model.connection.gesturesEnabled)
                .accessibilityIdentifier(SessionOmpAccessibility.relaunch)
            }
            if model.canStop {
                Button(SessionConsoleText.stop) { showingStop = true }
                    .buttonStyle(.bordered)
                    .disabled(!model.connection.gesturesEnabled)
                    .accessibilityIdentifier(SessionOmpAccessibility.stop)
            }
        }
    }

    // MARK: - Faits dérivés

    private var dialogs: [RpcDialogRequest] { client.hosted?.dialogs ?? [] }

    private var canSend: Bool {
        IOSSessionOmpModel.canSendPrompt(state: client.hosted?.state, dialogs: dialogs, text: draft)
    }

    /// Le dialogue n'est présenté que connecté ; encore en attente, il se rouvre à
    /// la reconnexion (etats-non-connecte-heterogenes-ios, S-5).
    private var pendingDialogBinding: Binding<RpcDialogRequest?> {
        Binding(get: { model.connection == .connected ? dialogs.first : nil }, set: { _ in })
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
