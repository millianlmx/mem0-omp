// La TOUR DE CONTRÔLE du poste de travail, écrite une fois pour le Mac et l'iPhone/iPad,
// en plus de `WorkstationSections` : les navigateurs et la navigation gardée (page
// Réglages), l'action commandée depuis l'app, « Demander au poste » et les demandes en
// langage naturel, les automatisations, les sessions des jobs du poste (le même direct
// que celui d'une feature), la confirmation de l'arrêt d'urgence et les feuilles de
// détail d'une action (résultat entier, capture JPEG) et d'une réunion (transcription,
// besoins).
//
// L'arrêt d'urgence est permis à TOUT jeton : son bouton n'est jamais grisé par le rôle.
// Demandes, automatisations et réglages exigent le jeton approbateur ; les gestes restent
// offerts, le serveur décide et son refus se dit au plus près (`ApproverOnlyNotice`).

#if canImport(AppKit)
import AppKit
#endif
import ConsoleClient
import ConsoleCore
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

// MARK: - Navigateurs et navigation gardée

struct WorkstationBrowsersSection: View {
    @ObservedObject var workstation: WorkstationModel
    let status: WorkstationStatus

    var body: some View {
        Section {
            if status.browsers.isEmpty {
                Text(ControlText.noBrowser).foregroundStyle(.secondary)
            }
            ForEach(status.browsers) { browser in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(browser.name)
                            .font(.headline)
                        if browser.isDefault {
                            Text(ControlText.isDefault)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    ConsoleStatusChip(status: ConsoleStatus(
                        text: browser.online ? WorkstationText.online : WorkstationText.offline,
                        tone: browser.online ? .success : .neutral
                    ))
                    Text(WorkstationText.lastSeen(ConsoleFormat.relative(ms: browser.lastSeenAt, nowMs: Date().timeIntervalSince1970 * 1000)))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let version = browser.extensionVersion {
                        Text(WorkstationText.version(version))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            if status.browsers.count > 1 {
                Picker(ControlText.defaultBrowser, selection: defaultBinding) {
                    Text(ControlText.firstSeen).tag(String?.none)
                    ForEach(status.browsers) { browser in
                        Text(browser.name).tag(Optional(browser.id))
                    }
                }
                .disabled(workstation.isSaving)
                .consoleID("workstation.defaultBrowser")
            }
        } header: {
            Text(ControlText.browsersTitle)
        } footer: {
            Text(ControlText.defaultBrowserHint)
        }
    }

    private var defaultBinding: Binding<String?> {
        Binding(get: { status.defaultBrowser }, set: { id in Task { await workstation.setDefaultBrowser(id) } })
    }
}

struct WorkstationNavigationSection: View {
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var drafts: HarnessDrafts
    let status: WorkstationStatus

    var body: some View {
        Section {
            TextField(ControlText.allowedHosts, text: hostsBinding, prompt: Text(ControlText.allowedHostsPrompt), axis: .vertical)
                .lineLimit(2...8)
                .consolePlainInput()
                .consoleID("workstation.allowedHosts")
            Text(source(status.navigationSource?.hostsAreSet == true))
                .font(.caption)
                .foregroundStyle(.secondary)
            Button(ControlText.allowedHostsSave) {
                let hosts = WorkstationModel.hosts(from: drafts.workstationHosts ?? "")
                Task {
                    if await workstation.setAllowedHosts(hosts) { drafts.workstationHosts = nil }
                }
            }
            .disabled(workstation.isSaving || !hostsChanged)
            .consoleID("workstation.allowedHosts.save")
            Toggle(isOn: guardBinding) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(ControlText.exfiltrationGuard)
                    Text(ControlText.exfiltrationGuardHint)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(source(status.navigationSource?.guardIsSet == true))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .disabled(workstation.isSaving)
            .consoleID("workstation.exfiltrationGuard")
            if status.navigationSource?.hostsAreSet == true || status.navigationSource?.guardIsSet == true {
                Button(ControlText.backToConfig) {
                    Task {
                        if status.navigationSource?.hostsAreSet == true { await workstation.setAllowedHosts(nil) }
                        if status.navigationSource?.guardIsSet == true { await workstation.setExfiltrationGuard(nil) }
                        drafts.workstationHosts = nil
                    }
                }
                .disabled(workstation.isSaving)
                .consoleID("workstation.navigation.reset")
            }
            if workstation.failure == .approverOnly {
                ApproverOnlyNotice()
            }
        } header: {
            Text(ControlText.navigationTitle)
        } footer: {
            Text(ControlText.allowedHostsHint + " " + ControlText.navigationApproverHint)
        }
    }

    private func source(_ isSet: Bool) -> String { isSet ? ControlText.fromSetting : ControlText.fromConfig }

    private var hostsBinding: Binding<String> {
        Binding(
            get: { drafts.workstationHosts ?? WorkstationModel.identitiesText(status.allowedHosts) },
            set: { drafts.workstationHosts = $0 }
        )
    }

    private var hostsChanged: Bool {
        guard let text = drafts.workstationHosts else { return false }
        return WorkstationModel.hosts(from: text) != status.allowedHosts
    }

    private var guardBinding: Binding<Bool> {
        Binding(get: { status.exfiltrationGuard }, set: { on in Task { await workstation.setExfiltrationGuard(on) } })
    }
}

// MARK: - Commander une action

struct WorkstationCommandSection: View {
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var drafts: HarnessDrafts
    let status: WorkstationStatus

    var body: some View {
        Section {
            Picker(ControlText.commandKind, selection: $drafts.workstationCommand.kind) {
                Text(ControlText.commandOpen).tag(WorkstationCommandKind.open)
                Text(ControlText.commandNavigate).tag(WorkstationCommandKind.navigate)
            }
            .consoleSegmented()
            .consoleID("workstation.command.kind")
            TextField(ControlText.commandURL, text: $drafts.workstationCommand.url, prompt: Text(ControlText.commandURLPrompt))
                .consolePlainInput()
                .consoleURLInput()
                .consoleID("workstation.command.url")
            if drafts.workstationCommand.kind == .navigate {
                TextField(ControlText.commandTab, text: $drafts.workstationCommand.tabId)
                    .consoleDecimalInput()
                    .consoleID("workstation.command.tab")
            }
            TextField(ControlText.commandRationale, text: $drafts.workstationCommand.rationale, axis: .vertical)
                .lineLimit(1...4)
                .consoleID("workstation.command.rationale")
            if status.browsers.count > 1 {
                BrowserPicker(browsers: status.browsers, selection: $drafts.workstationCommand.browserId)
            }
            Button(ControlText.commandSend) {
                let draft = drafts.workstationCommand
                Task {
                    if await workstation.command(draft) != nil {
                        drafts.workstationCommand = WorkstationCommandDraft(kind: draft.kind, browserId: draft.browserId)
                    }
                }
            }
            .disabled(!workstation.canAct || workstation.isSaving || !drafts.workstationCommand.isComplete)
            .consoleID("workstation.command.send")
            if let sent = workstation.lastCommand {
                Button {
                    drafts.showWorkstationAction(sent)
                } label: {
                    Text(ControlText.commandSent(sent.seq, state: WorkstationText.state(sent.state)))
                        .font(.caption)
                }
                .buttonStyle(.borderless)
            }
        } footer: {
            Text(ControlText.commandHint)
        }
    }
}

/// Le choix d'un navigateur (le défaut, ou l'un des appairés).
struct BrowserPicker: View {
    let browsers: [WorkstationBrowser]
    @Binding var selection: String?

    var body: some View {
        Picker(ControlText.browserTarget, selection: $selection) {
            Text(ControlText.defaultBrowser).tag(String?.none)
            ForEach(browsers) { browser in
                Text(browser.name).tag(Optional(browser.id))
            }
        }
        .consoleID("workstation.browser")
    }
}

// MARK: - Demandes

/// « Demander au poste » sur la page principale : la demande en langage naturel (un champ,
/// le navigateur s'il y en a plusieurs, l'envoi), puis les demandes en cours et la plus
/// récente des terminées — son compte rendu se lit sans changer de page. Les autres
/// sont sur la page des demandes.
struct WorkstationAskSection: View {
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var drafts: HarnessDrafts
    let status: WorkstationStatus
    let requests: [WorkstationRequest]

    var body: some View {
        let shown = Self.shown(requests)
        Section {
            TextField(ControlText.requestsTitle, text: $drafts.workstationRequestText, prompt: Text(ControlText.requestPrompt), axis: .vertical)
                .lineLimit(2...6)
                .labelsHidden()
                .consoleID("workstation.request.text")
            if status.browsers.count > 1 {
                BrowserPicker(browsers: status.browsers, selection: $drafts.workstationRequestBrowser)
            }
            Button {
                let text = drafts.workstationRequestText
                let browser = drafts.workstationRequestBrowser
                Task {
                    if await workstation.createRequest(text, browserId: browser) != nil { drafts.workstationRequestText = "" }
                }
            } label: {
                Label(ControlText.requestSend, systemImage: ControlText.requestSymbol)
            }
            .disabled(!workstation.canAct || workstation.isSaving || drafts.workstationRequestText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .consoleID("workstation.request.send")
            if workstation.failure == .approverOnly {
                ApproverOnlyNotice()
            }
            ForEach(shown) { request in
                WorkstationRequestRow(workstation: workstation, request: request)
            }
            if requests.count > shown.count {
                NavigationLink(value: WorkstationPage.requests) {
                    Text(WorkstationText.allRequests)
                }
                .consoleID("workstation.requests.all")
            }
        } header: {
            Text(WorkstationText.askTitle)
        }
    }

    /// Les demandes en file ou en cours, et la plus récente des terminées (les demandes
    /// arrivent les plus récentes d'abord).
    static func shown(_ requests: [WorkstationRequest]) -> [WorkstationRequest] {
        let latest = requests.first { !$0.isOpen }?.id
        return requests.filter { $0.isOpen || $0.id == latest }
    }
}

/// Toutes les demandes, sur leur page.
struct WorkstationRequestsListSection: View {
    @ObservedObject var workstation: WorkstationModel
    let requests: [WorkstationRequest]

    var body: some View {
        Section {
            if workstation.failure == .approverOnly {
                ApproverOnlyNotice()
            }
            if requests.isEmpty {
                Text(ControlText.noRequest).foregroundStyle(.secondary)
            }
            ForEach(requests) { request in
                WorkstationRequestRow(workstation: workstation, request: request)
            }
        }
    }
}

extension WorkstationRequest {
    /// En file ou en cours : la demande peut encore être annulée.
    var isOpen: Bool { state == .queued || state == .running }
}

struct WorkstationRequestRow: View {
    @ObservedObject var workstation: WorkstationModel
    let request: WorkstationRequest

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(request.instruction)
                .consoleReadable()
            ConsoleStatusChip(status: ConsoleStatus(text: ControlText.requestState(request.state.rawValue), tone: Self.tone(request.state)))
            Text(ConsoleFormat.dateTime(ms: request.createdAt) + (request.by.map { " · " + $0 } ?? ""))
                .font(.caption)
                .foregroundStyle(.secondary)
            if let reason = request.reason, !reason.isEmpty {
                Text(WorkstationText.reason(reason))
                    .font(.caption)
                    .foregroundStyle(request.state == .failed ? .red : .secondary)
                    .consoleReadable()
            }
            if let report = request.report, !report.isEmpty {
                Text(ControlText.requestReport)
                    .font(.caption.weight(.semibold))
                // Le compte rendu de l'agent est du Markdown (titres, gras, listes) : rendu, pas cité.
                ConsoleMarkdown(markdown: report)
                    .font(.callout)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if request.state == .queued || request.state == .running {
                Button(ControlText.requestCancel, role: .destructive) {
                    Task { await workstation.cancelRequest(request) }
                }
                .buttonStyle(.bordered)
                .disabled(workstation.isSaving)
                .consoleID("workstation.request.cancel")
            }
        }
        .padding(.vertical, 2)
    }

    static func tone(_ state: WorkstationRequestState) -> ConsoleTone {
        switch state {
        case .queued: .neutral
        case .running: .info
        case .done: .success
        case .failed: .danger
        case .cancelled: .paused
        }
    }
}

// MARK: - Automatisations

struct WorkstationAutomationsSection: View {
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var drafts: HarnessDrafts
    let automations: [WorkstationAutomation]

    var body: some View {
        Section {
            if automations.isEmpty {
                Text(ControlText.noAutomation).foregroundStyle(.secondary)
            }
            ForEach(automations) { automation in
                VStack(alignment: .leading, spacing: 4) {
                    Text(automation.title)
                        .font(.headline)
                    Text(automation.frequency)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let cron = automation.schedule {
                        Text(ControlText.scheduled(cron))
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }
                    ForEach(Array(automation.steps.enumerated()), id: \.offset) { index, step in
                        Text(verbatim: "\(index + 1). \(step)")
                            .font(.caption)
                            .consoleReadable()
                    }
                    HStack {
                        Button(ControlText.automationLaunch) {
                            Task { await workstation.launchAutomation(automation) }
                        }
                        .buttonStyle(.bordered)
                        .consoleID("workstation.automation.launch")
                        Button(ControlText.automationDelete, role: .destructive) {
                            drafts.automationRemoval = automation
                        }
                        .buttonStyle(.bordered)
                    }
                    .disabled(workstation.isSaving)
                }
                .padding(.vertical, 2)
            }
            let tasks = automatableTasks
            if !tasks.isEmpty, let version = workstation.profile?.profile?.version {
                Text(ControlText.automatableTasks)
                    .font(.subheadline.weight(.semibold))
                ForEach(tasks, id: \.index) { item in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.task.title)
                        TextField(ControlText.cronLabel, text: cronBinding(item.index), prompt: Text(ControlText.cronPrompt))
                            .consolePlainInput()
                            .font(.callout.monospaced())
                        Button(ControlText.automate) {
                            let cron = drafts.automationCron[item.index] ?? ""
                            Task {
                                if await workstation.createAutomation(version: version, task: item.index, schedule: cron) != nil {
                                    drafts.automationCron[item.index] = nil
                                }
                            }
                        }
                        .buttonStyle(.bordered)
                        .disabled(workstation.isSaving)
                        .consoleID("workstation.automate.\(item.index)")
                    }
                }
            }
        }
    }

    /// Les tâches automatisables du profil qui ne sont pas encore une automatisation.
    private var automatableTasks: [(index: Int, task: WorkstationTask)] {
        let tasks = workstation.profile?.profile?.repetitiveTasks ?? []
        let kept = Set(automations.map(\.title))
        return tasks.enumerated()
            .filter { $0.element.automatable && !kept.contains($0.element.title) }
            .map { (index: $0.offset, task: $0.element) }
    }

    private func cronBinding(_ index: Int) -> Binding<String> {
        Binding(get: { drafts.automationCron[index] ?? "" }, set: { drafts.automationCron[index] = $0 })
    }
}

// MARK: - Sessions des jobs du poste

struct WorkstationSessionsSection: View {
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        Section {
            ForEach(WorkstationSessionJob.allCases) { job in
                Button {
                    drafts.sessionRequest = HarnessSessionRequest(target: .workstation(job), title: ControlText.job(job.rawValue))
                } label: {
                    Label(ControlText.job(job.rawValue), systemImage: PipelineServerText.sessionSymbol)
                }
                .consoleID("workstation.session.\(job.rawValue)")
            }
        }
    }
}

