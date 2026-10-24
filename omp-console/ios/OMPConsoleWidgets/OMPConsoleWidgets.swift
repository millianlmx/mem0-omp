import ActivityKit
import ConsoleClient
import ConsoleCore
import SwiftUI
import WidgetKit

// L'extension de widgets de l'app iOS :
// - la Live Activity d'une feature suivie, sur l'écran verrouillé et dans la Dynamic
//   Island — son état, son étape, l'outil que l'agent emploie, une alerte en cours et
//   son coût. L'app la démarre depuis le menu contextuel d'une feature
//   (`IOSLiveActivityCenter`) ; ses mises à jour viennent de l'app ouverte ou du
//   serveur par APNs ;
// - le widget d'écran d'accueil « Boîte du serveur » : ce qui attend l'humain et les
//   features en cours avec leur étape et leurs alertes. Il relit la boîte lui-même
//   toutes les 15 minutes par le groupe d'apps partagé avec l'app
//   (`HarnessWidgetStore`), et montre le dernier instantané hors ligne. Un toucher
//   ouvre l'app sur l'Accueil.
// Les mots viennent du noyau.

@main
struct OMPConsoleWidgetsBundle: WidgetBundle {
    var body: some Widget {
        OMPInboxWidget()
        OMPRunLiveActivity()
    }
}

// MARK: - Widget d'écran d'accueil

struct OMPInboxEntry: TimelineEntry {
    let date: Date
    let snapshot: HarnessWidgetSnapshot
}

/// La boîte du serveur : relue à chaque rafraîchissement, sinon le dernier instantané de l'app.
struct OMPInboxProvider: TimelineProvider {
    /// Le rythme de relecture demandé à WidgetKit (qui peut l'espacer).
    static let refresh: TimeInterval = 15 * 60

    func placeholder(in context: Context) -> OMPInboxEntry {
        OMPInboxEntry(date: Date(), snapshot: Self.sample)
    }

    func getSnapshot(in context: Context, completion: @escaping (OMPInboxEntry) -> Void) {
        let cached = HarnessWidgetStore.fromBundle()?.snapshot()
        completion(OMPInboxEntry(date: Date(), snapshot: context.isPreview ? (cached ?? Self.sample) : (cached ?? .unconfigured)))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<OMPInboxEntry>) -> Void) {
        Task {
            let snapshot = await Self.load()
            let now = Date()
            completion(Timeline(entries: [OMPInboxEntry(date: now, snapshot: snapshot)], policy: .after(now.addingTimeInterval(Self.refresh))))
        }
    }

    /// La boîte relue au serveur avec l'adresse et le jeton que l'app a partagés ;
    /// sinon le dernier instantané ; sinon « aucun serveur ».
    static func load() async -> HarnessWidgetSnapshot {
        guard let store = HarnessWidgetStore.fromBundle() else { return .unconfigured }
        let cached = store.snapshot()
        guard let address = store.address(),
              let token = try? await store.tokens.token(for: HarnessWidgetStore.tokenAccount)
        else { return cached ?? .unconfigured }
        guard let inbox = try? await HarnessInboxReader.read(address: address, token: token) else {
            return cached ?? HarnessWidgetSnapshot(configured: true)
        }
        let snapshot = HarnessWidgetSnapshot(inbox: inbox, configured: true)
        store.save(snapshot)
        return snapshot
    }

    /// L'aperçu de la galerie de widgets.
    static let sample = HarnessWidgetSnapshot(
        configured: true,
        pending: 2,
        alerts: 1,
        runs: [
            .init(id: "a", title: "Export CSV", state: "awaiting_human", step: "specs"),
            .init(id: "b", title: "Recherche plein texte", state: "running", step: "impl", alert: "stalled", cost: 0.42),
            .init(id: "c", title: "Thème sombre", state: "running", step: "review", cost: 1.1),
        ],
        activeCount: 3,
        updatedAt: Date().timeIntervalSince1970
    )
}

