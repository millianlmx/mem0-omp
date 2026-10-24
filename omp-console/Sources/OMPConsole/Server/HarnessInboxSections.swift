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
        if !server.canAct {
            Section {
                Text(PipelineServerText.readOnly)
                    .foregroundStyle(.secondary)
            }
        }
        Section {
            if inbox.batches.isEmpty {
                emptyRow
            }
            ForEach(inbox.batches) { batch in
                batchView(batch)
                    .disabled(!server.canAct)
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
                    .disabled(!server.canAct)
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
                    .disabled(!server.canAct)
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
                    .disabled(!server.canAct)
            }
            ForEach(inbox.decisionRunIds, id: \.self) { runId in
                Button(inbox.decisionRunIds.count == 1 ? PipelineServerText.acceptAll : PipelineServerText.acceptAllLine(inbox.run(runId)?.title ?? runId)) {
                    Task { await server.acceptAllDecisions(runId: runId) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!server.canAct || server.busy.contains(runId))
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
                    if let context = item.shownContext {
                        Text(context)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let recommended = item.recommended {
                        Text(PipelineServerText.recommended(recommended))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    HStack {
                        ForEach(item.options, id: \.self) { option in
                            Button {
                                drafts.answers[item.id] = option
                            } label: {
                                Label(option, systemImage: drafts.answer(for: item) == option ? PipelineServerText.chosenSymbol : PipelineServerText.optionSymbol)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    TextField(PipelineServerText.answerPlaceholder, text: answerBinding(item))
                    TextField(PipelineServerText.reasonOptional, text: reasonBinding(item.id))
                }
            }
            HStack {
                Button(PipelineServerText.answer) {
                    let answers = drafts.answers(for: batch)
                    let reasons = drafts.reasons(for: batch)
                    Task {
                        if await server.answer(runId: batch.id, answers: answers, reasons: reasons) { drafts.clearAnswers(for: batch) }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!drafts.canAnswer(batch) || server.busy.contains(batch.id))
                if let recommended = HarnessDrafts.recommendedAnswers(for: batch) {
                    Button(PipelineServerText.acceptRecommended) {
                        Task {
                            if await server.answer(runId: batch.id, answers: recommended) { drafts.clearAnswers(for: batch) }
                        }
                    }
                    .buttonStyle(.bordered)
                    .disabled(server.busy.contains(batch.id))
                }
            }
        }
        .padding(.vertical, 4)
    }

    /// La saisie d'une réponse : l'option recommandée tant que rien n'est tapé.
    private func answerBinding(_ item: HarnessEscalation) -> Binding<String> {
        Binding(get: { drafts.answer(for: item) }, set: { drafts.answers[item.id] = $0 })
    }

    private func reasonBinding(_ id: Int) -> Binding<String> {
        Binding(get: { drafts.reasons[id] ?? "" }, set: { drafts.reasons[id] = $0 })
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
                if run.verdict != nil {
                    Button(PipelineServerText.approve) {
                        Task { await server.validate(runId: run.id, approve: true, reason: "") }
                    }
                    .buttonStyle(.borderedProminent)
                    Button(PipelineServerText.refuse) { drafts.beginRefusal(run) }
                        .buttonStyle(.bordered)
                } else {
                    // Arrêté sans verdict (échecs répétés, fusion refusée) : repart de son étape.
                    Button(PipelineServerText.retry) { drafts.retryRequest = run }
                        .buttonStyle(.borderedProminent)
                }
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
            if let status = PipelineServerText.decisionStatus(decision.status) {
                Text(status)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(decision.decidedAtDeadline ? Color.orange : Color.secondary)
            }
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

/// Une feature : titre, étape, corrections, reprise différée ou dernier échec ; puis ses
/// gestes, tous confirmés par `harnessGestures` : l'arrêt, la relance (en échec ou arrêtée
/// sur une attente), l'annulation d'une feature fusionnée.
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
                if let detail = run.detailLine() {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if run.fixes > 0 {
                    Text(PipelineServerText.fixes(run.fixes))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let cost = server.inbox?.costs[run.id] {
                    Label(MonitoringText.cost(cost), systemImage: MonitoringText.costSymbol)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                ForEach(server.inbox?.alerts(of: run.id) ?? []) { alert in
                    Label(alert.line, systemImage: alert.symbol)
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
            Spacer()
            if run.canFollowSession {
                Button {
                    drafts.sessionRequest = HarnessSessionRequest(run: run)
                } label: {
                    Label(PipelineServerText.sessionTitle, systemImage: PipelineServerText.sessionSymbol)
                }
                .buttonStyle(.bordered)
                .help(PipelineServerText.sessionTitle)
                .accessibilityIdentifier("pipelines.session.open")
            }
            if run.canRetry {
                Button(PipelineServerText.retry) { drafts.retryRequest = run }
                    .buttonStyle(.bordered)
                    .disabled(server.busy.contains(run.id))
            }
            if run.canRevert {
                Button(PipelineServerText.revertFeature) { drafts.revertRequest = run }
                    .buttonStyle(.bordered)
                    .disabled(server.busy.contains(run.id))
            }
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
    /// renversement d'une décision, arrêt, relance et annulation d'une feature.
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
            .sheet(item: $drafts.sessionRequest) { request in
                HarnessSessionSheet(server: server, request: request)
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
            .confirmationDialog(
                PipelineServerText.retryConfirm,
                isPresented: Binding(get: { drafts.retryRequest != nil }, set: { if !$0 { drafts.retryRequest = nil } }),
                presenting: drafts.retryRequest
            ) { run in
                Button(PipelineServerText.retry) {
                    Task { await server.retry(runId: run.id) }
                }
                Button(PipelineServerText.cancel, role: .cancel) {}
            } message: { run in
                if let detail = run.detailLine() { Text(detail) }
                if let reason = run.reason { Text(reason) }
                Text(PipelineServerText.retryMessage)
            }
            .confirmationDialog(
                PipelineServerText.revertConfirm,
                isPresented: Binding(get: { drafts.revertRequest != nil }, set: { if !$0 { drafts.revertRequest = nil } }),
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
