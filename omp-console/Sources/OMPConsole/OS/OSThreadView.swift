// PROTOTYPE « OS agentique » (branche proto/os-fils) : la page d'un FIL. Pas
// d'onglets : un récit en cartes, de l'origine au résultat — ce qui l'a ouvert, le
// plan quand il a plusieurs tâches, l'agent au travail (son pouls), ce qui vous attend,
// ce que l'agent a décidé seul, le résultat. En pied, une seule zone : une consigne
// à l'agent qui travaille, sinon une demande de suite à l'OS.

import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

struct OSThreadView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var intakes: HarnessIntakes
    @ObservedObject var pulse: OSPulse
    @ObservedObject var workspace: OSWorkspace
    let thread: OSThread
    /// Le nom de chaque navigateur du poste, par identifiant.
    let browsers: [String: String]

    @State private var draft = ""
    @State private var sending = false
    @State private var sent: String?
    @State private var reportExpanded = false

    private var inbox: HarnessInbox? { server.inbox }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    header
                    originCard
                    if thread.runs.count > 1 { planCard }
                    if thread.requests.count > 1 { attemptsCard }
                    if let request = thread.request { requestCards(request) }
                    if let audit = thread.audit, thread.runs.isEmpty { auditCard(audit) }
                    ForEach(thread.liveRuns) { run in
                        runCards(run)
                    }
                    if thread.liveRuns.isEmpty {
                        let merged = thread.runs.filter { $0.phase == .merged }
                        ForEach(merged.isEmpty ? Array(thread.runs.suffix(1)) : merged) { run in
                            runCards(run)
                        }
                    }
                }
                .frame(maxWidth: 760, alignment: .leading)
                .padding(24)
                .frame(maxWidth: .infinity)
            }
            if !thread.runs.isEmpty || thread.request != nil {
                Divider()
                composer
                    .padding(.horizontal, 24)
                    .padding(.vertical, 12)
            }
        }
    }

    // MARK: En-tête et origine

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                OSPhaseMark(phase: thread.phase, size: 18)
                Text(thread.title)
                    .font(.title2.weight(.bold))
                    .textSelection(.enabled)
            }
            HStack(spacing: 8) {
                OSTag(text: OSText.origin(thread.origin), symbol: OSText.originSymbol(thread.origin))
                OSTag(text: OSText.state(thread.phase), tint: thread.phase.color)
                if thread.cost > 0 {
                    OSTag(text: thread.cost.formatted(.currency(code: "USD")), symbol: "dollarsign.circle")
                }
                Text(thread.createdAt.osDate.formatted(.relative(presentation: .named)))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            // OÙ et SUR QUOI : la machine, le dépôt, la branche, l'étape, le modèle ; ou le navigateur.
            if let run = thread.focusRun {
                OSPlace(subject: .run(run))
            } else if let request = thread.request {
                OSPlace(subject: .request(request, browser: request.browserId.flatMap { browsers[$0] }))
            }
        }
    }

    /// Ce qui a ouvert le fil, en une ligne : la phrase de l'humain quand on l'a.
    @ViewBuilder
    private var originCard: some View {
        if let intake = thread.intake {
            quote(intake.text, who: OSText.origin(.person(intake.by)))
        } else if let request = thread.request {
            quote(request.instruction, who: OSText.origin(.person(request.by)))
        } else if let first = thread.runs.first, !first.request.isEmpty {
            DisclosureGroup {
                ConsoleMarkdown(markdown: first.request)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 6)
            } label: {
                Label(OSThreads.gist(first.request), systemImage: OSText.originSymbol(thread.origin))
                    .lineLimit(1)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func quote(_ text: String, who: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "person.crop.circle.fill")
                .font(.title2)
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                Text(who).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text(text).textSelection(.enabled)
            }
        }
    }

    // MARK: Plan

    private var planCard: some View {
        OSCard {
            VStack(alignment: .leading, spacing: 8) {
                Text(OSText.tasks(thread.runs.count).uppercased())
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
                ForEach(Array(thread.runs.enumerated()), id: \.element.id) { index, run in
                    Button {
                        workspace.understand(runId: run.id, level: .summary)
                    } label: {
                        HStack(spacing: 8) {
                            OSPhaseMark(phase: OSThreads.phase(of: run, inbox: inbox), size: 11)
                            Text(taskTitle(run, index: index))
                                .lineLimit(1)
                                .foregroundStyle(run.phase == .cancelled ? .secondary : .primary)
                            Spacer()
                            Text(OSText.runState(run)).font(.caption).foregroundStyle(.secondary)
                            Text(run.updatedAt.osDate.formatted(.relative(presentation: .named)))
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                                .frame(width: 110, alignment: .trailing)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    /// Les tentatives d'une même demande au poste : une ligne chacune, la raison d'un échec en clair.
    private var attemptsCard: some View {
        OSCard {
            VStack(alignment: .leading, spacing: 8) {
                Text(OSText.tasks(thread.requests.count).uppercased())
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
                ForEach(Array(thread.requests.enumerated()), id: \.element.id) { index, request in
                    let phase = OSThreads.phase(of: request)
                    HStack(spacing: 8) {
                        OSPhaseMark(phase: phase, size: 11)
                        Text(OSText.attempt(index + 1))
                        if let reason = request.reason, !reason.isEmpty, phase != .done {
                            Text(OSThreads.firstLine(reason)).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        Text(OSText.state(phase)).font(.caption).foregroundStyle(.secondary)
                        Text(request.updatedAt.osDate.formatted(date: .omitted, time: .shortened))
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        }
    }

    /// Le titre d'une tâche : le sien s'il dit autre chose que le fil, sinon son issue ou son rang.
    private func taskTitle(_ run: HarnessRun, index: Int) -> String {
        let clean = OSThreads.clean(run.title)
        if clean.title.lowercased() != thread.title.lowercased() { return clean.title }
        if let issue = clean.issue { return "Issue #\(issue)" }
        return OSText.attempt(index + 1)
    }

    // MARK: Une feature

    @ViewBuilder
    private func runCards(_ run: HarnessRun) -> some View {
        let phase = OSThreads.phase(of: run, inbox: inbox)
        if phase == .working || phase == .queued {
            liveCard(run, phase: phase)
        }
        ForEach(OSDecision.of(runId: run.id, server: server)) { decision in
            OSDecisionCard(server: server, workstation: workstation, intakes: intakes, workspace: workspace, decision: decision)
        }
        autonomousCards(run)
        if [.merged, .failed, .cancelled].contains(run.phase) {
            resultCard(run)
        }
    }

    private func liveCard(_ run: HarnessRun, phase: OSPhase) -> some View {
        TimelineView(.periodic(from: .now, by: 5)) { context in
            OSCard(tint: .accentColor, emphasized: phase == .working) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        OSPhaseMark(phase: phase, size: 14)
                        Text(run.repo + " · " + OSText.runState(run))
                            .font(.headline)
                        Spacer()
                        OSStepDots(run: run)
                    }
                    if let activity = pulse.current(.run(run.id), now: context.date) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("↳")
                            Text(activity.line)
                            if let tool = activity.tool {
                                Text(tool).font(.caption.monospaced()).foregroundStyle(.tertiary)
                            }
                        }
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    } else if let reason = run.reason, !reason.isEmpty {
                        Text("↳ " + OSThreads.firstLine(reason)).foregroundStyle(.secondary).lineLimit(2)
                    }
                    HStack {
                        Text(run.createdAt.osDate.formatted(.relative(presentation: .named)))
                        if run.fixes > 0 { Text("· " + OSText.fixes(run.fixes)) }
                        if let cost = inbox?.costs[run.id], cost > 0 { Text("· " + cost.formatted(.currency(code: "USD"))) }
                        Spacer()
                        Button(OSText.understand + " ›") { workspace.understand(runId: run.id, level: .raw) }
                            .buttonStyle(.borderless)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }
        }
    }

    /// Ce que l'agent a tranché seul : une ligne par décision, la garder ou la revoir.
    @ViewBuilder
    private func autonomousCards(_ run: HarnessRun) -> some View {
        let decisions = inbox?.decisions.filter { $0.runId == run.id } ?? []
        if !decisions.isEmpty {
            OSCard(tint: .purple, emphasized: true) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(OSText.autonomous.uppercased())
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.purple)
                    ForEach(decisions) { decision in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: "diamond.fill").foregroundStyle(.purple).font(.caption)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(decision.chosen).fontWeight(.semibold)
                                Text(OSThreads.firstLine(decision.question)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer()
                            Button(OSText.accept) { Task { await server.accept(runId: run.id, seq: decision.seq) } }
                            Button(OSText.revisit) { workspace.understand(runId: run.id, level: .summary) }
                        }
                    }
                }
            }
        }
    }

    private func resultCard(_ run: HarnessRun) -> some View {
        let merged = run.phase == .merged
        let tint: Color = merged ? .green : run.phase == .failed ? .red : .secondary
        return OSCard(tint: tint, emphasized: merged) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    OSPhaseMark(phase: OSThreads.phase(of: run, inbox: nil), size: 14)
                    Text(merged ? OSText.merged : OSText.runState(run).capitalized)
                        .font(.headline)
                    if let verdict = run.verdict { OSTag(text: OSText.risk(verdict), tint: verdict.isLowRisk ? .green : .orange) }
                    if run.fixes > 0 { OSTag(text: OSText.fixes(run.fixes)) }
                    Spacer()
                    if let pr = run.prUrl, let url = URL(string: pr) {
                        Link(destination: url) { Label(OSText.openPR, systemImage: "arrow.up.right.square") }
                    }
                    Button(OSText.understand + " ›") { workspace.understand(runId: run.id, level: .summary) }
                        .buttonStyle(.borderless)
                }
                if let summary = run.verdict?.summary, merged {
                    Text(OSThreads.firstLine(summary)).foregroundStyle(.secondary).lineLimit(2)
                } else if let reason = run.reason, !reason.isEmpty {
                    Text(OSThreads.firstLine(reason)).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        }
    }

    // MARK: Le poste

    @ViewBuilder
    private func requestCards(_ request: WorkstationRequest) -> some View {
        let phase = OSThreads.phase(of: request)
        if phase.isLive {
            TimelineView(.periodic(from: .now, by: 5)) { context in
                OSCard(tint: .accentColor, emphasized: true) {
                    HStack(spacing: 8) {
                        OSPhaseMark(phase: phase, size: 14)
                        Text(OSText.poste).font(.headline)
                        Text("↳ " + (pulse.workstation(now: context.date)?.activity.line ?? OSText.state(phase)))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
            }
        }
        if let report = request.report, !report.isEmpty {
            OSCard(tint: phase.color, emphasized: phase == .done) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        OSPhaseMark(phase: phase, size: 14)
                        Text(OSText.reportTitle).font(.headline)
                        Spacer()
                        Button(reportExpanded ? OSText.less : OSText.readAll) { reportExpanded.toggle() }
                            .buttonStyle(.borderless)
                    }
                    if reportExpanded {
                        ConsoleMarkdown(markdown: report)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    } else {
                        Text(MarkdownDocument.inline(OSThreads.preview(report, lines: 4)))
                            .lineLimit(5)
                    }
                }
            }
        } else if let reason = request.reason, !reason.isEmpty, !phase.isLive {
            OSCard(tint: phase.color) {
                Label(OSThreads.firstLine(reason), systemImage: phase.symbol).foregroundStyle(.secondary)
            }
        }
    }

    // MARK: Un audit

    private func auditCard(_ audit: HarnessAudit) -> some View {
        Group {
            if audit.isProposed, let inbox, inbox.auditsProposed.contains(where: { $0.id == audit.id }) {
                OSDecisionCard(server: server, workstation: workstation, intakes: intakes, workspace: workspace, decision: .audit(audit))
            } else {
                OSCard(tint: .accentColor, emphasized: true) {
                    HStack(spacing: 8) {
                        OSPhaseMark(phase: .working, size: 14)
                        Text(OSText.origin(.audit(audit.focus))).font(.headline)
                        Text("↳ " + (pulse.current(.audit(audit.id))?.line ?? audit.state)).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
            }
        }
    }

    // MARK: Pied

    private var target: HarnessRun? {
        thread.runs.last { $0.acceptsInstructions }
    }

    private var composer: some View {
        HStack(spacing: 8) {
            Image(systemName: target == nil ? "sparkles" : "text.bubble")
                .foregroundStyle(Color.accentColor)
            TextField(target == nil ? OSText.followUp : OSText.reply, text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .onSubmit(send)
                .disabled(sending || !server.canAct)
            if sending { ProgressView().controlSize(.small) }
            if let sent { Text(sent).font(.caption).foregroundStyle(.secondary) }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.05)))
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        sending = true
        Task {
            if let run = target {
                if await server.instruct(runId: run.id, text: text) != nil {
                    draft = ""
                    sent = "✓"
                }
            } else {
                let ask = "Suite de « \(thread.title) » : \(text)"
                if (try? await intakes.submit(text: ask, source: "console", repo: thread.repo)) != nil {
                    draft = ""
                    sent = "✓"
                }
            }
            sending = false
        }
    }
}
