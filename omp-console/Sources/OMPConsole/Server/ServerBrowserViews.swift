// Le NAVIGATEUR DU SERVEUR dans la section « Poste » du Mac, à l'usage de l'appareil
// approbateur : l'état de chaque compte (Slack, Google), l'import de la session du Chrome
// de l'utilisateur (l'extension répond seule, dans les deux minutes) et la connexion
// interactive, dans une feuille qui montre la page du serveur, y renvoie les clics et les
// frappes, et se termine par « Terminer ».
//
// Propre au Mac : l'app iOS n'en a pas. Les gestes restent offerts à tout jeton qui peut
// agir — le serveur décide, son refus se dit au plus près par le bandeau d'échec. Le modèle
// (`ServerBrowserModel`, porté par `HarnessModel`) ne porte aucun texte : les mots viennent
// de `ServerBrowserText`. Les boucles de relecture (l'import ouvert, l'image de la page)
// sont des tâches de ces vues : les fermer les arrête.

import AppKit
import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

// MARK: - Section de la page Poste

struct ServerBrowserSection: View {
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var model: ServerBrowserModel
    @Binding var loginShown: Bool

    var body: some View {
        if let browser = workstation.status?.serverBrowser, !browser.accounts.isEmpty {
            Section {
                if let failure = model.failure {
                    ConsoleFailureBanner(failure: failure)
                }
                ConsoleStatusChip(status: ConsoleStatus(
                    text: browser.online ? ServerBrowserText.online : ServerBrowserText.offline,
                    tone: browser.online ? .success : .neutral
                ))
                .consoleID("workstation.vps.online")
                ForEach(browser.accounts) { account in
                    row(account)
                }
                importFeedback
                openLogin
            } header: {
                Label(ServerBrowserText.sectionTitle, systemImage: ServerBrowserText.sectionSymbol)
            } footer: {
                Text(ServerBrowserText.sectionHint + " " + ServerBrowserText.importHint + " " + ServerBrowserText.loginHint)
            }
        }
    }