// MARK: - Feuilles et confirmations

struct WorkstationControlSheets: ViewModifier {
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var drafts: HarnessDrafts

    func body(content: Content) -> some View {
        content
            .sheet(item: $drafts.workstationActionShown) { action in
                WorkstationActionSheet(workstation: workstation, drafts: drafts, shown: action)
            }
            .sheet(item: $drafts.workstationMeetingShown) { meeting in
                WorkstationMeetingSheet(workstation: workstation, drafts: drafts, meeting: meeting)
            }
            .confirmationDialog(
                ControlText.stopConfirm,
                isPresented: $drafts.workstationStopAsked,
                titleVisibility: .visible
            ) {
                Button(ControlText.stop, role: .destructive) {
                    Task { await workstation.stop() }
                }
                .consoleID("workstation.stop.commit")
                Button(PipelineServerText.cancel, role: .cancel) {}
            } message: {
                Text(ControlText.stopMessage)
            }
            .confirmationDialog(
                ControlText.automationDeleteConfirm,
                isPresented: Binding(get: { drafts.automationRemoval != nil }, set: { if !$0 { drafts.automationRemoval = nil } }),
                titleVisibility: .visible,
                presenting: drafts.automationRemoval
            ) { automation in
                Button(ControlText.automationDelete, role: .destructive) {
                    Task { await workstation.deleteAutomation(automation) }
                }
                Button(PipelineServerText.cancel, role: .cancel) {}
            } message: { _ in
                Text(ControlText.automationDeleteMessage)
            }
    }
}

