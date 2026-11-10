// La DEMANDE à l'écran, écrite une fois pour le Mac et l'iPhone/iPad : le bouton
// permanent d'« À traiter », la feuille de saisie (un champ multiligne : la dictée est
// celle du clavier du système), les cartes des demandes ouvertes — classement en
// cours, question avec « Répondre », plan avec Confirmer / Modifier / Annuler, réponse
// directe ou échec avec « Écarter » — et la feuille « Modifier le plan ».
//
// Rien n'est créé avant « Confirmer » : le serveur classe, l'humain décide. Un refus
// du serveur est dit sur la carte ou dans la feuille qui l'a provoqué.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// La source déclarée au serveur : l'app Mac ou l'app iOS (aussi lue par les écrans `OS/`).
var intakeSource: String {
    #if os(iOS)
    "ios"
    #else
    "console"
    #endif
}

/// Le texte d'un échec de geste sur une demande.
func intakeMessage(_ failure: HarnessIntakeFailure) -> String {
    switch failure {
    case .unsupported: IntakeText.unsupported
    case .server(.approverOnly): IntakeText.approverOnly
    case .server(let failure): failure.message
    }
}

// MARK: - À traiter

/// Le bouton Demande, toujours là, puis une section par demande ouverte.
public struct IntakeInboxSection: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var intakes: HarnessIntakes
    @ObservedObject var drafts: HarnessDrafts

    public init(server: HarnessModel, drafts: HarnessDrafts) {
        self.server = server
        self.intakes = server.intakes
        self.drafts = drafts
    }

    public var body: some View {
        Section {
            Button(IntakeText.title, systemImage: IntakeText.titleSymbol) { drafts.openIntake() }
                .buttonStyle(.borderedProminent)
                .disabled(!server.isConfigured || !server.canAct)
                .consoleID("inbox.intake")
        }
        ForEach(intakes.open) { intake in
            Section {
                IntakeCard(server: server, intakes: intakes, drafts: drafts, intake: intake)
                    .disabled(!server.canAct)
            } header: {
                header(intake)
            }
            .id("intake/" + intake.id)
        }
    }

    private func header(_ intake: HarnessIntake) -> some View {
        let (word, symbol): (String, String) =
            switch intake.state {
            case "clarifying": (IntakeText.clarifying, IntakeText.clarifyingSymbol)
            case "planned": (IntakeText.planned, IntakeText.plannedSymbol)
            case "answered": (IntakeText.answered, IntakeText.answeredSymbol)
            case "failed": (IntakeText.failed, IntakeText.failedSymbol)
            default: (IntakeText.classifying, IntakeText.classifyingSymbol)
            }
        return HStack(spacing: 6) {
            Label(word, systemImage: symbol)
                .foregroundStyle(intake.isClarifying || intake.isPlanned ? Color.orange : Color.secondary)
                .fixedSize()
            Text("· " + IntakeText.title + " · " + ConsoleFormat.relative(ms: intake.createdAt, nowMs: Date().timeIntervalSince1970 * 1000))
                .denseLines(1)
        }
    }
}

