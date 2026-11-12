// Les GRAPHIQUES de la page Système › Statistiques et santé : quatre sections tracées
// (Swift Charts) — ce qui vous attend par projet, le débit sur 14 jours, le coût des
// agents, la santé du serveur — sous leur seul titre : le graphique se lit sans phrase.
//
// Les séries viennent de `HarnessDashboard` (client partagé), les mots de
// `DashboardText`, les teintes d'`IOSDataPalette` (couleurs système dynamiques).
// Contrôles SYSTÈME uniquement ; les graphiques grandissent avec le texte
// (`minHeight`, jamais une hauteur figée).

import Charts
import ConsoleClient
import ConsoleCore
import SwiftUI

struct IOSStatsCharts: View {
    let dashboard: HarnessDashboard

    var body: some View {
        Section {
            waiting
        } header: {
            Text(DashboardText.waitingTitle)
        }

        Section {
            throughput
        } header: {
            Text(DashboardText.throughputTitle)
        }

        Section {
            cost
        } header: {
            Text(DashboardText.costTitle)
        }

        Section {
            health
        } header: {
            Text(DashboardText.healthTitle)
        }
    }

    // MARK: - Sections

    private static let kinds = HarnessDashboard.WaitKind.allCases.map { DashboardText.kind($0.rawValue) }
    private static let outcomes = [DashboardText.seriesMerged, DashboardText.seriesFailed, DashboardText.seriesCreated]

    /// Ce qui vous attend : une barre par projet, empilée par sorte.
    @ViewBuilder private var waiting: some View {
        if dashboard.waiting.isEmpty {
            Text(DashboardText.waitingNone)
                .foregroundStyle(.secondary)
        } else {
            Chart(dashboard.waiting) { item in
                BarMark(
                    x: .value(DashboardText.axisCount, item.count),
                    y: .value(DashboardText.axisProject, item.repo)
                )
                .foregroundStyle(by: .value(DashboardText.axisSeries, DashboardText.kind(item.kind.rawValue)))
                .cornerRadius(3)
                .accessibilityLabel(Text(item.repo))
                .accessibilityValue(Text(DashboardText.kindCount(DashboardText.kind(item.kind.rawValue), item.count)))
            }
            .chartForegroundStyleScale(domain: Self.kinds, range: IOSDataPalette.waitingKinds.map { Color(uiColor: $0) })
            .chartLegend(position: .bottom, alignment: .leading)
            .frame(minHeight: CGFloat(max(dashboard.waitingByRepo.count, 2)) * 36 + 48)
        }
    }

    /// Le débit : fusionnées et échouées empilées jour par jour, les lancées en ligne ;
    /// puis les features en cours par étape.
    @ViewBuilder private var throughput: some View {
        if !dashboard.hasStats {
            Text(DashboardText.noStats).foregroundStyle(.secondary)
        } else if !dashboard.hasThroughput {
            Text(DashboardText.throughputNone).foregroundStyle(.secondary)
        } else {
            Chart {
                ForEach(dashboard.days) { day in
                    BarMark(x: .value(DashboardText.axisDay, day.date, unit: .day), y: .value(DashboardText.axisCount, day.merged))
                        .foregroundStyle(by: .value(DashboardText.axisSeries, DashboardText.seriesMerged))
                    BarMark(x: .value(DashboardText.axisDay, day.date, unit: .day), y: .value(DashboardText.axisCount, day.failed))
                        .foregroundStyle(by: .value(DashboardText.axisSeries, DashboardText.seriesFailed))
                }
                ForEach(dashboard.days) { day in
                    LineMark(x: .value(DashboardText.axisDay, day.date, unit: .day), y: .value(DashboardText.axisCount, day.created))
                        .foregroundStyle(by: .value(DashboardText.axisSeries, DashboardText.seriesCreated))
                        .interpolationMethod(.monotone)
                        .lineStyle(StrokeStyle(lineWidth: 2))
                }
            }
            .chartForegroundStyleScale(domain: Self.outcomes, range: IOSDataPalette.outcomes.map { Color(uiColor: $0) })
            .chartLegend(position: .bottom, alignment: .leading)
            .chartXAxis {
                AxisMarks(values: .stride(by: .day, count: 4)) { _ in
                    AxisGridLine()
                    AxisValueLabel(format: .dateTime.day().month(.abbreviated))
                }
            }
            .frame(minHeight: 180)
        }
        if !dashboard.activeBySteps.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text(DashboardText.activeBySteps)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Chart(dashboard.activeBySteps) { share in
                    BarMark(
                        x: .value(DashboardText.axisCount, share.value),
                        y: .value(DashboardText.axisStep, share.label)
                    )
                    .foregroundStyle(Color.accentColor)
                    .cornerRadius(3)
                    .annotation(position: .trailing) {
                        Text(Int(share.value), format: .number)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .chartXAxis(.hidden)
                .frame(minHeight: CGFloat(dashboard.activeBySteps.count) * 32 + 8)
            }
        }
    }

