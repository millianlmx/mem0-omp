// ATLASSIAN à l'écran, écrit une fois pour le Mac et l'iPhone/iPad : la page du Poste
// (`WorkstationPage.atlassian`) — connexion OAuth du serveur, plan du jour, savoir de la
// boîte. Les commentaires Jira proposés par l'agent sont des décisions de l'OS.
//
// La connexion ouvre le lien d'autorisation dans le navigateur ; quand le retour arrive
// sur une boucle locale (`pasteBack`), l'humain colle l'adresse de retour dans le champ.
// Les gestes sont à l'appareil approbateur : sinon, `ApproverOnlyNotice` les remplace.

import ConsoleClient
import ConsoleCore
import SwiftUI

// MARK: - Page du Poste

public struct AtlassianSections: View {
    let server: HarnessModel
    @ObservedObject var atlassian: AtlassianModel

    public init(server: HarnessModel, atlassian: AtlassianModel) {
        self.server = server
        self.atlassian = atlassian
    }

    public var body: some View {
        if let failure = atlassian.failure {
            ConsoleFailureBanner(failure: failure)
        }
        if let status = atlassian.status {
            AtlassianConnectionSection(atlassian: atlassian, status: status)
            if status.connected {
                AtlassianPlanSection(server: server, atlassian: atlassian, status: status)
                AtlassianKnowledgeSection(atlassian: atlassian, status: status)
            }
        } else {
            Section {
                ProgressView()
                    .frame(maxWidth: .infinity)
            }
        }
    }
}

struct AtlassianConnectionSection: View {
    @ObservedObject var atlassian: AtlassianModel
    let status: AtlassianStatus
    @State private var callback = ""
    @Environment(\.openURL) private var openURL

    var body: some View {
        Section {
            LabeledContent(AtlassianText.state, value: status.connected ? AtlassianText.connected : AtlassianText.disconnected)
            if let site = status.site {
                LabeledContent(AtlassianText.site, value: site.url)
            }
            if let account = status.accountId {
                LabeledContent(AtlassianText.account, value: account)
            }
            if let at = status.connectedAt {
                LabeledContent(AtlassianText.connectedAt, value: ConsoleFormat.dateTime(ms: at))
            }
            if let at = status.expiresAt {
                LabeledContent(AtlassianText.expiresAt, value: ConsoleFormat.dateTime(ms: at))
            }
            if let error = status.lastError, !error.isEmpty {
                Text(AtlassianText.lastError(error))
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                    .consoleBanner(tone: .attention)
            }
            if atlassian.isApprover {
                gestures
            } else {
                ApproverOnlyNotice()
            }
        } header: {
            Label(AtlassianText.connectionTitle, systemImage: AtlassianText.connectionSymbol)
        } footer: {
            if !status.connected {
                Text(AtlassianText.connectHint)
            }
        }
    }

    @ViewBuilder
    private var gestures: some View {
        Button(AtlassianText.connect, systemImage: AtlassianText.connectSymbol) {
            Task {
                if let url = await atlassian.connect() { openURL(url) }
            }
        }
        .disabled(atlassian.busy.contains(AtlassianModel.connectGesture))
        .consoleID("atlassian.connect")
        if let pending = status.pending {
            Text(AtlassianText.pending(ConsoleFormat.dateTime(ms: pending.expiresAt)))
                .font(.caption)
                .foregroundStyle(.secondary)
            if status.pasteBack {
                TextField(AtlassianText.callbackField, text: $callback)
                    .autocorrectionDisabled()
                    .consoleID("atlassian.callback")
                Text(AtlassianText.callbackHint)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button(AtlassianText.submit) {
                    Task {
                        if await atlassian.submitCallback(callback) { callback = "" }
                    }
                }
                .disabled(callback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || atlassian.busy.contains(AtlassianModel.callbackGesture))
                .consoleID("atlassian.callback.submit")
            }
        }
        if status.connected {
            Button(AtlassianText.disconnect, systemImage: AtlassianText.disconnectSymbol, role: .destructive) {
                Task { await atlassian.disconnect() }
            }
            .disabled(atlassian.busy.contains(AtlassianModel.disconnectGesture))
            .consoleID("atlassian.disconnect")
        }
    }
}

