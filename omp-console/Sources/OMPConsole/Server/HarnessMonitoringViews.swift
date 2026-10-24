// Les panneaux du monitoring sur le Mac : les fichiers touchés par une feature et leurs
// différences, la sortie de ses tests en direct, sa frise ; et, dans les sections, les
// alertes de la veille, le coût, la comparaison des modèles, les tests instables et la
// santé du serveur. Tout vient du serveur de pipelines (`HarnessModel`) ; les mots de
// `MonitoringText`.

import Charts
import ConsoleClient
import ConsoleCore
import SwiftUI

// MARK: - Fichiers touchés

/// La liste des fichiers touchés et, à droite, les différences du fichier choisi. La
/// liste se relit quand un outil de l'agent se termine (`refreshKey`), après deux
/// secondes de calme.
struct HarnessChangesPane: View {
    @ObservedObject var server: HarnessModel
    let runId: String
    let refreshKey: Int
    @State private var changes: HarnessChanges?
    @State private var loaded = false
    @State private var selection: String?
    @State private var diff: HarnessFileDiff?

    var body: some View {
        HSplitView {
            List(selection: $selection) {
                if let changes {
                    Section {
                        ForEach(changes.files) { file in
                            HStack {
                                Text(file.path)
                                    .font(.callout.monospaced())
                                    .lineLimit(1)
                                    .truncationMode(.head)
                                Spacer()
                                Text(MonitoringText.lines(added: file.added, removed: file.removed))
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                            }
                            .help(MonitoringText.fileStatus(file.status))
                            .tag(file.path)
                        }
                    } header: {
                        Text(MonitoringText.changesSummary(count: changes.files.count, added: changes.added, removed: changes.removed))
                    } footer: {
                        Text(MonitoringText.changesSource(changes.source))
                    }
                } else if loaded {
                    Text(MonitoringText.changesUnavailable)
                        .foregroundStyle(.secondary)
                }
                if changes?.files.isEmpty == true {
                    Text(MonitoringText.changesEmpty)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(minWidth: 240, idealWidth: 300)
            Group {
                if let diff, diff.path == selection {
                    HarnessDiffView(diff: diff)
                } else {
                    Text(MonitoringText.diffChoose)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(minWidth: 360)
        }
        .task(id: refreshKey) {
            // Une rafale d'outils ne relit qu'une fois : la tâche précédente est annulée.
            if loaded { try? await Task.sleep(for: .seconds(2)) }
            guard !Task.isCancelled else { return }
            changes = await server.changes(runId: runId)
            loaded = true
            if let selection { diff = await server.fileDiff(runId: runId, path: selection) }
        }
        .task(id: selection) {
            guard let selection else { return }
            diff = await server.fileDiff(runId: runId, path: selection)
        }
    }
}

/// Les différences d'un fichier, ligne à ligne, ajouts en vert et retraits en rouge.
struct HarnessDiffView: View {
    let diff: HarnessFileDiff

    var body: some View {
        ScrollView([.vertical, .horizontal]) {
            LazyVStack(alignment: .leading, spacing: 0) {
                if diff.truncated {
                    Label(MonitoringText.diffTruncated, systemImage: "scissors")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .padding(.bottom, 6)
                }
                ForEach(diff.lines) { line in
                    Text(line.text.isEmpty ? " " : line.text)
                        .font(.callout.monospaced())
                        .foregroundStyle(line.kind == .hunk ? Color.secondary : Color.primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 6)
                        .background(Self.tint(line.kind))
                }
            }
            .textSelection(.enabled)
            .padding(8)
        }
    }

    static func tint(_ kind: HarnessDiffLine.Kind) -> Color {
        switch kind {
        case .added: Color.green.opacity(0.15)
        case .removed: Color.red.opacity(0.15)
        case .hunk: Color.secondary.opacity(0.08)
        case .context: Color.clear
        }
    }
}

// MARK: - Tests en direct

/// Les derniers jobs de tests d'une feature ; la sortie du job choisi (par défaut le
/// dernier) défile au fil de son écriture.
struct HarnessTestsPane: View {
    let jobs: [HarnessTestJob]
    let followsEnd: Bool
    @State private var selection: Int?

    var body: some View {
        if jobs.isEmpty {
            Text(MonitoringText.testsEmpty)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            HSplitView {
                List(selection: $selection) {
                    ForEach(jobs.reversed()) { job in
                        Label(MonitoringText.testLine(scope: job.scope, attempt: job.attempt, outcome: job.outcome), systemImage: MonitoringText.testSymbol(job.outcome))
                            .foregroundStyle(job.outcome == nil ? Color.primary : job.passed ? Color.green : Color.red)
                            .tag(job.id)
                    }
                }
                .frame(minWidth: 220, idealWidth: 260)
                output
                    .frame(minWidth: 360)
            }
        }
    }

    private var shown: HarnessTestJob? {
        jobs.first { $0.id == selection } ?? jobs.last
    }

    private var output: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Text(shown?.output ?? "")
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                Color.clear.frame(height: 1).id("fin")
            }
            .onChange(of: shown?.output) { _, _ in
                if followsEnd { proxy.scrollTo("fin", anchor: .bottom) }
            }
        }
    }
}

// MARK: - Frise

/// La frise d'une feature : ses étapes sur l'axe du temps (une barre par étape), puis
/// ses événements marquants, ses décisions et ses tests, dans l'ordre. Relue quand le
/// direct avance (`refreshKey`), après deux secondes de calme.
struct HarnessTimelinePane: View {
    @ObservedObject var server: HarnessModel
    let runId: String
    let refreshKey: Int
    @State private var timeline: HarnessTimeline?
    @State private var loaded = false

