// Le TABLEAU DE BORD de l'Accueil (feature accueil-tableau-de-bord) : ce qu'il faut
// voir d'un coup d'œil quand plusieurs projets tournent, avant la boîte de l'humain.
//
// - une rangée de tuiles de KPI (`HarnessDashboardKPI`) : ce qui bloque, ce qui est à
//   relire, ce qui tourne, la plus vieille attente, puis le débit et le coût de la
//   semaine ; une tuile de la boîte y fait défiler (`HarnessDrafts.homeAnchor`) ;
// - quatre cartes tracées (Swift Charts), deux par ligne quand la fenêtre le permet :
//   ce qui vous attend par projet, le débit sur 14 jours, le coût des agents, la santé.
//
// Les séries viennent de `HarnessDashboard` (client partagé), les mots de
// `DashboardText`. Une couleur porte une identité fixe (jamais un rang) ; vert et
// rouge restent aux états fusionnée / échouée, toujours nommés par la légende.

import Charts
import ConsoleClient
import ConsoleCore
import SwiftUI

struct HarnessDashboardSections: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let dashboard: HarnessDashboard

    var body: some View {
        Section {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 12)], alignment: .leading, spacing: 12) {
                HarnessDashboardKPI(
                    title: DashboardText.kpiPending,
                    value: "\(dashboard.pending)",
                    symbol: DashboardText.pendingSymbol,
                    attention: dashboard.pending > 0
                ) { drafts.homeAnchor = .toDecide }
                HarnessDashboardKPI(
                    title: DashboardText.kpiToReview,
                    value: "\(dashboard.toReview)",
                    symbol: DashboardText.toReviewSymbol
                ) { drafts.homeAnchor = .decisions }
                HarnessDashboardKPI(
                    title: DashboardText.kpiActive,
                    value: "\(dashboard.active)",
                    symbol: DashboardText.activeSymbol
                ) { drafts.homeAnchor = .active }
                HarnessDashboardKPI(
                    title: DashboardText.kpiOldest,
                    value: dashboard.oldestWaitSec.map(PipelineServerText.duration) ?? PipelineServerText.notAvailable,
                    symbol: DashboardText.oldestSymbol,
                    attention: (dashboard.oldestWaitSec ?? 0) > 24 * 3600
                )
                HarnessDashboardKPI(
                    title: DashboardText.kpiMerged,
                    value: dashboard.mergedLast7Days.map(String.init) ?? PipelineServerText.notAvailable,
                    symbol: DashboardText.mergedSymbol
                )
                HarnessDashboardKPI(
                    title: DashboardText.kpiMergeRate,
                    value: dashboard.mergeRate.map(PipelineServerText.percent) ?? PipelineServerText.notAvailable,
                    symbol: DashboardText.mergeRateSymbol
                )
                HarnessDashboardKPI(
                    title: DashboardText.kpiLeadTime,
                    value: dashboard.medianLeadSec.map(PipelineServerText.duration) ?? PipelineServerText.notAvailable,
                    symbol: DashboardText.leadTimeSymbol
                )
                HarnessDashboardKPI(
                    title: DashboardText.kpiCost,
                    value: dashboard.costLast7Days.map(MonitoringText.cost) ?? PipelineServerText.notAvailable,
                    symbol: DashboardText.costSymbol
                )
                if dashboard.alerts > 0 {
                    HarnessDashboardKPI(
                        title: DashboardText.kpiAlerts,
                        value: "\(dashboard.alerts)",
                        symbol: DashboardText.alertsSymbol,
                        attention: true
                    )
                }
                if dashboard.auditsToSort > 0 {
                    HarnessDashboardKPI(
                        title: DashboardText.kpiAudits,
                        value: "\(dashboard.auditsToSort)",
                        symbol: DashboardText.auditsSymbol
                    )
                }
            }
            .padding(.vertical, 4)
        } header: {
            HStack {
                Text(server.address ?? "")
                Spacer()
                Label(
                    server.isLive ? PipelineServerText.live : PipelineServerText.offline,
                    systemImage: server.isLive ? PipelineServerText.liveSymbol : PipelineServerText.offlineSymbol
                )
            }
        }

        Section {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 360), spacing: 16, alignment: .top)], alignment: .leading, spacing: 16) {
                card(DashboardText.waitingTitle, hint: DashboardText.waitingHint) { waiting }
                card(DashboardText.throughputTitle, hint: DashboardText.throughputHint) { throughput }
                card(DashboardText.costTitle, hint: DashboardText.costHint) { cost }
                card(DashboardText.healthTitle, hint: DashboardText.healthHint) { health }
            }
            .padding(.vertical, 4)
        }
    }

    // MARK: - Cartes

    private func card<Content: View>(_ title: String, hint: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.headline)
            content()
            Text(hint)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .consoleCard(selected: false)
    }

    /// Les sortes d'attente, dans l'ordre de la légende, et leur teinte fixe.
    private static let kinds = HarnessDashboard.WaitKind.allCases.map { DashboardText.kind($0.rawValue) }
    private static let kindColors: [Color] = [.blue, .purple, .teal, .pink]
    /// Les issues des features : vert et rouge, les teintes d'état, nommées par la légende.
    private static let outcomes = [DashboardText.seriesMerged, DashboardText.seriesFailed, DashboardText.seriesCreated]
    private static let outcomeColors: [Color] = [.green, .red, .secondary]

    /// Ce qui vous attend : une barre par projet, empilée par sorte.
    @ViewBuilder private var waiting: some View {
        if dashboard.waiting.isEmpty {
            empty(DashboardText.waitingNone)
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
            .chartForegroundStyleScale(domain: Self.kinds, range: Self.kindColors)
            .chartLegend(position: .bottom, alignment: .leading)
            .frame(height: CGFloat(max(dashboard.waitingByRepo.count, 2)) * 32 + 48)
        }
    }

    /// Le débit : fusionnées et échouées empilées jour par jour, les lancées en ligne ;
    /// puis les features en cours par étape.
    @ViewBuilder private var throughput: some View {
        if !dashboard.hasStats {
            empty(DashboardText.noStats)
        } else if !dashboard.hasThroughput {
            empty(DashboardText.throughputNone)
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
            .chartForegroundStyleScale(domain: Self.outcomes, range: Self.outcomeColors)
            .chartLegend(position: .bottom, alignment: .leading)
            .chartXAxis {
                AxisMarks(values: .stride(by: .day, count: 3)) { _ in
                    AxisGridLine()
                    AxisValueLabel(format: .dateTime.day().month(.abbreviated))
                }
            }
            .frame(height: 160)
        }
        if !dashboard.activeBySteps.isEmpty {
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
                    Text("\(Int(share.value))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .chartXAxis(.hidden)
            .frame(height: CGFloat(dashboard.activeBySteps.count) * 26 + 8)
        }
    }

    /// Le coût des agents : jour par jour, puis par projet sur la semaine.
    @ViewBuilder private var cost: some View {
        if !dashboard.hasStats {
            empty(DashboardText.noStats)
        } else if !dashboard.hasCost {
            empty(MonitoringText.usageNone)
        } else {
            Chart(dashboard.days) { day in
                BarMark(
                    x: .value(DashboardText.axisDay, day.date, unit: .day),
                    y: .value(DashboardText.axisCost, day.cost)
                )
                .foregroundStyle(Color.indigo)
                .cornerRadius(3)
                .accessibilityValue(Text(MonitoringText.cost(day.cost)))
            }
            .chartXAxis {
                AxisMarks(values: .stride(by: .day, count: 3)) { _ in
                    AxisGridLine()
                    AxisValueLabel(format: .dateTime.day().month(.abbreviated))
                }
            }
            .frame(height: 140)
            if !dashboard.costByRepo.isEmpty {
                Text(DashboardText.costByRepo)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Chart(dashboard.costByRepo) { share in
                    BarMark(
                        x: .value(DashboardText.axisCost, share.value),
                        y: .value(DashboardText.axisProject, share.label)
                    )
                    .foregroundStyle(Color.indigo)
                    .cornerRadius(3)
                    .annotation(position: .trailing) {
                        Text(MonitoringText.cost(share.value))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .chartXAxis(.hidden)
                .frame(height: CGFloat(dashboard.costByRepo.count) * 26 + 8)
            }
        }
    }

    /// La santé : la part des passages en échec par étape, puis l'occupation du serveur.
    @ViewBuilder private var health: some View {
        if !dashboard.hasStats {
            empty(DashboardText.noStats)
        } else {
            if !dashboard.stepHealth.isEmpty {
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
                .frame(height: CGFloat(dashboard.stepHealth.count) * 26 + 8)
            }
            Text(DashboardText.capacity)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            if let runners = dashboard.runners {
                capacity(PipelineServerText.runners, runners)
            }
            if let heavy = dashboard.heavy {
                capacity(PipelineServerText.heavySlots, heavy)
            }
            if let flaky = dashboard.flaky {
                LabeledContent(MonitoringText.flakyTitle, value: "\(flaky)")
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

    private func empty(_ text: String) -> some View {
        Text(text)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
    }
}

/// Une tuile de KPI : son intitulé et son symbole, puis la valeur en grand. Une
/// tuile de la boîte (`open`) fait défiler l'Accueil jusqu'à sa section.
struct HarnessDashboardKPI: View {
    let title: String
    let value: String
    let symbol: String
    var attention = false
    var open: (@MainActor () -> Void)?

    var body: some View {
        if let open {
            Button { open() } label: { tile }
                .buttonStyle(.plain)
        } else {
            tile
        }
    }

    private var tile: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(title, systemImage: symbol)
                .font(.caption.weight(.semibold))
                .foregroundStyle(attention ? Color.orange : Color.secondary)
                .lineLimit(2)
            Text(value)
                .font(.title.weight(.semibold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
        .consoleCard(selected: false)
        .accessibilityElement(children: .combine)
    }
}
