// Les sections d'EXPLOITATION de la tour de contrôle, écrites une fois pour le Mac et
// l'iPhone/iPad : la Vigie (mode, plafonds, battement, incidents), les Planifications
// (liste, création, activer, déclencher, supprimer), l'Administration (clients, dépôts,
// rechargement, erreurs des clients — admin seulement) et les Issues (lues et
// corrigées par le MCP du serveur).
//
// Chaque app les pose dans son cadre (formulaire du Mac, liste groupée d'iOS). Un
// serveur qui ne sert pas une fonction le dit en clair (`ControlText.absent`), un jeton
// qui n'y a pas droit aussi ; un échec d'échange vient en bandeau. Les gestes
// destructifs (supprimer, révoquer) passent par une confirmation (`controlGestures`).

import ConsoleClient
import ConsoleCore
import SwiftUI

/// L'état d'une fonction de la tour : absente du serveur, refusée au jeton, ou servie.
struct ControlAvailabilityNotice: View {
    let availability: HarnessFeatureAvailability

    var body: some View {
        switch availability {
        case .absent:
            Section { Text(ControlText.absent).foregroundStyle(.secondary) }
        case .forbidden(let motive):
            ConsoleFailureBanner(failure: .forbidden(motive))
        case .unknown:
            Section { ProgressView().frame(maxWidth: .infinity) }
        case .available:
            EmptyView()
        }
    }
}

// MARK: - Vigie

/// Le silence de la vigie, en bandeau rouge (Accueil et section Vigie).
public struct VigieSilentBanner: View {
    @ObservedObject var vigie: HarnessVigie

    public init(vigie: HarnessVigie) {
        self.vigie = vigie
    }

    public var body: some View {
        if vigie.isSilent {
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Label(ControlText.vigieSilent, systemImage: ControlText.vigieSilentSymbol)
                        .font(.headline)
                    if let at = vigie.view?.heartbeat?.at {
                        Text(ControlText.heartbeat(ConsoleFormat.relative(ms: at, nowMs: Date().timeIntervalSince1970 * 1000)))
                            .font(.caption)
                    }
                }
                .foregroundStyle(.red)
                .consoleBanner(tone: .danger)
                .consoleID("vigie.silent")
            }
        }
    }
}

