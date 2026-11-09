// PROTOTYPE « OS agentique » (branche proto/os-fils) : une DÉCISION en carte compacte.
// L'en-tête tient en une ligne, l'option recommandée est le bouton principal (⏎ dans
// le tri), le reste se déplie à la demande ; « Lire » ouvre « Comprendre » au niveau
// Résumé, où vivent les cartes complètes existantes. Chaque bouton est un vrai geste
// du serveur.

import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

struct OSDecisionCard: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var intakes: HarnessIntakes
    @ObservedObject var workspace: OSWorkspace
    let decision: OSDecision
    /// Le tri : la carte est seule à l'écran, plus grande, et ⏎ prend le geste principal.
    var large = false
    var done: (() -> Void)?

    @State private var choices: [Int: String] = [:]
    @State private var custom = ""
    @State private var editing = false
    @State private var reason = ""
    @State private var refusing = false
    @State private var failed = false
    @State private var working = false

    var body: some View {
        OSCard(tint: .orange, emphasized: true) {
            VStack(alignment: .leading, spacing: large ? 14 : 10) {
                HStack(spacing: 6) {
                    Image(systemName: symbol)
                    Text(kind.uppercased())
                    if let context { Text("·"); Text(context).lineLimit(1) }
                }
                .font(.caption2.weight(.bold))
                .foregroundStyle(.orange)
                content
                if failed {
                    if let failure = server.failure ?? workstation.failure {
                        ConsoleFailureBanner(failure: failure)
                    }
                }
            }
            .disabled(working)
        }
    }

    // MARK: En-tête

    private var kind: String {
        switch decision {
        case .questions: OSText.question
        case .specs: OSText.specs
        case .verdict: OSText.verdict
        case .approval: OSText.send
        case let .intake(intake): intake.isClarifying ? OSText.clarify : OSText.plan
        case .audit: OSText.proposals
        }
    }

    private var symbol: String {
        switch decision {
        case .questions: "questionmark.bubble.fill"
        case .specs: "doc.text.fill"
        case .verdict: "checkmark.seal.fill"
        case .approval: "paperplane.fill"
        case .intake: "sparkles"
        case .audit: "list.bullet.rectangle"
        }
    }

    /// Le fil d'où vient la décision, quand la carte est vue hors de son fil (le tri).
    private var context: String? {
        guard large else { return nil }
        switch decision {
        case let .questions(batch): return batch.run.map { OSThreads.clean($0.title).title }
        case let .specs(run), let .verdict(run): return OSThreads.clean(run.title).title
        case let .audit(audit): return audit.repo
        default: return nil
        }
    }

    private var headlineFont: Font { large ? .title3.weight(.semibold) : .headline }

    // MARK: Contenu

    @ViewBuilder
    private var content: some View {
        switch decision {
        case let .questions(batch): questions(batch)
        case let .specs(run): gate(run, headline: specsHeadline(run), detail: run.briefing?.cards.first?.headline, primary: OSText.validate)
        case let .verdict(run): gate(run, headline: verdictHeadline(run), detail: run.verdict.map { OSText.risk($0) }, primary: OSText.merge)
        case let .approval(action): approval(action)
        case let .intake(intake): intakeCard(intake)
        case let .audit(audit): auditCard(audit)
        }
    }

    private func specsHeadline(_ run: HarnessRun) -> String {
        let feature = run.briefing?.feature.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return feature.isEmpty ? OSText.specsReady : OSThreads.firstLine(feature)
    }

    private func verdictHeadline(_ run: HarnessRun) -> String {
        run.verdict.map { OSThreads.firstLine($0.summary) } ?? OSThreads.clean(run.title).title
    }

    // Questions : la recommandation d'abord, les autres options en menu, « Autre… » en champ.
    @ViewBuilder
    private func questions(_ batch: HarnessEscalationBatch) -> some View {
        ForEach(batch.items) { item in
            VStack(alignment: .leading, spacing: 6) {
                Text(item.card?.headline ?? OSThreads.firstLine(item.question))
                    .font(headlineFont)
                    .fixedSize(horizontal: false, vertical: true)
                if let stake = item.card?.stake, !stake.isEmpty {
                    Text(stake).font(.callout).foregroundStyle(.secondary)
                }
                if large || batch.items.count > 1 {
                    ForEach(item.choices) { choice in
                        choiceRow(item: item, choice: choice)
                    }
                }
            }
        }
        if editing {
            TextField(OSText.other, text: $custom, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
        }
        HStack(spacing: 8) {
            if batch.items.count == 1, let item = batch.items.first, !editing {
                // En grand, les options sont montrées : le geste prend celle qui est choisie.
                let recommended = (large ? choices[item.id] : nil) ?? item.recommended ?? item.options.first ?? ""
                Button {
                    answer(batch, with: [item.id: recommended])
                } label: {
                    Label(OSText.take + " « " + recommended + " »", systemImage: "checkmark")
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(large ? .defaultAction : nil)
                .disabled(recommended.isEmpty || !batch.acceptsAnswers)
                if item.options.count > 1, !large {
                    Menu(OSText.answer) {
                        ForEach(item.options.filter { $0 != recommended }, id: \.self) { option in
                            Button(option) { answer(batch, with: [item.id: option]) }
                        }
                    }
                    .fixedSize()
                    .disabled(!batch.acceptsAnswers)
                }
                Button(OSText.other) { editing = true }
                    .disabled(!batch.acceptsAnswers)
            } else if editing, let item = batch.items.first {
                Button(OSText.answer) { answer(batch, with: [item.id: custom]) }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(large ? .defaultAction : nil)
                    .disabled(custom.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button(OSText.cancel) { editing = false }
            } else {
                Button(OSText.answer) {
                    var answers: [Int: String] = [:]
                    for item in batch.items { answers[item.id] = choices[item.id] ?? item.recommended ?? item.options.first ?? "" }
                    answer(batch, with: answers)
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(large ? .defaultAction : nil)
                .disabled(!batch.acceptsAnswers)
            }
            Spacer()
            readButton(batch.id)
        }
        if !batch.acceptsAnswers {
            Label(OSText.waitsStep, systemImage: "hourglass").font(.caption).foregroundStyle(.secondary)
        }
    }

    private func choiceRow(item: HarnessEscalation, choice: HarnessChoice) -> some View {
        let selected = (choices[item.id] ?? item.recommended) == choice.option
        return Button {
            choices[item.id] = choice.option
        } label: {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(selected ? Color.accentColor : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(choice.option).fontWeight(choice.isPreferred ? .semibold : .regular)
                        if choice.isPreferred { OSTag(text: "recommandé", tint: .green) }
                    }
                    if let impact = choice.impact, !impact.isEmpty {
                        Text(impact).font(.caption).foregroundStyle(.secondary).lineLimit(large ? 3 : 1)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // Specs et revue : valider, refuser avec une raison, lire.
    @ViewBuilder
    private func gate(_ run: HarnessRun, headline: String, detail: String?, primary: String) -> some View {
        Text(headline)
            .font(headlineFont)
            .lineLimit(large ? 4 : 2)
        if let detail, !detail.isEmpty {
            Text(detail).font(.callout).foregroundStyle(.secondary).lineLimit(2)
        }
        if refusing {
            TextField(OSText.reason, text: $reason, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
        }
        HStack(spacing: 8) {
            if refusing {
                Button(OSText.refuseNow, role: .destructive) {
                    perform { await server.validate(runId: run.id, approve: false, reason: reason) }
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
                .disabled(reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button(OSText.cancel) { refusing = false }
            } else {
                Button {
                    perform { await server.validate(runId: run.id, approve: true, reason: "") }
                } label: {
                    Label(primary, systemImage: "checkmark")
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(large ? .defaultAction : nil)
                Button(OSText.refuse) { refusing = true }
            }
            Spacer()
            readButton(run.id)
        }
    }

    // L'envoi du poste : le message EN ENTIER, ses destinataires, approuver ou refuser.
    @ViewBuilder
    private func approval(_ action: WorkstationAction) -> some View {
        let shown = action.approval
        Text(shown?.summary ?? action.kind)
            .font(headlineFont)
        Text(OSText.to(shown?.recipients ?? []))
            .font(.caption)
            .foregroundStyle(.secondary)
        if let preview = shown?.preview, !preview.isEmpty {
            Text(preview)
                .font(.callout)
                .textSelection(.enabled)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
        }
        if refusing {
            TextField(OSText.reason, text: $reason).textFieldStyle(.roundedBorder)
        }
        HStack(spacing: 8) {
            if refusing {
                Button(OSText.refuseNow, role: .destructive) {
                    perform { await workstation.refuse(shown: action, reason: reason) }
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
                Button(OSText.cancel) { refusing = false }
            } else {
                Button {
                    perform { await workstation.approve(shown: action) }
                } label: {
                    Label(OSText.approve, systemImage: "paperplane")
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(large ? .defaultAction : nil)
                Button(OSText.refuse) { refusing = true }
            }
            Spacer()
        }
    }

    // La Demande : le plan à lancer, ou la question de l'OS.
    @ViewBuilder
    private func intakeCard(_ intake: HarnessIntake) -> some View {
        if intake.isClarifying {
            Text(intake.question ?? intake.text).font(headlineFont)
            TextField(OSText.answer, text: $custom, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
            HStack {
                Button(OSText.answer) {
                    perform { (try? await intakes.answer(intake, text: custom)) != nil }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(large ? .defaultAction : nil)
                .disabled(custom.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button(OSText.cancel) { perform { (try? await intakes.cancel(intake)) != nil } }
                Spacer()
            }
        } else if let plan = intake.plan {
            Text(plan.title).font(headlineFont)
            if let creates = plan.creates, !creates.isEmpty {
                Text(creates).font(.callout).foregroundStyle(.secondary).lineLimit(3)
            }
            HStack {
                Button {
                    perform { (try? await intakes.confirm(intake)) != nil }
                } label: {
                    Label(OSText.confirm, systemImage: "play.fill")
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(large ? .defaultAction : nil)
                Button(OSText.cancel) { perform { (try? await intakes.cancel(intake)) != nil } }
                Spacer()
            }
        }
    }

    @ViewBuilder
    private func auditCard(_ audit: HarnessAudit) -> some View {
        Text(audit.focus.isEmpty ? audit.repo : OSThreads.firstLine(audit.focus)).font(headlineFont)
        ForEach(Array(audit.proposals.prefix(large ? 8 : 3).enumerated()), id: \.offset) { _, proposal in
            Label(proposal.title, systemImage: proposal.isWeakness ? "exclamationmark.triangle" : "plus.circle")
                .font(.callout)
                .lineLimit(1)
        }
        HStack {
            Button {
                perform {
                    await server.launchProposals(auditId: audit.id, items: Array(audit.proposals.indices), title: audit.focus.isEmpty ? audit.repo : audit.focus) != nil
                }
            } label: {
                Label(OSText.launchAll, systemImage: "play.fill")
            }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut(large ? .defaultAction : nil)
            Spacer()
        }
    }

    private func readButton(_ runId: String) -> some View {
        Button {
            workspace.understand(runId: runId, level: .summary)
        } label: {
            Label(OSText.read, systemImage: "text.magnifyingglass")
        }
        .buttonStyle(.borderless)
    }

    // MARK: Gestes

    private func answer(_ batch: HarnessEscalationBatch, with answers: [Int: String]) {
        perform { await server.answer(runId: batch.id, answers: answers) }
    }

    private func perform(_ gesture: @escaping @MainActor () async -> Bool) {
        working = true
        failed = false
        Task {
            let ok = await gesture()
            working = false
            failed = !ok
            if ok {
                editing = false
                refusing = false
                done?()
            }
        }
    }
}
