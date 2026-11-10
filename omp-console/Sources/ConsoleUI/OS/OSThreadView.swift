// L'« OS agentique » : la page d'un FIL, partagée par le Mac et l'iPhone/iPad. Pas
// d'onglets : un récit en cartes, de l'origine au résultat — ce qui l'a ouvert, la session
// locale qui y travaille, le plan quand il a plusieurs tâches, l'agent au travail (son
// pouls, « Corriger… », « Arrêter… »), ce qui le retient en file (carte « Bloqué »), ce qui
// vous attend, ce que l'agent a décidé seul, le résultat (« Refaire »). L'en-tête porte le
// coût du fil et son curseur d'autonomie. En pied, une seule zone : une consigne à l'agent
// qui travaille (elle le corrige là où il est), sinon une demande de suite à l'OS.

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct OSThreadView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var intakes: HarnessIntakes
    @ObservedObject var pulse: OSPulse
    @ObservedObject var workspace: OSWorkspace
    let thread: OSThread
    /// Le nom de chaque navigateur du poste, par identifiant.
    let browsers: [String: String]
    /// Les brouillons de la coque : ses feuilles de création (« Refaire ») et l'ouverture
    /// d'une feature dans son fil.
    let drafts: HarnessDrafts?

    /// `browsers` : le nom de chaque navigateur du poste, par identifiant. `drafts` : les
    /// brouillons de la coque ; sans eux, « Refaire » n'est pas proposé et une feature
    /// citée s'ouvre dans « Comprendre ».
    public init(
        server: HarnessModel, workstation: WorkstationModel, intakes: HarnessIntakes, pulse: OSPulse, workspace: OSWorkspace,
        thread: OSThread, browsers: [String: String], drafts: HarnessDrafts? = nil
    ) {
        self.server = server
        self.workstation = workstation
        self.intakes = intakes
        self.pulse = pulse
        self.workspace = workspace
        self.thread = thread
        self.browsers = browsers
        self.drafts = drafts
    }

    @State private var draft = ""
    @State private var sending = false
    @State private var sent: String?
    @State private var reportExpanded = false
    /// La feature que « Corriger… » a désignée : la consigne du pied lui est adressée.
    @State private var amending: String?
    @State private var always = false
    @State private var stopping: HarnessRun?
    /// Un geste de la page a été refusé : sa raison s'affiche sous l'en-tête.
    @State private var failure: HarnessFailure?
    /// « Où et sur quoi » : replié, la page ne montre que le chemin ; ouvert, la machine, le dépôt et la branche.
    @State private var placeShown = false
    @FocusState private var composing: Bool

    private var inbox: HarnessInbox? { server.inbox }

    public var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    header
                    if let failure {
                        ConsoleFailureBanner(failure: failure)
                    }
                    originCard
                    if let session = thread.localSession {
                        OSLocalSessionCard(server: server, pulse: pulse, session: session, opened: open) {
                            workspace.open(OSWorkspace.now)
                        }
                    }
                    if thread.runs.count > 1 { planCard }
                    if thread.requests.count > 1 { attemptsCard }
                    if let request = thread.request { requestCards(request) }
                    if let audit = thread.audit, thread.runs.isEmpty { auditCard(audit) }
                    ForEach(thread.liveRuns) { run in
                        runCards(run)
                    }
                    if thread.liveRuns.isEmpty {
                        let merged = thread.runs.filter { $0.phase == .merged }
                        ForEach(merged.isEmpty ? Array(thread.runs.suffix(1)) : merged) { run in
                            runCards(run)
                        }
                    }
                }
                .frame(maxWidth: 760, alignment: .leading)
                .osPagePadding(24)
                .frame(maxWidth: .infinity)
            }
            if !thread.runs.isEmpty || thread.request != nil {
                Divider()
                composer
                    .frame(maxWidth: 760)
                    .padding(.horizontal, Self.composerMargin)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity)
            }
        }
        .osRunStop(server: server, run: $stopping)
        .task { await server.osReadFeatures() }
    }

    /// La marge du pied : celle de la page.
    #if os(macOS)
    private static let composerMargin: CGFloat = 24
    #else
    private static let composerMargin: CGFloat = 16
    #endif

    /// Ouvre une feature dans son fil (la coque le résout) ; sans coque, dans « Comprendre ».
    private func open(_ runId: String) {
        if let drafts {
            drafts.openedRun = runId
        } else {
            workspace.understand(runId: runId, level: .summary)
        }
    }

    // MARK: En-tête et origine

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                OSPhaseMark(phase: thread.phase, size: 18)
                Text(thread.title)
                    .font(.title2.weight(.bold))
                    .osSelectable()
            }
            // Où en est la feature : cinq points reliés, l'étape en cours nommée.
            if let run = thread.focusRun {
                OSJourney(run: run, tint: thread.phase.color, large: true)
            }
            OSLine(spacing: 10, gestures: false) {
                OSTag(text: thread.origin.label, symbol: thread.origin.symbol)
                if thread.focusRun == nil {
                    OSTag(text: thread.phase.label, tint: thread.phase.color)
                }
                if thread.cost > 0 {
                    Label(MonitoringText.cost(thread.cost), systemImage: "dollarsign.circle")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                        .accessibilityLabel(OSDecideText.total(thread.cost))
                }
                Text(thread.createdAt.osRelative)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                // OÙ et SUR QUOI : la machine, le dépôt, la branche, l'étape, le modèle ; ou le navigateur.
                Button {
                    placeShown.toggle()
                } label: {
                    Image(systemName: placeShown ? "info.circle.fill" : "info.circle")
                }
                .osBorderless()
                .help(OSText.places)
                .accessibilityLabel(OSText.places)
            }
            if placeShown {
                if let run = thread.focusRun {
                    OSPlace(subject: .run(run))
                } else if let request = thread.request {
                    OSPlace(subject: .request(request, browser: request.browserId.flatMap { browsers[$0] }))
                }
            }
            OSAutonomyPicker(server: server, runs: thread.liveRuns) { failure = server.failure }
        }
    }

    /// Ce qui a ouvert le fil, en une ligne : la phrase de l'humain quand on l'a.
    @ViewBuilder
    private var originCard: some View {
        if let intake = thread.intake {
            quote(intake.text, who: OSOrigin.person(intake.by).label)
        } else if let request = thread.request {
            quote(request.instruction, who: OSOrigin.person(request.by).label)
        } else if let first = thread.runs.first, !first.request.isEmpty {
            DisclosureGroup {
                ConsoleMarkdown(markdown: first.request)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 6)
            } label: {
                Label(OSThreads.gist(first.request), systemImage: thread.origin.symbol)
                    .lineLimit(1)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func quote(_ text: String, who: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "person.crop.circle.fill")
                .font(.title2)
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                Text(who).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text(text).osSelectable()
            }
        }
    }

    // MARK: Plan

    private var planCard: some View {
        OSCard {
            VStack(alignment: .leading, spacing: 8) {
                Text(OSText.tasks(thread.runs.count).uppercased())
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
                ForEach(Array(thread.runs.enumerated()), id: \.element.id) { index, run in
                    Button {
                        workspace.understand(runId: run.id, level: .summary)
                    } label: {
                        HStack(spacing: 8) {
                            OSPhaseMark(phase: OSThreads.phase(of: run, inbox: inbox), size: 11)
                            // Le Mac aligne l'état et la date en colonnes ; l'iPhone les pose sous le titre.
                            #if os(macOS)
                            Text(taskTitle(run, index: index))
                                .lineLimit(1)
                                .foregroundStyle(run.phase == .cancelled ? .secondary : .primary)
                            Spacer()
                            Text(run.osState).font(.caption).foregroundStyle(.secondary)
                            Text(run.updatedAt.osRelative)
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                                .frame(width: 110, alignment: .trailing)
                            #else
                            VStack(alignment: .leading, spacing: 2) {
                                Text(taskTitle(run, index: index))
                                    .lineLimit(2)
                                    .multilineTextAlignment(.leading)
                                    .foregroundStyle(run.phase == .cancelled ? .secondary : .primary)
                                Text(run.osState + " · " + run.updatedAt.osRelative)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                            #endif
                        }
                        .frame(minHeight: ConsolePlatform.minimumTarget)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    /// Les tentatives d'une même demande au poste : une ligne chacune, la raison d'un échec en clair.
    private var attemptsCard: some View {
        OSCard {
            VStack(alignment: .leading, spacing: 8) {
                Text(OSText.tasks(thread.requests.count).uppercased())
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
                ForEach(Array(thread.requests.enumerated()), id: \.element.id) { index, request in
                    let phase = OSThreads.phase(of: request)
                    HStack(spacing: 8) {
                        OSPhaseMark(phase: phase, size: 11)
                        Text(OSText.attempt(index + 1))
                        if let reason = request.reason, !reason.isEmpty, phase != .done {
                            Text(OSThreads.firstLine(reason)).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        Text(phase.label).font(.caption).foregroundStyle(.secondary)
                        Text(ConsoleFormat.time(ms: request.updatedAt))
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        }
    }

    /// Le titre d'une tâche : le sien s'il dit autre chose que le fil, sinon son issue ou son rang.
    private func taskTitle(_ run: HarnessRun, index: Int) -> String {
        let clean = OSThreads.clean(run.title)
        if clean.title.lowercased() != thread.title.lowercased() { return clean.title }
        if let issue = clean.issue { return OSText.originIssue(issue) }
        return OSText.attempt(index + 1)
    }

    // MARK: Une feature

    @ViewBuilder
    private func runCards(_ run: HarnessRun) -> some View {
        let phase = OSThreads.phase(of: run, inbox: inbox)
        let gestures = server.osGestures(run)
        if phase == .queued, run.waitCause != nil {
            OSRunBlockedCard(server: server, run: run, open: open, stop: { stopping = run }) {
                failure = server.pause.failure ?? server.failure
            }
        } else if phase == .working || phase == .queued {
            liveCard(run, phase: phase, gestures: gestures)
        }
        ForEach(OSDecisions.of(runId: run.id, inbox: inbox)) { decision in
            OSDecisionCard(server: server, workstation: workstation, intakes: intakes, workspace: workspace, decision: decision)
        }
        autonomousCards(run)
        if [.merged, .failed, .cancelled].contains(run.phase) {
            resultCard(run, gestures: gestures)
        }
    }

    private func liveCard(_ run: HarnessRun, phase: OSPhase, gestures: OSRunGestures) -> some View {
        TimelineView(.periodic(from: .now, by: 5)) { context in
            OSCard(tint: .accentColor, emphasized: phase == .working) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        OSPhaseMark(phase: phase, size: 14)
                        Text(run.repo + " · " + run.osState)
                            .font(.headline)
                        Spacer()
                        // Le chemin est déjà en tête de la page : seul un fil à plusieurs features le répète ici.
                        if thread.liveRuns.count > 1 { OSJourney(run: run) }
                    }
                    if let activity = pulse.current(.run(run.id), now: context.date) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("↳")
                            Text(activity.line)
                            if let tool = activity.tool {
                                Text(tool).font(.caption.monospaced()).foregroundStyle(.tertiary)
                            }
                        }
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    } else if let reason = run.reason, !reason.isEmpty {
                        Text("↳ " + OSThreads.firstLine(reason)).foregroundStyle(.secondary).lineLimit(2)
                    }
                    OSLine(spacing: 8) {
                        if gestures.amend {
                            Button(OSDecideText.amend) { amend(run) }
                        }
                        if gestures.stop {
                            Button(OSDecideText.stop) { stopping = run }
                        }
                        Spacer()
                        Group {
                            // Sur l'iPhone, la rangée passe à la ligne : la date, les corrections
                            // et le coût restent un seul texte.
                            #if os(macOS)
                            Text(run.createdAt.osRelative)
                            if run.fixes > 0 { Text("· " + OSText.fixes(run.fixes)) }
                            if let cost = inbox?.costs[run.id], cost > 0 { Text("· " + MonitoringText.cost(cost)) }
                            #else
                            Text(liveFacts(run))
                            #endif
                            Button(OSText.understand + " ›") { workspace.understand(runId: run.id, level: .raw) }
                                .osBorderless()
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    #if os(iOS)
    /// « il y a 7 minutes · 2 corrections · 1,18 $ » : depuis quand, et ce que la feature a coûté.
    private func liveFacts(_ run: HarnessRun) -> String {
        var facts = [run.createdAt.osRelative]
        if run.fixes > 0 { facts.append(OSText.fixes(run.fixes)) }
        if let cost = inbox?.costs[run.id], cost > 0 { facts.append(MonitoringText.cost(cost)) }
        return facts.joined(separator: " · ")
    }
    #endif

    /// Ce que l'agent a tranché seul : une ligne par décision, la garder ou la revoir.
    @ViewBuilder
    private func autonomousCards(_ run: HarnessRun) -> some View {
        let decisions = inbox?.decisions.filter { $0.runId == run.id } ?? []
        if !decisions.isEmpty {
            OSCard(tint: .purple, emphasized: true) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(OSText.autonomous.uppercased())
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.purple)
                    ForEach(decisions) { decision in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: "diamond.fill").foregroundStyle(.purple).font(.caption)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(decision.chosen).fontWeight(.semibold)
                                Text(OSThreads.firstLine(decision.question)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer()
                            Button(OSText.keep) { Task { await server.accept(runId: run.id, seq: decision.seq) } }
                                .osRowButton()
                            Button(OSText.revisit) { workspace.understand(runId: run.id, level: .summary) }
                                .osRowButton()
                        }
                    }
                }
            }
        }
    }

    private func resultCard(_ run: HarnessRun, gestures: OSRunGestures) -> some View {
        let merged = run.phase == .merged
        let tint: Color = merged ? .green : run.phase == .failed ? .red : .secondary
        return OSCard(tint: tint, emphasized: merged) {
            VStack(alignment: .leading, spacing: 8) {
                OSLine(spacing: 8, gestures: false) {
                    OSPhaseMark(phase: OSThreads.phase(of: run, inbox: nil), size: 14)
                    Text(merged ? OSText.merged : run.osState.capitalized)
                        .font(.headline)
                    if let verdict = run.verdict { OSTag(text: PipelineServerText.risk(verdict.risk), tint: verdict.isLowRisk ? .green : .orange) }
                    if run.fixes > 0 { OSTag(text: OSText.fixes(run.fixes)) }
                    Spacer()
                    if let pr = run.prUrl, let url = URL(string: pr) {
                        Link(destination: url) {
                            Label(OSText.openPR, systemImage: "arrow.up.right.square")
                                .frame(minHeight: ConsolePlatform.minimumTarget)
                        }
                    }
                    Button(OSText.understand + " ›") { workspace.understand(runId: run.id, level: .summary) }
                        .osBorderless()
                }
                if let summary = run.verdict?.summary, merged {
                    Text(OSThreads.firstLine(summary)).foregroundStyle(.secondary).lineLimit(2)
                } else if let reason = run.reason, !reason.isEmpty {
                    Text(OSThreads.firstLine(reason)).foregroundStyle(.secondary).lineLimit(2)
                }
                if gestures.amend || (gestures.redo && drafts != nil) {
                    OSLine(spacing: 8) {
                        if gestures.amend {
                            Button(OSDecideText.amend) { amend(run) }
                        }
                        if gestures.redo, let drafts {
                            OSRunRedoMenu(server: server, drafts: drafts, run: run) { failure = server.failure }
                        }
                        Spacer()
                    }
                }
            }
        }
    }

    // MARK: Le poste

    @ViewBuilder
    private func requestCards(_ request: WorkstationRequest) -> some View {
        let phase = OSThreads.phase(of: request)
        if phase.isLive {
            TimelineView(.periodic(from: .now, by: 5)) { context in
                OSCard(tint: .accentColor, emphasized: true) {
                    HStack(spacing: 8) {
                        OSPhaseMark(phase: phase, size: 14)
                        Text(OSText.poste).font(.headline)
                        Text("↳ " + (pulse.workstation(now: context.date)?.activity.line ?? phase.label))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
            }
        }
        if let report = request.report, !report.isEmpty {
            OSCard(tint: phase.color, emphasized: phase == .done) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        OSPhaseMark(phase: phase, size: 14)
                        Text(OSText.reportTitle).font(.headline)
                        Spacer()
                        Button(reportExpanded ? OSText.collapse : OSText.readAll) { reportExpanded.toggle() }
                            .osBorderless()
                    }
                    if reportExpanded {
                        ConsoleMarkdown(markdown: report)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .osSelectable()
                    } else {
                        Text(MarkdownDocument.inline(OSThreads.preview(report, lines: 4)))
                            .lineLimit(5)
                    }
                }
            }
        } else if let reason = request.reason, !reason.isEmpty, !phase.isLive {
            OSCard(tint: phase.color) {
                Label(OSThreads.firstLine(reason), systemImage: phase.symbol).foregroundStyle(.secondary)
            }
        }
    }

    // MARK: Un audit

    private func auditCard(_ audit: HarnessAudit) -> some View {
        Group {
            if audit.isProposed, let inbox, inbox.auditsProposed.contains(where: { $0.id == audit.id }) {
                OSDecisionCard(server: server, workstation: workstation, intakes: intakes, workspace: workspace, decision: .audit(audit))
            } else {
                OSCard(tint: .accentColor, emphasized: true) {
                    HStack(spacing: 8) {
                        OSPhaseMark(phase: .working, size: 14)
                        Text(OSOrigin.audit(audit.focus).label).font(.headline)
                        Text("↳ " + (pulse.current(.audit(audit.id))?.line ?? audit.state)).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
            }
        }
    }

    // MARK: Pied

    /// La feature que la consigne du pied corrige : celle que « Corriger… » a désignée,
    /// sinon la dernière qui en accepte une.
    private var target: HarnessRun? {
        if let amending, let run = thread.runs.first(where: { $0.id == amending }), server.osGestures(run).amend { return run }
        return thread.runs.last { $0.acceptsInstructions && server.osGestures($0).amend }
    }

    /// « Corriger… » : la consigne du pied s'adresse à cette feature.
    private func amend(_ run: HarnessRun) {
        amending = run.id
        composing = true
    }

    private var composer: some View {
        let target = target
        return HStack(spacing: 8) {
            Image(systemName: target == nil ? "sparkles" : "text.bubble")
                .foregroundStyle(Color.accentColor)
                .accessibilityHidden(true)
            TextField(target == nil ? OSText.followUp : OSText.reply, text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .focused($composing)
                .onSubmit(send)
                .disabled(sending || !server.canAct)
            // La case ne paraît qu'avec une consigne en cours : elle porte sur elle.
            if let target, !draft.isEmpty, server.osGestures(target).always {
                OSCheckbox(label: OSDecideText.always, isOn: $always)
                    .font(.caption)
            }
            if sending { ProgressView().controlSize(.small) }
            if let sent { Text(sent).font(.caption).foregroundStyle(.secondary) }
            // Sans touche ⏎ sous le doigt, la saisie part par son bouton.
            #if os(iOS)
            if !sending, !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button(action: send) {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                }
                .buttonStyle(OSTouchLinkStyle())
                .accessibilityLabel(OSText.send)
            }
            #endif
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.05)))
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        sending = true
        failure = nil
        Task {
            if let run = target {
                if await server.osAmend(run, text: text, always: always) {
                    delivered()
                } else {
                    failure = server.failure
                }
            } else {
                // Une phrase du PROTOCOLE, pas un texte d'écran : le serveur titre ses suites
                // ainsi et `OSThreads.clean` la reconnaît, en français quelle que soit la langue.
                let ask = "Suite de « \(thread.title) » : \(text)"
                if (try? await intakes.submit(text: ask, source: intakeSource, repo: thread.repo)) != nil {
                    delivered()
                }
            }
            sending = false
        }
    }

    private func delivered() {
        draft = ""
        sent = "✓"
        always = false
        amending = nil
    }
}
