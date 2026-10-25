// Le TABLEAU DE BORD de l'Accueil iOS (feature accueil-tableau-de-bord) — pendant de
// `Sources/OMPConsole/Server/HarnessDashboardView.swift` : avant la boîte de l'humain,
// des tuiles de KPI puis quatre sections tracées (Swift Charts) — ce qui vous attend
// par projet, le débit sur 14 jours, le coût des agents, la santé du serveur.
//
// Les séries viennent de `HarnessDashboard` (client partagé), les mots de
// `DashboardText`, les teintes d'`IOSDataPalette` (couleurs système dynamiques).
// Contrôles SYSTÈME uniquement ; les graphiques grandissent avec le texte
// (`minHeight`, jamais une hauteur figée).

import Charts
import ConsoleClient
import ConsoleCore
import SwiftUI

struct IOSDashboardSections: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let dashboard: HarnessDashboard

    var body: some View {
        Section {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: 10)], alignment: .leading, spacing: 10) {
                IOSDashboardKPI(
                    title: DashboardText.kpiPending,
                    value: Text(dashboard.pending, format: .number),
                    symbol: DashboardText.pendingSymbol,
                    attention: dashboard.pending > 0
                ) { drafts.homeAnchor = .toDecide }
                IOSDashboardKPI(
                    title: DashboardText.kpiToReview,
                    value: Text(dashboard.toReview, format: .number),
                    symbol: DashboardText.toReviewSymbol
                ) { drafts.homeAnchor = .decisions }
                IOSDashboardKPI(
                    title: DashboardText.kpiActive,
                    value: Text(dashboard.active, format: .number),
                    symbol: DashboardText.activeSymbol
                ) { drafts.homeAnchor = .active }
                IOSDashboardKPI(
                    title: DashboardText.kpiOldest,
                    value: Text(dashboard.oldestWaitSec.map(PipelineServerText.duration) ?? PipelineServerText.notAvailable).monospacedDigit(),
                    symbol: DashboardText.oldestSymbol,
                    attention: (dashboard.oldestWaitSec ?? 0) > 24 * 3600
                )
                IOSDashboardKPI(
                    title: DashboardText.kpiMerged,
                    value: dashboard.mergedLast7Days.map { Text($0, format: .number) } ?? Text(PipelineServerText.notAvailable),
                    symbol: DashboardText.mergedSymbol
                )
                IOSDashboardKPI(
                    title: DashboardText.kpiMergeRate,
                    value: Text(dashboard.mergeRate.map(PipelineServerText.percent) ?? PipelineServerText.notAvailable),
                    symbol: DashboardText.mergeRateSymbol
                )
                IOSDashboardKPI(
                    title: DashboardText.kpiLeadTime,
                    value: Text(dashboard.medianLeadSec.map(PipelineServerText.duration) ?? PipelineServerText.notAvailable).monospacedDigit(),
                    symbol: DashboardText.leadTimeSymbol
                )
                IOSDashboardKPI(
                    title: DashboardText.kpiCost,
                    value: Text(dashboard.costLast7Days.map(MonitoringText.cost) ?? PipelineServerText.notAvailable),
                    symbol: DashboardText.costSymbol
                )
                if dashboard.alerts > 0 {
                    IOSDashboardKPI(
                        title: DashboardText.kpiAlerts,
                        value: Text(dashboard.alerts, format: .number),
                        symbol: DashboardText.alertsSymbol,
                        attention: true
                    )
                }
                if dashboard.auditsToSort > 0 {
                    IOSDashboardKPI(
                        title: DashboardText.kpiAudits,
                        value: Text(dashboard.auditsToSort, format: .number),
                        symbol: DashboardText.auditsSymbol
                    )
                }
            }
            .iosBareListRow()
        } header: {
            Label(
                server.isLive ? PipelineServerText.live : PipelineServerText.offline,
                systemImage: server.isLive ? PipelineServerText.liveSymbol : PipelineServerText.offlineSymbol
            )
        }

        Section {
            waiting
        } header: {
            Text(DashboardText.waitingTitle)
        } footer: {
            Text(DashboardText.waitingHint)
        }

        Section {
            throughput
        } header: {
            Text(DashboardText.throughputTitle)
        } footer: {
            Text(DashboardText.throughputHint)
        }

        Section {
            cost
        } header: {
            Text(DashboardText.costTitle)
        } footer: {
            Text(DashboardText.costHint)
        }

        Section {
            health
        } header: {
            Text(DashboardText.healthTitle)
        } footer: {
            Text(DashboardText.healthHint)
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

/// Une tuile de KPI : son intitulé et son symbole, puis la valeur en grand. Une
/// tuile de la boîte (`open`) fait défiler l'Accueil jusqu'à sa section.
struct IOSDashboardKPI: View {
    let title: String
    /// La valeur, déjà mise en forme (chiffres à chasse fixe pour une durée).
    let value: Text
    let symbol: String
    var attention = false
    var open: (@MainActor () -> Void)?

    var body: some View {
        if let open {
            Button { open() } label: { tile }
                .buttonStyle(.plain)
                .iosHoverEffect()
        } else {
            tile
        }
    }

    private var tile: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(title, systemImage: symbol)
                .font(.caption.weight(.semibold))
                .foregroundStyle(attention ? Color.orange : Color.secondary)
            value
                .font(.title2.weight(.semibold))
                .monospacedDigit()
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, minHeight: IOSMetrics.minimumTarget, alignment: .leading)
        .iosCard(raised: true)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}
