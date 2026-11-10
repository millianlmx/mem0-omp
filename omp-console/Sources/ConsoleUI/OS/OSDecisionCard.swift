// L'« OS agentique » : une DÉCISION en carte, partagée par le Mac et l'iPhone/iPad. L'ordre
// est toujours le même : la sorte et le fil, LA PREUVE (vignettes avant/après, tests,
// ampleur et risque d'une revue ; première carte du briefing et raison de porte de specs ;
// enjeu d'une question), la phrase de décision, puis les gestes. Une question montre ses
// options avec leur conséquence, la recommandée en tête, et son échéance quand le serveur
// tranchera seul. Une porte se valide ou se corrige (« Corriger… », à la place d'un refus) ;
// « Toujours ainsi » fait d'une réponse ou d'une correction une consigne permanente ; le
// menu « … » écrit la règle de palier du type et arrête la feature avec son motif. « Lire »
// ouvre « Comprendre ». Chaque bouton est un vrai geste du serveur.

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct OSDecisionCard: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var intakes: HarnessIntakes
    @ObservedObject var workspace: OSWorkspace
    let decision: ConsoleClient.OSDecision
    /// Le tri : la carte est seule à l'écran, plus grande, et ⏎ prend le geste principal.
    let large: Bool
    let done: (() -> Void)?

    /// `large` : la carte du tri. `done` : appelé quand le geste a tranché la décision.
    public init(
        server: HarnessModel, workstation: WorkstationModel, intakes: HarnessIntakes, workspace: OSWorkspace,
        decision: ConsoleClient.OSDecision, large: Bool = false, done: (() -> Void)? = nil
    ) {
        self.server = server
        self.workstation = workstation
        self.intakes = intakes
        self.workspace = workspace
        self.decision = decision
        self.large = large
        self.done = done
    }

    @State private var choices: [Int: String] = [:]
    @State private var custom = ""
    /// « Autre… » : la réponse libre à une question.
    @State private var editing = false
    @State private var reason = ""
    /// « Corriger… » d'une porte, « Refuser… » d'un envoi du poste : le champ est ouvert.
    @State private var correcting = false
    @State private var always = false
    @State private var failure: HarnessFailure?
    @State private var working = false
    @State private var stopping: HarnessRun?
    @State private var ruleWritten = false

    public var body: some View {
        OSCard(tint: .orange, emphasized: true) {
            VStack(alignment: .leading, spacing: large ? 14 : 10) {
                // Sur l'iPhone et l'iPad, le menu « … » de la feature est au coin de la carte : la
                // rangée des gestes garde sa largeur.
                #if os(macOS)
                HStack(spacing: 6) {
                    Image(systemName: symbol)
                    Text(kind.uppercased())
                    if let context { Text("·"); Text(context).lineLimit(1) }
                }
                .font(.caption2.weight(.bold))
                .foregroundStyle(.orange)
                #else
                HStack(spacing: 6) {
                    Label {
                        Text([kind.uppercased(), context].compactMap { $0 }.joined(separator: " · "))
                    } icon: {
                        Image(systemName: symbol).accessibilityHidden(true)
                    }
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.orange)
                    Spacer(minLength: 0)
                    if let run = menuRun {
                        moreMenu(run, gestures: server.osGestures(run))
                    }
                }
                #endif
                content
                if let failure {
                    ConsoleFailureBanner(failure: failure)
                }
            }
            .disabled(working)
        }
        .osRunStop(server: server, run: $stopping) { done?() }
        .task { await server.osReadFeatures() }
    }

    // MARK: En-tête

    /// La sorte de décision, en tête de la carte.
    private var kind: String {
        switch decision {
        case .questions: OSText.kindQuestion
        case .specs: OSText.kindSpecs
        case .verdict: OSText.kindVerdict
        case .approval: OSText.kindSend
        case let .intake(intake): intake.isClarifying ? OSText.kindClarify : OSText.kindPlan
        case .audit: OSText.kindProposals
        case .jira: OSText.kindJira
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
        case .jira: "text.bubble.fill"
        }
    }

    /// Le fil d'où vient la décision, quand la carte est vue hors de son fil (le tri).
    private var context: String? {
        guard large else { return nil }
        switch decision {
        case let .questions(batch): return batch.run.map { OSThreads.clean($0.title).title }
        case let .specs(run), let .verdict(run): return OSThreads.clean(run.title).title
        case let .audit(audit): return audit.repo
        case let .jira(write): return write.issueKey
        default: return nil
        }
    }

    /// La feature dont le menu « … » règle le palier ou l'arrête : celle de la question,
    /// des specs ou de la revue.
    private var menuRun: HarnessRun? {
        switch decision {
        case let .questions(batch): batch.run
        case let .specs(run), let .verdict(run): run
        default: nil
        }
    }

    private var headlineFont: Font { large ? .title3.weight(.semibold) : .headline }

    // MARK: Contenu

    @ViewBuilder
    private var content: some View {
        switch decision {
        case let .questions(batch): questions(batch)
        case let .specs(run): gate(run, primary: OSText.validate)
        case let .verdict(run): gate(run, primary: OSText.merge)
        case let .approval(action): approval(action)
        case let .intake(intake): intakeCard(intake)
        case let .audit(audit): auditCard(audit)
        case let .jira(write): jiraCard(write)
        }
    }

    // MARK: Questions

    // L'enjeu, la question, ses options (la recommandée en tête, chacune avec ce qu'elle
    // emporte), l'échéance, puis le geste qui prend l'option choisie.
    @ViewBuilder
    private func questions(_ batch: HarnessEscalationBatch) -> some View {
        let gestures = batch.run.map(server.osGestures) ?? OSRunGestures()
        ForEach(batch.items) { item in
            VStack(alignment: .leading, spacing: 6) {
                if let stake = item.card?.stake, !stake.isEmpty {
                    Text(stake).font(.callout).foregroundStyle(.secondary)
                }
                Text(item.card?.headline ?? OSThreads.firstLine(item.question))
                    .font(headlineFont)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(OSChoices.ordered(item.choices)) { choice in
                    choiceRow(item: item, choice: choice)
                }
                deadline(item, run: batch.run, gestures: gestures)
            }
        }
        if editing {
            TextField(OSText.other, text: $custom, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
        }
        OSLine(spacing: 8) {
            if editing, let item = batch.items.first {
                Button(OSText.answer) { answer(batch, with: [item.id: custom]) }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(large ? .defaultAction : nil)
                    .disabled(custom.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !batch.acceptsAnswers)
                Button(OSText.cancel) { editing = false }
            } else {
                let chosen = chosen(batch)
                Button {
                    answer(batch, with: chosen)
                } label: {
                    Label(primaryLabel(batch, chosen: chosen), systemImage: "checkmark")
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(large ? .defaultAction : nil)
                .disabled(!batch.acceptsAnswers || chosen.values.contains(where: \.isEmpty))
                if batch.items.count == 1 {
                    Button(OSText.other) { editing = true }
                        .disabled(!batch.acceptsAnswers)
                }
            }
            if gestures.always {
                OSCheckbox(label: OSDecideText.always, isOn: $always)
            }
            Spacer()
            readButton(batch.id)
            #if os(macOS)
            moreMenu(batch.run, gestures: gestures)
            #endif
        }
        if !batch.acceptsAnswers {
            Label(OSText.waitsStep, systemImage: "hourglass").font(.caption).foregroundStyle(.secondary)
        }
    }

    /// La réponse à chaque question : l'option choisie, sinon la recommandée, sinon la première.
    private func chosen(_ batch: HarnessEscalationBatch) -> [Int: String] {
        var answers: [Int: String] = [:]
        for item in batch.items { answers[item.id] = choices[item.id] ?? item.recommended ?? item.options.first ?? "" }
        return answers
    }

    /// « Prendre « Garder le cache » » pour une question seule dont l'option tient sur un bouton.
    private func primaryLabel(_ batch: HarnessEscalationBatch, chosen: [Int: String]) -> String {
        guard batch.items.count == 1, let option = chosen.values.first, !option.isEmpty, option.count <= 32 else { return OSText.answer }
        return OSText.take(option)
    }

    /// Une option en carte : la choisie prend la teinte de l'accent et montre sa conséquence ; la
    /// recommandée porte une étoile verte. Les autres gardent leur conséquence en infobulle.
    private func choiceRow(item: HarnessEscalation, choice: HarnessChoice) -> some View {
        let selected = (choices[item.id] ?? item.recommended) == choice.option
        return Button {
            choices[item.id] = choice.option
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(selected ? Color.accentColor : .secondary)
                    Text(choice.option).fontWeight(selected || choice.isPreferred ? .semibold : .regular)
                    if choice.isPreferred {
                        Image(systemName: "star.fill")
                            .font(.caption)
                            .foregroundStyle(.green)
                            .help(OSText.recommended)
                            .accessibilityLabel(OSText.recommended)
                    }
                    Spacer(minLength: 0)
                }
                if selected, let impact = choice.impact, !impact.isEmpty {
                    Text(impact)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(large ? 3 : 2)
                        .padding(.leading, 26)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, minHeight: ConsolePlatform.minimumTarget, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(selected ? Color.accentColor.opacity(0.12) : Color.primary.opacity(0.04)))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(selected ? Color.accentColor.opacity(0.6) : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(selected ? "" : choice.impact ?? "")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// L'échéance : un anneau qui se vide et le temps qu'il reste. « Attendre ma réponse » passe la
    /// feature en « tout me demander » (plus rien ne s'applique seul) ; la phrase entière est en infobulle.
    @ViewBuilder
    private func deadline(_ item: HarnessEscalation, run: HarnessRun?, gestures: OSRunGestures) -> some View {
        if item.autoDate != nil {
            TimelineView(.periodic(from: .now, by: 1)) { timeline in
                if let deadline = OSDeadline.of(item, now: timeline.date) {
                    let sentence = OSDecideText.deadline(option: deadline.option, seconds: deadline.seconds)
                    OSLine(spacing: 10, gestures: false) {
                        OSCountdown(seconds: deadline.seconds, tint: .orange)
                            .help(sentence)
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel(sentence)
                        if gestures.autonomy, let run {
                            Button {
                                perform(settles: false) { await server.setAutonomy(runId: run.id, level: .ask) }
                            } label: {
                                Label(OSDecideText.waitForMe, systemImage: "hand.raised.fill").labelStyle(.iconOnly)
                            }
                            .osBorderless()
                            .help(OSDecideText.waitForMe)
                        }
                    }
                }
            }
        }
    }

    // MARK: Specs et revue

    // La preuve, la phrase, puis : valider (ou fusionner), corriger, et le menu « … ».
    @ViewBuilder
    private func gate(_ run: HarnessRun, primary: String) -> some View {
        let gestures = server.osGestures(run)
        if run.awaitsSpecs {
            specsProof(run)
        } else {
            OSDecideReviewProof(server: server, run: run, large: large)
        }
        Text(run.awaitsSpecs ? specsHeadline(run) : verdictHeadline(run))
            .font(headlineFont)
            .lineLimit(large ? 4 : 2)
        if correcting {
            TextField(OSDecideText.amendPrompt, text: $reason, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
        }
        OSLine(spacing: 8) {
            if correcting {
                Button(OSDecideText.amendNow) {
                    perform { await server.osAmend(run, text: reason, always: always) }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(large ? .defaultAction : nil)
                .disabled(reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button(OSText.cancel) { correcting = false }
                if gestures.always {
                    OSCheckbox(label: OSDecideText.always, isOn: $always)
                }
            } else {
                Button {
                    perform { await server.validate(runId: run.id, approve: true, reason: "") }
                } label: {
                    Label(primary, systemImage: "checkmark")
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(large ? .defaultAction : nil)
                .disabled(!server.canAct)
                if gestures.amend {
                    Button(OSDecideText.amend) { correcting = true }
                }
            }
            Spacer()
            readButton(run.id)
            #if os(macOS)
            moreMenu(run, gestures: gestures)
            #endif
        }
    }

    /// La première carte du briefing (le point qui demande un regard) et la raison de la porte.
    @ViewBuilder
    private func specsProof(_ run: HarnessRun) -> some View {
        if let card = run.briefing?.cards.first {
            VStack(alignment: .leading, spacing: 3) {
                Text(card.headline).font(.callout.weight(.semibold))
                if !card.stake.isEmpty {
                    Text(card.stake).font(.callout).foregroundStyle(.secondary)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
        }
        if let reason = run.reason, !reason.isEmpty {
            Label(OSThreads.firstLine(reason), systemImage: "flag")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
    }

    private func specsHeadline(_ run: HarnessRun) -> String {
        let feature = run.briefing?.feature.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return feature.isEmpty ? OSText.specsReady : OSThreads.firstLine(feature)
    }

    private func verdictHeadline(_ run: HarnessRun) -> String {
        run.verdict.map { OSThreads.firstLine($0.summary) } ?? OSThreads.clean(run.title).title
    }

    /// Le menu « … » : la règle de palier du type (admin, feature typée) et l'arrêt motivé.
    @ViewBuilder
    private func moreMenu(_ run: HarnessRun?, gestures: OSRunGestures) -> some View {
        if let run, gestures.stop || gestures.rule != nil {
            Menu {
                if let rule = gestures.rule {
                    Button(
                        OSDecideText.alwaysAlone(kind: rule.kind.rawValue, repo: rule.repo),
                        systemImage: ruleWritten ? "checkmark" : "bolt.badge.checkmark"
                    ) {
                        write(rule)
                    }
                    .disabled(ruleWritten)
                }
                if gestures.stop {
                    Button(OSDecideText.stop, systemImage: "stop.circle", role: .destructive) { stopping = run }
                }
            } label: {
                Label(OSDecideText.more, systemImage: "ellipsis.circle")
                    .labelStyle(.iconOnly)
                    .frame(minWidth: ConsolePlatform.minimumTarget, minHeight: ConsolePlatform.minimumTarget)
            }
            .menuIndicator(.hidden)
            .buttonStyle(.borderless)
            .fixedSize()
        }
    }

    // MARK: Envoi du poste

    // Le message EN ENTIER, ses destinataires, approuver ou refuser.
    @ViewBuilder
    private func approval(_ action: WorkstationAction) -> some View {
        let shown = action.approval
        if let preview = shown?.preview, !preview.isEmpty {
            Text(preview)
                .font(.callout)
                .osSelectable()
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
        }
        Text(shown?.summary ?? action.kind)
            .font(headlineFont)
        Text(OSText.to(shown?.recipients ?? []))
            .font(.caption)
            .foregroundStyle(.secondary)
        if correcting {
            TextField(OSText.reason, text: $reason).textFieldStyle(.roundedBorder)
        }
        OSLine(spacing: 8) {
            if correcting {
                Button(OSText.refuseNow, role: .destructive) {
                    perform { await workstation.refuse(shown: action, reason: reason) }
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
                Button(OSText.cancel) { correcting = false }
            } else {
                Button {
                    perform { await workstation.approve(shown: action) }
                } label: {
                    Label(OSText.approve, systemImage: "paperplane")
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(large ? .defaultAction : nil)
                Button(OSText.refuse) { correcting = true }
            }
            Spacer()
        }
    }

    // MARK: Demande

    // Le plan à lancer, ou la question de l'OS.
    @ViewBuilder
    private func intakeCard(_ intake: HarnessIntake) -> some View {
        if intake.isClarifying {
            Text(intake.question ?? intake.text).font(headlineFont)
            TextField(OSText.answer, text: $custom, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
            OSLine {
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
            if let creates = plan.creates, !creates.isEmpty {
                Text(creates).font(.callout).foregroundStyle(.secondary).lineLimit(3)
            }
            Text(plan.title).font(headlineFont)
            OSLine {
                Button {
                    perform { (try? await intakes.confirm(intake)) != nil }
                } label: {
                    Label(OSText.launch, systemImage: "play.fill")
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(large ? .defaultAction : nil)
                Button(OSText.cancel) { perform { (try? await intakes.cancel(intake)) != nil } }
                Spacer()
            }
        }
    }

    // MARK: Commentaire Jira

    // Le texte EN ENTIER, la raison, envoyer ou écarter.
    @ViewBuilder
    private func jiraCard(_ write: AtlassianWrite) -> some View {
        Text(write.body)
            .font(.callout)
            .osSelectable()
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
        Text(write.issueKey + " · " + OSThreads.firstLine(write.why)).font(headlineFont).lineLimit(2)
        OSLine {
            Button {
                perform { await server.atlassian.approve(write.id) }
            } label: {
                Label(OSText.send, systemImage: "paperplane")
            }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut(large ? .defaultAction : nil)
            Button(OSText.dismiss) { perform { await server.atlassian.dismiss(write.id) } }
            Spacer()
        }
    }

    // MARK: Propositions d'audit

    @ViewBuilder
    private func auditCard(_ audit: HarnessAudit) -> some View {
        ForEach(Array(audit.proposals.prefix(large ? 8 : 3).enumerated()), id: \.offset) { _, proposal in
            Label(proposal.title, systemImage: proposal.isWeakness ? "exclamationmark.triangle" : "plus.circle")
                .font(.callout)
                .lineLimit(1)
        }
        Text(audit.focus.isEmpty ? audit.repo : OSThreads.firstLine(audit.focus)).font(headlineFont)
        OSLine {
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
        .osBorderless()
    }

    // MARK: Gestes

    private func answer(_ batch: HarnessEscalationBatch, with answers: [Int: String]) {
        perform { await server.answer(runId: batch.id, answers: answers, always: always ? Set(answers.keys) : []) }
    }

    /// « Toujours valider seul … » : la règle est écrite, la décision en cours reste à prendre.
    private func write(_ rule: OSAlwaysRule) {
        working = true
        Task {
            ruleWritten = await server.autonomy.setRule(repo: rule.repo, kind: rule.kind, gate: rule.gate, mode: .auto)
            failure = ruleWritten ? nil : server.autonomy.failure
            working = false
        }
    }

    /// `settles` : le geste tranche la décision (la carte s'efface, le tri avance).
    private func perform(settles: Bool = true, _ gesture: @escaping @MainActor () async -> Bool) {
        working = true
        failure = nil
        Task {
            let ok = await gesture()
            working = false
            failure = ok ? nil : server.failure ?? workstation.failure
            if ok, settles {
                editing = false
                correcting = false
                done?()
            }
        }
    }
}

/// Une case à cocher avec son mot, la même sur le Mac et l'iPhone/iPad.
struct OSCheckbox: View {
    let label: String
    @Binding var isOn: Bool

    var body: some View {
        Button {
            isOn.toggle()
        } label: {
            HStack(spacing: 5) {
                Image(systemName: isOn ? "checkmark.square.fill" : "square")
                    .foregroundStyle(isOn ? Color.accentColor : .secondary)
                Text(label)
            }
            .frame(minHeight: ConsolePlatform.minimumTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}
