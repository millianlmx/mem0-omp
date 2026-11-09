// Le PONT CORPO ↔ USINE à l'écran, écrit une fois pour le Mac et l'iPhone/iPad :
// les propositions nées des signalements de collègues dans « À traiter », la feuille
// qui montre le texte EXACT qui partira à la forge (relu par l'aperçu du serveur après
// chaque modification) avec ses deux gestes, confirmer ou écarter, et la section
// Origine de la page d'une feature lancée depuis l'une d'elles.
//
// Rien de vide ne s'affiche : sans proposition, sans origine, ou pour un jeton qui
// n'est pas celui du propriétaire, ces vues ne montrent rien. Un refus d'approbateur
// est dit dans la feuille, jamais dans le bandeau de tête.

#if canImport(AppKit)
import AppKit
#endif
import ConsoleClient
import ConsoleCore
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

// MARK: - À traiter

/// Les propositions ouvertes, seulement quand il y en a : chacune avec son canal, la
/// personne, l'extrait et le geste « Relire et confirmer » qui ouvre sa feuille.
public struct SignalProposalsSection: View {
    @ObservedObject var signals: CorporateSignalsModel
    @ObservedObject var drafts: HarnessDrafts

    public init(signals: CorporateSignalsModel, drafts: HarnessDrafts) {
        self.signals = signals
        self.drafts = drafts
    }

    public var body: some View {
        if signals.availability == .available, !signals.proposals.isEmpty {
            Section {
                ForEach(signals.proposals) { signal in
                    SignalProposalRow(signals: signals, drafts: drafts, signal: signal)
                }
            } header: {
                Label(SignalText.sectionTitle, systemImage: SignalText.sectionSymbol)
                    .foregroundStyle(.orange)
            } footer: {
                Text(SignalText.sectionHint)
            }
        }
    }
}

struct SignalProposalRow: View {
    @ObservedObject var signals: CorporateSignalsModel
    @ObservedObject var drafts: HarnessDrafts
    let signal: CorporateSignal

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(SignalText.proposal(repo: signal.repo))
                .font(.callout.weight(.semibold))
                .foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
            if let title = signal.title, !title.isEmpty {
                Text(title)
                    .font(.headline)
                    .consoleReadable()
            }
            Text(signal.excerpt)
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(4)
            Text(origin)
                .font(.caption)
                .foregroundStyle(.secondary)
            if let error = signal.error, !error.isEmpty {
                Text(SignalText.lastError(error))
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                    .consoleBanner(tone: .attention)
            }
            Button(SignalText.review, systemImage: SignalText.reviewSymbol) {
                drafts.signalShown = signal
            }
            .buttonStyle(.borderedProminent)
            .disabled(signals.busy.contains(signal.id))
            .consoleID("signal.review.\(signal.id)")
        }
        .padding(.vertical, 4)
    }

    /// « Slack · Bogue · Signalé par paul@exemple.fr · 8 nov. 2026 à 14:05 ».
    private var origin: String {
        var parts = [SignalText.channel(signal.channel)]
        if let kind = signal.kind { parts.append(SignalText.kind(kind)) }
        if let person = signal.personRef, !person.isEmpty { parts.append(SignalText.reportedBy(person)) }
        parts.append(ConsoleFormat.dateTime(ms: signal.createdAt))
        return parts.joined(separator: " · ")
    }
}

// MARK: - Feuille de confirmation