struct OMPInboxWidget: Widget {
    static let kind = "OMPConsoleInbox"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: OMPInboxProvider()) { entry in
            OMPInboxView(snapshot: entry.snapshot)
                .containerBackground(.fill.tertiary, for: .widget)
                .widgetURL(HarnessWidgetLink.url(.home))
        }
        .configurationDisplayName(MonitoringText.widgetName)
        .description(MonitoringText.widgetDescription)
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct OMPInboxView: View {
    let snapshot: HarnessWidgetSnapshot
    @Environment(\.widgetFamily) private var family

    var body: some View {
        if !snapshot.configured {
            Text(MonitoringText.widgetNotConfigured)
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                header
                if family != .systemSmall {
                    Divider()
                    runs
                }
                Spacer(minLength: 0)
                Text(MonitoringText.widgetUpdated(snapshot.updatedDate.formatted(date: .omitted, time: .shortened)))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Image(systemName: MonitoringText.widgetPendingSymbol)
                    .foregroundStyle(snapshot.pending > 0 ? Color.orange : Color.secondary)
                    .accessibilityHidden(true)
                Text("\(snapshot.pending)")
                    .font(family == .systemSmall ? .largeTitle.bold() : .title2.bold())
                    .monospacedDigit()
                    .accessibilityHidden(true)
            }
            Text(MonitoringText.widgetPending(snapshot.pending))
                .font(.caption)
                .lineLimit(2)
            HStack(spacing: 8) {
                Text(MonitoringText.widgetActive(snapshot.activeCount))
                if snapshot.alerts > 0 {
                    Label(MonitoringText.widgetAlerts(snapshot.alerts), systemImage: MonitoringText.alertSymbol(MonitoringCodes.stalled))
                        .foregroundStyle(.orange)
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var runs: some View {
        let shown = Array(snapshot.runs.prefix(family == .systemLarge ? 7 : 2))
        if shown.isEmpty {
            Text(MonitoringText.widgetNoActive)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        ForEach(shown) { run in
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: run.alert.map(MonitoringText.alertSymbol) ?? (run.needsHuman ? "person.crop.circle.badge.questionmark" : "gearshape.2"))
                    .foregroundStyle(run.alert != nil || run.needsHuman ? Color.orange : Color.blue)
                    .font(.caption)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 0) {
                    Text(run.title)
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                    Text(Self.line(run))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                if let cost = run.cost {
                    Text(MonitoringText.cost(cost))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }

    /// « En cours · /impl », ou l'alerte en cours.
    static func line(_ run: HarnessWidgetSnapshot.Run) -> String {
        if let alert = run.alert { return MonitoringText.event(alert) }
        let state = PipelineServerText.state(run.state)
        guard let step = run.step else { return state }
        return "\(state) · \(HarnessRun.label(forStep: step))"
    }
}

struct OMPRunLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: OMPRunActivityAttributes.self) { context in
            OMPRunLockScreenView(attributes: context.attributes, state: context.state)
                .padding()
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: OMPRunActivityStyle.symbol(state))
                        .foregroundStyle(OMPRunActivityStyle.tint(state))
                        .font(.title2)
                        .accessibilityHidden(true)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(MonitoringText.cost(state.cost))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.attributes.title)
                        .font(.headline)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    OMPRunStatusLines(state: state)
                }
            } compactLeading: {
                Image(systemName: OMPRunActivityStyle.symbol(state))
                    .foregroundStyle(OMPRunActivityStyle.tint(state))
                    .accessibilityHidden(true)
            } compactTrailing: {
                Text(OMPRunActivityStyle.stepLabel(state))
                    .font(.caption2)
            } minimal: {
                Image(systemName: OMPRunActivityStyle.symbol(state))
                    .foregroundStyle(OMPRunActivityStyle.tint(state))
                    .accessibilityHidden(true)
            }
            .keylineTint(OMPRunActivityStyle.tint(state))
        }
    }
}

/// L'activité sur l'écran verrouillé : la feature, son dépôt, son état et son coût.
struct OMPRunLockScreenView: View {
    let attributes: OMPRunActivityAttributes
    let state: HarnessActivityState

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: OMPRunActivityStyle.symbol(state))
                .font(.title2)
                .foregroundStyle(OMPRunActivityStyle.tint(state))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(attributes.title)
                        .font(.headline)
                        .lineLimit(1)
                    Spacer()
                    Text(MonitoringText.cost(state.cost))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                Text(attributes.repo)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                OMPRunStatusLines(state: state)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// L'état et l'étape, l'outil du moment, et l'alerte en cours.
struct OMPRunStatusLines: View {
    let state: HarnessActivityState

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(OMPRunActivityStyle.statusLine(state))
                .font(.subheadline)
            if let tool = state.tool, !state.isFinal {
                Text(PipelineServerText.sessionNow(tool))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if let alert = state.alert {
                Label(MonitoringText.event(alert), systemImage: MonitoringText.alertSymbol(alert))
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
    }
}

/// Le style d'une activité, d'après l'état de sa feature.
enum OMPRunActivityStyle {
    static func stepLabel(_ state: HarnessActivityState) -> String {
        state.step.map(HarnessRun.label(forStep:)) ?? PipelineServerText.state(state.state)
    }

    /// « En cours · /impl »
    static func statusLine(_ state: HarnessActivityState) -> String {
        guard let step = state.step, !state.isFinal else { return PipelineServerText.state(state.state) }
        return "\(PipelineServerText.state(state.state)) · \(HarnessRun.label(forStep: step))"
    }

    static func symbol(_ state: HarnessActivityState) -> String {
        if let alert = state.alert { return MonitoringText.alertSymbol(alert) }
        switch state.phase {
        case .merged: return "checkmark.seal.fill"
        case .failed: return "xmark.octagon.fill"
        case .cancelled: return "stop.circle"
        case .escalated, .awaitingHuman: return "person.crop.circle.badge.questionmark"
        case .merging: return "arrow.triangle.merge"
        case .queued: return "clock"
        case .running, nil: return "gearshape.2.fill"
        }
    }

    static func tint(_ state: HarnessActivityState) -> Color {
        if state.alert != nil { return .orange }
        switch state.phase {
        case .merged: return .green
        case .failed: return .red
        case .escalated, .awaitingHuman: return .orange
        default: return .blue
        }
    }
}
