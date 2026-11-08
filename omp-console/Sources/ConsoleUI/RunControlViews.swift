// La feature EN DIRECT, écrite une fois pour le Mac et l'iPhone/iPad : la consigne à
// l'agent qui y travaille (depuis la session en direct et le menu de la feature), le
// budget propre de la feature, la relance avec consigne, et ce qui retient une feature
// en file — dit en clair sur sa rangée et, pour la file entière, sur l'Accueil.
//
// La consigne part avec la révision de la feature (`If-Match`) : un autre appareil qui
// l'a changée entre-temps fait refuser l'envoi, et la boîte relue le montre.

import ConsoleClient
import ConsoleCore
import SwiftUI

extension HarnessRun {
    /// Une consigne a du sens : la feature n'est ni fusionnée, ni annulée, ni en échec.
    public var acceptsInstructions: Bool {
        guard let phase else { return false }
        return [.queued, .running, .escalated, .awaitingHuman].contains(phase)
    }

    /// Le budget se règle tant que la feature n'est pas finie.
    public var acceptsBudget: Bool {
        guard let phase else { return false }
        return ![.merged, .cancelled].contains(phase)
    }

    /// En file et retenue par l'admission : ce qui la retient (`nil` sinon).
    public var queueReason: String? {
        guard phase == .queued, let reason, !reason.isEmpty else { return nil }
        return reason
    }
}

/// Ce qui retient une feature en file, bien visible sur sa rangée.
public struct RunQueueReason: View {
    let run: HarnessRun

    public init(run: HarnessRun) {
        self.run = run
    }

    public var body: some View {
        if let reason = run.queueReason {
            VStack(alignment: .leading, spacing: 2) {
                if let cause = run.waitCause {
                    Text(ControlText.waitCause(cause))
                        .font(.caption.weight(.semibold))
                }
                Text(reason)
                    .font(.caption)
                    .consoleReadable()
            }
            .foregroundStyle(.orange)
            .accessibilityElement(children: .combine)
            .consoleID("run.queueReason")
        }
    }
}

/// La file d'admission en tête de la liste des features : combien de features dues sont
/// retenues, et pourquoi (rien quand aucune ne l'est).
public struct QueueSummarySection: View {
    @ObservedObject var server: HarnessModel

    public init(server: HarnessModel) {
        self.server = server
    }

    public var body: some View {
        if let queue = server.status?.queue, queue.held > 0 {
            Section {
                Label(ControlText.held(queue.held), systemImage: ControlText.queueSymbol)
                    .font(.headline)
                if let dominant = queue.dominant {
                    Text(ControlText.waitCause(dominant.cause))
                        .font(.callout.weight(.semibold))
                    Text(dominant.text)
                        .font(.callout)
                        .consoleReadable()
                }
                ForEach(queue.byCause.sorted { $0.value > $1.value }, id: \.key) { cause, count in
                    Text(ControlText.countLine(ControlText.waitCause(cause), count: count))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text(ControlText.queueTitle)
            }
            .consoleID("runs.queue")
        }
    }
}

/// La consigne à l'agent d'une feature : le champ, l'envoi et ce qu'en a fait le serveur.
public struct RunInstructionsComposer: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let runId: String

    public init(server: HarnessModel, drafts: HarnessDrafts, runId: String) {
        self.server = server
        self.drafts = drafts
        self.runId = runId
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField(ControlText.instructionsTitle, text: text, prompt: Text(ControlText.instructionsPrompt), axis: .vertical)
                .lineLimit(1...5)
                .disabled(!server.canAct)
                .consoleID("run.instructions.text")
            HStack {
                Button {
                    send()
                } label: {
                    Label(ControlText.instructionsSend, systemImage: ControlText.instructionsSymbol)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!server.canAct || server.busy.contains(runId) || drafts.instructionsText(for: runId).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .consoleID("run.instructions.send")
                if server.busy.contains(runId) { ProgressView().controlSize(.small) }
            }
            if let delivered = drafts.instructionsDelivered[runId] {
                Text(ControlText.delivered(session: delivered == .session))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .consoleID("run.instructions.delivered")
            }
        }
    }

    private var text: Binding<String> {
        Binding(get: { drafts.instructionsText(for: runId) }, set: { drafts.instructions[runId] = $0 })
    }

    private func send() {
        let id = runId
        let typed = drafts.instructionsText(for: id)
        Task {
            if let delivered = await server.instruct(runId: id, text: typed) {
                drafts.instructionsDelivered[id] = delivered
                drafts.instructions[id] = nil
            }
        }
    }
}

