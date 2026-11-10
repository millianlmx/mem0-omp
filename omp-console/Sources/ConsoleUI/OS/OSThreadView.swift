// L'« OS agentique » : la page d'un FIL, partagée par le Mac et l'iPhone/iPad. Pas
// d'onglets : un titre, UNE ligne (« ● Client Acme · acme-web · au travail · 1,18 $ · il
// y a 7 minutes »), puis un récit en cartes — ce qui l'a ouvert, la session locale qui y
// travaille, ses tâches quand il en a plusieurs, l'agent AU TRAVAIL (son pouls,
// « Autonomie : », « Corriger… », « Arrêter… »), ce qui le retient EN ATTENTE (pourquoi,
// et « rien à faire »), ce qui est À VOUS (la carte de décision), ce que l'agent a décidé
// seul (« Valider » / « Corriger… »), puis l'issue : LIVRÉ (ce qui l'a été, « Refaire »),
// EN ÉCHEC (« Relancer », « Corriger… »), ARRÊTÉ (son motif, « Refaire »). Aucune phrase du
// serveur ni résumé de l'agent n'y paraît : chaque cause se dit par une phrase de l'app
// tirée d'un code ; branche, modèle, machine et lien de la demande de fusion vivent dans
// « Comprendre ». En pied, une seule zone : une consigne à l'agent qui travaille (elle le
// corrige là où il est), sinon une demande de suite à l'OS.

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct OSThreadView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var intakes: HarnessIntakes
    @ObservedObject var pulse: OSPulse
    @ObservedObject var workspace: OSWorkspace
    @ObservedObject var spaces: HarnessSpacesModel
    @ObservedObject var pause: HarnessPauseModel
    let thread: OSThread
    /// Le nom de chaque navigateur du poste, par identifiant.
    let browsers: [String: String]
    /// Les brouillons de la coque : ses feuilles de création (« Refaire ») et l'ouverture
    /// d'une tâche dans son fil.
    let drafts: HarnessDrafts?

    /// `browsers` : le nom de chaque navigateur du poste, par identifiant. `drafts` : les
    /// brouillons de la coque ; sans eux, « Refaire » n'est pas proposé et une tâche
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
        spaces = server.spaces
        pause = server.pause
        self.thread = thread
        self.browsers = browsers
        self.drafts = drafts
    }

    @State private var draft = ""
    @State private var sending = false
    @State private var sent: String?
    @State private var reportExpanded = false
    /// La tâche que « Corriger… » a désignée : la consigne du pied lui est adressée.
    @State private var amending: String?
    @State private var always = false
    @State private var stopping: HarnessRun?
    /// Une relance est en cours : la tâche ou la demande au poste relancée.
    @State private var retrying: String?
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
                    originLine
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
        .task {
            await server.osReadFeatures()
            if spaces.availability == .unknown { await spaces.refresh() }
            if pause.availability == .unknown { await pause.refresh() }
        }
    }

    /// La marge du pied : celle de la page.
    #if os(macOS)
    private static let composerMargin: CGFloat = 24
    #else
    private static let composerMargin: CGFloat = 16
    #endif

    /// Le niveau le plus détaillé de « Comprendre » : ce que l'agent fait, en direct.
    private static var liveLevel: OSLevel { OSLevel.allCases.last ?? .summary }

    /// Ouvre une tâche dans son fil (la coque le résout) ; sans coque, dans « Comprendre ».
    private func open(_ runId: String) {
        if let drafts {
            drafts.openedRun = runId
        } else {
            workspace.understand(runId: runId, level: .summary)
        }
    }

    // MARK: En-tête et origine

    /// Le titre, puis UNE ligne : pour qui (l'espace et sa pastille), où (le dépôt, le
    /// poste, la machine d'une session locale), l'état, le coût, depuis quand.
    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                OSPhaseMark(phase: thread.phase, size: 18)
                Text(thread.title)
                    .font(.title2.weight(.bold))
                    .osSelectable()
                Spacer(minLength: 0)
                Button {
                    placeShown.toggle()
                } label: {
                    Image(systemName: placeShown ? "info.circle.fill" : "info.circle")
                }
                .osBorderless()
                .help(OSText.places)
                .accessibilityLabel(OSText.places)
            }
            OSSpaceLine(space: OSThreads.space(of: thread, spaces: spaces.spaces), items: headerItems, font: .callout)
            // Où en est la tâche : cinq points reliés, l'étape en cours nommée.
            if let run = thread.focusRun {
                OSJourney(run: run, tint: thread.phase.color, large: true)
            }
            // OÙ et SUR QUOI : la machine, le dépôt, la branche, l'étape, le modèle ; ou le navigateur.
            if placeShown {
                if let run = thread.focusRun {
                    OSPlace(subject: .run(run))
                } else if let request = thread.request {
                    OSPlace(subject: .request(request, browser: request.browserId.flatMap { browsers[$0] }))
                }
            }
        }
    }

    private var headerItems: [OSSpaceLine.Item] {
        var items: [OSSpaceLine.Item] = []
        if let place = thread.repo ?? (thread.requests.isEmpty ? thread.localSession?.host : OSText.poste) {
            items.append(OSSpaceLine.Item(place))
        }
        // Le chemin en cinq points dit déjà l'état de la tâche : le mot ne vient qu'en son absence.
        if thread.focusRun == nil { items.append(OSSpaceLine.Item(thread.phase.osWord, strong: true)) }
        if thread.cost > 0 { items.append(OSSpaceLine.Item(MonitoringText.cost(thread.cost))) }
        items.append(OSSpaceLine.Item(thread.updatedAt.osRelative))
        return items
    }

    /// Ce qui a ouvert le fil, en une ligne : la phrase de l'humain quand on l'a, sinon qui
    /// l'a ouvert et le début de sa demande (elle se déplie).
    @ViewBuilder
    private var originLine: some View {
        if let intake = thread.intake {
            quote(intake.text, origin: .person(intake.by))
        } else if let request = thread.request {
            quote(request.instruction, origin: .person(request.by))
        } else if let first = thread.runs.first, !first.request.isEmpty {
            DisclosureGroup {
                ConsoleMarkdown(markdown: first.request)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 6)
            } label: {
                Label(thread.origin.label + " · " + OSThreads.gist(first.request), systemImage: Self.symbol(of: thread.origin))
                    .lineLimit(1)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func quote(_ text: String, origin: OSOrigin) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: Self.symbol(of: origin, filled: true))
                .font(.title2)
                .foregroundStyle(Color.accentColor)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(origin.label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text(text).osSelectable()
            }
        }
    }

    /// Le symbole de qui a ouvert le fil : un serveur quand c'est « Le serveur » (aucune
    /// personne nommée), sinon celui de l'origine.
    private static func symbol(of origin: OSOrigin, filled: Bool = false) -> String {
        if case .person(nil) = origin { return "server.rack" }
        if case .person = origin, filled { return "person.crop.circle.fill" }
        return origin.symbol
    }

    // MARK: Tâches et essais

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
                            Text(stateWord(run)).font(.caption).foregroundStyle(.secondary)
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
                                Text(stateWord(run) + " · " + run.updatedAt.osRelative)
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

    /// Les essais d'une même demande au poste : une ligne chacun, son état, son heure.
    private var attemptsCard: some View {
        OSCard {
            VStack(alignment: .leading, spacing: 8) {
                Text(OSDecideText.attempts(thread.requests.count).uppercased())
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
                ForEach(Array(thread.requests.enumerated()), id: \.element.id) { index, request in
                    let phase = OSThreads.phase(of: request)
                    HStack(spacing: 8) {
                        OSPhaseMark(phase: phase, size: 11)
                        Text(OSDecideText.attempt(index + 1))
                        Spacer()
                        Text(phase.osWord).font(.caption).foregroundStyle(.secondary)
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
        return OSDecideText.task(index + 1)
    }

    /// Le titre d'une tâche sur sa carte, dans un fil qui en a plusieurs ; `nil` sinon (le
    /// titre du fil suffit).
    private func cardTitle(_ run: HarnessRun) -> String? {
        guard thread.runs.count > 1, let index = thread.runs.firstIndex(where: { $0.id == run.id }) else { return nil }
        return taskTitle(run, index: index)
    }

    /// Où en est une tâche, au mot du glossaire : son étape quand elle travaille, sinon son état.
    private func stateWord(_ run: HarnessRun) -> String {
        run.phase == .running ? OSText.steps[OSThreads.stepIndex(of: run)] : OSThreads.phase(of: run, inbox: inbox).osWord
    }

    // MARK: Une tâche

    @ViewBuilder
    private func runCards(_ run: HarnessRun) -> some View {
        let phase = OSThreads.phase(of: run, inbox: inbox)
        let gestures = server.osGestures(run)
        if phase == .queued {
            OSRunBlockedCard(
                server: server, run: run, open: open, stop: { stopping = run }, failed: { failure = server.pause.failure ?? server.failure },
                title: cardTitle(run)
            )
        } else if phase == .working {
            liveCard(run, gestures: gestures)
        }
        ForEach(OSDecisions.of(runId: run.id, inbox: inbox)) { decision in
            OSDecisionCard(
                server: server, workstation: workstation, intakes: intakes, workspace: workspace, decision: decision,
                titled: thread.runs.count > 1
            )
        }
        autonomousCards(run)
        switch run.phase {
        case .merged: deliveredCard(run, gestures: gestures)
        case .failed: failedCard(run, gestures: gestures)
        case .cancelled: stoppedCard(run, gestures: gestures)
        default: EmptyView()
        }
    }

    /// La tête d'une carte d'état : son symbole, son mot, le titre de la tâche dans un fil
    /// qui en a plusieurs, puis « Comprendre › ». `steps` : le chemin de la tâche en cinq
    /// points (la carte « Au travail » d'un fil à plusieurs tâches vivantes, dont la tête de
    /// page ne montre qu'une).
    private func cardHead(_ phase: OSPhase, _ word: String, run: HarnessRun, level: OSLevel = .summary, steps: Bool = false) -> some View {
        HStack(spacing: 8) {
            OSPhaseMark(phase: phase, size: 14)
            Text(word).font(.headline)
            if let title = cardTitle(run) {
                Text(title).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            if steps {
                OSJourney(run: run)
            }
            Button(OSText.understand + " ›") { workspace.understand(runId: run.id, level: level) }
                .osBorderless()
                .font(.caption)
        }
    }

    /// AU TRAVAIL : l'étape, le pouls, la pause qui vient, le curseur d'autonomie, puis
    /// « Corriger… » et « Arrêter… ».
    private func liveCard(_ run: HarnessRun, gestures: OSRunGestures) -> some View {
        TimelineView(.periodic(from: .now, by: 5)) { context in
            OSCard(tint: .accentColor, emphasized: true) {
                VStack(alignment: .leading, spacing: 8) {
                    cardHead(.working, OSText.atWork, run: run, level: Self.liveLevel, steps: thread.liveRuns.count > 1)
                    // Ce que fait l'agent, en ses mots ; l'outil qu'il manie se lit dans « Comprendre ».
                    if let activity = pulse.current(.run(run.id), now: context.date) {
                        Text(verbatim: "↳ " + activity.line)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    // Une pause douce est posée : l'agent finit son étape avant de s'arrêter.
                    if let state = pause.pause, state.paused, !state.now {
                        Label {
                            Text(OSDecideText.finishing)
                        } icon: {
                            Image(systemName: "pause.circle").foregroundStyle(.orange)
                        }
                    }
                    // Le curseur règle toutes les tâches vivantes du fil : il paraît une fois.
                    if run.id == thread.liveRuns.first(where: { OSThreads.phase(of: $0, inbox: inbox) == .working })?.id {
                        OSAutonomyPicker(server: server, runs: thread.liveRuns) { failure = server.failure }
                    }
                    if gestures.amend || gestures.stop || run.fixes > 0 {
                        OSLine(spacing: 8) {
                            if gestures.amend {
                                Button(OSDecideText.amend) { amend(run) }
                            }
                            if gestures.stop {
                                Button(OSDecideText.stop) { stopping = run }
                            }
                            Spacer()
                            if run.fixes > 0 {
                                Text(OSText.fixes(run.fixes)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
    }

    /// Ce que l'agent a tranché seul : une ligne par décision, la valider ou la corriger.
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
                            Button(OSText.validate) { Task { await server.accept(runId: run.id, seq: decision.seq) } }
                                .osRowButton()
                                .disabled(!server.canAct)
                            // « Corriger… » : la consigne du pied dit ce qu'il fallait décider.
                            Button(OSDecideText.amend) { amend(run) }
                                .osRowButton()
                                .disabled(!server.canAct)
                        }
                    }
                }
            }
        }
    }

    /// LIVRÉ : ce qui a été livré, en une phrase de l'app ; « Refaire ».
    private func deliveredCard(_ run: HarnessRun, gestures: OSRunGestures) -> some View {
        OSCard(tint: .green, emphasized: true) {
            VStack(alignment: .leading, spacing: 8) {
                cardHead(.done, OSWatchText.sectionDelivered, run: run)
                Text(deliveredLine(run))
                    .fixedSize(horizontal: false, vertical: true)
                redoRow(run, gestures: gestures)
            }
        }
    }

    /// « « Exporter les commandes en CSV » est livré · 4 fichiers »
    private func deliveredLine(_ run: HarnessRun) -> String {
        let sentence = OSDecideText.delivered(OSThreads.clean(run.title).title)
        guard let files = run.verdict?.files.count, files > 0 else { return sentence }
        return sentence + " · " + OSDecideText.files(files)
    }

    /// EN ÉCHEC : pourquoi (le code de la cause, en clair), « Relancer » d'abord, « Corriger… » ensuite.
    private func failedCard(_ run: HarnessRun, gestures: OSRunGestures) -> some View {
        OSCard(tint: .red, emphasized: true) {
            VStack(alignment: .leading, spacing: 8) {
                cardHead(.failed, OSDecideText.cardFailed, run: run)
                Text(OSDecideText.failCause(run.lastFailCause))
                    .fixedSize(horizontal: false, vertical: true)
                if gestures.retry || gestures.amend {
                    OSLine(spacing: 8) {
                        if gestures.retry {
                            Button(PipelineServerText.retry, systemImage: "arrow.clockwise") { retry(run) }
                                .buttonStyle(.borderedProminent)
                                .disabled(retrying != nil)
                        }
                        if gestures.amend {
                            Button(OSDecideText.amend) { amend(run) }
                        }
                        Spacer()
                    }
                }
            }
        }
    }

    /// ARRÊTÉ : le motif de l'arrêt quand il en a un ; « Refaire ».
    private func stoppedCard(_ run: HarnessRun, gestures: OSRunGestures) -> some View {
        OSCard {
            VStack(alignment: .leading, spacing: 8) {
                cardHead(.stopped, OSDecideText.cardStopped, run: run)
                if let cause = run.cancelCause, !cause.isEmpty {
                    Text(OSDecideText.cause(cause)).foregroundStyle(.secondary)
                }
                redoRow(run, gestures: gestures)
            }
        }
    }

    /// « Refaire ▾ » : le menu d'un fil fini, quand la coque prête ses feuilles.
    @ViewBuilder
    private func redoRow(_ run: HarnessRun, gestures: OSRunGestures) -> some View {
        if gestures.redo, let drafts {
            OSLine(spacing: 8) {
                OSRunRedoMenu(server: server, drafts: drafts, run: run) { failure = server.failure }
                Spacer()
            }
        }
    }

    // MARK: Le poste

    @ViewBuilder
    private func requestCards(_ request: WorkstationRequest) -> some View {
        let phase = OSThreads.phase(of: request)
        if phase.isLive {
            TimelineView(.periodic(from: .now, by: 5)) { context in
                OSCard(tint: phase.color, emphasized: true) {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 8) {
                            OSPhaseMark(phase: phase, size: 14)
                            Text(phase == .working ? OSText.atWork : OSDecideText.cardWaiting).font(.headline)
                            Text(OSText.poste).foregroundStyle(.secondary)
                        }
                        if phase == .queued {
                            Text(OSDecideText.requestWaiting)
                            Text(OSDecideText.leavesAlone).font(.callout).foregroundStyle(.secondary)
                        } else if let activity = pulse.workstation(now: context.date)?.activity.line {
                            Text(verbatim: "↳ " + activity)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
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
        }
        if phase == .failed {
            OSCard(tint: .red, emphasized: true) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        OSPhaseMark(phase: .failed, size: 14)
                        Text(OSDecideText.cardFailed).font(.headline)
                        Text(OSText.poste).foregroundStyle(.secondary)
                    }
                    Text(OSDecideText.requestFailed)
                    if server.canAct {
                        OSLine(spacing: 8) {
                            Button(PipelineServerText.retry, systemImage: "arrow.clockwise") { retry(request) }
                                .buttonStyle(.borderedProminent)
                                .disabled(retrying != nil)
                            // « Corriger… » : la consigne du pied repart en demande de suite.
                            Button(OSDecideText.amend) { composing = true }
                            Spacer()
                        }
                    }
                }
            }
        } else if phase == .stopped {
            OSCard {
                HStack(spacing: 8) {
                    OSPhaseMark(phase: .stopped, size: 14)
                    Text(OSDecideText.cardStopped).font(.headline)
                    Text(OSText.poste).foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: Un audit

    /// Un audit sans projet : au travail tant qu'il analyse ; ses propositions rendues, il a
    /// livré — elles se choisissent, se lancent ou s'écartent dans Propositions.
    @ViewBuilder
    private func auditCard(_ audit: HarnessAudit) -> some View {
        if audit.isProposed {
            OSCard(tint: .green, emphasized: true) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        OSPhaseMark(phase: .done, size: 14)
                        Text(OSWatchText.sectionDelivered).font(.headline)
                        Text(OSOrigin.audit(audit.focus).label).foregroundStyle(.secondary)
                    }
                    Text(OSDecideText.auditProposals(audit.proposals.count))
                    if server.proposals.isServed {
                        OSLine(spacing: 8) {
                            Button(OSDecideText.seeProposals, systemImage: "arrow.right.circle") {
                                workspace.open(OSWorkspace.proposals)
                            }
                            Spacer()
                        }
                    }
                }
            }
        } else {
            let waiting = audit.state == "queued"
            OSCard(tint: waiting ? .secondary : .accentColor, emphasized: true) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        OSPhaseMark(phase: waiting ? .queued : .working, size: 14)
                        Text(waiting ? OSDecideText.cardWaiting : OSText.atWork).font(.headline)
                        Text(OSOrigin.audit(audit.focus).label).foregroundStyle(.secondary)
                    }
                    if !waiting {
                        Text(verbatim: "↳ " + (pulse.current(.audit(audit.id))?.line ?? OSDecideText.auditAnalysing))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
            }
        }
    }

    // MARK: Pied

    /// La tâche que la consigne du pied corrige : celle que « Corriger… » a désignée,
    /// sinon la dernière qui en accepte une.
    private var target: HarnessRun? {
        if let amending, let run = thread.runs.first(where: { $0.id == amending }), server.osGestures(run).amend { return run }
        return thread.runs.last { $0.acceptsInstructions && server.osGestures($0).amend }
    }

    /// « Corriger… » : la consigne du pied s'adresse à cette tâche.
    private func amend(_ run: HarnessRun) {
        amending = run.id
        composing = true
    }

    /// « Relancer » une tâche en échec : elle repart de l'étape où elle s'est arrêtée.
    private func retry(_ run: HarnessRun) {
        retrying = run.id
        failure = nil
        Task {
            if await !server.retry(runId: run.id) { failure = server.failure }
            retrying = nil
        }
    }

    /// « Relancer » une demande au poste en échec : la même consigne, dans le même navigateur.
    private func retry(_ request: WorkstationRequest) {
        retrying = request.id
        failure = nil
        Task {
            if await workstation.createRequest(request.instruction, browserId: request.browserId) == nil { failure = workstation.failure }
            retrying = nil
        }
    }

    private var composer: some View {
        let aimed = self.target
        return HStack(spacing: 8) {
            Image(systemName: aimed == nil ? "sparkles" : "text.bubble")
                .foregroundStyle(Color.accentColor)
                .accessibilityHidden(true)
            TextField(aimed == nil ? OSText.followUp : OSText.reply, text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .focused($composing)
                .onSubmit(send)
                .disabled(sending || !server.canAct)
            // La case ne paraît qu'avec une consigne en cours : elle porte sur elle.
            if let aimed, !draft.isEmpty, server.osGestures(aimed).always {
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
            if let run = self.target {
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

extension OSPhase {
    /// L'état d'un fil ou d'une tâche au mot du glossaire de l'interface : « en attente »
    /// pour ce qui attend son tour, les autres mots étant ceux de `label`.
    var osWord: String {
        self == .queued ? OSDecideText.stateWaiting : label
    }
}