    var body: some View {
        Group {
            if let timeline {
                Form {
                    Section {
                        if timeline.steps.isEmpty {
                            Text(MonitoringText.timelineEmpty)
                                .foregroundStyle(.secondary)
                        } else {
                            chart(timeline)
                                .frame(minHeight: CGFloat(timeline.steps.count) * 28 + 40)
                            ForEach(timeline.steps) { step in
                                LabeledContent(timeline.line(for: step), value: timeline.costLine(for: step))
                            }
                        }
                    } header: {
                        Text(MonitoringText.timelineSteps)
                    } footer: {
                        Text(MonitoringText.costFooter(timeline.cost))
                    }
                    if !timeline.events.isEmpty {
                        Section(MonitoringText.timelineEvents) {
                            ForEach(Array(timeline.events.enumerated()), id: \.offset) { _, event in
                                HStack(alignment: .firstTextBaseline) {
                                    Label(MonitoringText.event(event.type), systemImage: MonitoringText.eventSymbol(event.type))
                                    Spacer()
                                    Text(Self.time(event.at))
                                        .font(.caption.monospacedDigit())
                                        .foregroundStyle(.secondary)
                                }
                                if let summary = event.summary {
                                    Text(summary)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .textSelection(.enabled)
                                }
                            }
                        }
                    }
                    if !timeline.decisions.isEmpty {
                        Section(MonitoringText.timelineDecisions) {
                            ForEach(timeline.decisions, id: \.seq) { decision in
                                Text(MonitoringText.decisionLine(seq: decision.seq, question: decision.question, chosen: decision.chosen))
                            }
                        }
                    }
                    if !timeline.tests.isEmpty {
                        Section(MonitoringText.timelineTests) {
                            ForEach(Array(timeline.tests.enumerated()), id: \.offset) { _, test in
                                LabeledContent(MonitoringText.testLine(scope: test.scope, attempt: max(test.attempts, 1), outcome: test.outcome), value: Self.time(test.at))
                            }
                        }
                    }
                }
                .formStyle(.grouped)
            } else if loaded {
                Text(MonitoringText.timelineUnavailable)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: refreshKey) {
            if loaded { try? await Task.sleep(for: .seconds(2)) }
            guard !Task.isCancelled else { return }
            timeline = await server.timeline(runId: runId)
            loaded = true
        }
    }

    /// Une barre par étape, dans l'ordre : « 1. /req », « 2. /specs »… (une étape refaite a sa propre ligne).
    private func chart(_ timeline: HarnessTimeline) -> some View {
        Chart(Array(timeline.steps.enumerated()), id: \.element.id) { item in
            BarMark(
                xStart: .value(MonitoringText.timelineTimeAxis, Self.date(item.element.startedAt)),
                xEnd: .value(MonitoringText.timelineTimeAxis, Self.date(item.element.endedAt ?? timeline.now)),
                y: .value(MonitoringText.timelineStepAxis, timeline.chartLabel(position: item.offset + 1, step: item.element))
            )
            .foregroundStyle(Self.color(item.element.phase))
            .cornerRadius(3)
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

// MARK: - Accueil : alertes

/// Les alertes de la veille du serveur, en tête de l'accueil ; chacune ouvre le direct de sa feature.
struct HarnessAlertsSection: View {
    @ObservedObject var drafts: HarnessDrafts
    let inbox: HarnessInbox

    var body: some View {
        if !inbox.alerts.isEmpty {
            Section {
                ForEach(inbox.alerts) { alert in
                    Button {
                        if let run = inbox.run(alert.runId) { drafts.sessionRequest = HarnessSessionRequest(run: run) }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Label(alert.line, systemImage: alert.symbol)
                                .foregroundStyle(.orange)
                            Text(inbox.run(alert.runId)?.title ?? alert.runId)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(.plain)
                }
            } header: {
                Text(MonitoringText.alertsTitle)
            } footer: {
                Text(MonitoringText.alertsHint)
            }
        }
    }
}

// MARK: - Statistiques

/// La consommation des agents : depuis le début, sur 7 jours, et jour par jour.
struct HarnessUsageSection: View {
    let usage: HarnessUsageStats

    var body: some View {
        Section {
            LabeledContent(MonitoringText.usageTotal, value: MonitoringText.usageLine(cost: usage.total.cost, tokens: usage.total.tokens))
            LabeledContent(MonitoringText.usageWeek, value: MonitoringText.usageLine(cost: usage.last7Days.cost, tokens: usage.last7Days.tokens))
            if usage.byDay.isEmpty {
                Text(MonitoringText.usageNone)
                    .foregroundStyle(.secondary)
            } else {
                Chart(usage.byDay) { day in
                    BarMark(
                        x: .value(MonitoringText.usageDayAxis, day.day),
                        y: .value(MonitoringText.costLabel, day.cost)
                    )
                }
                .frame(height: 140)
                .accessibilityLabel(MonitoringText.usageByDay)
            }
        } header: {
            Text(MonitoringText.usageTitle)
        } footer: {
            Text(MonitoringText.usageHint)
        }
    }
}

/// La comparaison des modèles, un par ligne.
struct HarnessModelsSection: View {
    let models: [HarnessModelStats]

    var body: some View {
        Section {
            if models.isEmpty {
                Text(MonitoringText.modelsNone)
                    .foregroundStyle(.secondary)
            }
            ForEach(models) { model in
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.model)
                        .font(.callout.monospaced())
                    Text(model.stepsLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(model.outcomeLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        } header: {
            Text(MonitoringText.modelsTitle)
        } footer: {
            Text(MonitoringText.modelsHint)
        }
    }
}

/// Les commandes de tests instables.
struct HarnessFlakySection: View {
    let flaky: [HarnessFlakyTest]

    var body: some View {
        Section {
            if flaky.isEmpty {
                Text(MonitoringText.flakyNone)
                    .foregroundStyle(.secondary)
            }
            ForEach(flaky) { test in
                VStack(alignment: .leading, spacing: 2) {
                    Text(test.command)
                        .font(.callout.monospaced())
                        .lineLimit(2)
                        .textSelection(.enabled)
                    Text(test.line)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        } header: {
            Text(MonitoringText.flakyTitle)
        } footer: {
            Text(MonitoringText.flakyHint)
        }
    }
}

/// La santé du serveur au fil du temps : occupation des agents et des tests, file
/// d'attente, mémoire libre, limites de débit et bascules. Relue toutes les
/// `sampleSec` secondes tant que la section est à l'écran.
struct HarnessHealthSection: View {
    @ObservedObject var server: HarnessModel

    var body: some View {
        Section {
            if let metrics = server.metrics, let last = metrics.samples.last {
                LabeledContent(MonitoringText.healthAgents, value: MonitoringText.slotsLine(used: last.runner.used, capacity: last.runner.capacity, waiting: last.runner.waiting))
                LabeledContent(MonitoringText.healthTests, value: MonitoringText.slotsLine(used: last.heavy.used, capacity: last.heavy.capacity, waiting: last.heavy.waiting))
                LabeledContent(MonitoringText.healthQueue, value: "\(last.queuedRuns)")
                if let memory = last.memAvailableMiB {
                    LabeledContent(MonitoringText.healthMemory, value: PipelineServerText.mebibytes(memory))
                }
                Chart(metrics.samples) { sample in
                    LineMark(
                        x: .value(MonitoringText.healthTimeAxis, sample.date),
                        y: .value(MonitoringText.healthValueAxis, sample.runner.used)
                    )
                    .foregroundStyle(by: .value(MonitoringText.healthValueAxis, MonitoringText.healthAgents))
                    LineMark(
                        x: .value(MonitoringText.healthTimeAxis, sample.date),
                        y: .value(MonitoringText.healthValueAxis, sample.heavy.used)
                    )
                    .foregroundStyle(by: .value(MonitoringText.healthValueAxis, MonitoringText.healthTests))
                    LineMark(
                        x: .value(MonitoringText.healthTimeAxis, sample.date),
                        y: .value(MonitoringText.healthValueAxis, sample.queuedRuns)
                    )
                    .foregroundStyle(by: .value(MonitoringText.healthValueAxis, MonitoringText.healthQueue))
                    if sample.rateLimited + sample.failovers > 0 {
                        PointMark(
                            x: .value(MonitoringText.healthTimeAxis, sample.date),
                            y: .value(MonitoringText.healthValueAxis, sample.rateLimited + sample.failovers)
                        )
                        .foregroundStyle(by: .value(MonitoringText.healthValueAxis, MonitoringText.healthIncidents))
                    }
                }
                .frame(height: 160)
                if metrics.samples.contains(where: { $0.memAvailableMiB != nil }) {
                    Chart(metrics.samples.filter { $0.memAvailableMiB != nil }) { sample in
                        AreaMark(
                            x: .value(MonitoringText.healthTimeAxis, sample.date),
                            y: .value(MonitoringText.healthMemory, sample.memAvailableMiB ?? 0)
                        )
                        .opacity(0.4)
                    }
                    .frame(height: 100)
                    .accessibilityLabel(MonitoringText.healthMemory)
                }
            } else {
                Text(MonitoringText.healthEmpty(sampleSec: server.metrics?.sampleSec ?? 15))
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text(MonitoringText.healthTitle)
        }
        .task {
            while !Task.isCancelled {
                await server.refreshMetrics()
                try? await Task.sleep(for: .seconds(max(server.metrics?.sampleSec ?? 15, 5)))
            }
        }
    }
}
