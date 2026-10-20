// La boîte de l'humain du serveur de pipelines, en sections de formulaire : les
// questions à trancher (un lot par feature), les specs et les verdicts à valider, les
// décisions prises seules (accepter ou renverser) et les features en cours. L'Accueil
// la pose sous son résumé.
//
// Le modèle (`HarnessModel`) et les brouillons (`HarnessDrafts`) viennent du client
// partagé, comme dans l'app iOS ; les mots viennent de `PipelineServerText`. Aucun
// `@State` (macros absentes sous les Command Line Tools) : l'état d'écran vit dans
// les brouillons. Les feuilles et confirmations sont posées par `harnessGestures`.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct HarnessInboxSections: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let inbox: HarnessInbox

    var body: some View {
        Section {
            if inbox.batches.isEmpty {
                emptyRow
            }
            ForEach(inbox.batches) { batch in
                batchView(batch)
            }
        } header: {
            Text(PipelineServerText.toDecide)
        } footer: {
            Text(PipelineServerText.toDecideHint)
        }

        Section {
            if inbox.specsAwaiting.isEmpty {
                emptyRow
            }
            ForEach(inbox.specsAwaiting) { run in
                specsView(run)
            }
        } header: {
            Text(PipelineServerText.specsToValidate)
        } footer: {
            Text(PipelineServerText.specsToValidateHint)
        }

        Section {
            if inbox.verdictsAwaiting.isEmpty {
                emptyRow
            }
            ForEach(inbox.verdictsAwaiting) { run in
                verdictView(run)
            }
        } header: {
            Text(PipelineServerText.verdictsToValidate)
        } footer: {
            Text(PipelineServerText.toValidateHint)
        }

        Section {
            if inbox.decisions.isEmpty {
                emptyRow
            }
            ForEach(inbox.decisions) { decision in
                decisionView(decision, run: inbox.run(decision.runId))
            }
        } header: {
            Text(PipelineServerText.toReview)
        } footer: {
            Text(PipelineServerText.toReviewHint)
        }

        Section {
            if inbox.active.isEmpty {
                Text(PipelineServerText.nothingInProgress)
                    .foregroundStyle(.secondary)
            }
            ForEach(inbox.active) { run in
                HarnessRunRow(server: server, drafts: drafts, run: run)
            }
        } header: {
            Text(PipelineServerText.inProgress)
        }
    }

    private var emptyRow: some View {
        Text(PipelineServerText.nothingPending)
            .foregroundStyle(.secondary)
    }

    // MARK: - À trancher

    private func batchView(_ batch: HarnessEscalationBatch) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(batch.run?.title ?? batch.id)
                .font(.headline)
            ForEach(batch.items) { item in
                VStack(alignment: .leading, spacing: 6) {
                    Text(PipelineServerText.category(item.category))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.orange)
                    Text(item.question)
                        .textSelection(.enabled)
                    if !item.context.isEmpty {
                        Text(item.context)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    HStack {
                        ForEach(item.options, id: \.self) { option in
                            Button(option) { drafts.answers[item.id] = option }
                                .buttonStyle(.bordered)
                        }
                    }
                    TextField(PipelineServerText.answerPlaceholder, text: answerBinding(item.id))
                }
            }
            Button(PipelineServerText.answer) {
                let answers = drafts.answers(for: batch)
                Task {
                    if await server.answer(runId: batch.id, answers: answers) { drafts.clearAnswers(for: batch) }
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(!drafts.canAnswer(batch) || server.busy.contains(batch.id))
        }
        .padding(.vertical, 4)
    }

    private func answerBinding(_ id: Int) -> Binding<String> {
        Binding(get: { drafts.answers[id] ?? "" }, set: { drafts.answers[id] = $0 })
    }

    // MARK: - Specs à valider

    private func specsView(_ run: HarnessRun) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(run.title)
                .font(.headline)
            if let specs = drafts.specs[run.id] {
                ScrollView {
                    Text(specs)
                        .font(.callout.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 320)
            } else {
                Button(PipelineServerText.readSpecs) {
                    Task {
                        if let view = await server.runView(run.id) { drafts.specs[run.id] = view.specs ?? "" }
                    }
                }
                .buttonStyle(.bordered)
            }
            HStack {
                Button(PipelineServerText.approveSpecs) {
                    Task {
                        if await server.validate(runId: run.id, approve: true, reason: "") { drafts.specs[run.id] = nil }
                    }
                }
                .buttonStyle(.borderedProminent)
                Button(PipelineServerText.refuse) { drafts.beginRefusal(run) }
                    .buttonStyle(.bordered)
            }
            .disabled(server.busy.contains(run.id))
        }
        .padding(.vertical, 4)
    }

    // MARK: - Verdicts à valider

    private func verdictView(_ run: HarnessRun) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(run.title)
                .font(.headline)
            if let verdict = run.verdict {
                Text(PipelineServerText.risk(verdict.risk))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(verdict.isLowRisk ? Color.green : Color.orange)
                Text(verdict.summary)
                    .textSelection(.enabled)
                verdictList(PipelineServerText.blockers, verdict.blockers)
                verdictList(PipelineServerText.risks, verdict.risks)
                verdictList(PipelineServerText.unverified, verdict.unverified)
                if verdict.isWeak {
                    Label(PipelineServerText.weakVerdict, systemImage: "eyeglasses")
                        .font(.callout)
                        .foregroundStyle(.orange)
                }
            }
            if let reason = run.reason {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack {
                Button(PipelineServerText.approve) {
                    Task { await server.validate(runId: run.id, approve: true, reason: "") }
                }
                .buttonStyle(.borderedProminent)
                Button(PipelineServerText.refuse) { drafts.beginRefusal(run) }
                    .buttonStyle(.bordered)
            }
            .disabled(server.busy.contains(run.id))
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func verdictList(_ title: String, _ items: [String]) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption.weight(.semibold))
                ForEach(items, id: \.self) { item in
                    Text("· " + item)
                        .font(.callout)
                }
            }
        }
    }

    // MARK: - Décisions prises seules

    private func decisionView(_ decision: HarnessDecision, run: HarnessRun?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let run {
                Text(run.title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            Text(PipelineServerText.decisionLine(seq: decision.seq, question: decision.question, chosen: decision.chosen))
                .textSelection(.enabled)
            Text(PipelineServerText.rationale(decision.rationale))
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack {
                Button(PipelineServerText.accept) {
                    Task { await server.accept(runId: decision.runId, seq: decision.seq) }
                }
                .buttonStyle(.bordered)
                Button(PipelineServerText.reverse) { drafts.beginReversal(decision) }
                    .buttonStyle(.bordered)
            }
            .disabled(server.busy.contains(decision.runId))
        }
        .padding(.vertical, 4)
    }
}