/// Les feuilles de la feature en direct : consigne, budget et relance avec consigne.
struct RunControlSheets: ViewModifier {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    func body(content: Content) -> some View {
        content
            .sheet(item: $drafts.instructionsRequest) { run in
                instructionsSheet(run)
            }
            .sheet(item: $drafts.budgetRequest) { run in
                budgetSheet(run)
            }
            .sheet(item: $drafts.retryRequest) { run in
                retrySheet(run)
            }
    }

    private func instructionsSheet(_ run: HarnessRun) -> some View {
        NavigationStack {
            Form {
                Section {
                    Text(run.title)
                        .font(.headline)
                    RunQueueReason(run: run)
                    RunInstructionsComposer(server: server, drafts: drafts, runId: run.id)
                } footer: {
                    Text(ControlText.instructionsHint)
                }
                if let failure = server.failure {
                    Section { ConsoleFailureBanner(failure: failure) }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(ControlText.instructionsTitle)
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.close) { drafts.instructionsRequest = nil }
                }
            }
        }
        .consoleSheetSize(minWidth: 480, minHeight: 300)
    }

    private func budgetSheet(_ run: HarnessRun) -> some View {
        NavigationStack {
            Form {
                Section {
                    Text(run.title)
                        .font(.headline)
                    if let budget = drafts.budgetShown {
                        Text(ControlText.spent(MonitoringText.cost(budget.cost)))
                            .monospacedDigit()
                        if let ceiling = budget.budget {
                            Text(ControlText.ceiling(MonitoringText.cost(ceiling), own: budget.isOwn))
                                .monospacedDigit()
                        } else {
                            Text(ControlText.budgetNone)
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        ProgressView()
                    }
                    TextField(ControlText.budgetLabel, text: $drafts.budgetText, prompt: Text(ControlText.budgetPrompt))
                        .consoleDecimalInput()
                        .consoleID("run.budget.amount")
                    if !drafts.budgetText.isEmpty, drafts.budgetValue == nil {
                        Text(ControlText.budgetInvalid)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                    Button(ControlText.budgetReset) {
                        let id = run.id
                        Task { drafts.budgetShown = await server.setBudget(runId: id, budgetUsd: nil) ?? drafts.budgetShown }
                    }
                    .disabled(!server.canAct || server.busy.contains(run.id) || drafts.budgetShown?.isOwn != true)
                    .consoleID("run.budget.reset")
                } footer: {
                    Text(ControlText.budgetHint)
                }
                if let failure = server.failure {
                    Section { ConsoleFailureBanner(failure: failure) }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(ControlText.budgetTitle)
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.close) { drafts.budgetRequest = nil }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(ControlText.budgetSave) {
                        guard let value = drafts.budgetValue else { return }
                        let id = run.id
                        Task {
                            if let budget = await server.setBudget(runId: id, budgetUsd: value) {
                                drafts.budgetShown = budget
                                drafts.budgetText = ""
                            }
                        }
                    }
                    .disabled(!server.canAct || drafts.budgetValue == nil || server.busy.contains(run.id))
                    .consoleID("run.budget.save")
                }
            }
        }
        .task(id: run.id) {
            drafts.budgetShown = await server.runDetail(runId: run.id)?.budget ?? HarnessBudget()
        }
        .consoleSheetSize(minWidth: 460, minHeight: 320)
    }

    private func retrySheet(_ run: HarnessRun) -> some View {
        NavigationStack {
            Form {
                Section {
                    Text(run.title)
                        .font(.headline)
                    if let detail = run.detailLine() {
                        Text(detail)
                            .font(.callout)
                    }
                    if let reason = run.reason {
                        Text(reason)
                            .font(.callout)
                            .consoleReadable()
                    }
                    Text(PipelineServerText.retryMessage)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                } header: {
                    Text(PipelineServerText.retryConfirm)
                }
                Section {
                    TextField(ControlText.retryInstructionsLabel, text: $drafts.retryInstructions, prompt: Text(ControlText.instructionsPrompt), axis: .vertical)
                        .lineLimit(2...6)
                        .consoleID("run.retry.instructions")
                } footer: {
                    Text(ControlText.retryInstructionsHint)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(ControlText.retryTitle)
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.cancel) { drafts.retryRequest = nil }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(PipelineServerText.retry) {
                        let id = run.id
                        let instructions = drafts.retryInstructions
                        drafts.retryRequest = nil
                        Task { await server.retry(runId: id, instructions: instructions) }
                    }
                    .consoleID("run.retry.commit")
                }
            }
        }
        .consoleSheetSize(minWidth: 480, minHeight: 320)
    }
}

extension HarnessSessionRequest {
    /// Le sous-titre d'un direct : celui d'une feature, de l'analyse d'un audit ou d'un job du poste.
    public var subtitle: String {
        switch target {
        case .run: PipelineServerText.sessionTitle
        case .audit: MonitoringText.auditSessionTitle
        case .workstation: ControlText.sessionsTitle
        }
    }
}