/// La feuille d'une proposition : le message du collègue, le dépôt (modifiable parmi
/// ceux du serveur), le titre et la description à éditer, puis ce que la forge recevra,
/// tel que l'aperçu du serveur le rend après chaque modification. Confirmer n'est
/// possible qu'une fois l'aperçu lu ; le serveur décide (approbateur, politique).
struct SignalConfirmSheet: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var signals: CorporateSignalsModel
    @ObservedObject var drafts: HarnessDrafts
    let signal: CorporateSignal

    @State private var repo: String
    @State private var title: String
    @State private var text: String
    @State private var reason = ""
    /// Le texte de départ vient de l'aperçu de la proposition (sans titre ni corps).
    @State private var seeded = false
    @State private var preview: CorporateSignalPreview?
    @State private var isPreviewing = false
    @State private var previewFailure: HarnessFailure?
    @State private var failure: HarnessFailure?
    @State private var isSending = false

    init(server: HarnessModel, drafts: HarnessDrafts, signal: CorporateSignal) {
        self.server = server
        self.signals = server.signals
        self.drafts = drafts
        self.signal = signal
        _repo = State(initialValue: signal.repo ?? "")
        _title = State(initialValue: signal.title ?? "")
        _text = State(initialValue: signal.body ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                messageSection
                draftSection
                sentSection
                if let failure {
                    Section {
                        Text(failure == .approverOnly ? SignalText.approverOnly : failure.message)
                            .font(.callout)
                            .fixedSize(horizontal: false, vertical: true)
                            .consoleBanner(tone: .attention)
                            .consoleID("signal.failure")
                    }
                }
                dismissSection
            }
            .formStyle(.grouped)
            .navigationTitle(SignalText.sheetTitle)
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.cancel) { drafts.signalShown = nil }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(SignalText.confirm) { confirm() }
                        .disabled(!canConfirm)
                        .consoleID("signal.confirm")
                }
            }
            .task { if server.repos.isEmpty { await server.refreshCatalog() } }
            .task(id: [repo, title, text]) { await readPreview() }
        }
        .consoleSheetSize(minWidth: 560, minHeight: 620)
    }

    private var messageSection: some View {
        Section {
            Text(signal.excerpt)
                .consoleReadable()
            Text(SignalText.channel(signal.channel))
                .font(.caption)
                .foregroundStyle(.secondary)
            if let person = signal.personRef, !person.isEmpty {
                Text(SignalText.reportedBy(person))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let url = URL(string: signal.url), url.scheme != nil {
                Link(destination: url) {
                    Label(SignalText.threadLabel, systemImage: SignalText.openThreadSymbol)
                }
            }
        } header: {
            Text(SignalText.messageHeader)
        }
    }

    private var draftSection: some View {
        Section {
            if repoChoices.isEmpty {
                LabeledContent(SignalText.repoLabel, value: repo)
            } else {
                Picker(SignalText.repoLabel, selection: $repo) {
                    ForEach(repoChoices, id: \.self) { name in
                        Text(name).tag(name)
                    }
                }
                .consoleID("signal.repo")
            }
            TextField(SignalText.titleLabel, text: $title, axis: .vertical)
                .consoleID("signal.title")
            TextField(SignalText.bodyLabel, text: $text, axis: .vertical)
                .lineLimit(4...16)
                .consoleID("signal.body")
        } header: {
            Text(SignalText.draftHeader)
        }
    }

    @ViewBuilder
    private var sentSection: some View {
        Section {
            if let preview {
                Text(SignalText.policy(preview.policy.applied))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(preview.policy.applied == "full" ? Color.orange : Color.secondary)
                if let note = preview.policy.note, !note.isEmpty {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let issue = preview.issue {
                    Text(SignalText.issueExists(repo: issue.repo, number: issue.number))
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text(preview.title)
                        .font(.headline)
                        .consoleReadable()
                        .consoleID("signal.preview.title")
                    Text(preview.body)
                        .consoleReadable()
                        .consoleBanner(tone: .neutral)
                        .consoleID("signal.preview.body")
                }
            } else if let previewFailure {
                Text(previewFailure.message)
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                    .consoleBanner(tone: .attention)
            } else if isPreviewing {
                ProgressView(SignalText.previewing)
            }
        } header: {
            Text(SignalText.sentHeader)
        } footer: {
            Text(SignalText.sentHint)
        }
    }

    private var dismissSection: some View {
        Section {
            TextField(PipelineServerText.reasonLabel, text: $reason, axis: .vertical)
                .consoleID("signal.dismiss.reason")
            Button(SignalText.dismiss, role: .destructive) { dismiss() }
                .disabled(isSending)
                .consoleID("signal.dismiss")
        } footer: {
            Text(SignalText.dismissHint)
        }
    }

    /// Les dépôts du serveur, et celui de la proposition s'il n'y figure pas.
    private var repoChoices: [String] {
        var names = server.repos.map(\.name)
        if !repo.isEmpty, !names.contains(repo) { names.insert(repo, at: 0) }
        return names
    }

    private var canConfirm: Bool {
        preview != nil && !isPreviewing && !isSending && !repo.isEmpty
            && !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Relit l'aperçu : d'abord celui de la proposition (texte de départ du serveur), puis,
    /// après une courte pause de saisie, celui du texte modifié.
    private func readPreview() async {
        if seeded {
            try? await Task.sleep(for: .milliseconds(400))
            if Task.isCancelled { return }
        }
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if seeded, trimmedTitle.isEmpty || trimmedText.isEmpty {
            preview = nil
            return
        }
        isPreviewing = true
        defer { isPreviewing = false }
        do {
            let read = try await signals.preview(
                signal,
                repo: repo.isEmpty ? nil : repo,
                title: seeded ? title : nil,
                body: seeded ? text : nil
            )
            if Task.isCancelled { return }
            previewFailure = nil
            preview = read
            if !seeded {
                seeded = true
                repo = read.repo
                title = read.title
                text = read.body
            }
        } catch {
            guard let failed = error as? HarnessFailure else { return }
            preview = nil
            previewFailure = failed
        }
    }

    private func confirm() {
        isSending = true
        let (repo, title, text) = (repo, title, text)
        Task {
            defer { isSending = false }
            do {
                _ = try await signals.confirm(signal, repo: repo, title: title, body: text)
                drafts.signalShown = nil
            } catch {
                failure = error as? HarnessFailure
            }
        }
    }

    private func dismiss() {
        isSending = true
        let reason = reason
        Task {
            defer { isSending = false }
            do {
                try await signals.dismiss(signal, reason: reason)
                drafts.signalShown = nil
            } catch {
                failure = error as? HarnessFailure
            }
        }
    }
}

/// La feuille de confirmation d'une proposition, posée une fois par l'app avec les
/// autres gestes du serveur (`harnessGestures`).
struct SignalGestures: ViewModifier {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    func body(content: Content) -> some View {
        content
            .sheet(item: $drafts.signalShown) { signal in
                SignalConfirmSheet(server: server, drafts: drafts, signal: signal)
            }
            .sheet(item: $drafts.replyShown) { reply in
                ReplySheet(server: server, drafts: drafts, reply: reply)
            }
    }
}

// MARK: - Réponses au collègue

/// Les brouillons de réponse au collègue, seulement quand il y en a : chacun avec sa
/// sorte, son canal, la personne et le début du texte, et le geste qui ouvre sa feuille.
public struct ReplyDraftsSection: View {
    @ObservedObject var signals: CorporateSignalsModel
    @ObservedObject var drafts: HarnessDrafts

    public init(signals: CorporateSignalsModel, drafts: HarnessDrafts) {
        self.signals = signals
        self.drafts = drafts
    }

    public var body: some View {
        if signals.repliesAvailability == .available, !signals.replies.isEmpty {
            Section {
                ForEach(signals.replies) { reply in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(SignalText.replyKind(reply.kind))
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(.orange)
                        Text(reply.text)
                            .font(.callout)
                            .lineLimit(4)
                        Text(ReplySheet.origin(of: reply))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if let error = reply.error, !error.isEmpty {
                            Text(error)
                                .font(.callout)
                                .fixedSize(horizontal: false, vertical: true)
                                .consoleBanner(tone: .attention)
                        }
                        Button(SignalText.openReply, systemImage: SignalText.repliesSymbol) {
                            drafts.replyShown = reply
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(signals.busy.contains(reply.id))
                        .consoleID("reply.review.\(reply.id)")
                    }
                    .padding(.vertical, 4)
                }
            } header: {
                Label(SignalText.repliesTitle, systemImage: SignalText.repliesSymbol)
                    .foregroundStyle(.orange)
            } footer: {
                Text(SignalText.repliesHint)
            }
        }
    }
}

/// La feuille d'un brouillon : le canal, le lien du fil et le texte à éditer. Une origine
/// `manual` n'a pas de fil : elle se copie, sans bouton d'envoi. Le serveur décide
/// (approbateur, poste actif) ; son refus est dit dans la feuille.
struct ReplySheet: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var signals: CorporateSignalsModel
    @ObservedObject var drafts: HarnessDrafts
    let reply: CorporateReply

    @State private var text: String
    @State private var failure: HarnessFailure?
    @State private var isSending = false
    @State private var copied = false
    /// Le texte tel que le serveur le garde : « Enregistrer » n'apparaît qu'après une modification.
    @State private var savedText: String

    init(server: HarnessModel, drafts: HarnessDrafts, reply: CorporateReply) {
        self.server = server
        self.signals = server.signals
        self.drafts = drafts
        self.reply = reply
        _text = State(initialValue: reply.text)
        _savedText = State(initialValue: reply.text)
    }

    /// « Slack · Réponse finale · paul@exemple.fr · 8 nov. 2026 à 14:05 ».
    static func origin(of reply: CorporateReply) -> String {
        var parts = [SignalText.channel(reply.channel), SignalText.replyKind(reply.kind)]
        if let person = reply.personRef, !person.isEmpty { parts.append(person) }
        parts.append(ConsoleFormat.dateTime(ms: reply.createdAt))
        return parts.joined(separator: " · ")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent(SignalText.channelLabel, value: SignalText.channel(reply.channel))
                    if let person = reply.personRef, !person.isEmpty {
                        LabeledContent(SignalText.personLabel, value: person)
                    }
                    if let url = URL(string: reply.url), url.scheme != nil {
                        LabeledContent(SignalText.threadLabel) {
                            Link(destination: url) {
                                Label(url.host() ?? reply.url, systemImage: SignalText.openThreadSymbol)
                            }
                        }
                    }
                } header: {
                    Text(SignalText.replyKind(reply.kind))
                }
                Section {
                    TextField(SignalText.replyTextLabel, text: $text, axis: .vertical)
                        .lineLimit(4...16)
                        .consoleID("reply.text")
                    if text != savedText, !reply.isCopyOnly {
                        Button(SignalText.saveReply) {
                            run { savedText = try await signals.edit(reply, text: text).text }
                        }
                        .disabled(isSending || trimmed.isEmpty)
                        .consoleID("reply.save")
                    }
                } footer: {
                    Text(reply.isCopyOnly ? SignalText.copyOnlyHint : SignalText.approveReplyHint)
                }
                if let failure {
                    Section {
                        Text(failure == .approverOnly ? SignalText.replyApproverOnly : failure.message)
                            .font(.callout)
                            .fixedSize(horizontal: false, vertical: true)
                            .consoleBanner(tone: .attention)
                            .consoleID("reply.failure")
                    }
                }
                Section {
                    Button(SignalText.archiveReply, role: .destructive) {
                        run(closing: true) { try await signals.archive(reply) }
                    }
                    .disabled(isSending)
                    .consoleID("reply.archive")
                } footer: {
                    Text(SignalText.archiveReplyHint)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(SignalText.replySheetTitle)
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.cancel) { drafts.replyShown = nil }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if reply.isCopyOnly {
                        Button(copied ? SignalText.copiedReply : SignalText.copyReply, systemImage: SignalText.copySymbol) {
                            ReplyPasteboard.copy(text)
                            copied = true
                        }
                        .consoleID("reply.copy")
                    } else {
                        Button(SignalText.approveReply) {
                            run(closing: true) { try await signals.approve(reply, text: text) }
                        }
                        .disabled(isSending || trimmed.isEmpty)
                        .consoleID("reply.approve")
                    }
                }
            }
        }
        .consoleSheetSize(minWidth: 520, minHeight: 480)
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Un geste du serveur : la feuille se ferme s'il aboutit (`closing`), dit son refus sinon.
    private func run<Done>(closing: Bool = false, _ gesture: @escaping @MainActor () async throws -> Done) {
        isSending = true
        failure = nil
        Task {
            defer { isSending = false }
            do {
                _ = try await gesture()
                if closing { drafts.replyShown = nil }
            } catch {
                failure = error as? HarnessFailure
            }
        }
    }
}

