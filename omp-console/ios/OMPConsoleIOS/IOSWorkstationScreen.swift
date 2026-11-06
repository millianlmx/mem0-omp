import Charts
import ConsoleClient
import ConsoleCore
import SwiftUI

// La section « Poste » de l'app iOS : le poste de travail observé par l'extension
// Chrome et l'agent 24/24 du serveur, en liste groupée dans le cadre commun des
// écrans du serveur (`IOSHarnessScreen`). En tête, l'état de l'extension et
// l'observation, l'autonomie — avec, toujours visible, la garde d'envoi qu'aucun mode
// ne lève —, la pause et les adresses de l'utilisateur ; puis les envois à approuver,
// le profil et l'activité observée, le journal des décisions et les réunions.
//
// Le modèle (`WorkstationModel`, porté par `HarnessModel`) et les brouillons viennent
// du client partagé, comme sur le Mac ; les mots viennent de `WorkstationText` :
// aucun libellé en dur ici (`design-ios/AC-5`). Sur iPhone, la section est rangée
// sous « Plus » : ses envois à approuver remontent aussi sur l'Accueil.

struct IOSWorkstationScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        IOSHarnessScreen(server: server, drafts: drafts, section: .workstation, catalog: false, reloadAlso: { await workstation.load() }) {
            // Le refus d'un jeton non approbateur se dit là où sont les gestes (réglages,
            // envois à approuver), pas en tête.
            if let failure = workstation.failure, failure != .approverOnly {
                Text(failure.message)
                    .font(.callout)
                    .iosBanner(tone: .attention)
                    .iosBareListRow()
            }
            switch workstation.availability {
            case .absent:
                Section {
                    Text(WorkstationText.absent).foregroundStyle(.secondary)
                }
            case .reserved(let motive):
                Text(HarnessFailure.forbidden(motive).message)
                    .font(.callout)
                    .iosBanner(tone: .attention)
                    .iosBareListRow()
            case .unknown:
                Section {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                }
            case .available:
                if let status = workstation.status {
                    IOSWorkstationStatusSections(workstation: workstation, drafts: drafts, status: status)
                }
                IOSWorkstationApprovalsSection(workstation: workstation, drafts: drafts)
                IOSWorkstationProfileSections(workstation: workstation)
                IOSWorkstationJournalSection(journal: workstation.journal)
                IOSWorkstationMeetingsSection(meetings: workstation.meetings)
            }
        }
        .task { await workstation.load() }
    }
}

// MARK: - État, autonomie, pause, adresses

struct IOSWorkstationStatusSections: View {
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var drafts: HarnessDrafts
    let status: WorkstationStatus

