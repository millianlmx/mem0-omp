// L'« OS agentique » : une DÉCISION en carte, partagée par le Mac et l'iPhone/iPad. L'ordre
// est toujours le même : POUR QUI l'on tranche (« ● Client Acme · acme-web · Revue » : la
// pastille de l'espace, le dépôt, la sorte), LA PREUVE (vignettes avant/après, tests,
// ampleur et risque d'une revue ; première carte du briefing de specs ; enjeu d'une
// question), POURQUOI on vous demande (une phrase de l'app tirée du code de la porte),
// puis les gestes. Une question montre ses options avec leur conséquence, la recommandée
// en tête, et son échéance quand le serveur tranchera seul. Une porte se valide ou se
// corrige ; une tâche arrêtée par ses échecs se relance ; « Toujours ainsi » fait d'une
// réponse ou d'une correction une consigne permanente ; le menu « … » règle l'autonomie,
// écrit la règle de palier du type et arrête la tâche avec son motif. « Comprendre » est
// le seul accès au détail. Chaque bouton est un vrai geste du serveur ; aucune phrase du
// serveur ni résumé de l'agent n'est montré.

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct OSDecisionCard: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var intakes: HarnessIntakes
    @ObservedObject var workspace: OSWorkspace
    @ObservedObject var spaces: HarnessSpacesModel
    let decision: ConsoleClient.OSDecision
    /// Le tri : la carte est seule à l'écran, plus grande, et ⏎ prend le geste principal.
    let large: Bool
    /// La carte nomme sa tâche (un fil de plusieurs tâches) ; le tri la nomme toujours.
    let titled: Bool
    let done: (() -> Void)?

    /// `large` : la carte du tri. `titled` : la carte porte le titre de sa tâche (le tri le
    /// porte toujours). `done` : appelé quand le geste a tranché la décision.
    public init(
        server: HarnessModel, workstation: WorkstationModel, intakes: HarnessIntakes, workspace: OSWorkspace,
        decision: ConsoleClient.OSDecision, large: Bool = false, titled: Bool = false, done: (() -> Void)? = nil
    ) {
        self.server = server
        self.workstation = workstation
        self.intakes = intakes
        self.workspace = workspace
        spaces = server.spaces
        self.decision = decision
        self.large = large
        self.titled = titled
        self.done = done
    }

    @State private var choices: [Int: String] = [:]
    @State private var custom = ""
    /// « Autre… » : la réponse libre à une question.
    @State private var editing = false
    @State private var reason = ""
    /// « Corriger… » : le champ de la correction est ouvert.
    @State private var correcting = false
    @State private var always = false
    @State private var failure: HarnessFailure?
    @State private var working = false
    @State private var stopping: HarnessRun?
    @State private var ruleWritten = false
    /// « Modifier le plan » d'une demande : la feuille est ouverte sur elle.
    @State private var editingPlan: HarnessIntake?

    public var body: some View {
        OSCard(tint: .orange, emphasized: true) {
            VStack(alignment: .leading, spacing: large ? 14 : 10) {
                // « Comprendre » et le menu « … » de la tâche sont au coin de la carte : la rangée
                // des gestes garde sa largeur pour ce qui tranche.
                HStack(alignment: .center, spacing: 8) {
                    context
                    Spacer(minLength: 0)
                    if let run = menuRun {
                        understandButton(run.id)
                        moreMenu(run, gestures: server.osGestures(run))
                    }
                }
                if let title, large || titled {
                    Text(title)
                        .font(large ? .headline : .subheadline.weight(.semibold))
                        .foregroundStyle(large ? .primary : .secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                content
                if let failure {
                    ConsoleFailureBanner(failure: failure)
                }
            }
            .disabled(working)
        }
        .osRunStop(server: server, run: $stopping) { done?() }
        .task {
            await server.osReadFeatures()
            if spaces.availability == .unknown { await spaces.refresh() }
        }
    }

    // MARK: En-tête

    /// Pour qui l'on tranche, et quoi : « ● Client Acme · acme-web · Revue ».
    private var context: some View {
        OSSpaceLine(
            space: OSDecisions.space(of: decision, spaces: spaces.spaces),
            items: (self.place.map { [OSSpaceLine.Item($0)] } ?? []) + [OSSpaceLine.Item(self.kind, strong: true, tint: .orange, symbol: self.symbol)]
        )
    }

    /// Ce qu'attend la tâche d'une porte ; `nil` pour les autres décisions.
    private var wait: OSHumanWait? {
        switch decision {
        case let .specs(run), let .verdict(run): OSHumanWait.of(run) ?? .verdict
        default: nil
        }
    }

    /// La sorte de décision.
    private var kind: String {
        switch decision {
        case .questions: return OSText.kindQuestion
        case .specs, .verdict:
            switch wait {
            case .specs, .irreversible: return OSText.kindSpecs
            case .arbitration: return OSDecideText.kindArbitration
            case .budget: return OSDecideText.kindBudget
            case .failure: return OSDecideText.cardFailed
            default: return OSText.kindVerdict
            }
        case .approval: return OSText.kindSend
        case let .intake(intake): return intake.isClarifying ? OSText.kindClarify : OSText.kindPlan
        case .jira: return OSText.kindJira
        }
    }

    private var symbol: String {
        switch decision {
        case .questions: return "questionmark.bubble.fill"
        case .specs, .verdict:
            switch wait {
            case .specs, .irreversible: return "doc.text.fill"
            case .arbitration: return "scale.3d"
            case .budget: return "dollarsign.circle.fill"
            case .failure: return "xmark.octagon.fill"
            default: return "checkmark.seal.fill"
            }
        case .approval: return "paperplane.fill"
        case .intake: return "sparkles"
        case .jira: return "text.bubble.fill"
        }
    }

    /// Où la décision s'applique : le dépôt, le poste, ou le ticket d'un commentaire.
    private var place: String? {
        switch decision {
        case .questions, .specs, .verdict: decision.repo
        case .approval: OSText.poste
        case let .intake(intake): decision.repo ?? (intake.plan?.kind == "workstation_request" ? OSText.poste : nil)
        case let .jira(write): write.issueKey
        }
    }

    /// Le titre de la tâche : montré au tri, et dans un fil de plusieurs tâches.
    private var title: String? {
        menuRun.map { OSThreads.clean($0.title).title }
    }

    /// La tâche dont le menu « … » règle l'autonomie, écrit le palier ou l'arrête : celle de
    /// la question, des specs ou de la revue.
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
        case let .specs(run), let .verdict(run): gate(run, wait: OSHumanWait.of(run) ?? .verdict)
        case let .approval(action): approval(action)
        case let .intake(intake): intakeCard(intake)
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
            TextField(IntakeText.replyPrompt, text: $custom, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
        }
        OSLine(spacing: 8) {
            if editing, let item = batch.items.first {
                Button { answer(batch, with: [item.id: custom]) } label: { primaryLabel(OSText.send) }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(large ? .defaultAction : nil)
                    .disabled(custom.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !batch.acceptsAnswers)
                Button(OSText.cancel) { editing = false }
            } else {
                let picked = self.chosen(batch)
                Button {
                    answer(batch, with: picked)
                } label: {
                    primaryLabel(takeLabel(batch, chosen: picked), symbol: "checkmark")
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(large ? .defaultAction : nil)
                .disabled(!batch.acceptsAnswers || picked.values.contains(where: \.isEmpty))
                if batch.items.count == 1 {
                    Button(OSText.other) { editing = true }
                        .disabled(!batch.acceptsAnswers)
                }
            }
            if gestures.always {
                OSCheckbox(label: OSDecideText.always, isOn: $always)
            }
            Spacer()
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

    /// « Prendre « Garder le cache » » pour une question seule dont l'option tient sur un
    /// bouton ; sinon « Envoyer » (les réponses partent ensemble).
    private func takeLabel(_ batch: HarnessEscalationBatch, chosen: [Int: String]) -> String {
        guard batch.items.count == 1, let option = chosen.values.first, !option.isEmpty, option.count <= 32 else { return OSText.send }
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
    /// tâche en « tout me demander » (plus rien ne s'applique seul) ; la phrase entière (« « Garder
    /// le cache » dans 12 min sauf avis contraire ») est en infobulle.
    @ViewBuilder
    private func deadline(_ item: HarnessEscalation, run: HarnessRun?, gestures: OSRunGestures) -> some View {
        if item.autoDate != nil {
            TimelineView(.periodic(from: .now, by: 1)) { timeline in
                if let deadline = OSDeadline.of(item, now: timeline.date) {
                    let sentence = deadline.text
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

    // MARK: Une tâche qui attend l'humain

    // La preuve, pourquoi on vous demande, puis le geste de la sorte d'attente : valider ou
    // corriger une porte (specs, revue, arbitrage), reprendre après un budget dépassé,
    // relancer ou corriger après des échecs répétés.
    @ViewBuilder
    private func gate(_ run: HarnessRun, wait: OSHumanWait) -> some View {
        let gestures = server.osGestures(run)
        switch wait {
        case .specs, .irreversible: specsProof(run)
        case .verdict, .arbitration: OSDecideReviewProof(server: server, run: run, large: large)
        case .budget, .failure, .questions: EmptyView()
        }
        if wait == .failure {
            Label(OSDecideText.failCause(run.lastFailCause), systemImage: "exclamationmark.triangle")
                .foregroundStyle(.secondary)
        }
        ForEach(OSGateReason.of(run).prefix(3), id: \.self) { reason in
            Label(reason.text, systemImage: "flag")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
        }
        if correcting {
            TextField(OSDecideText.amendPrompt, text: $reason, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
        }
        OSLine(spacing: 8) {
            if correcting {
                Button {
                    perform { await server.osAmend(run, text: reason, always: always) }
                } label: {
                    primaryLabel(ControlText.fix)
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(large ? .defaultAction : nil)
                .disabled(reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button(OSText.cancel) { correcting = false }
                if gestures.always, wait.isGate {
                    OSCheckbox(label: OSDecideText.always, isOn: $always)
                }
            } else {
                Button {
                    perform {
                        if wait.isRetry { return await server.retry(runId: run.id) }
                        return await server.validate(runId: run.id, approve: true, reason: "")
                    }
                } label: {
                    primaryLabel(Self.primary(wait), symbol: wait.isRetry ? "arrow.clockwise" : "checkmark")
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(large ? .defaultAction : nil)
                .disabled(!server.canAct)
                // Un budget dépassé ne se corrige pas : on l'accorde, ou on arrête (menu « … »).
                if gestures.amend, wait != .budget {
                    Button(OSDecideText.amend) { correcting = true }
                }
            }
            Spacer()
        }
    }

    /// Le geste qui dit oui : « Valider » une porte, « Relancer » après un échec,
    /// « Reprendre » après un budget dépassé.
    private static func primary(_ wait: OSHumanWait) -> String {
        switch wait {
        case .failure: PipelineServerText.retry
        case .budget: OSWatchText.resume
        default: OSText.validate
        }
    }

    /// La première carte du briefing (le point qui demande un regard), puis ce que les specs
    /// décrivent en une phrase.
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
        Text(specsHeadline(run))
            .font(headlineFont)
            .lineLimit(large ? 4 : 2)
    }

    private func specsHeadline(_ run: HarnessRun) -> String {
        let feature = run.briefing?.feature.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return feature.isEmpty ? OSText.specsReady : OSThreads.firstLine(feature)
    }

    /// Le menu « … » : l'autonomie de la tâche, la règle de palier du type (admin, tâche
    /// typée) et l'arrêt motivé.
    @ViewBuilder
    private func moreMenu(_ run: HarnessRun, gestures: OSRunGestures) -> some View {
        if gestures.stop || gestures.rule != nil || gestures.autonomy {
            Menu {
                OSAutonomyMenu(server: server, runs: [run]) { failure = server.failure }
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

    // Le message EN ENTIER, ses destinataires ; l'envoyer, le corriger (le poste reçoit ce
    // qu'il faut changer) ou l'écarter.
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
            TextField(OSDecideText.amendPrompt, text: $reason, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
        }
        OSLine(spacing: 8) {
            if correcting {
                Button(ControlText.fix) {
                    perform { await workstation.refuse(shown: action, reason: reason) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button(OSText.cancel) { correcting = false }
            } else {
                Button {
                    perform { await workstation.approve(shown: action) }
                } label: {
                    primaryLabel(OSText.send, symbol: "paperplane")
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(large ? .defaultAction : nil)
                Button(OSDecideText.amend) { correcting = true }
                Button(OSText.dismiss) { perform { await workstation.refuse(shown: action, reason: "") } }
            }
            Spacer()
        }
    }

    // MARK: Demande

    // Le plan à lancer (sur son dépôt), ou la question de l'OS.
    @ViewBuilder
    private func intakeCard(_ intake: HarnessIntake) -> some View {
        if intake.isClarifying {
            Text(intake.question ?? intake.text).font(headlineFont)
            TextField(IntakeText.replyPrompt, text: $custom, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
            OSLine {
                Button {
                    perform { (try? await intakes.answer(intake, text: custom)) != nil }
                } label: {
                    primaryLabel(OSText.send)
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(large ? .defaultAction : nil)
                .disabled(custom.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button(OSText.dismiss) { perform { (try? await intakes.cancel(intake)) != nil } }
                Spacer()
            }
        } else if let plan = intake.plan {
            Text(plan.title).font(headlineFont)
            if !plan.statement.isEmpty {
                Text(plan.statement).font(.callout).foregroundStyle(.secondary).lineLimit(large ? 5 : 3)
            }
            OSLine {
                Button {
                    perform { (try? await intakes.confirm(intake)) != nil }
                } label: {
                    primaryLabel(plan.repo.map(OSDecideText.launchOn) ?? OSText.launch, symbol: "play.fill")
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(large ? .defaultAction : nil)
                Button(OSText.dismiss) { perform { (try? await intakes.cancel(intake)) != nil } }
                Spacer()
                Button {
                    editingPlan = intake
                } label: {
                    Label(IntakeText.editTitle, systemImage: "pencil")
                }
                .labelStyle(.iconOnly)
                .help(IntakeText.editTitle)
                .osBorderless()
            }
            .sheet(item: $editingPlan) { intake in
                IntakePlanSheet(server: server, intake: intake)
            }
        }
    }

    // MARK: Commentaire Jira

    // Le texte EN ENTIER, ce qui le motive, l'envoyer ou l'écarter.
    @ViewBuilder
    private func jiraCard(_ write: AtlassianWrite) -> some View {
        Text(write.body)
            .font(.callout)
            .osSelectable()
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
        Text(OSThreads.firstLine(write.why)).font(headlineFont).lineLimit(2)
        OSLine {
            Button {
                perform { await server.atlassian.approve(write.id) }
            } label: {
                primaryLabel(OSText.send, symbol: "paperplane")
            }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut(large ? .defaultAction : nil)
            Button(OSText.dismiss) { perform { await server.atlassian.dismiss(write.id) } }
            Spacer()
        }
    }

    // MARK: Accès

    /// « Comprendre » : le seul accès au détail de la tâche. Au tri, la feuille se referme
    /// d'abord : « Comprendre » s'ouvre sur l'écran, pas derrière elle.
    private func understandButton(_ runId: String) -> some View {
        Button {
            if large { workspace.triage = false }
            workspace.understand(runId: runId, level: .summary)
        } label: {
            // Au coin de la carte : le mot sur le Mac, le symbole seul sous le doigt.
            #if os(macOS)
            Label(OSText.understand, systemImage: "text.magnifyingglass")
            #else
            Label(OSText.understand, systemImage: "text.magnifyingglass").labelStyle(.iconOnly)
            #endif
        }
        .osBorderless()
    }

    /// Le libellé du geste principal ; au tri, il dit sa touche (⏎ le prend).
    private func primaryLabel(_ text: String, symbol: String? = nil) -> some View {
        HStack(spacing: 6) {
            if let symbol {
                Label(text, systemImage: symbol)
            } else {
                Text(text)
            }
            if large { OSKeyHint(key: "⏎") }
        }
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
