import ConsoleClient
import ConsoleCore
import SwiftUI

// Les écrans de pilotage de l'app iOS, tous servis par le serveur de pipelines du
// VPS (omp-harness), joint directement : Accueil (résumé et boîte de l'humain),
// Pipelines (features : lancer, suivre, arrêter), Projet, Audit et Statistiques.
//
// Un seul `HarnessModel` et un seul `HarnessDrafts` pour l'app (posés par
// `OMPConsoleIOSApp`) : le flux d'événements tient chaque écran à jour. Les mots
// viennent du noyau (`PipelineServerText`), les symboles de `IOSShellText` : aucun
// libellé en dur ici (`design-ios/AC-5`).

/// Le cadre commun : relier le serveur s'il ne l'est pas, sinon la liste groupée,
/// avec l'échec du dernier échange en tête, le tirer-pour-actualiser et le bouton
/// du serveur en barre.
struct IOSHarnessScreen<Content: View>: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let section: ConsoleSection
    let catalog: Bool
    @ViewBuilder let content: () -> Content

    var body: some View {
        Group {
            if !server.isLoaded {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if !server.isConfigured {
                notConfigured
            } else {
                // Une tuile du tableau de bord de l'Accueil demande une section de la
                // boîte (`homeAnchor`) : la liste y défile, puis oublie la demande.
                ScrollViewReader { proxy in
                    List {
                        if let failure = server.failure {
                            Text(failure.message)
                                .font(.callout)
                                .iosBanner(tone: .attention)
                                .iosBareListRow()
                        }
                        content()
                    }
                    .iosGroupedList()
                    .refreshable { await reload() }
                    .onChange(of: drafts.homeAnchor) { _, anchor in
                        guard let anchor else { return }
                        withAnimation(IOSMotion.scrollAnimation(reduceMotion: reduceMotion)) {
                            proxy.scrollTo(anchor.rawValue, anchor: .top)
                        }
                        drafts.homeAnchor = nil
                    }
                }
            }
        }
        .navigationTitle(section.title)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    drafts.serverSheetShown = true
                } label: {
                    Label(PipelineServerText.open, systemImage: IOSShellText.serverSymbol)
                }
                .accessibilityIdentifier("ios.server.open")
            }
        }
        .task {
            if catalog { await server.refreshCatalog() }
        }
        .iosHarnessGestures(server: server, drafts: drafts)
        // ⌘R relit l'écran comme le geste « tirer pour actualiser ».
        .focusedSceneValue(\.iosRefresh, IOSCommandAction(owner: section, isEnabled: server.isConfigured) {
            Task { await reload() }
        })
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ios.screen." + section.rawValue)
    }

    private func reload() async {
        await server.refresh()
        if catalog { await server.refreshCatalog() }
    }

    private var notConfigured: some View {
        VStack(spacing: 16) {
            Image(systemName: IOSShellText.serverSymbol)
                .font(.largeTitle)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text(PipelineServerText.notConfigured)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Button(PipelineServerText.configure) { drafts.serverSheetShown = true }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("ios.server.configure")
        }
        .padding()
        .iosReadableWidth()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Le choix du dépôt des lancements, parmi ceux que le serveur déclare.
struct IOSHarnessRepoPicker: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        if server.repos.isEmpty {
            Text(PipelineServerText.noRepo)
                .foregroundStyle(.secondary)
        } else {
            Picker(PipelineServerText.repoLabel, selection: Binding(
                get: { drafts.launchRepo(in: server.repos) ?? "" },
                set: { drafts.repo = $0 }
            )) {
                ForEach(server.repos) { repo in
                    Text(repo.name).tag(repo.name)
                }
            }
        }
    }
}