/// Une demande ouverte : la phrase, puis ce qu'elle attend de l'humain.
struct IntakeCard: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var intakes: HarnessIntakes
    @ObservedObject var drafts: HarnessDrafts
    let intake: HarnessIntake
    @State private var failure: HarnessIntakeFailure?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(intake.statement)
                .font(intake.isPlanned ? .callout : .headline)
                .foregroundStyle(intake.isPlanned ? Color.secondary : Color.primary)
                .consoleReadable()
            content
            if let failure {
                Text(intakeMessage(failure))
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                    .consoleBanner(tone: .attention)
                    .consoleID("intake.failure")
            }
        }
        .padding(.vertical, 4)
        .disabled(intakes.busy.contains(intake.id))
    }

    @ViewBuilder
    private var content: some View {
        if intake.isPlanned, let plan = intake.plan {
            planView(plan)
            ViewThatFits(in: .horizontal) {
                HStack { planButtons }
                VStack(alignment: .leading, spacing: 8) { planButtons }
            }
        } else if intake.isClarifying {
            Text(intake.question ?? "")
                .font(.headline)
                .consoleReadable()
            TextField(IntakeText.replyPrompt, text: answerBinding, axis: .vertical)
                .lineLimit(1...6)
                .consoleID("intake.reply.field")
            HStack {
                Button(IntakeText.reply) { act { try await intakes.answer(intake, text: answerText) ; drafts.intakeAnswers[intake.id] = nil } }
                    .buttonStyle(.borderedProminent)
                    .disabled(answerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .consoleID("intake.reply")
                Button(IntakeText.cancel) { act { try await intakes.cancel(intake) } }
                    .buttonStyle(.bordered)
                    .consoleID("intake.cancel")
            }
        } else if intake.isSettled {
            if intake.state == "answered" {
                ConsoleMarkdown(markdown: intake.answer ?? "")
            } else {
                Text(intake.reason ?? IntakeText.failedFallback)
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                    .consoleBanner(tone: .attention)
            }
            Button(IntakeText.dismiss) { act { try await intakes.cancel(intake) } }
                .buttonStyle(.bordered)
                .consoleID("intake.dismiss")
        } else {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(IntakeText.classifying).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                Button(IntakeText.cancel) { act { try await intakes.cancel(intake) } }
                    .buttonStyle(.bordered)
                    .consoleID("intake.cancel")
            }
        }
    }

    /// Type, dépôt, puis ce qui sera créé, tel que le serveur le rédige.
    private func planView(_ plan: HarnessIntakePlan) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(IntakeText.kind(plan.kind) + " · " + (plan.repo ?? IntakeText.noRepo))
                .font(.caption.weight(.semibold))
                .foregroundStyle(.orange)
            Text(plan.title)
                .font(.headline)
                .consoleReadable()
            if let creates = plan.creates {
                LabeledContent(IntakeText.createsLabel) { Text(creates).multilineTextAlignment(.trailing) }
                    .font(.callout)
            }
        }
    }

    @ViewBuilder
    private var planButtons: some View {
        Button(IntakeText.confirm) { act { try await intakes.confirm(intake) } }
            .buttonStyle(.borderedProminent)
            .consoleID("intake.confirm")
        Button(IntakeText.modify) { drafts.intakeEdit = intake }
            .buttonStyle(.bordered)
            .consoleID("intake.modify")
        Button(IntakeText.cancel) { act { try await intakes.cancel(intake) } }
            .buttonStyle(.bordered)
            .consoleID("intake.cancel")
    }

    private var answerText: String { drafts.intakeAnswers[intake.id] ?? "" }

    private var answerBinding: Binding<String> {
        Binding(get: { drafts.intakeAnswers[intake.id] ?? "" }, set: { drafts.intakeAnswers[intake.id] = $0 })
    }

    private func act(_ gesture: @escaping @MainActor () async throws -> Void) {
        failure = nil
        Task {
            do {
                try await gesture()
            } catch let failed as HarnessIntakeFailure {
                failure = failed
            } catch {}
        }
    }
}

// MARK: - Feuille de saisie

/// La feuille « Demande » : une phrase libre, le dépôt facultatif, « Envoyer ». Elle se
/// referme à l'envoi ; la demande vit ensuite dans « À traiter ».
struct IntakeSheet: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @State private var failure: HarnessIntakeFailure?
    @State private var isSending = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(IntakeText.fieldPrompt, text: $drafts.intakeText, axis: .vertical)
                        .lineLimit(4...12)
                        .consoleID("intake.text")
                    if !server.repos.isEmpty {
                        Picker(IntakeText.repoLabel, selection: $drafts.intakeRepo) {
                            Text(IntakeText.repoDeduced).tag("")
                            ForEach(server.repos) { repo in
                                Text(repo.name).tag(repo.name)
                            }
                        }
                    }
                } footer: {
                    Text(IntakeText.fieldHint)
                }
                if let failure {
                    Section {
                        Text(intakeMessage(failure))
                            .font(.callout)
                            .fixedSize(horizontal: false, vertical: true)
                            .consoleBanner(tone: .attention)
                            .consoleID("intake.sheet.failure")
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(IntakeText.title)
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.cancel) { drafts.intakeSheetShown = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSending ? IntakeText.sending : IntakeText.send) { send() }
                        .disabled(!canSend)
                        .consoleID("intake.send")
                }
            }
            .task { if server.repos.isEmpty { await server.refreshCatalog() } }
        }
        .consoleSheetSize(minWidth: 520, minHeight: 360)
    }

    private var canSend: Bool {
        !isSending && server.canAct && !drafts.intakeText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        isSending = true
        failure = nil
        let (text, repo) = (drafts.intakeText, drafts.intakeRepo)
        Task {
            defer { isSending = false }
            do {
                try await server.intakes.submit(text: text, source: intakeSource, repo: repo)
                drafts.intakeText = ""
                drafts.intakeSheetShown = false
            } catch let failed as HarnessIntakeFailure {
                failure = failed
            } catch {}
        }
    }
}

// MARK: - Modifier le plan