/// Une feature en cours : titre, étape, corrections, et l'arrêt (confirmé par `harnessGestures`).
struct HarnessRunRow: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let run: HarnessRun

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(run.title)
                Text(run.statusLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if run.fixes > 0 {
                    Text(PipelineServerText.fixes(run.fixes))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if let phase = run.phase, [.queued, .running, .escalated, .awaitingHuman].contains(phase) {
                Button(PipelineServerText.stopFeature) { drafts.stopRequest = run }
                    .buttonStyle(.bordered)
                    .disabled(server.busy.contains(run.id))
            }
        }
    }
}

/// L'échec du dernier échange, cause puis remède.
struct HarnessFailureLabel: View {
    let failure: HarnessFailure

    var body: some View {
        Label {
            Text(failure.message)
                .textSelection(.enabled)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
        }
        .accessibilityIdentifier("server.failure")
    }
}

extension View {
    /// Les feuilles et confirmations des gestes du serveur : refus (specs ou verdict),
    /// renversement d'une décision, arrêt d'une feature.
    func harnessGestures(server: HarnessModel, drafts: HarnessDrafts) -> some View {
        modifier(HarnessGestures(server: server, drafts: drafts))
    }
}

private struct HarnessGestures: ViewModifier {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    func body(content: Content) -> some View {
        content
            .sheet(item: $drafts.reversal) { decision in
                reversalSheet(decision)
            }
            .sheet(item: $drafts.refusal) { run in
                refusalSheet(run)
            }
            .confirmationDialog(
                PipelineServerText.stopConfirm,
                isPresented: Binding(get: { drafts.stopRequest != nil }, set: { if !$0 { drafts.stopRequest = nil } }),
                presenting: drafts.stopRequest
            ) { run in
                Button(PipelineServerText.stopFeature, role: .destructive) {
                    Task { await server.cancel(runId: run.id) }
                }
                Button(PipelineServerText.cancel, role: .cancel) {}
            } message: { _ in
                Text(PipelineServerText.stopMessage)
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
        .frame(minWidth: 460, minHeight: 280)
    }

    private func reversalSheet(_ decision: HarnessDecision) -> some View {
        NavigationStack {
            Form {
                Section {
                    Text(decision.question)
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
        .frame(minWidth: 480, minHeight: 320)
    }
}
