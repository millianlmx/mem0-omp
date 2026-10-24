import Charts
import ConsoleClient
import ConsoleCore
import SwiftUI

// Le monitoring dans les écrans de pilotage iOS : les alertes de la veille du serveur
// en tête de l'Accueil (chacune ouvre le direct de sa feature), et dans Statistiques
// la consommation des agents, la comparaison des modèles, les tests instables et la
// santé du serveur, relue toutes les `sampleSec` secondes tant que l'écran est
// affiché. Les mots viennent du noyau (`MonitoringText`) : aucun libellé en dur ici.

/// Les alertes en cours, en tête de l'Accueil.
struct IOSAlertsSection: View {
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
                    .accessibilityIdentifier("ios.home.alert")
                }
            } header: {
                Text(MonitoringText.alertsTitle)
            } footer: {
                Text(MonitoringText.alertsHint)
            }
        }
    }
}

/// La consommation des agents : depuis le début, sur 7 jours, et jour par jour.
struct IOSUsageSection: View {
    let usage: HarnessUsageStats

    var body: some View {
        Section {
            LabeledContent(MonitoringText.usageTotal) {
                Text(MonitoringText.usageLine(cost: usage.total.cost, tokens: usage.total.tokens))
                    .monospacedDigit()
            }
            LabeledContent(MonitoringText.usageWeek) {
                Text(MonitoringText.usageLine(cost: usage.last7Days.cost, tokens: usage.last7Days.tokens))
                    .monospacedDigit()
            }
            if usage.byDay.isEmpty {
                Text(MonitoringText.usageNone)
                    .foregroundStyle(.secondary)
            } else {
                Chart(usage.byDay) { day in
                    BarMark(
                        x: .value(MonitoringText.usageDayAxis, day.day),
                        y: .value(MonitoringText.costLabel, day.cost)
                    )
                    .foregroundStyle(Color(uiColor: IOSDataPalette.duration))
                    .accessibilityLabel(Text(day.day))
                    .accessibilityValue(Text(MonitoringText.cost(day.cost)))
                }
                .frame(minHeight: 140)
            }
        } header: {
            Text(MonitoringText.usageTitle)
        } footer: {
            Text(MonitoringText.usageHint)
        }
    }
}

/// La comparaison des modèles.
struct IOSModelsSection: View {
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
                        .font(.footnote.monospaced())
                    Text(model.stepsLine)
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                    Text(model.outcomeLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            }
        } header: {
            Text(MonitoringText.modelsTitle)
        } footer: {
            Text(MonitoringText.modelsHint)
        }
    }
}

/// Les commandes de tests instables.
struct IOSFlakySection: View {
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
                        .font(.footnote.monospaced())
                    Text(test.line)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            }
        } header: {
            Text(MonitoringText.flakyTitle)
        } footer: {
            Text(MonitoringText.flakyHint)
        }
    }
}

/// La santé du serveur au fil du temps : occupation des agents et des tests, file
/// d'attente, mémoire libre, limites de débit et bascules.
struct IOSHealthSection: View {
    @ObservedObject var server: HarnessModel

    var body: some View {
        Section {
            if let metrics = server.metrics, let last = metrics.samples.last {
                LabeledContent(MonitoringText.healthAgents, value: MonitoringText.slotsLine(used: last.runner.used, capacity: last.runner.capacity, waiting: last.runner.waiting))
                LabeledContent(MonitoringText.healthTests, value: MonitoringText.slotsLine(used: last.heavy.used, capacity: last.heavy.capacity, waiting: last.heavy.waiting))
                LabeledContent(MonitoringText.healthQueue, value: String(last.queuedRuns))
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
                }
                .frame(minHeight: 160)
                .accessibilityHidden(true)
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
