// Une FEATURE à l'écran, écrite une fois pour le Mac et l'iPhone/iPad : le menu de sa
// priorité, et les feuilles et confirmations de ses gestes (`harnessGestures`).
//
// Les gestes qui changent le sort d'une feature (arrêt, relance, annulation d'une
// fusion) passent TOUJOURS par une confirmation (`drafts.stopRequest`, `retryRequest`,
// `revertRequest`) : un menu ne parle jamais au serveur lui-même. La priorité, elle,
// se change directement : rien ne se perd, et le serveur la borne.

import ConsoleClient
import ConsoleCore
import SwiftUI

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
    /// consigne et budget d'une feature, annulation d'une fusion.
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
