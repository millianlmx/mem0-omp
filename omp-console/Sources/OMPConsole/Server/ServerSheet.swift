// La feuille « Serveur de pipelines » de la section Pipelines : la boîte de l'humain
// tenue par le serveur du VPS (omp-harness). Elle montre les escalades à trancher (un
// lot par feature), les verdicts à valider, les décisions prises seules (accepter ou
// renverser, la raison rejoint la mémoire du projet) et les features en cours.
//
// Le modèle (`HarnessModel`) et les brouillons (`HarnessDrafts`) viennent du client
// partagé, comme dans l'app iOS ; les mots viennent de `PipelineServerText`. Aucun
// `@State` (macros absentes sous les Command Line Tools) : l'état d'écran vit dans
// les brouillons.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct ServerSheet: View {
    @StateObject private var server = HarnessModel.live()
    @StateObject private var drafts = HarnessDrafts()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(PipelineServerText.title)
                .toolbar { toolbarContent }
        }
        .frame(minWidth: 640, idealWidth: 720, minHeight: 520, idealHeight: 680)
        .task {
            await server.load()
            server.startLive()
        }
        .onDisappear { server.stopLive() }
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
        .confirmationDialog(PipelineServerText.forgetConfirm, isPresented: $drafts.forgetAsked) {
            Button(PipelineServerText.forget, role: .destructive) {
                Task { await server.forget() }
            }
            Button(PipelineServerText.cancel, role: .cancel) {}
        } message: {
            Text(PipelineServerText.forgetMessage)
        }
        .accessibilityIdentifier("server.sheet")
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button(PipelineServerText.close) { dismiss() }
        }
        if server.isConfigured {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { await server.refresh() }
                } label: {
                    Label(PipelineServerText.refresh, systemImage: "arrow.clockwise")
                }
                .keyboardShortcut("r", modifiers: .command)
                .disabled(server.isLoading)
                .accessibilityIdentifier("server.refresh")
            }
            ToolbarItem(placement: .primaryAction) {
                Button(PipelineServerText.forget) { drafts.forgetAsked = true }
                    .accessibilityIdentifier("server.forget")
            }
        }
    }

    // MARK: - Contenu

    @ViewBuilder
    private var content: some View {
        if !server.isLoaded {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if !server.isConfigured {
            setupForm
        } else {
            inboxForm(server.inbox ?? HarnessInbox())
        }
    }

    private var setupForm: some View {
        Form {
            Section {
                Text(PipelineServerText.setupExplanation)
                    .foregroundStyle(.secondary)
                TextField(PipelineServerText.addressLabel, text: $drafts.address, prompt: Text(PipelineServerText.addressPrompt))
                    .accessibilityIdentifier("server.address")
                SecureField(PipelineServerText.tokenLabel, text: $drafts.token)
                    .accessibilityIdentifier("server.secret")
            } header: {
                Text(PipelineServerText.setupTitle)
            }
            if let failure = server.failure {
                Section {
                    failureLabel(failure)
                }
            }
            Section {
                Button(PipelineServerText.save) {
                    Task {
                        if await server.configure(address: drafts.address, token: drafts.token) {
                            drafts.token = ""
                            server.startLive()
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(server.isLoading || drafts.address.isEmpty || drafts.token.isEmpty)
                .accessibilityIdentifier("server.save")
            }
        }
        .formStyle(.grouped)
    }

    private func inboxForm(_ inbox: HarnessInbox) -> some View {
        Form {
            Section {
                if let failure = server.failure {
                    failureLabel(failure)
                }
                Label(
                    server.isLive ? PipelineServerText.live : PipelineServerText.offline,
                    systemImage: server.isLive ? PipelineServerText.liveSymbol : PipelineServerText.offlineSymbol
                )
                .foregroundStyle(.secondary)
                Text(PipelineServerText.pending(inbox.pendingCount))
                    .font(.headline)
            } header: {
                Text(server.address ?? "")
            }

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
                if inbox.awaiting.isEmpty {
                    emptyRow
                }
                ForEach(inbox.awaiting) { run in
                    awaitingView(run)
                }
            } header: {
                Text(PipelineServerText.toValidate)
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
                    runRow(run)
                }
            } header: {
                Text(PipelineServerText.inProgress)
            }
        }
        .formStyle(.grouped)
    }

    private var emptyRow: some View {
        Text(PipelineServerText.nothingPending)
            .foregroundStyle(.secondary)
    }

    private func failureLabel(_ failure: HarnessFailure) -> some View {
        Label {
            Text(failure.message)
                .textSelection(.enabled)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
        }
        .accessibilityIdentifier("server.failure")
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

    // MARK: - À valider

    private func awaitingView(_ run: HarnessRun) -> some View {
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

    private func refusalSheet(_ run: HarnessRun) -> some View {
        NavigationStack {
            Form {
                Section {
                    Text(run.title)
                        .font(.headline)
                    TextField(PipelineServerText.reasonLabel, text: $drafts.refusalReason, axis: .vertical)
                } footer: {
                    Text(PipelineServerText.reasonHint)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(PipelineServerText.refuseTitle)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.cancel) { drafts.refusal = nil }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(PipelineServerText.send) {
                        let reason = drafts.refusalReason
                        drafts.refusal = nil
                        Task { await server.validate(runId: run.id, approve: false, reason: reason) }
                    }
                    .disabled(!drafts.canRefuse)
                }
            }
        }
        .frame(minWidth: 460, minHeight: 280)
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

    // MARK: - En cours

    private func runRow(_ run: HarnessRun) -> some View {
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
            if run.phase != .merging {
                Button(PipelineServerText.stopFeature) { drafts.stopRequest = run }
                    .buttonStyle(.bordered)
                    .disabled(server.busy.contains(run.id))
            }
        }
    }
}