public struct VigieSections: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var vigie: HarnessVigie
    @ObservedObject var drafts: HarnessDrafts

    public init(server: HarnessModel, drafts: HarnessDrafts) {
        self.server = server
        self.vigie = server.vigie
        self.drafts = drafts
    }

    public var body: some View {
        if let failure = vigie.failure {
            ConsoleFailureBanner(failure: failure)
        }
        ControlAvailabilityNotice(availability: vigie.availability)
        if vigie.availability == .available, let view = vigie.view {
            VigieSilentBanner(vigie: vigie)
            stateSection(view)
            settingsSection(view.settings)
            incidentsSection(view)
        }
    }

    private func stateSection(_ view: VigieView) -> some View {
        Section {
            ConsoleStatusChip(status: ConsoleStatus(text: ControlText.vigieMode(view.settings.mode), tone: Self.tone(view)))
                .consoleID("vigie.mode")
            if let hint = ControlText.vigieModeHint(view.settings.mode) {
                Text(hint).font(.callout)
            }
            if let beat = view.heartbeat {
                Text(ControlText.heartbeat(ConsoleFormat.relative(ms: beat.at, nowMs: Date().timeIntervalSince1970 * 1000)))
                    .font(.callout)
                Text([beat.client, beat.version.map(WorkstationText.version)].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text(ControlText.vigieNeverSeen).foregroundStyle(.secondary)
            }
            Text(ControlText.todayIssues(view.today.issues, of: view.settings.maxIssuesPerDay))
                .monospacedDigit()
            Text(ControlText.todayRuns(view.today.liveRuns, of: view.settings.maxLiveRuns))
                .monospacedDigit()
            Text(ControlText.todaySpent(MonitoringText.cost(view.today.spentUsd), of: MonitoringText.cost(view.settings.dailyBudgetUsd)))
                .monospacedDigit()
            let counts = VigieIncidentStatus.allCases.compactMap { status in
                view.incidents[status.rawValue].flatMap { $0 > 0 ? ControlText.countLine(ControlText.incidentStatus(status.rawValue), count: $0) : nil }
            }
            if !counts.isEmpty {
                Text(counts.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text(ControlText.vigieStateTitle)
        }
    }

    static func tone(_ view: VigieView) -> ConsoleTone {
        if view.isSilent { return .danger }
        switch view.settings.phase {
        case .off: return .neutral
        case .shadow: return .info
        case .report, .fix: return .success
        case nil: return .neutral
        }
    }

    private func settingsSection(_ current: VigieSettings) -> some View {
        Section {
            Picker(ControlText.vigieMode, selection: field(\.mode, current)) {
                ForEach(VigieMode.allCases) { mode in
                    Text(ControlText.vigieMode(mode.rawValue)).tag(mode.rawValue)
                }
            }
            .consoleSegmented()
            .consoleID("vigie.settings.mode")
            Stepper(value: field(\.maxIssuesPerDay, current), in: 0...1000) {
                Text(ControlText.vigieMaxIssues + " : \(edited(current).maxIssuesPerDay)")
            }
            .consoleID("vigie.settings.maxIssues")
            Stepper(value: field(\.maxLiveRuns, current), in: 0...1000) {
                Text(ControlText.vigieMaxRuns + " : \(edited(current).maxLiveRuns)")
            }
            .consoleID("vigie.settings.maxRuns")
            TextField(ControlText.vigieBudget, value: field(\.dailyBudgetUsd, current), format: .number)
                .consoleDecimalInput()
                .consoleID("vigie.settings.budget")
            TextField(ControlText.vigieRepos, text: reposBinding(current), prompt: Text(ControlText.vigieReposPrompt))
                .consolePlainInput()
                .consoleID("vigie.settings.repos")
            Button(ControlText.vigieSave) {
                let settings = edited(current)
                Task {
                    if await vigie.save(settings) { drafts.vigieSettings = nil }
                }
            }
            .disabled(!server.isAdmin || vigie.isSaving || drafts.vigieSettings == nil || drafts.vigieSettings == current)
            .consoleID("vigie.settings.save")
        } header: {
            Text(ControlText.vigieSettingsTitle)
        } footer: {
            Text(ControlText.vigieAdminHint)
        }
        .disabled(!server.isAdmin)
    }

    private func edited(_ current: VigieSettings) -> VigieSettings { drafts.vigieSettings ?? current }

    private func field<Value>(_ key: WritableKeyPath<VigieSettings, Value>, _ current: VigieSettings) -> Binding<Value> {
        Binding(
            get: { edited(current)[keyPath: key] },
            set: { value in
                var next = edited(current)
                next[keyPath: key] = value
                drafts.vigieSettings = next
            }
        )
    }

    private func reposBinding(_ current: VigieSettings) -> Binding<String> {
        Binding(
            get: { edited(current).repos.joined(separator: ", ") },
            set: { text in
                var next = edited(current)
                next.repos = text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                drafts.vigieSettings = next
            }
        )
    }

    private func incidentsSection(_ view: VigieView) -> some View {
        Section {
            Picker(ControlText.incidentsTitle, selection: $vigie.statusFilter) {
                Text(ControlText.allStatuses).tag(VigieIncidentStatus?.none)
                ForEach(VigieIncidentStatus.allCases) { status in
                    Text(ControlText.incidentStatus(status.rawValue)).tag(Optional(status))
                }
            }
            .consoleID("vigie.incidents.filter")
            if vigie.incidents.isEmpty {
                Text(ControlText.noIncident).foregroundStyle(.secondary)
            }
            ForEach(vigie.incidents) { incident in
                VigieIncidentRow(drafts: drafts, incident: incident)
            }
        } header: {
            Text(ControlText.incidentsTitle)
        }
    }
}

struct VigieIncidentRow: View {
    @ObservedObject var drafts: HarnessDrafts
    let incident: VigieIncident

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(incident.triage?.title.isEmpty == false ? incident.triage?.title ?? incident.message : incident.message)
                .font(.headline)
                .consoleReadable()
            ConsoleStatusChip(status: ConsoleStatus(text: ControlText.incidentStatus(incident.status), tone: Self.tone(incident.phase)))
            Text([incident.source, incident.location, incident.repo].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(.secondary)
                .consoleReadable()
            Text(ControlText.occurrences(incident.count, last: ConsoleFormat.relative(ms: incident.lastAt, nowMs: Date().timeIntervalSince1970 * 1000)))
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(ControlText.fingerprint + " " + incident.shortFingerprint)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .consoleReadable()
            if let symptom = incident.triage?.symptom, !symptom.isEmpty {
                Text(symptom)
                    .font(.callout)
                    .consoleReadable()
            }
            if let note = incident.note, !note.isEmpty {
                Text(note)
                    .font(.caption)
                    .consoleReadable()
            }
            HStack {
                if let number = incident.issueNumber, let url = incident.issueUrl.flatMap(URL.init(string:)) {
                    Link(ControlText.issueNumber(number), destination: url)
                        .consoleID("vigie.incident.issue")
                }
                if let runId = incident.fixRunId ?? incident.runId {
                    Button(incident.fixRunId != nil ? ControlText.fixRun : ControlText.incidentRun) {
                        drafts.sessionRequest = HarnessSessionRequest(target: .run(runId), title: incident.fixRunId != nil ? ControlText.fixRun : ControlText.incidentRun)
                    }
                    .buttonStyle(.bordered)
                    .consoleID("vigie.incident.run")
                }
            }
        }
        .padding(.vertical, 2)
    }

    static func tone(_ phase: VigieIncidentStatus?) -> ConsoleTone {
        switch phase {
        case .new, .bug, .deferred: .attention
        case .reported, .fixing, .watching: .info
        case .resolved: .success
        case .noise, nil: .neutral
        }
    }
}

// MARK: - Planifications

public struct SchedulesSections: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var schedules: HarnessSchedules
    @ObservedObject var drafts: HarnessDrafts

    public init(server: HarnessModel, drafts: HarnessDrafts) {
        self.server = server
        self.schedules = server.schedules
        self.drafts = drafts
    }

    public var body: some View {
        if let failure = schedules.failure {
            ConsoleFailureBanner(failure: failure)
        }
        ControlAvailabilityNotice(availability: schedules.availability)
        if schedules.availability == .available {
            listSection
        }
    }

    private var listSection: some View {
        Section {
            if schedules.schedules.isEmpty {
                Text(ControlText.noSchedule).foregroundStyle(.secondary)
                Button(ShellText.newSchedule, systemImage: PipelineServerText.newFeatureSymbol) { drafts.scheduleSheetShown = true }
                    .disabled(!server.canAct)
            }
            if let fired = schedules.lastFired {
                Text(ControlText.fired(ControlText.outcome(fired.outcome.status)) + " · " + fired.schedule.name)
                    .font(.caption)
                    .consoleBanner(tone: fired.outcome.status == "fired" ? .success : .attention)
            }
            ForEach(schedules.schedules) { schedule in
                ScheduleRow(server: server, schedules: schedules, drafts: drafts, schedule: schedule, timezone: schedules.timezone ?? "")
            }
        } header: {
            Text(ControlText.schedulesTitle)
        } footer: {
            Text(ControlText.scheduleCronHint)
        }
    }
}

