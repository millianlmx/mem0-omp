// L'écran Canaux du Poste, écrit une fois pour le Mac et l'iPhone/iPad : l'état de Gmail,
// de l'Agenda et de Slack (compte, dernière lecture, phrase du serveur pour un canal
// bloqué ou en erreur), et leur connexion par le serveur.
//
// Ce qui attend l'humain d'abord : une connexion en cours (ouvrir la page d'autorisation,
// recoller l'URL de retour, ou déclarer que l'administrateur bloque l'app), puis les trois
// canaux, puis une section par connexion (client OAuth, connecter). Saisir le client passe
// par une feuille (`ChannelClientSheet`) dont le secret ne vit que le temps de l'envoi.
//
// Les gestes n'existent que pour l'appareil approbateur (seul à recevoir l'URL
// d'autorisation) ; un autre jeton lit l'état et une phrase dit qui peut connecter. Le
// refus du serveur revient au geste, sans bandeau global. Le modèle est
// `server.channels` (`WorkstationChannelsModel`) ; les mots viennent de `ChannelText`.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// La feuille du client OAuth d'une connexion (`google` ou `slack`).
struct ChannelClientTarget: Identifiable, Hashable {
    let id: String
}

public struct WorkstationChannelsSections: View {
    @ObservedObject var channels: WorkstationChannelsModel
    @State private var clientSheet: ChannelClientTarget?
    @State private var failure: HarnessFailure?

    public init(channels: WorkstationChannelsModel) {
        self.channels = channels
    }

    public var body: some View {
        Group {
            if let failure = channels.failure {
                ConsoleFailureBanner(failure: failure)
            }
            if let failure {
                Section {
                    Text(failure == .approverOnly ? ChannelText.approverOnly : failure.message)
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                        .consoleBanner(tone: .attention)
                        .consoleID("channels.failure")
                }
            }
            if channels.isApprover {
                ForEach(channels.connections.filter { $0.login?.state == "waiting" }) { connection in
                    ChannelLoginSection(channels: channels, connection: connection, failure: $failure)
                }
            }
            ChannelListSection(channels: channels.channels)
            ForEach(channels.connections) { connection in
                ChannelConnectionSection(
                    channels: channels, connection: connection, clientSheet: $clientSheet, failure: $failure
                )
            }
            if !channels.isApprover {
                Section {
                    Text(ChannelText.approverOnly)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .consoleID("channels.approverOnly")
                }
            }
        }
        .task { await channels.refresh() }
        .sheet(item: $clientSheet) { target in
            ChannelClientSheet(channels: channels, connection: target.id, failure: $failure)
        }
    }
}

// MARK: - Les trois canaux

/// Gmail, l'Agenda et Slack : état, compte, dernière lecture, et la phrase du serveur
/// (blocage par l'administrateur, scope manquant, refus du fournisseur).
struct ChannelListSection: View {
    let channels: [WorkstationChannel]

    var body: some View {
        Section {
            ForEach(channels) { channel in
                ChannelRow(channel: channel)
            }
        } header: {
            Text(ChannelText.channelsHeader)
        } footer: {
            Text(ChannelText.channelsHint)
        }
    }
}

struct ChannelRow: View {
    let channel: WorkstationChannel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(ChannelText.channel(channel.id))
                    .font(.headline)
                Spacer(minLength: 8)
                ConsoleStatusChip(status: ChannelText.status(channel.state))
                    .consoleID("channel.state.\(channel.id)")
            }
            if let account = channel.account, !account.isEmpty {
                LabeledContent(ChannelText.accountLabel, value: account)
                    .font(.callout)
                    .consoleID("channel.account.\(channel.id)")
            }
            Text(lastRead)
                .font(.caption)
                .foregroundStyle(.secondary)
                .consoleID("channel.lastRead.\(channel.id)")
            if let error = channel.error, !error.isEmpty {
                Text(error)
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                    .foregroundStyle(channel.state == "blocked" ? Color.secondary : Color.orange)
                    .consoleID("channel.error.\(channel.id)")
            }
        }
        .padding(.vertical, 2)
    }

    private var lastRead: String {
        guard let at = channel.lastReadAt else { return ChannelText.neverRead }
        return ChannelText.lastRead(ConsoleFormat.relative(ms: at, nowMs: Date().timeIntervalSince1970 * 1000))
    }
}

// MARK: - Connexion en cours