/// Le détail d'une action : sa raison, ses paramètres, son résultat ENTIER, son erreur,
/// l'approbation et, pour une capture, l'image gardée par le serveur.
struct WorkstationActionSheet: View {
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var drafts: HarnessDrafts
    let shown: WorkstationAction

    /// L'action telle que relue (son état a pu changer depuis la liste).
    private var action: WorkstationAction { drafts.workstationActionView?.action ?? shown }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(WorkstationText.kind(action.kind))
                        .font(.headline)
                    ConsoleStatusChip(status: ConsoleStatus(text: WorkstationText.state(action.state), tone: WorkstationJournalRow.tone(of: action.phase)))
                    Text(action.rationale)
                        .consoleReadable()
                    Text(WorkstationText.origin(action.origin) + " · " + ConsoleFormat.dateTime(ms: action.createdAt))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let error = action.error, !error.isEmpty {
                        Text(WorkstationText.error(error))
                            .foregroundStyle(.red)
                            .consoleReadable()
                    }
                    if let decision = action.decision {
                        Text(decision.approved ? WorkstationText.approvedBy(decision.by) : WorkstationText.refusedBy(decision.by))
                            .font(.caption)
                    }
                    if [.queued, .running, .awaitingApproval].contains(action.phase) {
                        Button(ControlText.actionCancel, role: .destructive) {
                            let current = action
                            Task {
                                if await workstation.cancel(current) {
                                    drafts.workstationActionView = await workstation.action(current.seq)
                                }
                            }
                        }
                        .disabled(workstation.busy.contains(action.seq))
                        .consoleID("workstation.action.cancel")
                    }
                }
                if !action.params.isEmpty {
                    Section(ControlText.actionParams) {
                        Text(Self.json(.object(action.params)))
                            .font(.caption.monospaced())
                            .consoleReadable()
                    }
                }
                if let text = action.result?.text, !text.isEmpty {
                    Section(ControlText.actionResult) {
                        Text(text)
                            .font(.callout)
                            .consoleReadable()
                    }
                }
                if let data = action.result?.data, data != .null {
                    Section(ControlText.actionData) {
                        Text(Self.json(data))
                            .font(.caption.monospaced())
                            .consoleReadable()
                    }
                }
                if action.kind == "screenshot" || drafts.workstationCapture != nil {
                    Section(ControlText.actionCapture) {
                        if let capture = drafts.workstationCapture, let data = capture.data {
                            ConsoleCaptureImage(data: data)
                                .accessibilityLabel(Text(ControlText.captureLabel))
                            Text(ConsoleFormat.dateTime(ms: capture.at))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else if drafts.workstationActionView == nil {
                            ProgressView()
                        } else {
                            Text(ControlText.noCapture).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(ControlText.actionNumber(shown.seq))
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.close) { drafts.workstationActionShown = nil }
                }
            }
        }
        .task(id: shown.seq) {
            drafts.workstationActionView = await workstation.action(shown.seq) ?? WorkstationActionView(action: shown)
            if shown.kind == "screenshot" {
                drafts.workstationCapture = await workstation.capture(shown.seq)
            }
        }
        .consoleSheetSize(minWidth: 560, minHeight: 480)
    }

    /// Un JSON lisible : clés triées, indenté.
    static func json(_ value: JSONValue) -> String {
        guard let data = try? JSONEncoder.sorted.encode(value), let text = String(data: data, encoding: .utf8) else { return "" }
        return text
    }
}