/// « Nouvelle planification », en feuille (bouton « + » de la page Planifications).
struct NewScheduleSheet: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var schedules: HarnessSchedules
    @ObservedObject var drafts: HarnessDrafts

    init(server: HarnessModel, drafts: HarnessDrafts) {
        self.server = server
        self.schedules = server.schedules
        self.drafts = drafts
    }

    var body: some View {
        NavigationStack {
            Form {
                if let failure = schedules.failure {
                    ConsoleFailureBanner(failure: failure)
                }
                Section {
                    TextField(ControlText.scheduleName, text: $drafts.scheduleDraft.name, prompt: Text(ControlText.scheduleNamePrompt))
                        .consoleID("schedules.new.name")
                    Picker(ControlText.scheduleTarget, selection: $drafts.scheduleDraft.kind) {
                        ForEach(HarnessScheduleKind.allCases) { kind in
                            Text(ControlText.scheduleKind(kind.rawValue)).tag(kind)
                        }
                    }
                    .consoleSegmented()
                    .consoleID("schedules.new.kind")
                    Picker(ControlText.scheduleRepo, selection: repoBinding) {
                        ForEach(server.repos) { repo in
                            Text(repo.name).tag(repo.name)
                        }
                    }
                    .consoleID("schedules.new.repo")
                }
                Section {
                    switch drafts.scheduleDraft.kind {
                    case .run:
                        TextField(ControlText.scheduleTitle, text: $drafts.scheduleDraft.title)
                            .consoleID("schedules.new.title")
                        TextField(ControlText.scheduleRequest, text: $drafts.scheduleDraft.request, axis: .vertical)
                            .lineLimit(2...6)
                            .consoleID("schedules.new.request")
                        TextField(ControlText.scheduleBudget, text: $drafts.scheduleDraft.budget)
                            .consoleDecimalInput()
                            .consoleID("schedules.new.budget")
                    case .audit:
                        TextField(ControlText.scheduleFocus, text: $drafts.scheduleDraft.focus)
                            .consoleID("schedules.new.focus")
                    case .issues:
                        TextField(ControlText.scheduleLabel, text: $drafts.scheduleDraft.label)
                            .consolePlainInput()
                            .consoleID("schedules.new.label")
                    }
                }
                Section {
                    TextField(ControlText.scheduleCron, text: $drafts.scheduleDraft.cron, prompt: Text(ControlText.scheduleCronPrompt))
                        .consolePlainInput()
                        .font(.body.monospaced())
                        .consoleID("schedules.new.cron")
                    Toggle(ControlText.scheduleEnabled, isOn: $drafts.scheduleDraft.enabled)
                } footer: {
                    if let problem = drafts.scheduleDraft.problem, problem != .name {
                        Text(Self.message(problem))
                    } else {
                        Text(ControlText.scheduleCronHint)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(ControlText.newSchedule)
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.cancel) { drafts.scheduleSheetShown = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(ControlText.scheduleCreate) {
                        let draft = drafts.scheduleDraft
                        Task {
                            if await schedules.create(draft) != nil {
                                drafts.scheduleDraft = HarnessScheduleDraft()
                                drafts.scheduleSheetShown = false
                            }
                        }
                    }
                    .disabled(!server.canAct || schedules.isSaving || drafts.scheduleDraft.problem != nil)
                    .consoleID("schedules.new.create")
                }
            }
        }
        .consoleSheetSize(minWidth: 520, minHeight: 480)
        .task { await server.refreshCatalog() }
    }

    /// Le dépôt saisi, sinon le premier déclaré (posé dans la saisie au premier rendu).
    private var repoBinding: Binding<String> {
        Binding(
            get: {
                let typed = drafts.scheduleDraft.repo
                return server.repos.contains(where: { $0.name == typed }) ? typed : (server.repos.first?.name ?? "")
            },
            set: { drafts.scheduleDraft.repo = $0 }
        )
    }

    static func message(_ problem: HarnessScheduleDraft.Problem) -> String {
        switch problem {
        case .name: ControlText.scheduleProblemName
        case .cron: ControlText.scheduleProblemCron
        case .repo: ControlText.scheduleProblemRepo
        case .request: ControlText.scheduleProblemRequest
        case .budget: ControlText.budgetInvalid
        }
    }
}