/// Ouvrir la page d'autorisation, recoller ce que montre le navigateur, ou déclarer que
/// l'administrateur bloque l'app (toute la connexion, ou un seul canal Google).
struct ChannelLoginSection: View {
    @ObservedObject var channels: WorkstationChannelsModel
    let connection: WorkstationChannelConnection
    @Binding var failure: HarnessFailure?
    @State private var value = ""

    var body: some View {
        Section {
            if let raw = connection.login?.url, let url = URL(string: raw) {
                Link(destination: url) {
                    Label(ChannelText.openAuthorization, systemImage: ChannelText.openSymbol)
                }
                .consoleID("channel.login.open.\(connection.id)")
            }
            TextField(ChannelText.answerLabel, text: $value, axis: .vertical)
                .lineLimit(1...4)
                .consoleID("channel.login.value.\(connection.id)")
            Button(ChannelText.answer) {
                let sent = value
                act { _ = try await channels.answer(connection.id, value: sent) }
            }
            .buttonStyle(.borderedProminent)
            .disabled(busy || value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .consoleID("channel.login.answer.\(connection.id)")
            blockMenu
        } header: {
            Label(ChannelText.connection(connection.id) + " · " + ChannelText.loginHeader, systemImage: ChannelText.connectSymbol)
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                Text(ChannelText.answerHint)
                if connection.id == "slack" { Text(ChannelText.blockedHint) }
                if let expires = connection.login?.expiresAt {
                    Text(ChannelText.expires(ConsoleFormat.relative(ms: expires, nowMs: Date().timeIntervalSince1970 * 1000)))
                }
            }
        }
    }

    @ViewBuilder
    private var blockMenu: some View {
        if connection.id == "google" {
            Menu {
                Button(ChannelText.blockAll) { block(nil) }
                Button(ChannelText.blockGmailOnly) { block(["gmail"]) }
                Button(ChannelText.blockCalendarOnly) { block(["calendar"]) }
            } label: {
                Label(ChannelText.declareBlocked, systemImage: ChannelText.blockedSymbol)
            }
            .disabled(busy)
            .consoleID("channel.login.block.\(connection.id)")
        } else {
            Button {
                block(nil)
            } label: {
                Label(ChannelText.declareBlocked, systemImage: ChannelText.blockedSymbol)
            }
            .disabled(busy)
            .consoleID("channel.login.block.\(connection.id)")
        }
    }

    private var busy: Bool { channels.busy.contains(connection.id) }

    private func block(_ only: [String]?) {
        act { _ = try await channels.declareBlocked(connection.id, channels: only) }
    }

    private func act(_ run: @escaping @MainActor () async throws -> Void) {
        Task {
            do {
                try await run()
                failure = nil
                value = ""
            } catch {
                failure = error as? HarnessFailure
            }
        }
    }
}

// MARK: - Une connexion : client OAuth, connecter

struct ChannelConnectionSection: View {
    @ObservedObject var channels: WorkstationChannelsModel
    let connection: WorkstationChannelConnection
    @Binding var clientSheet: ChannelClientTarget?
    @Binding var failure: HarnessFailure?

    var body: some View {
        Section {
            if let clientId = connection.clientId, !clientId.isEmpty {
                Text(ChannelText.client(clientId))
                    .font(.callout)
                    .consoleID("channel.client.\(connection.id)")
            } else {
                Text(ChannelText.clientMissing)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            if let login = connection.login, login.state == "failed", let error = login.error, !error.isEmpty {
                Text(ChannelText.loginFailed(error))
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .consoleID("channel.login.failed.\(connection.id)")
            }
            if channels.isApprover {
                Button {
                    clientSheet = ChannelClientTarget(id: connection.id)
                } label: {
                    Label(connection.clientConfigured ? ChannelText.changeClient : ChannelText.configureClient, systemImage: ChannelText.clientSymbol)
                }
                .consoleID("channel.client.edit.\(connection.id)")
                if connection.clientConfigured {
                    connectControl
                }
            }
        } header: {
            Text(ChannelText.connection(connection.id))
        } footer: {
            if channels.isApprover, connection.id == "google", connection.clientConfigured {
                Text(ChannelText.connectHint)
            }
        }
    }

    @ViewBuilder
    private var connectControl: some View {
        if connection.id == "google" {
            Menu {
                Button(ChannelText.connectAll) { connect(nil) }
                Button(ChannelText.connectGmailOnly) { connect(["gmail"]) }
                Button(ChannelText.connectCalendarOnly) { connect(["calendar"]) }
            } label: {
                Label(ChannelText.connect, systemImage: ChannelText.connectSymbol)
            } primaryAction: {
                connect(nil)
            }
            .disabled(busy)
            .consoleID("channel.connect.\(connection.id)")
        } else {
            Button {
                connect(nil)
            } label: {
                Label(ChannelText.connect, systemImage: ChannelText.connectSymbol)
            }
            .disabled(busy)
            .consoleID("channel.connect.\(connection.id)")
        }
    }

    private var busy: Bool { channels.busy.contains(connection.id) }

    private func connect(_ only: [String]?) {
        Task {
            do {
                _ = try await channels.startLogin(connection.id, channels: only)
                failure = nil
            } catch {
                failure = error as? HarnessFailure
            }
        }
    }
}

// MARK: - Feuille du client OAuth

/// Google : le JSON téléchargé du client « Application de bureau », ou identifiant et
/// secret ; Slack : l'identifiant client seul (PKCE). Le secret et le JSON ne vivent que
/// dans l'état de la feuille, vidés à l'envoi : l'app ne les garde ni ne les réaffiche.
struct ChannelClientSheet: View {
    @ObservedObject var channels: WorkstationChannelsModel
    let connection: String
    @Binding var failure: HarnessFailure?
    @Environment(\.dismiss) private var dismiss