/// Une feature : titre, état et étape, reprise différée ou dernier échec, corrections ;
/// son menu ouvre le direct de sa session, la suit sur l'écran verrouillé (Live
/// Activity), demande l'arrêt, la relance (en échec ou arrêtée sur une attente) ou
/// l'annulation d'une feature fusionnée, ces trois gestes confirmés par `iosHarnessGestures`.
struct IOSHarnessRunRow: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @EnvironmentObject private var activities: IOSLiveActivityCenter
    let run: HarnessRun

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(run.title)
            IOSStatusChip(status: ConsoleStatus(text: run.statusLine, tone: Self.tone(of: run.phase)))
            if let detail = run.detailLine() {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if run.fixes > 0 {
                Text(PipelineServerText.fixes(run.fixes))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let cost = server.inbox?.costs[run.id] {
                Label(MonitoringText.cost(cost), systemImage: MonitoringText.costSymbol)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(server.inbox?.alerts(of: run.id) ?? []) { alert in
                Label(alert.line, systemImage: alert.symbol)
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
        .contextMenu {
            if run.canFollowSession {
                Button(PipelineServerText.sessionTitle, systemImage: PipelineServerText.sessionSymbol) { drafts.sessionRequest = HarnessSessionRequest(run: run) }
            }
            if activities.isAvailable, run.phase.map({ ![.merged, .failed, .cancelled].contains($0) }) ?? false {
                Button(
                    activities.isFollowing(run.id) ? MonitoringText.activityStop : MonitoringText.activityStart,
                    systemImage: MonitoringText.activitySymbol
                ) { activities.toggle(run, with: server) }
            }
            if run.canRetry {
                Button(PipelineServerText.retry) { drafts.retryRequest = run }
            }
            if run.canRevert {
                Button(PipelineServerText.revertFeature, role: .destructive) { drafts.revertRequest = run }
            }
            if let phase = run.phase, [.queued, .running, .escalated, .awaitingHuman].contains(phase) {
                Button(PipelineServerText.stopFeature, role: .destructive) { drafts.stopRequest = run }
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// Le ton qui double l'état : l'attente de l'humain se signale, l'échec alarme.
    static func tone(of phase: HarnessRunState?) -> ConsoleTone {
        switch phase {
        case .running, .merging: .info
        case .escalated, .awaitingHuman: .attention
        case .merged: .success
        case .failed: .danger
        case .queued, .cancelled, nil: .neutral
        }
    }
}

// MARK: - Accueil

/// L'Accueil : le tableau de bord d'abord (KPIs et graphiques, pour comprendre d'un
/// coup d'œil ce qui se passe sur tous les projets), puis les alertes et la boîte.
struct IOSHarnessHomeScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        IOSHarnessScreen(server: server, drafts: drafts, section: .home, catalog: true) {
            let inbox = server.inbox ?? HarnessInbox()
            IOSDashboardSections(server: server, drafts: drafts, dashboard: HarnessDashboard(inbox: inbox, stats: server.stats))
            IOSAlertsSection(drafts: drafts, inbox: inbox)
            IOSHarnessInboxSections(server: server, drafts: drafts, inbox: inbox)
        }
    }
}

/// La boîte de l'humain : questions à trancher, specs et verdicts à valider,
/// décisions prises seules, features en cours.
struct IOSHarnessInboxSections: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let inbox: HarnessInbox

    var body: some View {
        if !server.canAct {
            Section {
                Text(PipelineServerText.readOnly).foregroundStyle(.secondary)
            }
        }
        Section {
            if inbox.batches.isEmpty { empty }
            ForEach(inbox.batches) { batch in batchView(batch).disabled(!server.canAct) }
        } header: {
            Text(PipelineServerText.toDecide)
        } footer: {
            Text(PipelineServerText.toDecideHint)
        }
        .id(HarnessHomeAnchor.toDecide.rawValue)
        Section {
            if inbox.specsAwaiting.isEmpty { empty }
            ForEach(inbox.specsAwaiting) { run in specsView(run).disabled(!server.canAct) }
        } header: {
            Text(PipelineServerText.specsToValidate)
        } footer: {
            Text(PipelineServerText.specsToValidateHint)
        }
        .id(HarnessHomeAnchor.specs.rawValue)
        Section {
            if inbox.verdictsAwaiting.isEmpty { empty }
            ForEach(inbox.verdictsAwaiting) { run in verdictView(run).disabled(!server.canAct) }
        } header: {
            Text(PipelineServerText.verdictsToValidate)
        } footer: {
            Text(PipelineServerText.toValidateHint)
        }
        .id(HarnessHomeAnchor.verdicts.rawValue)
        Section {
            if inbox.decisions.isEmpty { empty }
            ForEach(inbox.decisions) { decision in decisionView(decision, run: inbox.run(decision.runId)).disabled(!server.canAct) }
            ForEach(inbox.decisionRunIds, id: \.self) { runId in
                Button(inbox.decisionRunIds.count == 1 ? PipelineServerText.acceptAll : PipelineServerText.acceptAllLine(inbox.run(runId)?.title ?? runId)) {
                    Task { await server.acceptAllDecisions(runId: runId) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!server.canAct || server.busy.contains(runId))
            }
        } header: {
            Text(PipelineServerText.toReview)
        } footer: {
            Text(PipelineServerText.toReviewHint)
        }
        .id(HarnessHomeAnchor.decisions.rawValue)
        Section {
            if inbox.active.isEmpty {
                Text(PipelineServerText.nothingInProgress).foregroundStyle(.secondary)
            }
            ForEach(inbox.active) { run in
                IOSHarnessRunRow(server: server, drafts: drafts, run: run)
            }
        } header: {
            Text(PipelineServerText.inProgress)
        }
        .id(HarnessHomeAnchor.active.rawValue)
    }

    private var empty: some View {
        Text(PipelineServerText.nothingPending).foregroundStyle(.secondary)
    }

    private func batchView(_ batch: HarnessEscalationBatch) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(batch.run?.title ?? batch.id)
                .font(.headline)
            ForEach(batch.items) { item in
                VStack(alignment: .leading, spacing: 6) {
                    Text(PipelineServerText.category(item.category))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.orange)
                    Text(item.question)
                    if let context = item.shownContext {
                        Text(context)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let recommended = item.recommended {
                        Text(PipelineServerText.recommended(recommended))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(item.options, id: \.self) { option in
                        Button {
                            drafts.answers[item.id] = option
                        } label: {
                            Label(
                                option,
                                systemImage: drafts.answer(for: item) == option ? PipelineServerText.chosenSymbol : PipelineServerText.optionSymbol
                            )
                        }
                        .buttonStyle(.borderless)
                    }
                    // La réponse présélectionnée est l'option recommandée, tant que rien n'est tapé.
                    TextField(PipelineServerText.answerPlaceholder, text: Binding(
                        get: { drafts.answer(for: item) },
                        set: { drafts.answers[item.id] = $0 }
                    ))
                    TextField(PipelineServerText.reasonOptional, text: Binding(
                        get: { drafts.reasons[item.id] ?? "" },
                        set: { drafts.reasons[item.id] = $0 }
                    ))
                }
            }
            Button(PipelineServerText.answer) {
                let answers = drafts.answers(for: batch)
                let reasons = drafts.reasons(for: batch)
                Task {
                    if await server.answer(runId: batch.id, answers: answers, reasons: reasons) { drafts.clearAnswers(for: batch) }
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(!drafts.canAnswer(batch) || server.busy.contains(batch.id))
            // Un seul geste : toutes les escalades du lot reçoivent la recommandation de l'agent.
            if let recommended = HarnessDrafts.recommendedAnswers(for: batch) {
                Button(PipelineServerText.acceptRecommended) {
                    Task {
                        if await server.answer(runId: batch.id, answers: recommended) { drafts.clearAnswers(for: batch) }
                    }
                }
                .buttonStyle(.bordered)
                .disabled(server.busy.contains(batch.id))
                .accessibilityIdentifier("ios.home.acceptRecommended")
            }
        }
        .padding(.vertical, 4)
    }

    private func specsView(_ run: HarnessRun) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(run.title)
                .font(.headline)
            if let specs = drafts.specs[run.id] {
                IOSMarkdownView(blocks: MarkdownDocument.blocks(specs))
                    .textSelection(.enabled)
            } else {
                Button(PipelineServerText.readSpecs) {
                    Task {
                        if let view = await server.runView(run.id) { drafts.specs[run.id] = view.specs ?? "" }
                    }
                }
                .buttonStyle(.borderless)
            }
            HStack {
                Button(PipelineServerText.approveSpecs) {
                    Task {
                        if await server.validate(runId: run.id, approve: true, reason: "") { drafts.specs[run.id] = nil }
                    }
                }
                .buttonStyle(.borderedProminent)
                Button(PipelineServerText.refuse) { drafts.beginRefusal(run) }
                    .buttonStyle(.bordered)
            }
            .disabled(server.busy.contains(run.id))
        }
        .padding(.vertical, 4)
    }

    private func verdictView(_ run: HarnessRun) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(run.title)
                .font(.headline)
            if let verdict = run.verdict {
                Text(PipelineServerText.risk(verdict.risk))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(verdict.isLowRisk ? Color.green : Color.orange)
                Text(verdict.summary)
                list(PipelineServerText.blockers, verdict.blockers)
                list(PipelineServerText.risks, verdict.risks)
                list(PipelineServerText.unverified, verdict.unverified)
                if verdict.isWeak {
                    Label(PipelineServerText.weakVerdict, systemImage: IOSShellText.weakVerdictSymbol)
                        .font(.callout)
                        .foregroundStyle(.orange)
                }
            }
            if let reason = run.reason {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack {
                if run.verdict != nil {
                    Button(PipelineServerText.approve) {
                        Task { await server.validate(runId: run.id, approve: true, reason: "") }
                    }
                    .buttonStyle(.borderedProminent)
                    Button(PipelineServerText.refuse) { drafts.beginRefusal(run) }
                        .buttonStyle(.bordered)
                } else {
                    // Arrêtée sans verdict (échecs répétés, fusion refusée) : repart de son étape.
                    Button(PipelineServerText.retry) { drafts.retryRequest = run }
                        .buttonStyle(.borderedProminent)
                }
            }
            .disabled(server.busy.contains(run.id))
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func list(_ title: String, _ items: [String]) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption.weight(.semibold))
                ForEach(items, id: \.self) { item in
                    Text(IOSShellText.bullet(item))
                        .font(.callout)
                }
            }
        }
    }

    private func decisionView(_ decision: HarnessDecision, run: HarnessRun?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let run {
                Text(run.title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            Text(PipelineServerText.decisionLine(seq: decision.seq, question: decision.question, chosen: decision.chosen))
            Text(PipelineServerText.rationale(decision.rationale))
                .font(.caption)
                .foregroundStyle(.secondary)
            if let status = PipelineServerText.decisionStatus(decision.status) {
                Text(status)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(decision.decidedAtDeadline ? Color.orange : Color.secondary)
            }
            HStack {
                Button(PipelineServerText.accept) {
                    Task { await server.accept(runId: decision.runId, seq: decision.seq) }
                }
                .buttonStyle(.bordered)
                Button(PipelineServerText.reverse) { drafts.beginReversal(decision) }
                    .buttonStyle(.bordered)
            }
            .disabled(server.busy.contains(decision.runId))
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Pipelines

struct IOSHarnessPipelinesScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        IOSHarnessScreen(server: server, drafts: drafts, section: .kanban, catalog: true) {
            Section {
                IOSHarnessRepoPicker(server: server, drafts: drafts)
                TextField(PipelineServerText.titleLabel, text: $drafts.runTitle)
                    .accessibilityIdentifier("ios.pipelines.launch.title")
                TextField(PipelineServerText.requestLabel, text: $drafts.runRequest, axis: .vertical)
                    .accessibilityIdentifier("ios.pipelines.launch.request")
                Button(PipelineServerText.launch) {
                    guard let repo = drafts.launchRepo(in: server.repos) else { return }
                    let title = drafts.runTitle
                    let request = drafts.runRequest
                    Task {
                        if await server.launchRun(repo: repo, title: title, request: request) != nil { drafts.clearRun() }
                    }
                }
                .disabled(!drafts.canLaunchRun || server.isLaunching || server.repos.isEmpty)
                .accessibilityIdentifier("ios.pipelines.launch.commit")
            } header: {
                Text(PipelineServerText.launchRunTitle)
            } footer: {
                Text(PipelineServerText.launchRunHint)
            }
            let runs = server.inbox?.runs ?? []
            Section {
                if runs.isEmpty {
                    Text(PipelineServerText.noRun).foregroundStyle(.secondary)
                }
                ForEach(runs) { run in
                    IOSHarnessRunRow(server: server, drafts: drafts, run: run)
                }
            } header: {
                Text(PipelineServerText.allRuns)
            }
        }
    }
}

// MARK: - Projet

struct IOSHarnessProjectsScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        IOSHarnessScreen(server: server, drafts: drafts, section: .project, catalog: true) {
            Section {
                IOSHarnessRepoPicker(server: server, drafts: drafts)
                TextField(PipelineServerText.projectTitleLabel, text: $drafts.projectTitle)
                    .accessibilityIdentifier("ios.project.launch.title")
            } header: {
                Text(PipelineServerText.launchProjectTitle)
            } footer: {
                Text(PipelineServerText.launchProjectHint)
            }
            ForEach($drafts.features) { $feature in
                Section {
                    TextField(PipelineServerText.titleLabel, text: $feature.title)
                    TextField(PipelineServerText.requestLabel, text: $feature.request, axis: .vertical)
                    TextField(PipelineServerText.modulesLabel, text: $feature.modules)
                    if drafts.features.count > 1 {
                        Button(PipelineServerText.removeFeature, role: .destructive) { drafts.removeFeature(feature.id) }
                    }
                }
            }
            Section {
                Button {
                    drafts.addFeature()
                } label: {
                    Label(PipelineServerText.addFeature, systemImage: IOSShellText.addSymbol)
                }
                Button(PipelineServerText.launch) {
                    guard let repo = drafts.launchRepo(in: server.repos) else { return }
                    let title = drafts.projectTitle
                    let features = drafts.features
                    Task {
                        if await server.launchProject(repo: repo, title: title, features: features) != nil { drafts.clearProject() }
                    }
                }
                .disabled(!drafts.canLaunchProject || server.isLaunching || server.repos.isEmpty)
                .accessibilityIdentifier("ios.project.launch.commit")
            }
            Section {
                if server.projects.isEmpty {
                    Text(PipelineServerText.noProject).foregroundStyle(.secondary)
                }
                ForEach(server.projects) { project in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(project.title)
                        Text(PipelineServerText.projectLine(total: project.runs.total, merged: project.runs.count(.merged)))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(project.isDone ? PipelineServerText.projectDone : PipelineServerText.projectActive)
                            .font(.caption)
                            .foregroundStyle(project.isDone ? Color.green : Color.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            } header: {
                Text(PipelineServerText.projectsTitle)
            }
        }
    }
}

// MARK: - Audit

struct IOSHarnessAuditsScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        IOSHarnessScreen(server: server, drafts: drafts, section: .audit, catalog: true) {
            Section {
                IOSHarnessRepoPicker(server: server, drafts: drafts)
                TextField(PipelineServerText.focusLabel, text: $drafts.auditFocus, prompt: Text(PipelineServerText.focusPrompt))
                    .accessibilityIdentifier("ios.audit.launch.focus")
                Button(PipelineServerText.launch) {
                    guard let repo = drafts.launchRepo(in: server.repos) else { return }
                    let focus = drafts.auditFocus
                    Task {
                        if await server.launchAudit(repo: repo, focus: focus) != nil { drafts.auditFocus = "" }
                    }
                }
                .disabled(server.isLaunching || server.repos.isEmpty)
                .accessibilityIdentifier("ios.audit.launch.commit")
            } header: {
                Text(PipelineServerText.launchAuditTitle)
            } footer: {
                Text(PipelineServerText.launchAuditHint)
            }
            if server.audits.isEmpty {
                Section {
                    Text(PipelineServerText.noAudit).foregroundStyle(.secondary)
                }
            }
            ForEach(server.audits) { audit in
                Section {
                    auditRows(audit)
                } header: {
                    Text(audit.focus.isEmpty ? PipelineServerText.wholeRepo : audit.focus)
                }
            }
        }
    }

    @ViewBuilder
    private func auditRows(_ audit: HarnessAudit) -> some View {
        Text(PipelineServerText.auditState(audit.state))
            .font(.caption.weight(.semibold))
            .foregroundStyle(audit.isProposed ? Color.orange : Color.secondary)
        if let reason = audit.reason, !reason.isEmpty {
            Text(reason)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        ForEach(Array(audit.proposals.enumerated()), id: \.offset) { index, proposal in
            if audit.isProposed {
                Button {
                    drafts.togglePick(audit, index)
                } label: {
                    Label {
                        proposalLabel(proposal)
                    } icon: {
                        Image(systemName: drafts.isPicked(audit, index) ? IOSShellText.pickedSymbol : IOSShellText.unpickedSymbol)
                    }
                }
                .buttonStyle(.borderless)
                .accessibilityAddTraits(drafts.isPicked(audit, index) ? .isSelected : [])
            } else {
                proposalLabel(proposal)
            }
        }
        if audit.isProposed {
            Button(PipelineServerText.launchProposals) {
                let items = Array(drafts.picks[audit.id] ?? [])
                let title = PipelineServerText.auditProjectTitle(audit.focus)
                Task {
                    if await server.launchProposals(auditId: audit.id, items: items, title: title) != nil { drafts.picks[audit.id] = nil }
                }
            }
            .disabled((drafts.picks[audit.id] ?? []).isEmpty || server.busyAudits.contains(audit.id))
        }
        if audit.canFollowSession {
            Button(MonitoringText.auditSessionTitle, systemImage: PipelineServerText.sessionSymbol) {
                drafts.sessionRequest = HarnessSessionRequest(target: .audit(audit.id), title: audit.focus.isEmpty ? PipelineServerText.wholeRepo : audit.focus)
            }
            .accessibilityIdentifier("ios.audit.session")
        }
        if audit.isOpen {
            Button(PipelineServerText.cancelAudit, role: .destructive) {
                Task { await server.cancelAudit(audit.id) }
            }
            .disabled(server.busyAudits.contains(audit.id))
        }
    }

    private func proposalLabel(_ proposal: HarnessAuditProposal) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(proposal.title)
            Text(IOSShellText.proposalDetail(
                kind: proposal.isWeakness ? PipelineServerText.weakness : PipelineServerText.feature,
                rationale: proposal.rationale
            ))
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Statistiques

struct IOSHarnessStatsScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        IOSHarnessScreen(server: server, drafts: drafts, section: .stats, catalog: true) {
            if let stats = server.stats {
                Section {
                    LabeledContent(PipelineServerText.total, value: String(stats.runs.total))
                    ForEach(HarnessRunState.allCases, id: \.self) { state in
                        if let count = stats.runs.byState[state.rawValue], count > 0 {
                            LabeledContent(PipelineServerText.state(state.rawValue), value: String(count))
                        }
                    }
                    LabeledContent(PipelineServerText.mergedWeek, value: String(stats.runs.mergedLast7Days))
                    LabeledContent(PipelineServerText.mergeRate, value: stats.runs.mergeRate.map(PipelineServerText.percent) ?? PipelineServerText.notAvailable)
                    LabeledContent(PipelineServerText.leadTime) {
                        Text(stats.runs.medianLeadSec.map(PipelineServerText.duration) ?? PipelineServerText.notAvailable)
                            .monospacedDigit()
                    }
                } header: {
                    Text(PipelineServerText.statsRuns)
                }
                Section {
                    ForEach(HarnessRun.stepKinds, id: \.self) { kind in
                        if let step = stats.steps[kind] {
                            Text(PipelineServerText.stepLine(label: HarnessRun.label(forStep: kind), count: step.count, failed: step.failed, median: step.medianSec))
                                .monospacedDigit()
                        }
                    }
                } header: {
                    Text(PipelineServerText.statsSteps)
                }
                Section {
                    LabeledContent(PipelineServerText.total, value: String(stats.tests.total))
                    LabeledContent(PipelineServerText.testsCached, value: String(stats.tests.cached))
                    LabeledContent(PipelineServerText.testsRetried, value: String(stats.tests.retried))
                } header: {
                    Text(PipelineServerText.statsTests)
                }
                if let usage = stats.usage {
                    IOSUsageSection(usage: usage)
                }
                if let models = stats.models {
                    IOSModelsSection(models: models)
                }
                if let flaky = stats.tests.flaky {
                    IOSFlakySection(flaky: flaky)
                }
                IOSHealthSection(server: server)
                Section {
                    LabeledContent(PipelineServerText.runners, value: PipelineServerText.slots(used: stats.scheduler.runner.used, capacity: stats.scheduler.runner.capacity))
                    LabeledContent(PipelineServerText.heavySlots, value: PipelineServerText.slots(used: stats.scheduler.heavy.used, capacity: stats.scheduler.heavy.capacity))
                    LabeledContent(PipelineServerText.memoryFree, value: stats.scheduler.memAvailableMiB.map(PipelineServerText.mebibytes) ?? PipelineServerText.notAvailable)
                } header: {
                    Text(PipelineServerText.statsCapacity)
                }
            } else {
                Section {
                    Text(PipelineServerText.noStats).foregroundStyle(.secondary)
                }
            }
        }
    }
}

