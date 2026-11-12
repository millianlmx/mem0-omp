import Charts
import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

// Le DIRECT d'un agent du serveur, sur iPhone et iPad : ce qu'il écrit, son
// raisonnement et chaque outil qu'il lance, avec son résultat, en temps réel — et,
// pour une feature, les fichiers qu'elle touche (leurs différences en un toucher), la
// sortie de ses tests et sa frise. Le contenu (`IOSSessionSections`) se pose dans une
// `List` : la page d'une feature (`IOSRunScreen`) le montre sous ses onglets, et la
// feuille « Session en direct » (`IOSSessionSheet`) le montre pour l'analyse d'un
// audit ou un job du poste.
//
// Chaque outil montre sa commande (son appel), même quand l'agent a donné son
// intention, et un appel de sous-agents montre chacun d'eux en une ligne, en direct.
// Un toucher ouvre son détail — son rendu lisible (`IOSToolBlockSections`), relu tant
// qu'il tourne, et son JSON brut replié dessous. Un paragraphe trop long pour le
// direct s'ouvre en entier.
//
// Le modèle suit un direct à la fois (`HarnessModel.followSession`) : la page ou la
// feuille l'ouvre à son apparition et l'arrête à sa disparition. Une session finie se
// rejoue page par page. « Suivre la fin » garde la dernière entrée à l'écran, d'un
// saut sous « Réduire les animations » (`IOSMotion`). Les mots viennent du noyau
// (`PipelineServerText`, `MonitoringText`) : aucun libellé en dur ici (`design-ios/AC-5`).

/// Ce que montre le contenu d'un direct : l'agent en direct, puis, pour une feature,
/// ses fichiers, ses tests et sa frise.
enum IOSSessionTab: Hashable {
    case live, changes, tests, timeline
}

/// Le contenu d'un direct, posé dans une `List` : son état, puis l'onglet montré. Les
/// détails (différences d'un fichier, entrée entière) se poussent dans la pile de
/// navigation qui l'entoure.
struct IOSSessionSections: View {
    let server: HarnessModel
    /// Le direct seul (publié au plus quatre fois par seconde), pas tout le modèle.
    @ObservedObject private var direct: HarnessDirect
    let target: HarnessSessionTarget
    let tab: IOSSessionTab
    @Binding var followsEnd: Bool

    init(server: HarnessModel, target: HarnessSessionTarget, tab: IOSSessionTab, followsEnd: Binding<Bool>) {
        self.server = server
        _direct = ObservedObject(wrappedValue: server.direct)
        self.target = target
        self.tab = tab
        _followsEnd = followsEnd
    }

    var body: some View {
        statusSection
        switch tab {
        case .live:
            liveSections
        case .changes:
            if let runId { IOSChangesSections(server: server, runId: runId, refreshKey: feed?.toolsDone ?? 0) }
        case .tests:
            IOSTestsSections(jobs: feed?.tests ?? [])
        case .timeline:
            if let runId { IOSTimelineSections(server: server, runId: runId, refreshKey: feed?.entries.count ?? 0) }
        }
    }

    private var runId: String? {
        if case let .run(id) = target { id } else { nil }
    }

    private var feed: HarnessSessionFeed? {
        direct.feed?.target == target ? direct.feed : nil
    }

    @ViewBuilder
    private var liveSections: some View {
        if feed?.hasEarlier == true {
            Section {
                Button(MonitoringText.loadEarlier) {
                    followsEnd = false
                    Task { await server.loadEarlierSession() }
                }
                .accessibilityIdentifier("ios.session.earlier")
            }
        }
        if let feed {
            // Une section par étape : des tranches d'index, sans recopier les entrées.
            ForEach(feed.stepSegments) { segment in
                Section {
                    ForEach(feed.entries[segment.range]) { entry in
                        Group {
                            if entry.canOpenDetails {
                                NavigationLink {
                                    IOSSessionDetailScreen(server: server, target: target, seq: entry.seq)
                                } label: {
                                    IOSSessionEntryRow(entry: entry, opens: true)
                                        .equatable()
                                }
                            } else {
                                IOSSessionEntryRow(entry: entry, opens: false)
                                    .equatable()
                            }
                        }
                        .id(entry.seq)
                    }
                } header: {
                    if let step = segment.step {
                        Text(PipelineServerText.sessionStep(HarnessRun.label(forStep: step)))
                    }
                }
            }
        }
    }