    @State private var pastesJSON = true
    @State private var json = ""
    @State private var clientId = ""
    @State private var clientSecret = ""
    @State private var sheetFailure: HarnessFailure?
    @State private var isSending = false

    var body: some View {
        NavigationStack {
            Form {
                if connection == "google" {
                    Section {
                        Picker(ChannelText.clientIdLabel, selection: $pastesJSON) {
                            Text(ChannelText.pasteJSON).tag(true)
                            Text(ChannelText.typeCredentials).tag(false)
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        if pastesJSON {
                            TextField(ChannelText.jsonLabel, text: $json, axis: .vertical)
                                .lineLimit(3...10)
                                .font(.callout.monospaced())
                                .autocorrectionDisabled()
                                .consoleID("channel.sheet.json")
                        } else {
                            TextField(ChannelText.clientIdLabel, text: $clientId)
                                .autocorrectionDisabled()
                                .consoleID("channel.sheet.clientId")
                            SecureField(ChannelText.clientSecretLabel, text: $clientSecret)
                                .consoleID("channel.sheet.clientSecret")
                        }
                    } footer: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(ChannelText.googleHint)
                            Text(ChannelText.secretHint)
                        }
                    }
                } else {
                    Section {
                        TextField(ChannelText.clientIdLabel, text: $clientId)
                            .autocorrectionDisabled()
                            .consoleID("channel.sheet.clientId")
                    } footer: {
                        Text(ChannelText.slackHint)
                    }
                }
                if let sheetFailure {
                    Section {
                        Text(sheetFailure == .approverOnly ? ChannelText.approverOnly : sheetFailure.message)
                            .font(.callout)
                            .fixedSize(horizontal: false, vertical: true)
                            .consoleBanner(tone: .attention)
                            .consoleID("channel.sheet.failure")
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(connection == "google" ? ChannelText.googleSheetTitle : ChannelText.slackSheetTitle)
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.cancel) { close() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(ChannelText.save) { save() }
                        .disabled(!canSave)
                        .consoleID("channel.sheet.save")
                }
            }
        }
        .consoleSheetSize(minWidth: 520, minHeight: 420)
        .onDisappear(perform: forgetSecrets)
    }

    private var canSave: Bool {
        guard !isSending else { return false }
        let filled = { (text: String) in !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        if connection == "google" {
            return pastesJSON ? filled(json) : filled(clientId) && filled(clientSecret)
        }
        return filled(clientId)
    }

    private func save() {
        isSending = true
        let request: () async throws -> Void
        if connection == "google" {
            let client: WorkstationChannelsModel.GoogleClient = pastesJSON
                ? .json(json)
                : .credentials(clientId: clientId, clientSecret: clientSecret)
            request = { try await channels.setGoogleClient(client) }
        } else {
            let id = clientId
            request = { try await channels.setSlackClient(clientId: id) }
        }
        // Le secret quitte l'état de la feuille dès l'envoi, réussi ou non.
        forgetSecrets()
        Task {
            defer { isSending = false }
            do {
                try await request()
                failure = nil
                close()
            } catch {
                sheetFailure = error as? HarnessFailure
            }
        }
    }

    private func forgetSecrets() {
        json = ""
        clientSecret = ""
    }

    private func close() {
        forgetSecrets()
        dismiss()
    }
}
