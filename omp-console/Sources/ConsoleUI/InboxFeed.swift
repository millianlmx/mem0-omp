// Les CARTES de ce qui attend l'humain sur une feature, écrites une fois pour le Mac et
// l'iPhone/iPad : un lot de questions à trancher (`EscalationBatchCard`), des specs à
// valider (`SpecsCard`), un verdict à valider (`VerdictCard`) et les décisions prises
// seules (`DecisionsCard`). « Comprendre » les montre par `RunPendingCard`.
//
// Chaque question est SITUÉE avant d'être posée (`QuestionViews`) : dépôt › feature ›
// étape, demande d'origine, situation décrite par l'agent, puis chaque option avec ce
// qu'elle emporte. Les feuilles et confirmations sont posées par `harnessGestures`.

import ConsoleClient
import ConsoleCore
import SwiftUI

// MARK: - À trancher

/// Un lot d'escalades : la place de la feature, puis chaque question avec sa situation
/// et l'impact de chaque option.
struct EscalationBatchCard: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let inbox: HarnessInbox
    let batch: HarnessEscalationBatch

    var body: some View {
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
                    if let card = item.card {
                        // La session en graphe : l'explication synthétique, le schéma de bifurcation
                        // (ses options se choisissent), la carte d'exploration, puis les détails repliés.
                        DecisionCardSummary(card: card)
                        BifurcationSchemaView(schema: card.schema, selected: drafts.answer(for: item)) { option in
                            drafts.answers[item.id] = option
                        }
                        CardExplorationView(server: server, runId: batch.id, escalationId: item.id, runState: batch.run?.state)
                        CardDetailsView(context: item.shownContext, rationale: item.shownRationale)
                    } else {
                        Text(MarkdownDocument.inline(item.question))
                            .font(.headline)
                            .consoleReadable()
                        QuestionContextView(context: item.shownContext)
                        VStack(alignment: .leading, spacing: 6) {
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
                HStack { buttons }
                VStack(alignment: .leading, spacing: 8) { buttons }
            }
        }
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private var buttons: some View {
        Button(PipelineServerText.answer) {
            let answers = drafts.answers(for: batch)
            let reasons = drafts.reasons(for: batch)
            Task {
                if await server.answer(runId: batch.id, answers: answers, reasons: reasons) { drafts.clearAnswers(for: batch) }
            }
        }
        .buttonStyle(.borderedProminent)
        .disabled(!batch.acceptsAnswers || !drafts.canAnswer(batch) || server.busy.contains(batch.id))
        // Un seul geste : toutes les escalades du lot reçoivent la recommandation de l'agent.
        if let recommended = HarnessDrafts.recommendedAnswers(for: batch) {
            Button(PipelineServerText.acceptRecommended) {
                Task {
                    if await server.answer(runId: batch.id, answers: recommended) { drafts.clearAnswers(for: batch) }
                }
            }
            .buttonStyle(.bordered)
            .disabled(!batch.acceptsAnswers || server.busy.contains(batch.id))
            .consoleID("home.acceptRecommended")
        }
    }
}

// MARK: - Specs à valider

struct SpecsCard: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let inbox: HarnessInbox
    let run: HarnessRun

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            QuestionPlaceView(place: inbox.question(run))
            // Le briefing (ce que fait la feature, les points ambigus) avant le document complet.
            if let briefing = run.briefing {
                BriefingView(briefing: briefing)
            }
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
            ViewThatFits(in: .horizontal) {
                HStack { buttons }
                VStack(alignment: .leading, spacing: 8) { buttons }
            }
            .disabled(server.busy.contains(run.id))
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var buttons: some View {
        Button(PipelineServerText.approveSpecs) {
            Task {
                if await server.validate(runId: run.id, approve: true, reason: "") { drafts.specs[run.id] = nil }
            }
        }
        .buttonStyle(.borderedProminent)
        Button(PipelineServerText.refuse) { drafts.beginRefusal(run) }
            .buttonStyle(.bordered)
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
}

// MARK: - Verdicts à valider

struct VerdictCard: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let inbox: HarnessInbox
    let run: HarnessRun

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            QuestionPlaceView(place: inbox.question(run))
            // Un arbitrage entre revue et correction : son briefing avant le verdict complet.
            if let briefing = run.briefing {
                BriefingView(briefing: briefing)
            }
            if let verdict = run.verdict {
                Text(PipelineServerText.risk(verdict.risk))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(verdict.isLowRisk ? Color.green : Color.orange)
                ConsoleMarkdown(markdown: verdict.summary)
                list(PipelineServerText.blockers, verdict.blockers)
                list(PipelineServerText.risks, verdict.risks)
                list(PipelineServerText.unverified, verdict.unverified)
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
                    .consoleReadable()
            }
            ViewThatFits(in: .horizontal) {
                HStack { buttons }
                VStack(alignment: .leading, spacing: 8) { buttons }
            }
            .disabled(server.busy.contains(run.id))
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var buttons: some View {
        if run.verdict != nil {
            Button(PipelineServerText.approve) {
                Task { await server.validate(runId: run.id, approve: true, reason: "") }
            }
            .buttonStyle(.borderedProminent)
            Button(PipelineServerText.refuse) { drafts.beginRefusal(run) }
                .buttonStyle(.bordered)
        } else {
            // Arrêtée sans verdict (échecs répétés, fusion refusée) : repart de son étape.
            Button(PipelineServerText.retry) { drafts.beginRetry(run) }
                .buttonStyle(.borderedProminent)
        }
    }

    @ViewBuilder
    private func list(_ title: String, _ items: [String]) -> some View {
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
}

// MARK: - Décisions prises seules

/// Les décisions prises seules sur une feature : chacune avec sa situation, l'option
/// retenue parmi les autres et la raison de l'agent ; « Tout accepter » d'un geste.
struct DecisionsCard: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let inbox: HarnessInbox
    let runId: String
    let decisions: [HarnessDecision]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(decisions.enumerated()), id: \.element.id) { index, decision in
                decisionView(decision)
                #if os(macOS)
                if index < decisions.count - 1 {
                    Divider()
                }
                #endif
            }
            if decisions.count > 1 {
                Button(PipelineServerText.acceptAll) {
                    Task { await server.acceptAllDecisions(runId: runId) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(server.busy.contains(runId))
            }
        }
        .padding(.vertical, 6)
    }

    private func decisionView(_ decision: HarnessDecision) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            QuestionPlaceView(place: inbox.question(decision))
            HStack(alignment: .firstTextBaseline) {
                if decision.autonomy != nil {
                    Label(AutonomyText.decidedAlone, systemImage: AutonomyText.decidedAloneSymbol)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tint)
                } else {
                    Text(PipelineServerText.category(decision.category))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                if let status = PipelineServerText.decisionStatus(decision.status) {
                    Text(status)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(decision.decidedAtDeadline ? Color.orange : Color.secondary)
                }
            }
            Text(MarkdownDocument.inline(decision.question))
                .font(.headline)
                .consoleReadable()
            if let autonomy = decision.autonomy {
                AutonomyProofView(proof: autonomy)
            } else if let context = decision.shownContext {
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
    }
}