// MARK: - Gestes

extension View {
    /// Les feuilles et confirmations des gestes du serveur : refus (specs ou
    /// verdict), renversement d'une décision, arrêt, relance et annulation d'une feature.
    func iosHarnessGestures(server: HarnessModel, drafts: HarnessDrafts) -> some View {
        modifier(IOSHarnessGestures(server: server, drafts: drafts))
    }
}

private struct IOSHarnessGestures: ViewModifier {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    func body(content: Content) -> some View {
        content
            .sheet(item: $drafts.reversal) { decision in
                reversalSheet(decision)
            }
            .sheet(item: $drafts.refusal) { run in
                refusalSheet(run)
            }
            .sheet(item: $drafts.sessionRequest) { request in
                IOSSessionSheet(server: server, request: request)
            }
            .confirmationDialog(
                PipelineServerText.stopConfirm,
                isPresented: Binding(get: { drafts.stopRequest != nil }, set: { if !$0 { drafts.stopRequest = nil } }),
                titleVisibility: .visible,
                presenting: drafts.stopRequest
            ) { run in
                Button(PipelineServerText.stopFeature, role: .destructive) {
                    Task { await server.cancel(runId: run.id) }
                }
                Button(PipelineServerText.cancel, role: .cancel) {}
            } message: { _ in
                Text(PipelineServerText.stopMessage)
            }
            .confirmationDialog(
                PipelineServerText.retryConfirm,
                isPresented: Binding(get: { drafts.retryRequest != nil }, set: { if !$0 { drafts.retryRequest = nil } }),
                titleVisibility: .visible,
                presenting: drafts.retryRequest
            ) { run in
                Button(PipelineServerText.retry) {
                    Task { await server.retry(runId: run.id) }
                }
                Button(PipelineServerText.cancel, role: .cancel) {}
            } message: { run in
                if let detail = run.detailLine() { Text(detail) }
                if let reason = run.reason { Text(reason) }
                Text(PipelineServerText.retryMessage)
            }
            .confirmationDialog(
                PipelineServerText.revertConfirm,
                isPresented: Binding(get: { drafts.revertRequest != nil }, set: { if !$0 { drafts.revertRequest = nil } }),
                titleVisibility: .visible,
                presenting: drafts.revertRequest
            ) { run in
                Button(PipelineServerText.revertFeature, role: .destructive) {
                    Task { await server.revert(runId: run.id) }
                }
                Button(PipelineServerText.cancel, role: .cancel) {}
            } message: { _ in
                Text(PipelineServerText.revertMessage)
            }
    }