    /// L'état du direct, en tête : l'agent au travail (et son outil du moment, ou le job
    /// de tests en cours), ou au repos ; l'échec qui a arrêté le direct, ou la
    /// reconnexion en cours.
    @ViewBuilder
    private var statusSection: some View {
        Section {
            if let failure = direct.failure {
                Text(failure.message)
                    .font(.callout)
                    .iosBanner(tone: .attention)
            } else if let feed, feed.isLoaded {
                IOSStatusChip(status: ConsoleStatus(
                    text: feed.isRunning ? PipelineServerText.sessionWorking : PipelineServerText.sessionIdle,
                    tone: feed.isRunning ? .info : .neutral
                ))
                if let current = feed.current {
                    Text(PipelineServerText.sessionNow(current.tool ?? current.text))
                        .font(.footnote.monospaced())
                        .foregroundStyle(.secondary)
                }
                if let test = feed.runningTest {
                    Label(MonitoringText.testLine(scope: test.scope, attempt: test.attempt, outcome: nil), systemImage: MonitoringText.testSymbol(nil))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if !direct.isLive {
                    Text(PipelineServerText.sessionReconnecting)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if feed.entries.isEmpty, tab == .live {
                    Text(PipelineServerText.sessionEmpty)
                        .foregroundStyle(.secondary)
                }
            } else {
                HStack {
                    ProgressView()
                    Text(PipelineServerText.sessionConnecting)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

extension View {
    /// « Suivre la fin » : la liste qui montre le direct de `target` garde sa dernière
    /// entrée à l'écran tant que `followsEnd` est vrai et que le direct est montré.
    func iosFollowsSessionEnd(server: HarnessModel, target: HarnessSessionTarget, shown: Bool, followsEnd: Bool, proxy: ScrollViewProxy) -> some View {
        modifier(IOSSessionEndFollower(direct: server.direct, target: target, shown: shown, followsEnd: followsEnd, proxy: proxy))
    }
}

private struct IOSSessionEndFollower: ViewModifier {
    @ObservedObject var direct: HarnessDirect
    let target: HarnessSessionTarget
    let shown: Bool
    let followsEnd: Bool
    let proxy: ScrollViewProxy
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .onChange(of: last) { _, last in scroll(to: last) }
            .onChange(of: followsEnd) { _, _ in scroll(to: last) }
    }

    private var last: HarnessSessionEntry? {
        direct.feed?.target == target ? direct.feed?.entries.last : nil
    }

    private func scroll(to last: HarnessSessionEntry?) {
        guard followsEnd, shown, let last else { return }
        withAnimation(IOSMotion.scrollAnimation(reduceMotion: reduceMotion)) {
            proxy.scrollTo(last.seq, anchor: .bottom)
        }
    }
}

/// Le bouton de barre « Suivre la fin » d'un direct.
struct IOSFollowEndToggle: View {
    @Binding var followsEnd: Bool

    var body: some View {
        Toggle(isOn: $followsEnd) {
            Label(PipelineServerText.sessionFollowEnd, systemImage: PipelineServerText.sessionFollowEndSymbol)
        }
        .toggleStyle(.button)
        .accessibilityIdentifier("ios.session.followEnd")
    }
}

/// La feuille « Session en direct » : l'analyse d'un audit ou un job du poste
/// (`drafts.sessionRequest`). Une feature, elle, s'ouvre en page (`IOSRunScreen`).
struct IOSSessionSheet: View {
    @ObservedObject var server: HarnessModel
    let request: HarnessSessionRequest
    @Environment(\.dismiss) private var dismiss
    @State private var followsEnd = true

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                List {
                    IOSSessionSections(server: server, target: request.target, tab: .live, followsEnd: $followsEnd)
                }
                .iosGroupedList()
                .iosFollowsSessionEnd(server: server, target: request.target, shown: true, followsEnd: followsEnd, proxy: proxy)
            }
            .navigationTitle(request.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    // Forme 44 pt, comme la fiche d'un souvenir : le bouton de barre par défaut n'a que 36 pt.
                    Button {
                        dismiss()
                    } label: {
                        Text(PipelineServerText.close)
                            .padding(.horizontal, 8)
                            .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("ios.session.close")
                }
                ToolbarItem(placement: .topBarLeading) {
                    IOSFollowEndToggle(followsEnd: $followsEnd)
                }
            }
        }
        // Une pose pour toute la feuille : le texte de l'agent, ses commandes et leurs résultats se copient.
        .textSelection(.enabled)
        .iosPageSheet()
        .onAppear { server.followSession(request.target) }
        .onDisappear { server.stopSession() }
    }
}

/// Une entrée du direct : un paragraphe rendu en Markdown, un raisonnement replié, un
/// outil (son état, son intention, sa commande, sa durée, son résultat replié) ou un
/// signal. `opens` : la rangée ouvre le détail de l'entrée (lien de navigation) — le
/// résultat et le raisonnement s'y lisent en entier, la rangée ne les replie pas. Égale à
/// elle-même tant que son entrée l'est : une rangée inchangée ne se redessine pas.
struct IOSSessionEntryRow: View, Equatable {
    let entry: HarnessSessionEntry
    let opens: Bool

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.entry == rhs.entry && lhs.opens == rhs.opens }

    var body: some View {
        switch entry.sort {
        case .tool:
            tool
        case .thinking:
            if opens {
                thinkingLabel
            } else {
                DisclosureGroup {
                    Text(entry.text)
                        .italic()
                        .foregroundStyle(.secondary)
                } label: {
                    thinkingLabel
                }
            }
        case .notice:
            Label(PipelineServerText.sessionNotice(entry.text), systemImage: PipelineServerText.sessionEntrySymbol(kind: entry.kind, status: nil))
                .font(.footnote)
                .foregroundStyle(.secondary)
        case .text:
            IOSMarkdownView(blocks: MarkdownDocument.blocks(entry.text))
        }
    }

    private var thinkingLabel: some View {
        Label(PipelineServerText.sessionThinking, systemImage: PipelineServerText.sessionEntrySymbol(kind: entry.kind, status: nil))
            .font(.subheadline)
            .foregroundStyle(.secondary)
    }

    private var tool: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Group {
                    if entry.isRunning {
                        ProgressView()
                    } else {
                        Image(systemName: PipelineServerText.sessionEntrySymbol(kind: entry.kind, status: entry.status))
                            .foregroundStyle(entry.isFailure ? Color.red : Color.green)
                    }
                }
                .accessibilityHidden(true)
                Text(entry.tool ?? "")
                    .font(.subheadline.monospaced().weight(.semibold))
                if let duration = entry.durationMs {
                    Text(PipelineServerText.sessionDuration(ms: duration))
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
            if !entry.text.isEmpty {
                Text(entry.text)
                    .font(.footnote.monospaced())
                    .foregroundStyle(.secondary)
            }
            if let call = entry.distinctCall {
                Text(call)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            if let agents = entry.agents, !agents.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(agents) { agent in
                        IOSAgentLineView(agent: agent)
                    }
                }
            } else if !opens, let detail = entry.detail {
                DisclosureGroup(PipelineServerText.sessionResult) {
                    Text(detail)
                        .font(.caption.monospaced())
                        .foregroundStyle(entry.isFailure ? Color.red : Color.secondary)
                }
                .font(.footnote)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(PipelineServerText.toolLine(tool: entry.tool ?? "", status: entry.status, text: entry.text))
    }
}

// MARK: - Détail d'une entrée

/// Le détail d'une entrée du direct : pour un outil, son état, son appel, ses arguments
/// complets et sa sortie entière — relus à chaque version de l'entrée tant qu'il
/// tourne —, pour un long paragraphe ou raisonnement, son texte entier. Le texte se
/// sélectionne par la pose de la feuille.
struct IOSSessionDetailScreen: View {
    let server: HarnessModel
    @ObservedObject private var direct: HarnessDirect
    let target: HarnessSessionTarget
    let seq: Int
    @State private var detail: HarnessSessionDetail?
    @State private var loaded = false
    @State private var showsRaw = false

    init(server: HarnessModel, target: HarnessSessionTarget, seq: Int) {
        self.server = server
        _direct = ObservedObject(wrappedValue: server.direct)
        self.target = target
        self.seq = seq
    }

    var body: some View {
        List {
            if let detail, let entry {
                if entry.isTool {
                    Section {
                        statusRow(entry)
                        if let step = entry.step {
                            Text(PipelineServerText.sessionStep(HarnessRun.label(forStep: step)))
                                .foregroundStyle(.secondary)
                        }
                        if let duration = entry.durationMs {
                            Text(PipelineServerText.sessionDuration(ms: duration))
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                if entry.isTool, detail.hasRendering, let view = detail.view {
                    if view.showsHeadline || entry.distinctCall != nil {
                        Section {
                            if view.showsHeadline {
                                code(view.headline)
                            }
                            // L'intention de l'agent, quand elle dit autre chose que l'appel.
                            if entry.distinctCall != nil {
                                Text(entry.text)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    IOSToolBlockSections(blocks: view.blocks)
                    if detail.args != nil || detail.result != nil {
                        Section {
                            DisclosureGroup(PipelineServerText.sessionRawJSON, isExpanded: $showsRaw) {
                                if let args = detail.args {
                                    Text(PipelineServerText.sessionRawArguments)
                                        .font(.subheadline.weight(.semibold))
                                    code(args)
                                }
                                if let result = detail.result {
                                    Text(PipelineServerText.sessionRawResult)
                                        .font(.subheadline.weight(.semibold))
                                    code(result)
                                }
                            }
                            .accessibilityIdentifier("ios.session.detail.raw")
                        }
                    }
                } else if entry.isTool {
                    if let call = entry.call {
                        Section {
                            code(call)
                        } header: {
                            Text(PipelineServerText.sessionCall)
                        }
                    }
                    if let args = detail.args {
                        Section {
                            code(args)
                        } header: {
                            Text(PipelineServerText.sessionArguments)
                        }
                    }
                    Section {
                        if let output = detail.output {
                            code(output, failure: entry.isFailure)
                        } else {
                            Text(PipelineServerText.sessionNoOutput)
                                .foregroundStyle(.secondary)
                        }
                    } header: {
                        Text(PipelineServerText.sessionOutput)
                    }
                } else if entry.isThinking {
                    Section {
                        Text(detail.output ?? entry.text)
                            .italic()
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Section {
                        IOSMarkdownView(blocks: MarkdownDocument.blocks(detail.output ?? entry.text))
                    }
                }
            } else if loaded {
                Section {
                    Text(PipelineServerText.sessionDetailUnavailable)
                        .foregroundStyle(.secondary)
                }
            } else {
                Section {
                    ProgressView()
                }
            }
        }
        .iosGroupedList()
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: live) {
            // Une rafale de versions (une commande qui écrit) ne coûte qu'une lecture.
            if loaded { try? await Task.sleep(for: .milliseconds(300)) }
            guard !Task.isCancelled else { return }
            if let fresh = await server.sessionDetail(target, seq: seq) { detail = fresh }
            loaded = true
        }
    }

    /// L'entrée telle que le direct la tient : chacune de ses versions relit le détail.
    private var live: HarnessSessionEntry? {
        guard direct.feed?.target == target else { return nil }
        return direct.feed?.entries.last { $0.seq == seq }
    }

    private var entry: HarnessSessionEntry? { live ?? detail?.entry }

    private var title: String {
        guard let entry else { return PipelineServerText.sessionDetails }
        switch entry.sort {
        case .tool: return entry.tool ?? PipelineServerText.sessionDetails
        case .thinking: return PipelineServerText.sessionThinking
        case .text, .notice: return PipelineServerText.sessionFullText
        }
    }

    private func statusRow(_ entry: HarnessSessionEntry) -> some View {
        HStack(spacing: 8) {
            Group {
                if entry.isRunning {
                    ProgressView()
                } else {
                    Image(systemName: PipelineServerText.sessionEntrySymbol(kind: entry.kind, status: entry.status))
                        .foregroundStyle(entry.isFailure ? Color.red : Color.green)
                }
            }
            .accessibilityHidden(true)
            Text(PipelineServerText.toolStatus(entry.status))
        }
    }

    /// Un texte d'outil tel quel, en chasse fixe.
    private func code(_ text: String, failure: Bool = false) -> some View {
        Text(text)
            .font(.footnote.monospaced())
            .foregroundStyle(failure ? Color.red : Color.primary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Fichiers touchés

/// Les fichiers touchés par la feature ; chacun ouvre ses différences. Relus quand un
/// outil de l'agent se termine (`refreshKey`), après deux secondes de calme.
struct IOSChangesSections: View {
    @ObservedObject var server: HarnessModel
    let runId: String
    let refreshKey: Int
    @State private var changes: HarnessChanges?
    @State private var loaded = false

    var body: some View {
        Section {
            if let changes {
                if changes.touched.isEmpty {
                    Text(MonitoringText.changesEmpty)
                        .foregroundStyle(.secondary)
                }
                ForEach(changes.touched) { file in
                    NavigationLink {
                        IOSDiffScreen(server: server, runId: runId, path: file.path)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(file.path)
                                .font(.footnote.monospaced())
                            Text(file.line)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } else if loaded {
                Text(MonitoringText.changesUnavailable)
                    .foregroundStyle(.secondary)
            } else {
                ProgressView()
            }
        } header: {
            if let changes {
                Text(MonitoringText.changesSummary(count: changes.touched.count, added: changes.added, removed: changes.removed))
            } else {
                Text(MonitoringText.changesTitle)
            }
        } footer: {
            if let changes { Text(MonitoringText.changesSource(changes.source)) }
        }
        .task(id: refreshKey) {
            if loaded { try? await Task.sleep(for: .seconds(2)) }
            guard !Task.isCancelled else { return }
            changes = await server.changes(runId: runId)
            loaded = true
        }
    }
}

/// Les différences d'un fichier, ligne à ligne : ajouts en vert, retraits en rouge.
struct IOSDiffScreen: View {
    @ObservedObject var server: HarnessModel
    let runId: String
    let path: String
    @State private var diff: HarnessFileDiff?
    @State private var loaded = false

    var body: some View {
        Group {
            if let diff {
                ScrollView([.vertical, .horizontal]) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if diff.truncated {
                            Text(MonitoringText.diffTruncated)
                                .font(.footnote)
                                .iosBanner(tone: .attention)
                        }
                        ForEach(diff.lines) { line in
                            Text(line.text)
                                .font(.footnote.monospaced())
                                .foregroundStyle(line.kind == .hunk ? Color.secondary : Color.primary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 6)
                                .background(Self.tint(line.kind))
                        }
                    }
                    .padding(8)
                }
            } else if loaded {
                Text(MonitoringText.diffUnavailable)
                    .foregroundStyle(.secondary)
                    .padding()
            } else {
                ProgressView()
            }
        }
        .navigationTitle(path)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            diff = await server.fileDiff(runId: runId, path: path)
            loaded = true
        }
    }

    static func tint(_ kind: HarnessDiffLine.Kind) -> Color {
        switch kind {
        case .added: Color.green.opacity(0.18)
        case .removed: Color.red.opacity(0.18)
        case .hunk: Color.secondary.opacity(0.1)
        case .context: Color.clear
        }
    }
}

// MARK: - Tests en direct

/// Les derniers jobs de tests de la feature, le plus récent d'abord ; sa sortie s'écrit
/// en direct, celle des autres se déplie.
struct IOSTestsSections: View {
    let jobs: [HarnessTestJob]

    var body: some View {
        if jobs.isEmpty {
            Section {
                Text(MonitoringText.testsEmpty)
                    .foregroundStyle(.secondary)
            }
        }
        ForEach(Array(jobs.reversed().enumerated()), id: \.element.id) { index, job in
            Section {
                if index == 0 {
                    Text(job.output)
                        .font(.caption.monospaced())
                } else {
                    DisclosureGroup(MonitoringText.testsTitle) {
                        Text(job.output)
                            .font(.caption.monospaced())
                    }
                }
            } header: {
                Label(MonitoringText.testLine(scope: job.scope, attempt: job.attempt, outcome: job.outcome), systemImage: MonitoringText.testSymbol(job.outcome))
            }
        }
    }
}

// MARK: - Frise

/// La frise de la feature : ses étapes sur l'axe du temps, puis ses événements
/// marquants, ses décisions et ses tests. Relue quand le direct avance.
struct IOSTimelineSections: View {
    @ObservedObject var server: HarnessModel
    let runId: String
    let refreshKey: Int
    @State private var timeline: HarnessTimeline?
    @State private var loaded = false

    var body: some View {
        Group {
            if let timeline {
                Section {
                    if timeline.steps.isEmpty {
                        Text(MonitoringText.timelineEmpty)
                            .foregroundStyle(.secondary)
                    } else {
                        Chart(Array(timeline.steps.enumerated()), id: \.element.id) { item in
                            BarMark(
                                xStart: .value(MonitoringText.timelineTimeAxis, Self.date(item.element.startedAt)),
                                xEnd: .value(MonitoringText.timelineTimeAxis, Self.date(item.element.endedAt ?? timeline.now)),
                                y: .value(MonitoringText.timelineStepAxis, timeline.chartLabel(position: item.offset + 1, step: item.element))
                            )
                            .foregroundStyle(Self.color(item.element.phase))
                        }
                        .frame(minHeight: CGFloat(timeline.steps.count) * 32 + 40)
                        .accessibilityHidden(true)
                        ForEach(timeline.steps) { step in
                            LabeledContent {
                                Text(timeline.costLine(for: step))
                                    .monospacedDigit()
                            } label: {
                                Text(timeline.line(for: step))
                                    .monospacedDigit()
                            }
                        }
                    }
                } header: {
                    Text(MonitoringText.timelineSteps)
                } footer: {
                    Text(MonitoringText.costFooter(timeline.cost))
                }
                if !timeline.events.isEmpty {
                    Section {
                        ForEach(Array(timeline.events.enumerated()), id: \.offset) { _, event in
                            VStack(alignment: .leading, spacing: 2) {
                                LabeledContent {
                                    Text(Self.time(event.at))
                                        .monospacedDigit()
                                } label: {
                                    Label(MonitoringText.event(event.type), systemImage: MonitoringText.eventSymbol(event.type))
                                }
                                if let summary = event.summary {
                                    Text(summary)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    } header: {
                        Text(MonitoringText.timelineEvents)
                    }
                }
                if !timeline.decisions.isEmpty {
                    Section {
                        ForEach(timeline.decisions, id: \.seq) { decision in
                            Text(MonitoringText.decisionLine(seq: decision.seq, question: decision.question, chosen: decision.chosen))
                        }
                    } header: {
                        Text(MonitoringText.timelineDecisions)
                    }
                }
                if !timeline.tests.isEmpty {
                    Section {
                        ForEach(Array(timeline.tests.enumerated()), id: \.offset) { _, test in
                            LabeledContent(MonitoringText.testLine(scope: test.scope, attempt: max(test.attempts, 1), outcome: test.outcome), value: Self.time(test.at))
                        }
                    } header: {
                        Text(MonitoringText.timelineTests)
                    }
                }
            } else if loaded {
                Section {
                    Text(MonitoringText.timelineUnavailable)
                        .foregroundStyle(.secondary)
                }
            } else {
                Section {
                    ProgressView()
                }
            }
        }
        .task(id: refreshKey) {
            if loaded { try? await Task.sleep(for: .seconds(2)) }
            guard !Task.isCancelled else { return }
            timeline = await server.timeline(runId: runId)
            loaded = true
        }
    }

    static func color(_ phase: HarnessStepPhase) -> Color {
        switch phase {
        case .done: .green
        case .failed: .red
        case .running: .blue
        case .escalated: .orange
        case .other: .gray
        }
    }

    static func date(_ ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }

    static func time(_ ms: Double) -> String {
        date(ms).formatted(date: .omitted, time: .shortened)
    }
}
