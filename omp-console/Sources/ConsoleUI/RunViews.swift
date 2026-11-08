// Une FEATURE à l'écran, écrite une fois pour le Mac et l'iPhone/iPad : sa LIGNE dans la
// liste (point d'état, titre, dépôt · étape · âge — une ligne dense, comme une session
// dans la barre latérale d'un terminal), le menu de sa priorité, et les feuilles et
// confirmations de ses gestes (`harnessGestures`).
//
// Les gestes qui changent le sort d'une feature (arrêt, relance, annulation d'une
// fusion) passent TOUJOURS par une confirmation (`drafts.stopRequest`, `retryRequest`,
// `revertRequest`) : un menu ne parle jamais au serveur lui-même. La priorité, elle,
// se change directement : rien ne se perd, et le serveur la borne.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// La ligne d'une feature : aucun bouton dedans, tout geste est dans son menu ou sa page.
public struct RunListRow: View {
    let run: HarnessRun
    let cost: Double?
    let alerts: Int

    public init(run: HarnessRun, cost: Double? = nil, alerts: Int = 0) {
        self.run = run
        self.cost = cost
        self.alerts = alerts
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            RunStateDot(run: run)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(run.title)
                        .font(.body.weight(HarnessRunGroup.of(run) == .needsYou ? .semibold : .regular))
                        .denseLines(2)
                    Spacer(minLength: 4)
                    Text(ConsoleFormat.relative(ms: run.updatedAt, nowMs: Date().timeIntervalSince1970 * 1000))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .denseLines(1)
                }
                Text(meta)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .denseLines(1)
                if let note {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .denseLines(2)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .consoleID("runs.row")
    }

    /// `dépôt · état · étape · coût` : ce qu'un coup d'œil doit savoir.
    private var meta: String {
        var parts = [run.repo, run.statusLine]
        if run.fixes > 0 { parts.append(ShellText.fixes(run.fixes)) }
        if let cost, cost > 0 { parts.append(MonitoringText.cost(cost)) }
        return parts.joined(separator: " · ")
    }

    /// Ce qui mérite l'œil : ce qui retient la feature en file, sa dernière panne, ses alertes.
    private var note: String? {
        if let reason = run.queueReason { return reason }
        if let detail = run.detailLine() { return detail }
        if alerts > 0 { return MonitoringText.alertsTitle }
        return nil
    }
}

extension View {
    /// La ligne d'une feature reste dense sur le Mac ; sur l'iPhone et l'iPad, elle grandit
    /// avec le texte (Dynamic Type) plutôt que de le tronquer.
    @ViewBuilder
    func denseLines(_ count: Int) -> some View {
        #if os(macOS)
        lineLimit(count)
        #else
        self
        #endif
    }
}

/// Le point d'état d'une feature : sa teinte, pleine quand elle travaille ou vous attend.
public struct RunStateDot: View {
    let run: HarnessRun

    public init(run: HarnessRun) {
        self.run = run
    }

    public var body: some View {
        let group = HarnessRunGroup.of(run)
        Circle()
            .fill(run.tone.consoleTint.opacity(group == .done || group == .queued ? 0.55 : 1))
            .overlay {
                if group == .running {
                    Circle().strokeBorder(run.tone.consoleTint.opacity(0.35), lineWidth: 3).scaleEffect(1.8)
                }
            }
            .frame(width: 9, height: 9)
            .accessibilityLabel(run.statusLine)
    }
}

extension HarnessRun {
    /// La feature tourne ou attend : elle peut être arrêtée.
    public var canStop: Bool {
        guard let phase else { return false }
        return [.queued, .running, .escalated, .awaitingHuman].contains(phase)
    }
}

/// Le menu de la priorité d'une feature encore vivante : trois crans, ou ±10.
public struct PriorityMenu: View {
    @ObservedObject var server: HarnessModel
    let run: HarnessRun

    public init(server: HarnessModel, run: HarnessRun) {
        self.server = server
        self.run = run
    }

    public var body: some View {
        Menu {
            Section {
                ForEach(HarnessRunGroups.priorityPresets, id: \.self) { value in
                    Button(PipelineServerText.priorityPreset(value)) { set(value) }
                        .disabled(value == run.admissionPriority)
                }
            }
            Section {
                Button(PipelineServerText.raisePriority) { set(run.admissionPriority + 10) }
                Button(PipelineServerText.lowerPriority) { set(run.admissionPriority - 10) }
            }
        } label: {
            Label(PipelineServerText.priority(run.admissionPriority), systemImage: PipelineServerText.prioritySymbol)
                .font(.caption)
        }
        .fixedSize()
        .disabled(!server.canAct || server.busy.contains(run.id))
        .consoleID("run.priority")
    }

    private func set(_ value: Int) {
        let bounded = min(max(value, HarnessLaunchOptions.priorityRange.lowerBound), HarnessLaunchOptions.priorityRange.upperBound)
        let id = run.id
        Task { await server.setPriority(runId: id, priority: bounded) }
    }
}