struct ScheduleRow: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var schedules: HarnessSchedules
    @ObservedObject var drafts: HarnessDrafts
    let schedule: HarnessSchedule
    let timezone: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Toggle(isOn: enabledBinding) {
                Text(schedule.name)
                    .font(.headline)
            }
            .disabled(!server.canAct || schedules.busy.contains(schedule.id))
            .consoleID("schedules.enabled")
            Text(ControlText.scheduleKind(schedule.target.kind) + " · " + schedule.repo)
                .font(.callout)
            if let title = schedule.target.title, !title.isEmpty {
                Text(title)
                    .font(.caption)
                    .consoleReadable()
            }
            Text(schedule.cron)
                .font(.caption.monospaced())
            if schedule.enabled, let next = schedule.nextRunAt {
                Text(ControlText.nextRun(ConsoleFormat.dateTime(ms: next), timezone: timezone))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if !schedule.enabled {
                Text(ControlText.scheduleDisabled)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let outcome = schedule.lastOutcome {
                Text(ControlText.lastRun(ConsoleFormat.dateTime(ms: outcome.at), outcome: ControlText.outcome(outcome.status)))
                    .font(.caption)
                    .foregroundStyle(outcome.status == "fired" ? Color.secondary : Color.orange)
                if !outcome.detail.isEmpty {
                    Text(outcome.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .consoleReadable()
                }
            }
            if let by = schedule.createdBy {
                Text(ControlText.createdBy(by))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack {
                Button(ControlText.scheduleRunNow) {
                    Task { await schedules.runNow(schedule) }
                }
                .buttonStyle(.bordered)
                .consoleID("schedules.runNow")
                Button(ControlText.scheduleDelete, role: .destructive) {
                    drafts.scheduleRemoval = schedule
                }
                .buttonStyle(.bordered)
                .consoleID("schedules.delete")
            }
            .disabled(!server.canAct || schedules.busy.contains(schedule.id))
        }
        .padding(.vertical, 2)
    }

    private var enabledBinding: Binding<Bool> {
        Binding(get: { schedule.enabled }, set: { on in Task { await schedules.setEnabled(schedule, on) } })
    }
}

// MARK: - Administration

public struct AdminSections: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var admin: HarnessAdmin
    @ObservedObject var drafts: HarnessDrafts

    public init(server: HarnessModel, drafts: HarnessDrafts) {
        self.server = server
        self.admin = server.admin
        self.drafts = drafts
    }

    /// Les sources des erreurs des clients (`POST /v1/client-errors`).
    static let sources = ["mac", "ios", "chrome", "omp", "vigie"]

    public var body: some View {
        if !server.isAdmin {
            Section { Text(ControlText.adminOnly).foregroundStyle(.secondary) }
        } else {
            if let failure = admin.failure {
                ConsoleFailureBanner(failure: failure)
            }
            clientsSection
            reposSection
            reloadSection
            errorsSection
        }
    }

    private var clientsSection: some View {
        Section {
            ForEach(admin.clients) { client in
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(client.name).font(.headline)
                        if client.approver { Text(ControlText.approverBadge).font(.caption).foregroundStyle(.orange) }
                        if client.pilot == true { Text(ControlText.pilotBadge).font(.caption).foregroundStyle(.blue) }
                    }
                    Text(ControlText.role(client.role) + " · " + (client.repos?.joined(separator: ", ") ?? ControlText.clientAllRepos))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button(ControlText.clientRevoke, role: .destructive) { drafts.clientRevocation = client }
                        .buttonStyle(.bordered)
                        .disabled(admin.isSaving)
                        .consoleID("admin.client.revoke")
                }
            }
            if let created = admin.created {
                VStack(alignment: .leading, spacing: 4) {
                    Text(ControlText.clientToken + " · " + created.client.name)
                        .font(.headline)
                    Text(created.token)
                        .font(.caption.monospaced())
                        .consoleReadable()
                        .consoleID("admin.client.token")
                    Text(ControlText.clientTokenHint)
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                .consoleBanner(tone: .attention)
            }
            TextField(ControlText.clientName, text: $drafts.clientName, prompt: Text(ControlText.clientNamePrompt))
                .consolePlainInput()
                .consoleID("admin.client.name")
            Picker(ControlText.clientRole, selection: $drafts.clientRole) {
                ForEach(["viewer", "operator", "admin"], id: \.self) { role in
                    Text(ControlText.role(role)).tag(role)
                }
            }
            .consoleSegmented()
            .consoleID("admin.client.role")
            if !server.repos.isEmpty {
                Text(ControlText.clientRepos + " · " + (drafts.clientRepos.isEmpty ? ControlText.clientAllRepos : drafts.clientRepos.sorted().joined(separator: ", ")))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                ForEach(server.repos) { repo in
                    Toggle(repo.name, isOn: repoBinding(repo.name))
                }
            }
            Button(ControlText.clientCreate) {
                let name = drafts.clientName
                let role = drafts.clientRole
                let repos = drafts.clientRepos.sorted()
                Task {
                    if await admin.createClient(name: name, role: role, repos: repos) != nil { drafts.clearClient() }
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(admin.isSaving || drafts.clientName.trimmingCharacters(in: .whitespaces).isEmpty)
            .consoleID("admin.client.create")
        } header: {
            Text(ControlText.clientsTitle)
        }
    }

    private func repoBinding(_ name: String) -> Binding<Bool> {
        Binding(
            get: { drafts.clientRepos.contains(name) },
            set: { on in if on { drafts.clientRepos.insert(name) } else { drafts.clientRepos.remove(name) } }
        )
    }

    private var reposSection: some View {
        Section {
            ForEach(admin.repos) { repo in
                VStack(alignment: .leading, spacing: 2) {
                    Text(repo.name).font(.headline)
                    Text([repo.scope, repo.mainBranch, repo.merge].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            TextField(ControlText.repoURL, text: $drafts.repoURL, prompt: Text(ControlText.repoURLPrompt))
                .consolePlainInput()
                .consoleID("admin.repo.url")
            TextField(ControlText.repoShortName, text: $drafts.repoName)
                .consolePlainInput()
                .consoleID("admin.repo.name")
            Button(ControlText.repoAdd) {
                let url = drafts.repoURL
                let name = drafts.repoName
                Task {
                    if let declared = await admin.declareRepo(url: url, name: name), declared.added {
                        drafts.repoURL = ""
                        drafts.repoName = ""
                    }
                }
            }
            .disabled(admin.isSaving || drafts.repoURL.trimmingCharacters(in: .whitespaces).isEmpty)
            .consoleID("admin.repo.add")
            if let declared = admin.declared {
                VStack(alignment: .leading, spacing: 4) {
                    Text(ControlText.repoDeclared(declared.repo, added: declared.added))
                        .font(.headline)
                    if !declared.message.isEmpty {
                        Text(declared.message)
                            .font(.caption)
                            .consoleReadable()
                    }
                    if let key = declared.deployKey {
                        Text(ControlText.deployKey)
                            .font(.subheadline.weight(.semibold))
                        Text(key.publicKey)
                            .font(.caption.monospaced())
                            .consoleReadable()
                            .fixedSize(horizontal: false, vertical: true)
                            .consoleID("admin.repo.deployKey")
                        Text(ControlText.deployKeyHint)
                            .font(.caption)
                        if let page = key.url.flatMap(URL.init(string:)) {
                            Link(ControlText.deployKeyOpen, destination: page)
                        }
                    }
                }
                .consoleBanner(tone: declared.added ? .success : .attention)
            }
        } header: {
            Text(ControlText.reposTitle)
        }
    }

    private var reloadSection: some View {
        Section {
            Button(ControlText.reload) {
                Task { await admin.reload() }
            }
            .disabled(admin.isSaving)
            .consoleID("admin.reload")
            if let summary = admin.reloaded {
                Text(ControlText.reloaded(repos: summary.repos, added: summary.added, removed: summary.removed))
                    .font(.caption)
                    .consoleReadable()
            }
        } header: {
            Text(ControlText.reloadTitle)
        } footer: {
            Text(ControlText.reloadHint)
        }
    }

    @ViewBuilder
    private var errorsSection: some View {
        if let errors = admin.clientErrors {
            Section {
                Picker(ControlText.errorsTitle, selection: $admin.errorSource) {
                    Text(ControlText.allSources).tag(String?.none)
                    ForEach(Self.sources, id: \.self) { source in
                        Text(ControlText.source(source)).tag(Optional(source))
                    }
                }
                .consoleID("admin.errors.source")
                if errors.isEmpty {
                    Text(ControlText.noClientError).foregroundStyle(.secondary)
                }
                ForEach(errors) { error in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(error.message)
                            .font(.callout)
                            .consoleReadable()
                        Text([ConsoleFormat.dateTime(ms: error.at), ControlText.source(error.source), error.client, error.version, error.kind].joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            } header: {
                Text(ControlText.errorsTitle)
            }
        }
    }
}

// MARK: - Issues

public struct IssuesSections: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var issues: HarnessIssues
    @ObservedObject var drafts: HarnessDrafts

    public init(server: HarnessModel, drafts: HarnessDrafts) {
        self.server = server
        self.issues = server.issues
        self.drafts = drafts
    }

    public var body: some View {
        if let failure = issues.failure {
            ConsoleFailureBanner(failure: failure)
        }
        Section {
            Picker(ControlText.issuesRepo, selection: repoBinding) {
                ForEach(server.repos) { repo in
                    Text(repo.name).tag(repo.name)
                }
            }
            .consoleID("issues.repo")
            if let fix = issues.lastFix {
                Text(ControlText.fixed(fix.issue, launched: fix.status == "launched"))
                    .font(.callout)
                    .consoleBanner(tone: fix.status == "launched" ? .success : .neutral)
            }
            if issues.issues.isEmpty, !issues.isLoading {
                Text(ControlText.noIssue).foregroundStyle(.secondary)
            }
            ForEach(issues.issues) { issue in
                IssueRow(server: server, issues: issues, drafts: drafts, issue: issue)
            }
        } header: {
            Text(ControlText.issuesTitle)
        } footer: {
            Text(ControlText.issuesHint)
        }
        .task(id: drafts.issuesRepo(in: server.repos)) {
            await issues.refresh(repo: drafts.issuesRepo(in: server.repos))
        }
    }

    private var repoBinding: Binding<String> {
        Binding(get: { drafts.issuesRepo(in: server.repos) ?? "" }, set: { drafts.issuesRepo = $0 })
    }
}

struct IssueRow: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var issues: HarnessIssues
    @ObservedObject var drafts: HarnessDrafts
    let issue: HarnessIssue

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(issue.title)
                .font(.headline)
                .consoleReadable()
            Text(ControlText.issueLine(issue.number, author: issue.author))
                .font(.caption)
                .foregroundStyle(.secondary)
            if !issue.labels.isEmpty {
                Text(issue.labels.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let run = issue.run {
                ConsoleStatusChip(status: ConsoleStatus(text: PipelineServerText.state(run.state), tone: Self.tone(run.phase)))
                Button(ControlText.openSession) {
                    drafts.sessionRequest = HarnessSessionRequest(target: .run(run.id), title: issue.title)
                }
                .buttonStyle(.bordered)
                .consoleID("issues.session")
            }
            HStack {
                Button(ControlText.fix) {
                    Task { await issues.fix(issue) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!server.canAct || issue.isCarried || issues.busy.contains(issue.number))
                .consoleID("issues.fix.\(issue.number)")
                if let url = URL(string: issue.url), !issue.url.isEmpty {
                    Link(ControlText.issueOpen, destination: url)
                }
            }
            if issue.isCarried {
                Text(ControlText.issueCarried)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    static func tone(_ phase: HarnessRunState?) -> ConsoleTone {
        switch phase {
        case .running, .merging: .info
        case .escalated, .awaitingHuman: .attention
        case .merged: .success
        case .failed: .danger
        case .queued, .cancelled, nil: .neutral
        }
    }
}

// MARK: - Confirmations

extension View {
    /// Les confirmations des gestes destructifs de l'exploitation : supprimer une
    /// planification, révoquer un client.
    public func controlGestures(server: HarnessModel, drafts: HarnessDrafts) -> some View {
        modifier(ControlGestures(server: server, drafts: drafts))
    }
}

private struct ControlGestures: ViewModifier {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    func body(content: Content) -> some View {
        content
            .confirmationDialog(
                ControlText.scheduleDeleteConfirm,
                isPresented: Binding(get: { drafts.scheduleRemoval != nil }, set: { if !$0 { drafts.scheduleRemoval = nil } }),
                titleVisibility: .visible,
                presenting: drafts.scheduleRemoval
            ) { schedule in
                Button(ControlText.scheduleDelete, role: .destructive) {
                    Task { await server.schedules.delete(schedule) }
                }
                Button(PipelineServerText.cancel, role: .cancel) {}
            } message: { _ in
                Text(ControlText.scheduleDeleteMessage)
            }
            .confirmationDialog(
                ControlText.clientRevokeConfirm,
                isPresented: Binding(get: { drafts.clientRevocation != nil }, set: { if !$0 { drafts.clientRevocation = nil } }),
                titleVisibility: .visible,
                presenting: drafts.clientRevocation
            ) { client in
                Button(ControlText.clientRevoke, role: .destructive) {
                    Task { await server.admin.revoke(client) }
                }
                Button(PipelineServerText.cancel, role: .cancel) {}
            } message: { _ in
                Text(ControlText.clientRevokeMessage)
            }
    }
}
