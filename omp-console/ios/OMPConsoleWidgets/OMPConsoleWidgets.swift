import ActivityKit
import ConsoleClient
import ConsoleCore
import SwiftUI
import WidgetKit

// L'extension de widgets de l'app iOS : la Live Activity d'une feature suivie, sur
// l'écran verrouillé et dans la Dynamic Island — son état, son étape, l'outil que
// l'agent emploie, une alerte en cours et son coût. L'app la démarre depuis le menu
// contextuel d'une feature (`IOSLiveActivityCenter`) ; ses mises à jour viennent de
// l'app ouverte ou du serveur par APNs. Les mots viennent du noyau.

@main
struct OMPConsoleWidgetsBundle: WidgetBundle {
    var body: some Widget {
        OMPRunLiveActivity()
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