/// La feuille « Modifier le plan » : type, dépôt, titre, énoncé et, selon le type,
/// périmètre ou planification ; « Confirmer » envoie la correction avec la confirmation.
struct IntakePlanSheet: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let intake: HarnessIntake
    @State private var plan: HarnessIntakePlan
    @State private var failure: HarnessIntakeFailure?
    @State private var isSending = false

    init(server: HarnessModel, drafts: HarnessDrafts, intake: HarnessIntake) {
        self.server = server
        self.drafts = drafts
        self.intake = intake
        _plan = State(initialValue: intake.plan ?? HarnessIntakePlan(kind: "feature", repo: nil, title: "", statement: intake.statement))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker(IntakeText.kindLabel, selection: $plan.kind) {
                        ForEach(HarnessIntakePlan.kinds, id: \.self) { kind in
                            Text(IntakeText.kind(kind)).tag(kind)
                        }
                    }
                    if plan.kind != "workstation_request" {
                        Picker(IntakeText.repoLabel, selection: repoBinding) {
                            ForEach(repoChoices, id: \.self) { repo in
                                Text(repo).tag(repo)
                            }
                        }
                    }
                    TextField(IntakeText.titleLabel, text: $plan.title)
                    TextField(IntakeText.statementLabel, text: $plan.statement, axis: .vertical)
                        .lineLimit(3...10)
                    if plan.kind == "audit" {
                        TextField(IntakeText.focusLabel, text: optional(\.focus))
                    }
                }
                if plan.kind == "schedule" {
                    Section {
                        TextField(IntakeText.cronLabel, text: scheduleBinding(\.cron))
                        Picker(IntakeText.targetLabel, selection: scheduleBinding(\.target)) {
                            ForEach(HarnessIntakeSchedule.targets, id: \.self) { target in
                                Text(targetTitle(target)).tag(target)
                            }
                        }
                        if schedule.target == "audit" {
                            TextField(IntakeText.focusLabel, text: scheduleOptional(\.focus))
                        }
                        if schedule.target == "issues" {
                            TextField(IntakeText.labelLabel, text: scheduleOptional(\.label))
                        }
                    }
                }
                if let failure {
                    Section {
                        Text(intakeMessage(failure))
                            .font(.callout)
                            .fixedSize(horizontal: false, vertical: true)
                            .consoleBanner(tone: .attention)
                            .consoleID("intake.edit.failure")
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(IntakeText.editTitle)
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.cancel) { drafts.intakeEdit = nil }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(IntakeText.confirm) { confirm() }
                        .disabled(isSending || plan.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .consoleID("intake.edit.confirm")
                }
            }
            .task { if server.repos.isEmpty { await server.refreshCatalog() } }
        }
        .consoleSheetSize(minWidth: 520, minHeight: 480)
    }

    /// Les dépôts du serveur, plus celui du plan s'il n'en fait pas partie.
    private var repoChoices: [String] {
        var names = server.repos.map(\.name)
        if let repo = plan.repo, !repo.isEmpty, !names.contains(repo) { names.insert(repo, at: 0) }
        return names
    }

    private var repoBinding: Binding<String> {
        Binding(get: { plan.repo ?? repoChoices.first ?? "" }, set: { plan.repo = $0 })
    }

    private func optional(_ key: WritableKeyPath<HarnessIntakePlan, String?>) -> Binding<String> {
        Binding(get: { plan[keyPath: key] ?? "" }, set: { plan[keyPath: key] = $0.isEmpty ? nil : $0 })
    }

    private var schedule: HarnessIntakeSchedule { plan.schedule ?? HarnessIntakeSchedule(cron: "", target: "run") }

    private func scheduleBinding(_ key: WritableKeyPath<HarnessIntakeSchedule, String>) -> Binding<String> {
        Binding(get: { schedule[keyPath: key] }, set: { value in
            var next = schedule
            next[keyPath: key] = value
            plan.schedule = next
        })
    }

    private func scheduleOptional(_ key: WritableKeyPath<HarnessIntakeSchedule, String?>) -> Binding<String> {
        Binding(get: { schedule[keyPath: key] ?? "" }, set: { value in
            var next = schedule
            next[keyPath: key] = value.isEmpty ? nil : value
            plan.schedule = next
        })
    }

    /// La cible d'une planification, en français.
    private func targetTitle(_ target: String) -> String {
        switch target {
        case "audit": IntakeText.targetAudit
        case "issues": IntakeText.targetIssues
        default: IntakeText.targetFeature
        }
    }

    private func confirm() {
        isSending = true
        failure = nil
        var sent = plan
        if sent.kind == "workstation_request" { sent.repo = nil } else if sent.repo == nil { sent.repo = repoChoices.first }
        if sent.kind != "schedule" { sent.schedule = nil } else if sent.schedule == nil { sent.schedule = schedule }
        if sent.kind != "audit" { sent.focus = nil }
        let corrected = sent
        Task {
            defer { isSending = false }
            do {
                try await server.intakes.confirm(intake, plan: corrected)
                drafts.intakeEdit = nil
            } catch let failed as HarnessIntakeFailure {
                failure = failed
            } catch {}
        }
    }
}
