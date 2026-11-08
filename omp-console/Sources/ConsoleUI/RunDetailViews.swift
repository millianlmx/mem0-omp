// La PAGE d'une feature, parties partagées par le Mac et l'iPhone/iPad : son en-tête
// (titre, état, dépôt, âge, coût, ce qui la retient), sa frise de jalons (Besoins →
// Specs → Implémentation → Revue → Fusion), ce qu'elle attend de vous (la carte de la
// boîte, en place), sa demande d'origine et le menu de ses gestes. Chaque app pose
// dessous le direct, les fichiers, les tests et la frise détaillée de sa session, et la
// consigne à l'agent en pied de page.

import ConsoleClient
import ConsoleCore
import SwiftUI

extension HarnessRun {
    /// Le jalon où en est la feature (0 Besoins … 4 Fusion), 5 une fois fusionnée,
    /// `nil` avant la première étape.
    public var milestone: Int? {
        switch phase {
        case .merged: return 5
        case .merging: return 4
        default: break
        }
        switch step {
        case "req": return 0
        case "specs": return 1
        case "impl": return 2
        case "review", "fix": return 3
        default: return nil
        }
    }
}

/// L'en-tête d'une feature : de quoi la reconnaître et savoir où elle en est.
public struct RunDetailHeader: View {
    @ObservedObject var server: HarnessModel
    let run: HarnessRun

    public init(server: HarnessModel, run: HarnessRun) {
        self.server = server
        self.run = run
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(run.title)
                .font(.title2.weight(.semibold))
                .consoleReadable()
            HStack(spacing: 8) {
                ConsoleStatusChip(status: ConsoleStatus(text: run.statusLine, tone: run.tone))
                Text(meta)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            RunStepTracker(run: run)
                .padding(.top, 4)
            RunQueueReason(run: run)
            if let detail = run.detailLine() {
                Text(detail)
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .consoleReadable()
            }
            ForEach(server.inbox?.alerts(of: run.id) ?? []) { alert in
                Label(alert.line, systemImage: alert.symbol)
                    .font(.callout)
                    .foregroundStyle(.orange)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .consoleID("run.header")
    }

    private var meta: String {
        var parts = [run.repo, ShellText.created(ConsoleFormat.relative(ms: run.createdAt, nowMs: Date().timeIntervalSince1970 * 1000))]
        if run.fixes > 0 { parts.append(ShellText.fixes(run.fixes)) }
        if let cost = server.inbox?.costs[run.id], cost > 0 { parts.append(MonitoringText.cost(cost)) }
        return parts.joined(separator: " · ")
    }
}

/// Les cinq jalons d'une feature, celui en cours souligné par la teinte de son état.
public struct RunStepTracker: View {
    let run: HarnessRun

    public init(run: HarnessRun) {
        self.run = run
    }

    private static let names = [ShellText.stepNeeds, ShellText.stepSpecs, ShellText.stepBuild, ShellText.stepReview, ShellText.stepMerge]

    public var body: some View {
        let current = run.milestone
        HStack(spacing: 4) {
            ForEach(Array(Self.names.enumerated()), id: \.offset) { index, name in
                VStack(alignment: .leading, spacing: 4) {
                    Capsule()
                        .fill(fill(index, current: current))
                        .frame(height: 4)
                    Text(name)
                        .font(.caption2.weight(index == current ? .semibold : .regular))
                        .foregroundStyle(index == current ? Color.primary : Color.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(current.map { Self.names[min($0, Self.names.count - 1)] } ?? run.statusLine)
        .consoleID("run.steps")
    }

    private func fill(_ index: Int, current: Int?) -> AnyShapeStyle {
        guard let current else { return AnyShapeStyle(.quaternary) }
        if index < current { return AnyShapeStyle(Color.green.opacity(0.7)) }
        if index == current { return AnyShapeStyle(run.tone.consoleTint) }
        return AnyShapeStyle(.quaternary)
    }
}

/// Ce que la feature attend de vous, en place : la carte de la boîte qui la concerne.
public struct RunPendingCard: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let run: HarnessRun

    public init(server: HarnessModel, drafts: HarnessDrafts, run: HarnessRun) {
        self.server = server
        self.drafts = drafts
        self.run = run
    }

    /// La feature attend quelque chose de l'humain.
    public static func isPending(_ run: HarnessRun, in inbox: HarnessInbox?) -> Bool {
        guard let inbox else { return false }
        return inbox.batches.contains { $0.id == run.id } || inbox.awaiting.contains { $0.id == run.id }
            || inbox.decisions.contains { $0.runId == run.id }
    }

    public var body: some View {
        if let inbox = server.inbox {
            if let batch = inbox.batches.first(where: { $0.id == run.id }) {
                EscalationBatchCard(server: server, drafts: drafts, inbox: inbox, batch: batch, showsOpen: false)
                    .disabled(!server.canAct)
            }
            if let waiting = inbox.awaiting.first(where: { $0.id == run.id }) {
                if waiting.awaitsSpecs {
                    SpecsCard(server: server, drafts: drafts, inbox: inbox, run: waiting, showsOpen: false)
                        .disabled(!server.canAct)
                } else {
                    VerdictCard(server: server, drafts: drafts, inbox: inbox, run: waiting, showsOpen: false)
                        .disabled(!server.canAct)
                }
            }
            let decisions = inbox.decisions.filter { $0.runId == run.id }
            if !decisions.isEmpty {
                DecisionsCard(server: server, drafts: drafts, inbox: inbox, runId: run.id, decisions: decisions)
                    .disabled(!server.canAct)
            }
        }
    }
}

/// La demande d'origine, repliée : elle se relit sans encombrer la page.
public struct RunRequestDisclosure: View {
    let run: HarnessRun

    public init(run: HarnessRun) {
        self.run = run
    }

    public var body: some View {
        if !run.request.isEmpty {
            DisclosureGroup(ShellText.request) {
                ConsoleMarkdown(markdown: run.request)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
            }
            .consoleID("run.request")
        }
    }
}

/// Le seul menu des gestes d'une feature, dans la barre de sa page.
public struct RunActionsMenu: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let run: HarnessRun

    public init(server: HarnessModel, drafts: HarnessDrafts, run: HarnessRun) {
        self.server = server
        self.drafts = drafts
        self.run = run
    }

    public var body: some View {
        Menu {
            RunMenuItems(server: server, drafts: drafts, run: run, includesOpen: false)
        } label: {
            Label(ShellText.actions, systemImage: ShellText.actionsSymbol)
        }
        .consoleID("run.actions")
    }
}