    private func row(_ account: ServerBrowserAccount) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(ServerBrowserText.accountName(account.domain))
                    .font(.headline)
                Spacer(minLength: 8)
                ConsoleStatusChip(status: ConsoleStatus(text: ServerBrowserText.state(account), tone: tone(of: account)))
            }
            if let changed = account.changedAt {
                Text(ServerBrowserText.changed(ConsoleFormat.relative(ms: changed, nowMs: Date().timeIntervalSince1970 * 1000)))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let hint = ServerBrowserText.stateHint(account) {
                Text(hint)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Button(ServerBrowserText.importAction) {
                    Task { await model.openImport(domain: account.domain) }
                }
                .disabled(!workstation.canAct || model.isBusy || model.pendingImport != nil)
                .consoleID("workstation.vps.import." + account.domain)
                Button(ServerBrowserText.loginAction) {
                    Task {
                        if await model.startLogin(url: account.loginURL) { loginShown = true }
                    }
                }
                .disabled(!workstation.canAct || model.isBusy || model.login != nil)
                .consoleID("workstation.vps.login." + account.domain)
            }
            .buttonStyle(.bordered)
        }
        .padding(.vertical, 2)
    }

    private func tone(of account: ServerBrowserAccount) -> ConsoleTone {
        switch account.phase {
        case .connected: .success
        case .expired: .attention
        case .blocked: .danger
        case .disconnected, nil: .neutral
        }
    }

    /// L'import ouvert (l'extension répond depuis Chrome), puis comment le dernier s'est refermé.
    @ViewBuilder
    private var importFeedback: some View {
        if let pending = model.pendingImport {
            HStack(alignment: .top, spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                VStack(alignment: .leading, spacing: 2) {
                    Text(ServerBrowserText.importOpened(ServerBrowserText.accountName(pending.domain)))
                    Text(ServerBrowserText.importDeadline(ConsoleFormat.time(ms: pending.expiresAt)))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .consoleID("workstation.vps.import.waiting")
        } else if let outcome = model.importOutcome {
            Label(ServerBrowserText.outcome(outcome), systemImage: symbol(of: outcome))
                .font(.callout)
                .foregroundStyle(color(of: outcome))
                .consoleID("workstation.vps.import.outcome")
        }
    }

    private func symbol(of outcome: ServerBrowserImportOutcome) -> String {
        switch outcome {
        case .received: "checkmark.circle"
        case .expired: "exclamationmark.triangle"
        }
    }

    private func color(of outcome: ServerBrowserImportOutcome) -> Color {
        switch outcome {
        case .received: .green
        case .expired: .orange
        }
    }

    /// Une connexion déjà ouverte sur le serveur : la reprendre, ou la terminer.
    @ViewBuilder
    private var openLogin: some View {
        if let login = model.login {
            VStack(alignment: .leading, spacing: 8) {
                Text(ServerBrowserText.loginOpen(ServerBrowserText.accountName(login.domain)))
                    .font(.callout)
                HStack {
                    Button(ServerBrowserText.loginResume) { loginShown = true }
                        .buttonStyle(.borderedProminent)
                        .consoleID("workstation.vps.login.resume")
                    Button(ServerBrowserText.loginFinish) {
                        Task { await model.finishLogin() }
                    }
                    .buttonStyle(.bordered)
                    .disabled(model.isBusy)
                    .consoleID("workstation.vps.login.finish")
                }
            }
        }
    }
}

/// Les tâches du navigateur du serveur, posées sur la page Poste : relire l'import ouvert
/// tant qu'il l'est, et reprendre une connexion déjà ouverte à l'ouverture de la page.
struct ServerBrowserTasks: ViewModifier {
    @ObservedObject var model: ServerBrowserModel

    func body(content: Content) -> some View {
        content
            .task { await model.resumeLogin() }
            .task(id: model.pendingImport) { await model.watchImport() }
    }
}

// MARK: - Feuille de la connexion

/// La page du serveur : son image rafraîchie une fois par seconde, les clics et les frappes
/// renvoyés à la page, et « Terminer » pour la fermer. « Fermer » laisse la connexion ouverte.
struct ServerBrowserLoginSheet: View {
    @ObservedObject var model: ServerBrowserModel
    @Binding var isPresented: Bool
    @State private var typed = ""
    @State private var hidesTyping = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if model.login?.error != nil {
                        Label(ServerBrowserText.refused, systemImage: "exclamationmark.triangle.fill")
                            .font(.callout)
                            .consoleBanner(tone: .attention)
                            .consoleID("workstation.vps.login.refused")
                    } else if let failure = model.failure {
                        ConsoleFailureBanner(failure: failure)
                    }
                    if let host = model.frame?.host ?? model.login?.host, !host.isEmpty {
                        Text(ServerBrowserText.page(host))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .consoleID("workstation.vps.login.host")
                    }
                    ServerBrowserPage(frame: model.frame) { input in
                        Task { await model.send(input) }
                    }
                } footer: {
                    Text(ServerBrowserText.clickHint)
                }
                Section {
                    HStack {
                        Group {
                            if hidesTyping {
                                SecureField(ServerBrowserText.typeLabel, text: $typed)
                            } else {
                                TextField(ServerBrowserText.typeLabel, text: $typed)
                            }
                        }
                        .onSubmit { sendTyped() }
                        .consoleID("workstation.vps.login.text")
                        Button(ServerBrowserText.typeSend) { sendTyped() }
                            .buttonStyle(.bordered)
                            .disabled(typed.isEmpty || inputDisabled)
                            .consoleID("workstation.vps.login.type")
                    }
                    Toggle(ServerBrowserText.typeHidden, isOn: $hidesTyping)
                    HStack {
                        ForEach(ServerBrowserKey.allCases, id: \.self) { key in
                            Button(ServerBrowserText.key(key)) {
                                Task { await model.send(.key(key)) }
                            }
                            .consoleID("workstation.vps.login.key." + key.rawValue.lowercased())
                        }
                        Spacer(minLength: 8)
                        Button {
                            Task { await model.send(.scroll(dy: -ServerBrowserInput.scrollStep)) }
                        } label: {
                            Label(ServerBrowserText.scrollUp, systemImage: "chevron.up")
                        }
                        .consoleID("workstation.vps.login.scrollUp")
                        Button {
                            Task { await model.send(.scroll(dy: ServerBrowserInput.scrollStep)) }
                        } label: {
                            Label(ServerBrowserText.scrollDown, systemImage: "chevron.down")
                        }
                        .consoleID("workstation.vps.login.scrollDown")
                    }
                    .buttonStyle(.bordered)
                    .labelStyle(.iconOnly)
                    .disabled(inputDisabled)
                } footer: {
                    Text(ServerBrowserText.loginFinishHint)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(ServerBrowserText.loginTitle(ServerBrowserText.accountName(model.login?.domain ?? "")))
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.close) { isPresented = false }
                        .consoleID("workstation.vps.login.close")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(ServerBrowserText.loginFinish) {
                        Task { await model.finishLogin() }
                    }
                    .disabled(model.isBusy)
                    .consoleID("workstation.vps.login.done")
                }
            }
        }
        .consoleSheetSize(minWidth: 780, minHeight: 680)
        .task { await model.followLogin() }
        .onChange(of: model.login?.id) { _, id in
            if id == nil { isPresented = false }
        }
    }

    /// Aucun geste ne part sans connexion, ni vers une connexion refusée, ni pendant un geste.
    private var inputDisabled: Bool {
        model.login == nil || model.login?.error != nil || model.isBusy
    }

    private func sendTyped() {
        let text = typed
        guard !text.isEmpty else { return }
        Task {
            if await model.send(.text(text)) { typed = "" }
        }
    }
}

/// L'image de la page du serveur, à sa proportion : un clic sur l'image devient un clic de
/// la page, ses coordonnées ramenées à la fenêtre du serveur (`ServerBrowserFrame.click`).
private struct ServerBrowserPage: View {
    let frame: ServerBrowserFrame?
    let onClick: (ServerBrowserInput) -> Void

    var body: some View {
        if let frame, let data = frame.data, let image = NSImage(data: data) {
            Image(nsImage: image)
                .resizable()
                .aspectRatio(CGFloat(max(frame.width, 1)) / CGFloat(max(frame.height, 1)), contentMode: .fit)
                .overlay {
                    GeometryReader { proxy in
                        Color.clear
                            .contentShape(Rectangle())
                            .gesture(
                                SpatialTapGesture()
                                    .onEnded { value in
                                        if let click = frame.click(
                                            atX: value.location.x, y: value.location.y,
                                            displayedWidth: proxy.size.width, displayedHeight: proxy.size.height
                                        ) {
                                            onClick(click)
                                        }
                                    }
                            )
                    }
                }
                .clipShape(.rect(cornerRadius: 8))
                .accessibilityLabel(ServerBrowserText.pageLabel)
                .consoleID("workstation.vps.login.page")
        } else {
            ProgressView {
                Text(ServerBrowserText.loginLoading)
            }
            .frame(maxWidth: .infinity)
        }
    }
}
