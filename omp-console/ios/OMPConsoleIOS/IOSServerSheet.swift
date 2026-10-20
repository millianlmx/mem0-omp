import ConsoleClient
import ConsoleCore
import SwiftUI

/// La feuille « Serveur de pipelines » de l'écran Pipelines : la boîte de l'humain
/// tenue par le serveur du VPS (omp-harness), jointe directement (Tailscale), sans
/// passer par le Mac. Les escalades d'une feature se répondent d'un geste, les
/// verdicts se valident ou se refusent (raison dans la mémoire du projet), les
/// décisions prises seules s'acceptent ou se renversent.
///
/// Le modèle et les brouillons viennent du client partagé, les mots du noyau
/// (`PipelineServerText`) : aucun libellé en dur ici (`design-ios/AC-5`).
struct IOSServerSheet: View {
    @StateObject private var server = HarnessModel.live()
    @StateObject private var drafts = HarnessDrafts()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(PipelineServerText.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(PipelineServerText.close) { dismiss() }
                    }
                    if server.isConfigured {
                        ToolbarItem(placement: .topBarLeading) {
                            Button(role: .destructive) {
                                drafts.forgetAsked = true
                            } label: {
                                Label(PipelineServerText.forget, systemImage: "trash")
                            }
                            .accessibilityIdentifier("ios.server.forget")
                        }
                    }
                }
        }
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
        .confirmationDialog(PipelineServerText.forgetConfirm, isPresented: $drafts.forgetAsked, titleVisibility: .visible) {
            Button(PipelineServerText.forget, role: .destructive) {
                Task { await server.forget() }
            }
            Button(PipelineServerText.cancel, role: .cancel) {}
        } message: {
            Text(PipelineServerText.forgetMessage)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ios.server.sheet")
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
            inboxList(server.inbox ?? HarnessInbox())
        }
    }

    private var setupForm: some View {
        Form {
            Section {
                Text(PipelineServerText.setupExplanation)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                TextField(PipelineServerText.addressLabel, text: $drafts.address, prompt: Text(PipelineServerText.addressPrompt))
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("ios.server.address")
                SecureField(PipelineServerText.tokenLabel, text: $drafts.token)
                    .accessibilityIdentifier("ios.server.secret")
            } header: {
                Text(PipelineServerText.setupTitle)
            }
            if let failure = server.failure {
                Section {
                    Text(failure.message)
                        .font(.callout)
                        .iosBanner(tone: .attention)
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
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
                .disabled(server.isLoading || drafts.address.isEmpty || drafts.token.isEmpty)
                .accessibilityIdentifier("ios.server.save")
            }
        }
        .formStyle(.grouped)
    }

    private func inboxList(_ inbox: HarnessInbox) -> some View {
        List {
            Section {
                if let failure = server.failure {
                    Text(failure.message)
                        .font(.callout)
                        .iosBanner(tone: .attention)
                        .iosBareListRow()
                }
                Label(
                    server.isLive ? PipelineServerText.live : PipelineServerText.offline,
                    systemImage: server.isLive ? PipelineServerText.liveSymbol : PipelineServerText.offlineSymbol
                )
                .font(.callout)
                .foregroundStyle(.secondary)
                Text(PipelineServerText.pending(inbox.pendingCount))
                    .font(.headline)
            } header: {
                Text(server.address ?? "")
            }

            Section {
                if inbox.batches.isEmpty { emptyRow }
                ForEach(inbox.batches) { batch in
                    batchView(batch)
                }
            } header: {
                Text(PipelineServerText.toDecide)
            } footer: {
                Text(PipelineServerText.toDecideHint)
            }

            Section {
                if inbox.awaiting.isEmpty { emptyRow }
                ForEach(inbox.awaiting) { run in
                    awaitingView(run)
                }
            } header: {
                Text(PipelineServerText.toValidate)
            } footer: {
                Text(PipelineServerText.toValidateHint)
            }

            Section {
                if inbox.decisions.isEmpty { emptyRow }
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
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                ForEach(inbox.active) { run in
                    runRow(run)
                }
            } header: {
                Text(PipelineServerText.inProgress)
            }
        }
        .iosGroupedList()
        .refreshable { await server.refresh() }
    }

    private var emptyRow: some View {
        Text(PipelineServerText.nothingPending)
            .font(.callout)
            .foregroundStyle(.secondary)
    }

    // MARK: - À trancher

    private func batchView(_ batch: HarnessEscalationBatch) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(batch.run?.title ?? batch.id)
                .font(.headline)
            ForEach(batch.items) { item in
                VStack(alignment: .leading, spacing: 6) {
                    Text(PipelineServerText.category(item.category))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.orange)
                    Text(item.question)
                        .font(.callout)
                    if !item.context.isEmpty {
                        Text(item.context)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(item.options, id: \.self) { option in
                        Button {
                            drafts.answers[item.id] = option
                        } label: {
                            Label(option, systemImage: drafts.answers[item.id] == option ? PipelineServerText.chosenSymbol : PipelineServerText.optionSymbol)
                        }
                        .buttonStyle(.borderless)
                        .frame(minHeight: IOSMetrics.minimumTarget)
                        .contentShape(Rectangle())
                    }
                    TextField(PipelineServerText.answerPlaceholder, text: answerBinding(item.id), axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                }
            }
            Button(PipelineServerText.answer) {
                let answers = drafts.answers(for: batch)
                Task {
                    if await server.answer(runId: batch.id, answers: answers) { drafts.clearAnswers(for: batch) }
                }
            }
            .buttonStyle(.borderedProminent)
            .frame(minHeight: IOSMetrics.minimumTarget)
            .disabled(!drafts.canAnswer(batch) || server.busy.contains(batch.id))
            .accessibilityIdentifier("ios.server.answer")
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
                    .font(.callout)
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
            ViewThatFits(in: .horizontal) {
                HStack { validationButtons(run) }
                VStack(alignment: .leading) { validationButtons(run) }
            }
            .disabled(server.busy.contains(run.id))
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func validationButtons(_ run: HarnessRun) -> some View {
        Button(PipelineServerText.approve) {
            Task { await server.validate(runId: run.id, approve: true, reason: "") }
        }
        .buttonStyle(.borderedProminent)
        .frame(minHeight: IOSMetrics.minimumTarget)
        .accessibilityIdentifier("ios.server.approve")
        Button(PipelineServerText.refuse) { drafts.beginRefusal(run) }
            .buttonStyle(.bordered)
            .frame(minHeight: IOSMetrics.minimumTarget)
            .accessibilityIdentifier("ios.server.refuse")
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
                        .accessibilityIdentifier("ios.server.refusal.reason")
                } footer: {
                    Text(PipelineServerText.reasonHint)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(PipelineServerText.refuseTitle)
            .navigationBarTitleDisplayMode(.inline)
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
        .presentationDetents([.medium, .large])
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
                .font(.callout)
            Text(PipelineServerText.rationale(decision.rationale))
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack {
                Button(PipelineServerText.accept) {
                    Task { await server.accept(runId: decision.runId, seq: decision.seq) }
                }
                .buttonStyle(.bordered)
                .frame(minHeight: IOSMetrics.minimumTarget)
                Button(PipelineServerText.reverse) { drafts.beginReversal(decision) }
                    .buttonStyle(.bordered)
                    .frame(minHeight: IOSMetrics.minimumTarget)
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
                        .accessibilityIdentifier("ios.server.reversal.reason")
                } footer: {
                    Text(PipelineServerText.reasonHint)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(PipelineServerText.reverseTitle)
            .navigationBarTitleDisplayMode(.inline)
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
        .presentationDetents([.medium, .large])
    }

    // MARK: - En cours

    private func runRow(_ run: HarnessRun) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(run.title)
                .font(.callout)
            Text(run.statusLine)
                .font(.caption)
                .foregroundStyle(.secondary)
            if run.fixes > 0 {
                Text(PipelineServerText.fixes(run.fixes))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .contextMenu {
            if run.phase != .merging {
                Button(PipelineServerText.stopFeature, role: .destructive) { drafts.stopRequest = run }
            }
        }
    }
}
