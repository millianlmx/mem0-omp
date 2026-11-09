// « À TRAITER », écrit une fois pour le Mac et l'iPhone/iPad : la ligne de pouls, le
// bouton Demande et les demandes ouvertes (`IntakeInboxSection`), les envois du poste
// à approuver, les propositions nées des signalements de collègues
// (`SignalProposalsSection`), puis la FILE unique de ce qui attend l'humain
// (`HarnessInboxFeed`) — un élément par section, son genre, son dépôt et son âge en
// tête, la décision dedans. Rien de vide ne s'affiche : une file vide devient « Rien
// ne vous attend ». Les graphiques et les compteurs vivent dans Système › Statistiques.
//
// Chaque question est SITUÉE avant d'être posée (`QuestionViews`) : dépôt › feature ›
// étape, demande d'origine, situation décrite par l'agent, puis chaque option avec ce
// qu'elle emporte. Les feuilles et confirmations sont posées par `harnessGestures`.
// Les cartes (`EscalationBatchCard`, `SpecsCard`, `VerdictCard`, `DecisionsCard`)
// servent aussi la page d'une feature (`RunPendingCard`).

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct InboxFeed: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var vigie: HarnessVigie
    @ObservedObject var signals: CorporateSignalsModel
    @ObservedObject var intakes: HarnessIntakes
    let inbox: HarnessInbox

    public init(server: HarnessModel, drafts: HarnessDrafts, inbox: HarnessInbox) {
        self.server = server
        self.drafts = drafts
        self.workstation = server.workstation
        self.vigie = server.vigie
        self.signals = server.signals
        self.intakes = server.intakes
        self.inbox = inbox
    }

    public var body: some View {
        let items = HarnessInboxFeed.items(inbox)
        Section {
            PulseLine(server: server, inbox: inbox)
        }
        if !server.canAct {
            Section {
                Text(PipelineServerText.readOnly).foregroundStyle(.secondary)
            }
        }
        VigieSilentBanner(vigie: vigie)
        IntakeInboxSection(server: server, drafts: drafts)
        WorkstationHomeApprovals(workstation: workstation, drafts: drafts)
        SignalProposalsSection(signals: signals, drafts: drafts)
        if items.isEmpty, workstation.approvals.isEmpty, signals.pendingCount == 0, intakes.open.isEmpty {
            Section {
                InboxAllClear(drafts: drafts, canAct: server.canAct)
            }
        }
        ForEach(items) { item in
            Section {
                InboxItemCard(server: server, drafts: drafts, inbox: inbox, item: item)
            } header: {
                InboxItemHeader(item: item, inbox: inbox)
            }
            .id(anchorID(of: item, in: items))
        }
        DigestSection(server: server)
    }

    /// L'identifiant de défilement : le premier élément d'un genre porte l'ancre de ce
    /// genre (palette, notification), les autres leur propre identité.
    private func anchorID(of item: HarnessInboxItem, in items: [HarnessInboxItem]) -> String {
        if let anchor = item.anchor, HarnessInboxFeed.first(anchor, in: items)?.id == item.id { return anchor.rawValue }
        return item.id
    }
}

/// La ligne de POULS : le direct, ce qui tourne, ce qui attend son tour, le coût de la
/// semaine. Une seule ligne, en lieu des tuiles et des graphiques d'autrefois.
public struct PulseLine: View {
    @ObservedObject var server: HarnessModel
    let inbox: HarnessInbox

    public init(server: HarnessModel, inbox: HarnessInbox) {
        self.server = server
        self.inbox = inbox
    }

    public var body: some View {
        let running = inbox.runs.filter { HarnessRunGroup.of($0) == .running }.count
        let queued = inbox.runs.filter { HarnessRunGroup.of($0) == .queued }.count
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 14) { parts(running: running, queued: queued) }
            VStack(alignment: .leading, spacing: 6) { parts(running: running, queued: queued) }
        }
        .font(.callout)
        .monospacedDigit()
        .accessibilityElement(children: .combine)
        .consoleID("inbox.pulse")
    }

    @ViewBuilder
    private func parts(running: Int, queued: Int) -> some View {
        HStack(spacing: 6) {
            Circle()
                .fill(server.isLive ? Color.green : Color.secondary)
                .frame(width: 8, height: 8)
            Text(server.isLive ? ShellText.live : ShellText.offline)
                .foregroundStyle(server.isLive ? Color.primary : Color.secondary)
        }
        Label(ShellText.running(running), systemImage: ConsoleSection.runs.systemImage)
            .foregroundStyle(running > 0 ? Color.primary : Color.secondary)
        if queued > 0 {
            Label(ShellText.queued(queued), systemImage: PipelineServerText.waitSymbol)
                .foregroundStyle(.secondary)
        }
        if let week = server.stats?.usage?.last7Days.cost, week > 0 {
            Label(ShellText.weekCost(MonitoringText.cost(week)), systemImage: MonitoringText.costSymbol)
                .foregroundStyle(.secondary)
        }
    }
}

/// La file vide : ce qui se passera, et le seul geste utile (lancer).
public struct InboxAllClear: View {
    @ObservedObject var drafts: HarnessDrafts
    let canAct: Bool

    public init(drafts: HarnessDrafts, canAct: Bool) {
        self.drafts = drafts
        self.canAct = canAct
    }