extension JSONEncoder {
    /// Un encodeur aux clés triées et indenté : un JSON montré tel quel.
    static var sorted: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}

/// Une capture JPEG, à sa largeur.
public struct ConsoleCaptureImage: View {
    let data: Data

    public init(data: Data) {
        self.data = data
    }

    public var body: some View {
        #if canImport(AppKit)
        if let image = NSImage(data: data) {
            Image(nsImage: image)
                .resizable()
                .scaledToFit()
                .clipShape(.rect(cornerRadius: 8))
        }
        #elseif canImport(UIKit)
        if let image = UIImage(data: data) {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .clipShape(.rect(cornerRadius: 8))
        }
        #endif
    }
}

/// Le détail d'une réunion : son résumé, ses besoins et sa transcription.
struct WorkstationMeetingSheet: View {
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var drafts: HarnessDrafts
    let meeting: WorkstationMeeting

    private var shown: WorkstationMeeting { drafts.workstationMeetingDetail?.meeting ?? meeting }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(WorkstationText.meetingState(shown.state) + " · " + ConsoleFormat.dateTime(ms: shown.startedAt))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let summary = shown.summary, !summary.isEmpty {
                        Text(summary)
                            .consoleReadable()
                    }
                }
                if !shown.needs.isEmpty {
                    Section(ControlText.needs) {
                        ForEach(Array(shown.needs.enumerated()), id: \.offset) { _, need in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(need.need)
                                if let who = need.who {
                                    Text(WorkstationText.forWhom(who)).font(.caption).foregroundStyle(.secondary)
                                }
                                if let due = need.due {
                                    Text(WorkstationText.due(due)).font(.caption).foregroundStyle(.secondary)
                                }
                                if !need.quote.isEmpty {
                                    Text(WorkstationText.quote(need.quote)).font(.caption.italic()).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                Section(ControlText.transcript) {
                    if let detail = drafts.workstationMeetingDetail {
                        if detail.transcript.isEmpty {
                            Text(ControlText.noTranscript).foregroundStyle(.secondary)
                        }
                        ForEach(Array(detail.transcript.enumerated()), id: \.offset) { _, segment in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(ControlText.speaker(isSelf: segment.isSelf) + " · " + ConsoleFormat.time(ms: segment.at))
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(segment.isSelf ? Color.accentColor : Color.secondary)
                                Text(segment.text)
                                    .consoleReadable()
                            }
                            .accessibilityElement(children: .combine)
                        }
                    } else {
                        ProgressView()
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(meeting.title.isEmpty ? ControlText.meetingTitle : meeting.title)
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.close) { drafts.workstationMeetingShown = nil }
                }
            }
        }
        .task(id: meeting.id) {
            drafts.workstationMeetingDetail = await workstation.meeting(meeting.id) ?? WorkstationMeetingDetail(meeting: meeting)
        }
        .consoleSheetSize(minWidth: 560, minHeight: 480)
    }
}

extension View {
    /// Une saisie d'adresse web : le clavier d'URL sur iOS.
    @ViewBuilder
    func consoleURLInput() -> some View {
        #if os(iOS)
        keyboardType(.URL)
        #else
        self
        #endif
    }
}