    var body: some View {
        Section {
            IOSStatusChip(status: ConsoleStatus(
                text: status.online ? WorkstationText.online : WorkstationText.offline,
                tone: status.online ? .success : .neutral
            ))
            if let seen = status.lastSeenAt {
                Text(WorkstationText.lastSeen(ConsoleFormat.relative(ms: seen, nowMs: Date().timeIntervalSince1970 * 1000)))
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                Text(WorkstationText.neverSeen)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            if let version = status.extensionVersion {
                Text(WorkstationText.version(version))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ProgressView(value: status.observedProgress) {
                Text(WorkstationText.observedTitle)
            } currentValueLabel: {
                Text(WorkstationText.observed(seconds: status.observedSeconds, thresholdHours: status.thresholdHours))
                    .monospacedDigit()
            }
            if let shift = status.lastShift {
                Text(WorkstationText.lastShift(ConsoleFormat.dateTime(ms: shift.at), actions: shift.actions))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let next = status.nextShiftAt {
                Text(WorkstationText.nextShift(ConsoleFormat.dateTime(ms: next)))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text(WorkstationText.statusTitle)
        } footer: {
            Text(WorkstationText.observedHint)
        }

        Section {
            Picker(WorkstationText.autonomyLabel, selection: autonomyBinding) {
                ForEach(WorkstationAutonomySetting.allCases) { setting in
                    Text(WorkstationText.autonomy(setting.rawValue)).tag(setting)
                }
            }
            .disabled(!workstation.canAct || workstation.isSaving)
            .accessibilityIdentifier("ios.workstation.autonomy")
            if let hint = WorkstationText.autonomyHint(status.autonomy.setting) {
                Text(hint)
                    .font(.callout)
            }
            if status.autonomySetting == .auto {
                Text(WorkstationText.effective(WorkstationText.autonomy(status.autonomy.effective)))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Label(WorkstationText.sendGuard, systemImage: WorkstationText.sendGuardSymbol)
                .font(.callout)
                .foregroundStyle(.orange)
                .accessibilityIdentifier("ios.workstation.sendGuard")
            if workstation.failure == .approverOnly {
                IOSApproverOnlyNotice()
            }
            Toggle(isOn: pausedBinding) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(WorkstationText.pauseLabel)
                    Text(WorkstationText.pauseHint)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .disabled(!workstation.canAct || workstation.isSaving)
            .accessibilityIdentifier("ios.workstation.paused")
        } header: {
            Text(WorkstationText.autonomyLabel)
        }

        Section {
            TextField(WorkstationText.identitiesLabel, text: identitiesBinding, prompt: Text(WorkstationText.identitiesPrompt), axis: .vertical)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .disabled(!workstation.canAct)
                .accessibilityIdentifier("ios.workstation.identities")
            Button(WorkstationText.identitiesSave) {
                let identities = WorkstationModel.identities(from: drafts.workstationIdentities ?? "")
                Task {
                    if await workstation.setSelfIdentities(identities) { drafts.workstationIdentities = nil }
                }
            }
            .disabled(!workstation.canAct || workstation.isSaving || !drafts.identitiesChanged(from: status))
            .accessibilityIdentifier("ios.workstation.identities.save")
        } header: {
            Text(WorkstationText.identitiesLabel)
        } footer: {
            Text(WorkstationText.identitiesHint)
        }
    }

    private var autonomyBinding: Binding<WorkstationAutonomySetting> {
        Binding(
            get: { status.autonomySetting ?? .auto },
            set: { setting in Task { await workstation.setAutonomy(setting) } }
        )
    }

    private var pausedBinding: Binding<Bool> {
        Binding(get: { status.paused }, set: { paused in Task { await workstation.setPaused(paused) } })
    }

    private var identitiesBinding: Binding<String> {
        Binding(
            get: { drafts.workstationIdentities ?? WorkstationModel.identitiesText(status.selfIdentities) },
            set: { drafts.workstationIdentities = $0 }
        )
    }
}

// MARK: - Envois à approuver

/// Les envois qui attendent l'humain, chacun avec ses destinataires et le message, et
/// les deux gestes : approuver, ou refuser avec une raison facultative.
struct IOSWorkstationApprovalsSection: View {
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        Section {
            if workstation.approvals.isEmpty {
                Text(WorkstationText.noApproval).foregroundStyle(.secondary)
            }
            if workstation.failure == .approverOnly {
                IOSApproverOnlyNotice()
            }
            ForEach(workstation.approvals) { action in
                IOSWorkstationApprovalRow(workstation: workstation, drafts: drafts, action: action)
            }
        } header: {
            Text(WorkstationText.approvalsTitle)
        } footer: {
            Text(WorkstationText.approvalsHint)
        }
    }
}

/// Sur l'Accueil : les envois à approuver, seulement quand il y en a.
struct IOSWorkstationHomeApprovals: View {
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        if !workstation.approvals.isEmpty {
            IOSWorkstationApprovalsSection(workstation: workstation, drafts: drafts)
        }
    }
}

/// Le jeton de cette app n'est pas l'approbateur : où obtenir le bon, au plus près des gestes.
struct IOSApproverOnlyNotice: View {
    var body: some View {
        Text(HarnessFailure.approverOnly.message)
            .font(.callout)
            .fixedSize(horizontal: false, vertical: true)
            .iosBanner(tone: .attention)
            .accessibilityIdentifier("ios.workstation.approverOnly")
    }
}

struct IOSWorkstationApprovalRow: View {
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var drafts: HarnessDrafts
    let action: WorkstationAction

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Une action proposée par l'agent 24/24 se distingue d'un envoi de message :
            // l'approuver n'autorise aucun envoi.
            if action.isProposal {
                Label(WorkstationText.proposal, systemImage: WorkstationText.proposalSymbol)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // Le résumé et le message se lisent EN ENTIER avant d'approuver : jamais tronqués
            // (une rangée de List les couperait sur une ligne).
            Text(action.approval?.summary ?? action.rationale)
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
            Text(WorkstationText.recipients(action.approval?.recipients ?? []))
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            if let preview = action.approval?.preview, !preview.isEmpty {
                Text(preview)
                    .fixedSize(horizontal: false, vertical: true)
                    .iosBanner(tone: .neutral)
                    .accessibilityLabel(Text(WorkstationText.previewLabel))
                    .accessibilityValue(Text(preview))
            }
            if action.approval?.summary != action.rationale {
                Text(action.rationale)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if action.isProposal {
                Text(WorkstationText.proposalHint)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(WorkstationText.origin(action.origin) + " · " + ConsoleFormat.dateTime(ms: action.createdAt))
                .font(.caption)
                .foregroundStyle(.secondary)
            ViewThatFits(in: .horizontal) {
                HStack { buttons }
                VStack(alignment: .leading, spacing: 8) { buttons }
            }
            .disabled(!workstation.canAct || workstation.busy.contains(action.seq))
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var buttons: some View {
        Button(WorkstationText.approve) {
            Task { await workstation.approve(shown: action) }
        }
        .buttonStyle(.borderedProminent)
        .accessibilityIdentifier("ios.workstation.approve.\(action.seq)")
        Button(PipelineServerText.refuse, role: .destructive) {
            drafts.beginWorkstationRefusal(action)
        }
        .buttonStyle(.bordered)
        .accessibilityIdentifier("ios.workstation.refusal.\(action.seq)")
    }
}

// MARK: - Profil et activité

struct IOSWorkstationProfileSections: View {
    @ObservedObject var workstation: WorkstationModel

    var body: some View {
        let reply = workstation.profile
        Section {
            if let profile = reply?.profile {
                Text(profile.summary)
                Text(WorkstationText.profileVersion(
                    profile.version,
                    updated: ConsoleFormat.relative(ms: profile.updatedAt, nowMs: Date().timeIntervalSince1970 * 1000)
                ))
                .font(.caption)
                .foregroundStyle(.secondary)
            } else {
                Text(WorkstationText.noProfile).foregroundStyle(.secondary)
            }
            Button(WorkstationText.rebuild) {
                Task { await workstation.rebuildProfile() }
            }
            .disabled(!workstation.canAct || workstation.isSaving)
            .accessibilityIdentifier("ios.workstation.rebuild")
            if workstation.rebuildQueued {
                Text(WorkstationText.rebuildQueued)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text(WorkstationText.profileTitle)
        }

        if let profile = reply?.profile {
            if !profile.habits.isEmpty {
                Section(WorkstationText.habits) {
                    ForEach(profile.habits, id: \.self) { Text($0) }
                }
            }
            if !profile.tools.isEmpty {
                Section(WorkstationText.tools) {
                    ForEach(profile.tools, id: \.name) { tool in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(tool.name)
                            Text(tool.usage)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            if !profile.schedule.isEmpty {
                Section(WorkstationText.schedule) {
                    Text(profile.schedule)
                }
            }
            if !profile.repetitiveTasks.isEmpty {
                Section(WorkstationText.repetitiveTasks) {
                    ForEach(profile.repetitiveTasks, id: \.title) { task in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(task.title)
                            Text(task.frequency)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            if !task.steps.isEmpty {
                                Text(task.steps.joined(separator: " → "))
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                            }
                            if task.automatable {
                                Label(WorkstationText.automatable, systemImage: WorkstationText.automatableSymbol)
                                    .font(.caption)
                                    .foregroundStyle(.green)
                            }
                        }
                    }
                }
            }
            if !profile.clientNeeds.isEmpty {
                Section(WorkstationText.clientNeeds) {
                    ForEach(Array(profile.clientNeeds.enumerated()), id: \.offset) { _, need in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(need.need)
                            if let who = need.who {
                                Text(WorkstationText.forWhom(who))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            if !profile.preferences.isEmpty {
                Section(WorkstationText.preferences) {
                    ForEach(profile.preferences, id: \.self) { Text($0) }
                }
            }
        }

        IOSWorkstationActivitySection(stats: reply?.stats ?? WorkstationProfileStats())
    }
}

/// L'activité observée : les sites les plus fréquentés et les heures actives, tracés.
/// Les graphiques grandissent avec le texte (`minHeight`, jamais une hauteur figée).
struct IOSWorkstationActivitySection: View {
    let stats: WorkstationProfileStats

    var body: some View {
        Section {
            if stats.topSites.isEmpty && stats.activeHourBars.isEmpty {
                Text(WorkstationText.noActivity).foregroundStyle(.secondary)
            } else {
                if let since = stats.since {
                    Text(WorkstationText.since(ConsoleFormat.dateTime(ms: since)))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if !stats.topSites.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(WorkstationText.topSites)
                            .font(.subheadline)
                        Chart(stats.topSites) { site in
                            BarMark(
                                x: .value(WorkstationText.axisTime, site.seconds / 3600),
                                y: .value(WorkstationText.axisSite, site.host)
                            )
                            .cornerRadius(3)
                            .accessibilityLabel(Text(site.host))
                            .accessibilityValue(Text(WorkstationText.siteShare(site.host, seconds: site.seconds, share: site.share)))
                        }
                        .chartXAxis(.hidden)
                        .frame(minHeight: CGFloat(stats.topSites.count) * 32 + 8)
                    }
                }
                if !stats.activeHourBars.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(WorkstationText.activeHours)
                            .font(.subheadline)
                        Chart(stats.activeHourBars) { bar in
                            BarMark(
                                x: .value(WorkstationText.axisHour, bar.hour),
                                y: .value(WorkstationText.axisTime, bar.seconds / 60)
                            )
                            .accessibilityLabel(Text(WorkstationText.hour(bar.hour)))
                            .accessibilityValue(Text(WorkstationText.observedTime(seconds: bar.seconds)))
                        }
                        .chartXScale(domain: 0...23)
                        .chartXAxis {
                            AxisMarks(values: [0, 6, 12, 18, 23]) { value in
                                AxisGridLine()
                                AxisValueLabel {
                                    if let hour = value.as(Int.self) { Text(WorkstationText.hour(hour)) }
                                }
                            }
                        }
                        .chartYAxis(.hidden)
                        .frame(minHeight: 140)
                    }
                }
                if !stats.sequences.isEmpty {
                    Text(WorkstationText.sequences)
                        .font(.subheadline)
                    ForEach(Array(stats.sequences.prefix(5).enumerated()), id: \.offset) { _, sequence in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(sequence.steps.joined(separator: " → "))
                                .font(.caption.monospaced())
                            Text(WorkstationText.times(sequence.count))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        } header: {
            Text(WorkstationText.activityTitle)
        }
    }
}

// MARK: - Journal des décisions

struct IOSWorkstationJournalSection: View {
    let journal: [WorkstationAction]

    var body: some View {
        Section {
            if journal.isEmpty {
                Text(WorkstationText.noAction).foregroundStyle(.secondary)
            }
            ForEach(journal) { action in
                IOSWorkstationJournalRow(action: action)
            }
        } header: {
            Text(WorkstationText.journalTitle)
        } footer: {
            Text(WorkstationText.journalHint)
        }
    }
}

struct IOSWorkstationJournalRow: View {
    let action: WorkstationAction

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(WorkstationText.kind(action.kind))
                .font(.headline)
            IOSStatusChip(status: ConsoleStatus(text: WorkstationText.state(action.state), tone: Self.tone(of: action.phase)))
            Text(action.rationale)
            Text(WorkstationText.origin(action.origin) + " · " + ConsoleFormat.dateTime(ms: action.createdAt))
                .font(.caption)
                .foregroundStyle(.secondary)
            if let decision = action.decision {
                Text(decision.approved ? WorkstationText.approvedBy(decision.by) : WorkstationText.refusedBy(decision.by))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let reason = action.approval?.reason, !reason.isEmpty {
                Text(WorkstationText.reason(reason))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let error = action.error, !error.isEmpty {
                Text(WorkstationText.error(error))
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            if let result = action.shortResult {
                Text(WorkstationText.result(result))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    /// Le ton qui double l'état : l'attente se signale, l'échec et le refus alarment.
    static func tone(of phase: WorkstationActionState?) -> ConsoleTone {
        switch phase {
        case .awaitingApproval: .attention
        case .failed, .refused, .expired: .danger
        case .done: .success
        case .running: .info
        case .queued, nil: .neutral
        }
    }
}

// MARK: - Réunions

struct IOSWorkstationMeetingsSection: View {
    let meetings: [WorkstationMeeting]

    var body: some View {
        Section {
            if meetings.isEmpty {
                Text(WorkstationText.noMeeting).foregroundStyle(.secondary)
            }
            ForEach(meetings) { meeting in
                VStack(alignment: .leading, spacing: 4) {
                    Text(meeting.title)
                        .font(.headline)
                    Text(WorkstationText.meetingState(meeting.state) + " · " + ConsoleFormat.dateTime(ms: meeting.startedAt))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(WorkstationText.segments(meeting.segments))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let summary = meeting.summary, !summary.isEmpty {
                        Text(summary)
                    }
                    ForEach(Array(meeting.needs.enumerated()), id: \.offset) { _, need in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(need.need)
                                .font(.callout)
                            if let who = need.who {
                                Text(WorkstationText.forWhom(who))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            if let due = need.due {
                                Text(WorkstationText.due(due))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            if !need.quote.isEmpty {
                                Text(WorkstationText.quote(need.quote))
                                    .font(.caption.italic())
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                .padding(.vertical, 2)
            }
        } header: {
            Text(WorkstationText.meetingsTitle)
        }
    }
}

// MARK: - Gestes

extension View {
    /// La feuille du refus d'un envoi du poste de travail (raison facultative).
    func iosWorkstationGestures(workstation: WorkstationModel, drafts: HarnessDrafts) -> some View {
        modifier(IOSWorkstationGestures(workstation: workstation, drafts: drafts))
    }
}

private struct IOSWorkstationGestures: ViewModifier {
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var drafts: HarnessDrafts

    func body(content: Content) -> some View {
        content
            .sheet(item: $drafts.workstationRefusal) { action in
                refusalSheet(action)
            }
    }

    private func refusalSheet(_ action: WorkstationAction) -> some View {
        NavigationStack {
            Form {
                Section {
                    Text(action.approval?.summary ?? action.rationale)
                        .font(.headline)
                    TextField(PipelineServerText.reasonLabel, text: $drafts.workstationRefusalReason, axis: .vertical)
                        .accessibilityIdentifier("ios.workstation.refusal.reason")
                } footer: {
                    Text(WorkstationText.refuseHint)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(WorkstationText.refuseTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.cancel) { drafts.workstationRefusal = nil }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(PipelineServerText.refuse, role: .destructive) {
                        let reason = drafts.workstationRefusalReason
                        drafts.workstationRefusal = nil
                        Task { await workstation.refuse(shown: action, reason: reason) }
                    }
                    .accessibilityIdentifier("ios.workstation.refusal.commit")
                }
            }
        }
    }
}