/// Le presse-papiers du système, sur le Mac comme sur l'iPhone/iPad.
enum ReplyPasteboard {
    @MainActor
    static func copy(_ text: String) {
        #if canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #elseif canImport(UIKit)
        UIPasteboard.general.string = text
        #endif
    }
}

// MARK: - Origine d'une feature

/// La section Origine de la page d'une feature : canal, personne telle que reçue, lien
/// du fil, extrait caviardé, issue et confirmation. Rien sans origine, ni pour un jeton
/// qui n'est pas celui du propriétaire. La page la lit par `signals.loadOrigin(runId:)`.
public struct RunOriginSection: View {
    @ObservedObject var signals: CorporateSignalsModel
    let runId: String

    public init(signals: CorporateSignalsModel, runId: String) {
        self.signals = signals
        self.runId = runId
    }

    public var body: some View {
        if let origin = signals.origins[runId] {
            Section {
                LabeledContent(SignalText.channelLabel, value: SignalText.channel(origin.channel))
                if let person = origin.personRef, !person.isEmpty {
                    LabeledContent(SignalText.personLabel, value: person)
                }
                if let url = URL(string: origin.url), url.scheme != nil {
                    LabeledContent(SignalText.threadLabel) {
                        Link(destination: url) {
                            Label(url.host() ?? origin.url, systemImage: SignalText.openThreadSymbol)
                        }
                    }
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(SignalText.excerptLabel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(origin.excerpt)
                        .consoleReadable()
                }
                LabeledContent(SignalText.issueLabel) {
                    if let url = URL(string: origin.issue.url), url.scheme != nil {
                        Link(issueLine(origin.issue), destination: url)
                    } else {
                        Text(issueLine(origin.issue))
                    }
                }
                Text(SignalText.confirmed(by: origin.confirmedBy, at: origin.confirmedAt.map { ConsoleFormat.dateTime(ms: $0) }))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let state = origin.reply {
                    LabeledContent(SignalText.replyLabel, value: Self.replyState(state))
                        .consoleID("run.origin.reply")
                }
            } header: {
                Text(SignalText.originTitle)
            }
            .consoleID("run.origin")
        }
    }

    /// « demo · Issue n° 12 ».
    private func issueLine(_ issue: CorporateSignalIssue) -> String {
        issue.repo + " · " + ControlText.issueNumber(issue.number)
    }

    /// L'état de la réponse au collègue ; un état inconnu de cette version se rend tel quel.
    static func replyState(_ state: CorporateReplyStatus) -> String {
        switch state {
        case .none: SignalText.replyNone
        case .draft: SignalText.replyDraft
        case .awaitingApproval: SignalText.replyAwaiting
        case .sent: SignalText.replySent
        case let .other(raw): raw
        }
    }
}