struct AtlassianPlanSection: View {
    let server: HarnessModel
    @ObservedObject var atlassian: AtlassianModel
    let status: AtlassianStatus
    @State private var launched: Set<Int> = []
    @State private var queued = false

    var body: some View {
        Section {
            if let plan = atlassian.plan {
                Text(plan.summary)
                    .consoleReadable()
                Text(AtlassianText.planMade(ConsoleFormat.dateTime(ms: plan.createdAt)))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                ForEach(Array(plan.items.enumerated()), id: \.offset) { index, item in
                    row(item, index: index)
                }
            } else {
                Text(AtlassianText.planEmpty).foregroundStyle(.secondary)
            }
            if atlassian.isApprover {
                Button(AtlassianText.replan, systemImage: AtlassianText.replanSymbol) {
                    Task { queued = await atlassian.runPlan() }
                }
                .disabled(atlassian.busy.contains(AtlassianModel.planGesture))
                .consoleID("atlassian.plan.run")
                if queued {
                    Text(AtlassianText.queued).font(.caption).foregroundStyle(.secondary)
                }
            }
        } header: {
            Label(AtlassianText.planTitle, systemImage: AtlassianText.planSymbol)
        } footer: {
            Text(status.plan.hour.map(AtlassianText.planHour) ?? AtlassianText.planManual)
        }
    }

    private func row(_ item: AtlassianPlanItem, index: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(item.key.map { $0 + " · " + item.title } ?? item.title)
                .font(.headline)
                .consoleReadable()
            if !item.why.isEmpty {
                Text(item.why)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !item.next.isEmpty {
                Text(AtlassianText.next(item.next))
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 12) {
                if let link = item.link {
                    Link(destination: link) {
                        Label(AtlassianText.openLink, systemImage: AtlassianText.openLinkSymbol)
                    }
                }
                if let launch = item.launch, server.canAct {
                    if launched.contains(index) {
                        Text(AtlassianText.launched).font(.caption).foregroundStyle(.secondary)
                    } else {
                        Button(AtlassianText.launch, systemImage: AtlassianText.launchSymbol) {
                            Task {
                                if await server.launchRun(repo: launch.repo, title: item.title, request: launch.request) != nil {
                                    launched.insert(index)
                                }
                            }
                        }
                        .consoleID("atlassian.plan.launch.\(index)")
                    }
                }
            }
            .buttonStyle(.bordered)
        }
        .padding(.vertical, 4)
    }
}

struct AtlassianKnowledgeSection: View {
    @ObservedObject var atlassian: AtlassianModel
    let status: AtlassianStatus
    @State private var queued = false

    var body: some View {
        Section {
            if let at = status.knowledge.lastAt {
                Text(AtlassianText.knowledgeLast(ConsoleFormat.dateTime(ms: at)))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text(AtlassianText.knowledgeNever).foregroundStyle(.secondary)
            }
            if let summary = status.knowledge.lastSummary, !summary.isEmpty {
                Text(summary)
                    .consoleReadable()
            }
            if atlassian.isApprover {
                Button(AtlassianText.knowledgeRun, systemImage: AtlassianText.knowledgeRunSymbol) {
                    Task { queued = await atlassian.runKnowledge() }
                }
                .disabled(atlassian.busy.contains(AtlassianModel.knowledgeGesture))
                .consoleID("atlassian.knowledge.run")
                if queued {
                    Text(AtlassianText.queued).font(.caption).foregroundStyle(.secondary)
                }
            }
        } header: {
            Label(AtlassianText.knowledgeTitle, systemImage: AtlassianText.knowledgeSymbol)
        }
    }
}
