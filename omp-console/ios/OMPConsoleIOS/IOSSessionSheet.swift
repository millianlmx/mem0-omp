import Charts
import ConsoleClient
import ConsoleCore
import SwiftUI

// La feuille « Session en direct » d'une feature (ou « Analyse en direct » d'un audit),
// sur iPhone et iPad : ce que l'agent du serveur écrit, son raisonnement et chaque
// outil qu'il lance, avec son résultat, en temps réel — et, pour une feature, les
// fichiers qu'elle touche (leurs différences en un toucher), la sortie de ses tests
// et sa frise, dans des onglets. Ouverte depuis le menu contextuel d'une feature
// (`IOSHarnessRunRow`) ou d'un audit.
//
// Le modèle suit un direct à la fois (`HarnessModel.followSession`) : la feuille
// l'ouvre à son apparition et l'arrête à sa fermeture. Une session finie se rejoue
// page par page. « Suivre la fin » garde la dernière entrée à l'écran, d'un saut sous
// « Réduire les animations » (`IOSMotion`). Le texte se sélectionne partout dans la
// feuille (une seule pose, sur sa pile de navigation). Les mots viennent du noyau
// (`PipelineServerText`, `MonitoringText`) : aucun libellé en dur ici (`design-ios/AC-5`).

/// Les onglets de la feuille.
enum IOSSessionTab: Hashable, CaseIterable {
    case live, changes, tests, timeline

    var title: String {
        switch self {
        case .live: MonitoringText.tabLive
        case .changes: MonitoringText.tabFiles
        case .tests: MonitoringText.tabTests
        case .timeline: MonitoringText.tabTimeline
        }
    }
}

/// Un fichier dont on lit les différences (destination de navigation).
struct IOSDiffTarget: Hashable {
    let runId: String
    let path: String
}

struct IOSSessionSheet: View {
    @ObservedObject var server: HarnessModel
    let request: HarnessSessionRequest
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var followsEnd = true
    @State private var tab: IOSSessionTab = .live

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                List {
                    if request.runId != nil {
                        Picker(PipelineServerText.sessionTitle, selection: $tab) {
                            ForEach(IOSSessionTab.allCases, id: \.self) { tab in
                                Text(tab.title).tag(tab)
                            }
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .iosBareListRow()
                        .accessibilityIdentifier("ios.session.tabs")
                    }
                    statusSection
                    switch tab {
                    case .live:
                        liveSections
                    case .changes:
                        if let runId = request.runId { IOSChangesSections(server: server, runId: runId, refreshKey: toolsDone) }
                    case .tests:
                        IOSTestsSections(jobs: feed?.tests ?? [])
                    case .timeline:
                        if let runId = request.runId { IOSTimelineSections(server: server, runId: runId, refreshKey: feed?.entries.count ?? 0) }
                    }
                }
                .iosGroupedList()
                .onChange(of: entries.last) { _, last in
                    scroll(proxy, to: last)
                }
                .onChange(of: followsEnd) { _, _ in
                    scroll(proxy, to: entries.last)
                }
            }
            .navigationTitle(request.title)
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: IOSDiffTarget.self) { target in
                IOSDiffScreen(server: server, target: target)
            }
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
                    Toggle(isOn: $followsEnd) {
                        Label(PipelineServerText.sessionFollowEnd, systemImage: PipelineServerText.sessionFollowEndSymbol)
                    }
                    .toggleStyle(.button)
                    .accessibilityIdentifier("ios.session.followEnd")
                }
            }
        }
        // Une pose pour toute la feuille : le texte de l'agent, ses commandes, leurs résultats et les différences se copient.
        .textSelection(.enabled)
        .iosPageSheet()
        .onAppear { server.followSession(request.target) }
        .onDisappear { server.stopSession() }
    }

    private var feed: HarnessSessionFeed? {
        server.session?.target == request.target ? server.session : nil
    }

    private var entries: [HarnessSessionEntry] { feed?.entries ?? [] }

    /// Les outils terminés : leur nombre relit les fichiers touchés.
    private var toolsDone: Int {
        entries.filter { $0.isTool && !$0.isRunning }.count
    }

    /// Les entrées, en groupes consécutifs de même étape.
    private var groups: [[HarnessSessionEntry]] {
        var groups: [[HarnessSessionEntry]] = []
        for entry in entries {
            if let last = groups.last?.last, last.step == entry.step {
                groups[groups.count - 1].append(entry)
            } else {
                groups.append([entry])
            }
        }
        return groups
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
        ForEach(groups, id: \.first?.seq) { group in
            Section {
                ForEach(group) { entry in
                    IOSSessionEntryRow(entry: entry)
                        .id(entry.seq)
                }
            } header: {
                if let step = group.first?.step {
                    Text(PipelineServerText.sessionStep(HarnessRun.label(forStep: step)))
                }
            }
        }
    }

    /// L'état du direct, en tête : l'agent au travail (et son outil du moment, ou le job
    /// de tests en cours), ou au repos ; les alertes de la feature ; l'échec qui a arrêté
    /// le direct, ou la reconnexion en cours.
    @ViewBuilder
    private var statusSection: some View {
        Section {
            if let failure = server.sessionFailure {
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
                if let runId = request.runId {
                    ForEach(server.inbox?.alerts(of: runId) ?? []) { alert in
                        Label(alert.line, systemImage: alert.symbol)
                            .font(.footnote)
                            .iosBanner(tone: .attention)
                    }
                    if let cost = server.inbox?.costs[runId] {
                        LabeledContent(MonitoringText.costLabel, value: MonitoringText.cost(cost))
                    }
                }
                if !server.isSessionLive {
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

    private func scroll(_ proxy: ScrollViewProxy, to last: HarnessSessionEntry?) {
        guard followsEnd, tab == .live, let last else { return }
        withAnimation(IOSMotion.scrollAnimation(reduceMotion: reduceMotion)) {
            proxy.scrollTo(last.seq, anchor: .bottom)
        }
    }
}

/// Une entrée du direct : un paragraphe, un raisonnement replié, un outil (son état,
/// son intention, son résultat replié) ou un signal.
struct IOSSessionEntryRow: View {
    let entry: HarnessSessionEntry

    var body: some View {
        switch entry.sort {
        case .tool:
            tool
        case .thinking:
            DisclosureGroup {
                Text(entry.text)
                    .italic()
                    .foregroundStyle(.secondary)
            } label: {
                Label(PipelineServerText.sessionThinking, systemImage: PipelineServerText.sessionEntrySymbol(kind: entry.kind, status: nil))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        case .notice:
            Label(PipelineServerText.sessionNotice(entry.text), systemImage: PipelineServerText.sessionEntrySymbol(kind: entry.kind, status: nil))
                .font(.footnote)
                .foregroundStyle(.secondary)
        case .text:
            Text(Self.markdown(entry.text))
        }
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
            }
            if !entry.text.isEmpty {
                Text(entry.text)
                    .font(.footnote.monospaced())
                    .foregroundStyle(.secondary)
            }
            if let detail = entry.detail {
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

    /// Le texte de l'agent en Markdown en ligne (gras, code, liens), sauts de ligne gardés.
    static func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
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
                    NavigationLink(value: IOSDiffTarget(runId: runId, path: file.path)) {
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
    let target: IOSDiffTarget
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
        .navigationTitle(target.path)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            diff = await server.fileDiff(runId: target.runId, path: target.path)
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