extension View {
    /// Les feuilles et confirmations des gestes du serveur : refus (specs ou verdict),
    /// renversement d'une décision, direct d'une session, arrêt, relance avec consigne,
    /// consigne et budget d'une feature, et annulation d'une fusion.
    public func harnessGestures(server: HarnessModel, drafts: HarnessDrafts) -> some View {
        modifier(HarnessGestures(server: server, drafts: drafts))
            .modifier(RunControlSheets(server: server, drafts: drafts))
    }
}

private struct HarnessGestures: ViewModifier {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @Environment(\.consoleShell) private var shell

    func body(content: Content) -> some View {
        content
            .sheet(item: $drafts.reversal) { decision in
                reversalSheet(decision)
            }
            .sheet(item: $drafts.refusal) { run in
                refusalSheet(run)
            }
            .sheet(item: $drafts.sessionRequest) { request in
                shell.session(request)
            }
            .confirmationDialog(
                PipelineServerText.stopConfirm,
                isPresented: Binding(get: { drafts.stopRequest != nil }, set: { if !$0 { drafts.stopRequest = nil } }),
                titleVisibility: .visible,
                presenting: drafts.stopRequest
            ) { run in
                Button(PipelineServerText.stopFeature, role: .destructive) {
                    Task { await server.cancel(runId: run.id) }
                }
                Button(PipelineServerText.cancel, role: .cancel) {}
            } message: { _ in
                Text(PipelineServerText.stopMessage)
            }
            .confirmationDialog(
                PipelineServerText.revertConfirm,
                isPresented: Binding(get: { drafts.revertRequest != nil }, set: { if !$0 { drafts.revertRequest = nil } }),
                titleVisibility: .visible,
                presenting: drafts.revertRequest
            ) { run in
                Button(PipelineServerText.revertFeature, role: .destructive) {
                    Task { await server.revert(runId: run.id) }
                }
                Button(PipelineServerText.cancel, role: .cancel) {}
            } message: { _ in
                Text(PipelineServerText.revertMessage)
            }
    }

    private func refusalSheet(_ run: HarnessRun) -> some View {
        let specs = run.awaitsSpecs
        return NavigationStack {
            Form {
                Section {
                    Text(run.title)
                        .font(.headline)
                    TextField(PipelineServerText.reasonLabel, text: $drafts.refusalReason, axis: .vertical)
                } footer: {
                    Text(specs ? PipelineServerText.specsHint : PipelineServerText.reasonHint)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(specs ? PipelineServerText.refuseSpecsTitle : PipelineServerText.refuseTitle)
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.cancel) { drafts.refusal = nil }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(PipelineServerText.send) {
                        let reason = drafts.refusalReason
                        drafts.refusal = nil
                        Task {
                            if await server.validate(runId: run.id, approve: false, reason: reason) { drafts.specs[run.id] = nil }
                        }
                    }
                    .disabled(!drafts.canRefuse)
                }
            }
        }
        .consoleSheetSize(minWidth: 460, minHeight: 280)
    }

    private func reversalSheet(_ decision: HarnessDecision) -> some View {
        NavigationStack {
            Form {
                Section {
                    Text(MarkdownDocument.inline(decision.question))
                        .font(.headline)
                    if !decision.alternatives.isEmpty {
                        Picker(PipelineServerText.reverseOption, selection: $drafts.reversalOption) {
                            ForEach(decision.alternatives, id: \.self) { option in
                                Text(option).tag(option)
                            }
                        }
                    }
                    TextField(PipelineServerText.reverseOption, text: $drafts.reversalOption)
                    TextField(PipelineServerText.reasonLabel, text: $drafts.reversalReason, axis: .vertical)
                } footer: {
                    Text(PipelineServerText.reasonHint)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(PipelineServerText.reverseTitle)
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.cancel) { drafts.reversal = nil }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(PipelineServerText.send) {
                        let option = drafts.reversalOption
                        let reason = drafts.reversalReason
                        drafts.reversal = nil
                        Task { await server.reverse(runId: decision.runId, seq: decision.seq, option: option, reason: reason) }
                    }
                    .disabled(!drafts.canReverse)
                }
            }
        }
        .consoleSheetSize(minWidth: 480, minHeight: 320)
    }
}

extension View {
    /// Le titre d'une feuille : en ligne sur iOS, celui du système sur le Mac.
    @ViewBuilder
    public func consoleInlineTitle() -> some View {
        #if os(iOS)
        navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }

    /// La taille minimale d'une feuille du Mac (une feuille iOS prend l'écran).
    @ViewBuilder
    public func consoleSheetSize(minWidth: CGFloat, minHeight: CGFloat) -> some View {
        #if os(macOS)
        frame(minWidth: minWidth, minHeight: minHeight)
        #else
        self
        #endif
    }
}