    public var body: some View {
        VStack(spacing: 10) {
            Image(systemName: ShellText.allClearSymbol)
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(.green)
                .accessibilityHidden(true)
            Text(ShellText.allClearTitle)
                .font(.title3.weight(.semibold))
            Text(ShellText.allClearHint)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if canAct {
                Button(PipelineServerText.newFeature) {
                    drafts.launchSheetShown = true
                }
                .buttonStyle(.borderedProminent)
                .padding(.top, 4)
                .consoleID("inbox.allClear.launch")
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
        .consoleID("inbox.allClear")
    }
}

/// L'en-tête d'un élément : son genre (symbole et mot, jamais coupé), puis son dépôt et
/// depuis quand il attend (coupés les premiers quand la largeur manque).
struct InboxItemHeader: View {
    let item: HarnessInboxItem
    let inbox: HarnessInbox

    var body: some View {
        HStack(spacing: 6) {
            Label(kind, systemImage: symbol)
                .foregroundStyle(item.isGate ? Color.orange : Color.secondary)
                .fixedSize()
            if !detail.isEmpty {
                Text(detail)
                    .denseLines(1)
            }
        }
    }

    /// « dépôt · il y a 2 heures ».
    private var detail: String {
        var parts: [String] = []
        if let repo { parts.append("· " + repo) }
        if let since { parts.append("· " + ConsoleFormat.relative(ms: since, nowMs: Date().timeIntervalSince1970 * 1000)) }
        return parts.joined(separator: " ")
    }

    private var run: HarnessRun? {
        switch item {
        case .questions(let batch): batch.run ?? item.runId.flatMap(inbox.run)
        case .specs(let run), .verdict(let run): run
        default: item.runId.flatMap(inbox.run)
        }
    }

    private var repo: String? {
        if case .audit(let audit) = item { return audit.repo }
        return run?.repo
    }

    private var since: Double? {
        switch item {
        case .alert(let alert): alert.since
        case .audit(let audit): audit.createdAt
        case .decisions(_, let items): items.map(\.createdAt).min()
        default: run?.updatedAt
        }
    }

    private var kind: String {
        switch item {
        case .questions(let batch): ShellText.kindQuestions(batch.items.count)
        case .specs: ShellText.kindSpecs
        case .verdict(let run): run.verdict == nil ? ShellText.kindStopped : ShellText.kindVerdict
        case .alert: ShellText.kindAlert
        case .audit: ShellText.kindAudit
        case .decisions(_, let items): ShellText.kindDecisions(items.count)
        }
    }

    private var symbol: String {
        switch item {
        case .questions: ShellText.questionsSymbol
        case .specs: ShellText.specsSymbol
        case .verdict: ShellText.verdictSymbol
        case .alert: ShellText.alertSymbol
        case .audit: ShellText.auditSymbol
        case .decisions: ShellText.decisionsSymbol
        }
    }
}

/// Le corps d'un élément : la décision, avec ce qu'il faut pour la prendre.
struct InboxItemCard: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @Environment(\.consoleShell) private var shell
    let inbox: HarnessInbox
    let item: HarnessInboxItem

    var body: some View {
        switch item {
        case .questions(let batch):
            EscalationBatchCard(server: server, drafts: drafts, inbox: inbox, batch: batch)
                .disabled(!server.canAct)
        case .specs(let run):
            SpecsCard(server: server, drafts: drafts, inbox: inbox, run: run)
                .disabled(!server.canAct)
        case .verdict(let run):
            VerdictCard(server: server, drafts: drafts, inbox: inbox, run: run)
                .disabled(!server.canAct)
        case .alert(let alert):
            alertCard(alert)
        case .audit(let audit):
            auditCard(audit)
        case .decisions(let runId, let items):
            DecisionsCard(server: server, drafts: drafts, inbox: inbox, runId: runId, decisions: items)
                .disabled(!server.canAct)
        }
    }

    private func alertCard(_ alert: HarnessAlert) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(alert.line, systemImage: alert.symbol)
                .foregroundStyle(.orange)
                .consoleReadable()
            if let run = inbox.run(alert.runId) {
                Text(run.title)
                    .font(.headline)
            }
            OpenRunButton(drafts: drafts, runId: alert.runId)
        }
        .padding(.vertical, 4)
    }

    private func auditCard(_ audit: HarnessAudit) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(audit.focus.isEmpty ? PipelineServerText.wholeRepo : audit.focus)
                .font(.headline)
            Text(ShellText.auditProposals(audit.proposals.count))
                .foregroundStyle(.secondary)
            Button(ShellText.openAudit, systemImage: ShellText.auditSymbol) {
                ConsoleNavigation.open(.audits, drafts: drafts, select: shell.select)
            }
            .buttonStyle(.bordered)
            .consoleID("inbox.audit.open")
        }
        .padding(.vertical, 4)
    }
}

/// « Ouvrir la feature » : sa page, dans la section Features.
struct OpenRunButton: View {
    @ObservedObject var drafts: HarnessDrafts
    @Environment(\.consoleShell) private var shell
    let runId: String

    var body: some View {
        Button(ShellText.openRun, systemImage: ShellText.openRunSymbol) {
            ConsoleNavigation.openRun(runId, drafts: drafts, select: shell.select)
        }
        .buttonStyle(.bordered)
        .consoleID("inbox.openRun")
    }
}

// MARK: - À trancher

/// Un lot d'escalades : la place de la feature, puis chaque question avec sa situation
/// et l'impact de chaque option.
struct EscalationBatchCard: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let inbox: HarnessInbox
    let batch: HarnessEscalationBatch
    var showsOpen = true

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
        if showsOpen {
            OpenRunButton(drafts: drafts, runId: batch.id)
        }
    }
}

// MARK: - Specs à valider

struct SpecsCard: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let inbox: HarnessInbox
    let run: HarnessRun
    var showsOpen = true

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
        if showsOpen {
            OpenRunButton(drafts: drafts, runId: run.id)
        }
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
    var showsOpen = true

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
        if showsOpen {
            OpenRunButton(drafts: drafts, runId: run.id)
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