    private func refusalSheet(_ run: HarnessRun) -> some View {
        let specs = run.awaitsSpecs
        return NavigationStack {
            Form {
                Section {
                    Text(run.title)
                        .font(.headline)
                    TextField(PipelineServerText.reasonLabel, text: $drafts.refusalReason, axis: .vertical)
                } footer: {
                    Text(specs ? PipelineServerText.specsHint : PipelineServerText.reasonHint)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(specs ? PipelineServerText.refuseSpecsTitle : PipelineServerText.refuseTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.cancel) { drafts.refusal = nil }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(PipelineServerText.send) {
                        let reason = drafts.refusalReason
                        drafts.refusal = nil
                        Task {
                            if await server.validate(runId: run.id, approve: false, reason: reason) { drafts.specs[run.id] = nil }
                        }
                    }
                    .disabled(!drafts.canRefuse)
                }
            }
        }
    }

    private func reversalSheet(_ decision: HarnessDecision) -> some View {
        NavigationStack {
            Form {
                Section {
                    Text(decision.question)
                        .font(.headline)
                    if !decision.alternatives.isEmpty {
                        Picker(PipelineServerText.reverseOption, selection: $drafts.reversalOption) {
                            ForEach(decision.alternatives, id: \.self) { option in
                                Text(option).tag(option)
                            }
                        }
                    }
                    TextField(PipelineServerText.reverseOption, text: $drafts.reversalOption)
                    TextField(PipelineServerText.reasonLabel, text: $drafts.reversalReason, axis: .vertical)
                } footer: {
                    Text(PipelineServerText.reasonHint)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(PipelineServerText.reverseTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.cancel) { drafts.reversal = nil }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(PipelineServerText.send) {
                        let option = drafts.reversalOption
                        let reason = drafts.reversalReason
                        drafts.reversal = nil
                        Task { await server.reverse(runId: decision.runId, seq: decision.seq, option: option, reason: reason) }
                    }
                    .disabled(!drafts.canReverse)
                }
            }
        }
    }
}