    /// Le coût des agents : jour par jour, puis par projet sur la semaine.
    @ViewBuilder private var cost: some View {
        if !dashboard.hasStats {
            Text(DashboardText.noStats).foregroundStyle(.secondary)
        } else if !dashboard.hasCost {
            Text(MonitoringText.usageNone).foregroundStyle(.secondary)
        } else {
            Chart(dashboard.days) { day in
                BarMark(
                    x: .value(DashboardText.axisDay, day.date, unit: .day),
                    y: .value(DashboardText.axisCost, day.cost)
                )
                .foregroundStyle(Color(uiColor: IOSDataPalette.cost))
                .cornerRadius(3)
                .accessibilityValue(Text(MonitoringText.cost(day.cost)))
            }
            .chartXAxis {
                AxisMarks(values: .stride(by: .day, count: 4)) { _ in
                    AxisGridLine()
                    AxisValueLabel(format: .dateTime.day().month(.abbreviated))
                }
            }
            .frame(minHeight: 150)
            if !dashboard.costByRepo.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text(DashboardText.costByRepo)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Chart(dashboard.costByRepo) { share in
                        BarMark(
                            x: .value(DashboardText.axisCost, share.value),
                            y: .value(DashboardText.axisProject, share.label)
                        )
                        .foregroundStyle(Color(uiColor: IOSDataPalette.cost))
                        .cornerRadius(3)
                        .annotation(position: .trailing) {
                            Text(MonitoringText.cost(share.value))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .chartXAxis(.hidden)
                    .frame(minHeight: CGFloat(dashboard.costByRepo.count) * 32 + 8)
                }
            }
        }
    }

    /// La santé : la part des passages en échec par étape, puis l'occupation du serveur.
    @ViewBuilder private var health: some View {
        if !dashboard.hasStats {
            Text(DashboardText.noStats).foregroundStyle(.secondary)
        } else {
            if !dashboard.stepHealth.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text(DashboardText.stepFailures)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Chart(dashboard.stepHealth) { step in
                        BarMark(
                            x: .value(DashboardText.axisFailures, step.failureRate),
                            y: .value(DashboardText.axisStep, step.step)
                        )
                        .foregroundStyle(step.failureRate >= 0.25 ? Color.orange : Color.accentColor)
                        .cornerRadius(3)
                        .annotation(position: .trailing) {
                            Text(PipelineServerText.percent(step.failureRate))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .chartXScale(domain: 0...1)
                    .chartXAxis(.hidden)
                    .frame(minHeight: CGFloat(dashboard.stepHealth.count) * 32 + 8)
                }
            }
            if let runners = dashboard.runners {
                capacity(PipelineServerText.runners, runners)
            }
            if let heavy = dashboard.heavy {
                capacity(PipelineServerText.heavySlots, heavy)
            }
            if let flaky = dashboard.flaky {
                LabeledContent(MonitoringText.flakyTitle) {
                    Text(flaky, format: .number).monospacedDigit()
                }
            }
        }
    }

    private func capacity(_ title: String, _ slots: HarnessStats.Slots) -> some View {
        Gauge(value: Double(min(slots.used, max(slots.capacity, 1))), in: 0...Double(max(slots.capacity, 1))) {
            Text(title)
        } currentValueLabel: {
            Text(DashboardText.occupancy(used: slots.used, capacity: slots.capacity))
                .monospacedDigit()
        }
        .gaugeStyle(.linearCapacity)
        .tint(slots.capacity > 0 && slots.used >= slots.capacity ? Color.orange : Color.accentColor)
    }
}
