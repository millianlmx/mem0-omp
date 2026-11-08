// La BOÎTE de l'humain, écrite une fois pour le Mac et l'iPhone/iPad : les questions à
// trancher (un lot par feature), les specs et les verdicts à valider, les décisions
// prises seules (accepter ou renverser) et les features en cours. L'Accueil des deux
// apps la pose sous son résumé, dans son formulaire (Mac) ou sa liste groupée (iOS).
//
// Chaque question est SITUÉE avant d'être posée (`QuestionViews`) : dépôt › feature ›
// étape, demande d'origine, situation décrite par l'agent, puis chaque option avec ce
// qu'elle emporte. Les feuilles et confirmations sont posées par `harnessGestures`.

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct InboxSections: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let inbox: HarnessInbox

    public init(server: HarnessModel, drafts: HarnessDrafts, inbox: HarnessInbox) {
        self.server = server
        self.drafts = drafts
        self.inbox = inbox
    }

    public var body: some View {
        if !server.canAct {
            Section {
                Text(PipelineServerText.readOnly).foregroundStyle(.secondary)
            }
        }
        Section {
            if inbox.batches.isEmpty { empty }
            ForEach(inbox.batches) { batch in batchView(batch).disabled(!server.canAct) }
        } header: {
            Text(PipelineServerText.toDecide)
        } footer: {
            Text(PipelineServerText.toDecideHint)
        }
        .id(HarnessHomeAnchor.toDecide.rawValue)

        Section {
            if inbox.specsAwaiting.isEmpty { empty }
            ForEach(inbox.specsAwaiting) { run in specsView(run).disabled(!server.canAct) }
        } header: {
            Text(PipelineServerText.specsToValidate)
        } footer: {
            Text(PipelineServerText.specsToValidateHint)
        }
        .id(HarnessHomeAnchor.specs.rawValue)

        Section {
            if inbox.verdictsAwaiting.isEmpty { empty }
            ForEach(inbox.verdictsAwaiting) { run in verdictView(run).disabled(!server.canAct) }
        } header: {
            Text(PipelineServerText.verdictsToValidate)
        } footer: {
            Text(PipelineServerText.toValidateHint)
        }
        .id(HarnessHomeAnchor.verdicts.rawValue)

        Section {
            if inbox.decisions.isEmpty { empty }
            ForEach(inbox.decisions) { decision in decisionView(decision).disabled(!server.canAct) }
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
        .id(HarnessHomeAnchor.decisions.rawValue)

        Section {
            if inbox.active.isEmpty {
                Text(PipelineServerText.nothingInProgress).foregroundStyle(.secondary)
            }
            ForEach(inbox.active) { run in
                RunRow(server: server, drafts: drafts, run: run)
            }
        } header: {
            Text(PipelineServerText.inProgress)
        }
        .id(HarnessHomeAnchor.active.rawValue)
    }

    private var empty: some View {
        Text(PipelineServerText.nothingPending).foregroundStyle(.secondary)
    }

    // MARK: - À trancher

    /// Un lot d'escalades : la place de la feature, puis chaque question avec sa
    /// situation et l'impact de chaque option.
    private func batchView(_ batch: HarnessEscalationBatch) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            if let first = batch.items.first {
                QuestionPlaceView(place: inbox.question(first, in: batch))
            }
            ForEach(Array(batch.items.enumerated()), id: \.element.id) { index, item in
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(PipelineServerText.category(item.category))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.orange)
                        if batch.items.count > 1 {
                            Text(PipelineServerText.questionIndex(index + 1, of: batch.items.count))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Text(MarkdownDocument.inline(item.question))
                        .font(.headline)
                        .consoleReadable()
                    QuestionContextView(context: item.shownContext)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(PipelineServerText.optionsTitle)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        ForEach(item.choices) { choice in
                            QuestionChoiceRow(
                                choice: choice,
                                badge: PipelineServerText.recommendedBadge,
                                selected: drafts.answer(for: item) == choice.option
                            ) {
                                drafts.answers[item.id] = choice.option
                            }
                        }
                    }
                    if let rationale = item.shownRationale {
                        QuestionReasonView(title: PipelineServerText.whyRecommended, text: rationale)
                    }
                    // La réponse présélectionnée est l'option recommandée, tant que rien n'est tapé.
                    TextField(PipelineServerText.answerPlaceholder, text: Binding(
                        get: { drafts.answer(for: item) },
                        set: { drafts.answers[item.id] = $0 }
                    ))
                    TextField(PipelineServerText.reasonOptional, text: Binding(
                        get: { drafts.reasons[item.id] ?? "" },
                        set: { drafts.reasons[item.id] = $0 }
                    ))
                }
                // Sur iOS, la rangée de liste sépare déjà ; le rang « 2 sur 3 » suffit.
                #if os(macOS)
                if index < batch.items.count - 1 {
                    Divider()
                }
                #endif
            }
            // Une question posée en cours d'étape se lit et se prépare, mais ne part qu'à sa fin.
            if !batch.acceptsAnswers {
                Label(PipelineServerText.answerAfterStep, systemImage: PipelineServerText.waitSymbol)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            ViewThatFits(in: .horizontal) {
                HStack { answerButtons(batch) }
                VStack(alignment: .leading, spacing: 8) { answerButtons(batch) }
            }
            .disabled(!batch.acceptsAnswers)
        }
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private func answerButtons(_ batch: HarnessEscalationBatch) -> some View {
        Button(PipelineServerText.answer) {
            let answers = drafts.answers(for: batch)
            let reasons = drafts.reasons(for: batch)
            Task {
                if await server.answer(runId: batch.id, answers: answers, reasons: reasons) { drafts.clearAnswers(for: batch) }
            }
        }
        .buttonStyle(.borderedProminent)
        .disabled(!drafts.canAnswer(batch) || server.busy.contains(batch.id))
        // Un seul geste : toutes les escalades du lot reçoivent la recommandation de l'agent.
        if let recommended = HarnessDrafts.recommendedAnswers(for: batch) {
            Button(PipelineServerText.acceptRecommended) {
                Task {
                    if await server.answer(runId: batch.id, answers: recommended) { drafts.clearAnswers(for: batch) }
                }
            }
            .buttonStyle(.bordered)
            .disabled(server.busy.contains(batch.id))
            .consoleID("home.acceptRecommended")
        }
    }

    // MARK: - Specs à valider

    private func specsView(_ run: HarnessRun) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            QuestionPlaceView(place: inbox.question(run))
            if let specs = drafts.specs[run.id] {
                // Les specs rendues (titres, listes de critères, tableaux, code), pas leur
                // source : elles se lisent comme un document, et se copient.
                specsDocument(ConsoleMarkdown(blocks: MarkdownDocument.blocks(specs)).textSelection(.enabled))
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

    /// Sur le Mac, de longues specs défilent dans leur cadre ; sur iOS, la liste défile.
    @ViewBuilder
    private func specsDocument(_ document: some View) -> some View {
        #if os(macOS)
        ScrollView {
            document
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.trailing, 8)
        }
        .frame(maxHeight: 420)
        #else
        document
        #endif
    }

    // MARK: - Verdicts à valider

    private func verdictView(_ run: HarnessRun) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            QuestionPlaceView(place: inbox.question(run))
            if let verdict = run.verdict {
                Text(PipelineServerText.risk(verdict.risk))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(verdict.isLowRisk ? Color.green : Color.orange)
                ConsoleMarkdown(markdown: verdict.summary)
                verdictList(PipelineServerText.blockers, verdict.blockers)
                verdictList(PipelineServerText.risks, verdict.risks)
                verdictList(PipelineServerText.unverified, verdict.unverified)
                if verdict.isWeak {
                    Label(PipelineServerText.weakVerdict, systemImage: PipelineServerText.weakVerdictSymbol)
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
                    // Arrêtée sans verdict (échecs répétés, fusion refusée) : repart de son étape.
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
                    Text(MarkdownDocument.inline(PipelineServerText.bullet(item)))
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: - Décisions prises seules

    /// Une décision prise seule : sa place, sa situation, l'option retenue parmi les
    /// autres (avec leurs impacts) et la raison de l'agent.
    private func decisionView(_ decision: HarnessDecision) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            QuestionPlaceView(place: inbox.question(decision))
            HStack(alignment: .firstTextBaseline) {
                Text(PipelineServerText.category(decision.category))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                if let status = PipelineServerText.decisionStatus(decision.status) {
                    Text(status)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(decision.decidedAtDeadline ? Color.orange : Color.secondary)
                }
            }
            Text(MarkdownDocument.inline(decision.question))
                .font(.headline)
                .consoleReadable()
            if let context = decision.shownContext {
                QuestionContextView(context: context)
            }
            VStack(alignment: .leading, spacing: 6) {
                ForEach(decision.choices) { choice in
                    QuestionChoiceRow(choice: choice, badge: PipelineServerText.chosenBadge, selected: choice.isPreferred)
                }
            }
            QuestionReasonView(title: PipelineServerText.whyChosen, text: decision.rationale)
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
        .padding(.vertical, 6)
    }
}
