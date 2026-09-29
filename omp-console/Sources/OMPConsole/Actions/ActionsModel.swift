// Le modèle d'action du Kanban (BR-2) : le journal borné des gestes, les
// émissions (livraisons et commandes), le sondage des accusés et l'état du
// formulaire de lancement.
//
// Deux invariants de forme :
//   - l'app n'écrit QUE par `PipelineWriter` : jamais un état de lot, jamais un
//     accusé, jamais `commands/` en dehors de ses propres identifiants (S-11) ;
//   - aucune phrase n'est composée ici : la mise en texte d'une entrée est
//     `ActionsText.journalLine(for:)`.
//
// L'horloge et le nonce sont INJECTABLES (patron `StoreClock`), et le sondage est
// une méthode publique appelable par un test (`controller.pumpCommands` côté
// TypeScript) : aucun minuteur ne tourne à vide.

import Combine
import Foundation

/// L'état d'une entrée de journal (S-4) : en attente d'accusé, prise en charge,
/// refusée (avec le motif du pilote ou sans), déposée, ou en échec d'écriture.
enum ActionJournalState: Sendable, Equatable {
    case awaitingAck
    case taken
    case refused(reason: String?)
    case delivered
    case failed(reason: String)
}

/// Une entrée du journal des gestes : le libellé du geste (`réponse`, `texte`,
/// `jalon specs`, `jalon revue`, `lancement`, `arrêt`), la cible (label du run,
/// slug, titre, nom du dépôt) et l'état.
struct ActionJournalEntry: Identifiable, Sendable, Equatable {
    let id: String
    let kindLabel: String
    let targetLabel: String
    var state: ActionJournalState
    let at: Double
}

@MainActor
final class ActionsModel: ObservableObject {
    /// Journal borné à 20 entrées, la plus récente en tête (S-4).
    static let journalLimit = 20

    /// Cadence du sondage des accusés (S-4).
    let ackPollMs: Double = 500

    @Published private(set) var journal: [ActionJournalEntry] = []

    // État du formulaire de lancement (BR-2, `@State` interdit sous CLT).
    @Published var launchFormShown = false
    @Published var launchTitle = ""
    @Published var launchDescription = ""
    @Published var launchRepoRoot: String?

    // État de la zone d'action : au plus UNE voie renseignée (S-3).
    @Published var answerSelectedLabel: String?
    @Published var answerCustomText = ""
    @Published var steerText = ""

    private let writer: PipelineWriter
    private let clock: StoreClock
    private let salt: @Sendable () -> String
    private var timer: Timer?

    init(
        writer: PipelineWriter = PipelineWriter(),
        clock: StoreClock = .live,
        salt: @escaping @Sendable () -> String = ActionsModel.randomSalt
    ) {
        self.writer = writer
        self.clock = clock
        self.salt = salt
    }

    /// Quatre hexadécimaux minuscules : le nom d'un fichier du canal doit porter un
    /// `salt` du motif `<4 hex>` pour être lu par le pilote (`COMMAND_FILE`).
    nonisolated static func randomSalt() -> String {
        var generator = SystemRandomNumberGenerator()
        return String(format: "%04x", UInt16.random(in: 0...0xFFFF, using: &generator))
    }

    // --- zone de réponse (S-3) -----------------------------------------------

    /// Le bouton « Répondre » n'est actif que si exactement une voie est
    /// renseignée, le texte libre étant jugé non blanc.
    var answerReady: Bool {
        answerSelectedLabel != nil || !Self.isBlank(answerCustomText)
    }

    /// Sélectionner une option VIDE le champ libre (S-3).
    func selectAnswerOption(_ label: String) {
        answerSelectedLabel = label
        answerCustomText = ""
    }

    /// Saisir dans le champ libre DÉSÉLECTIONNE l'option (S-3).
    func setAnswerCustomText(_ text: String) {
        answerCustomText = text
        if !text.isEmpty { answerSelectedLabel = nil }
    }

    func clearAnswer() {
        answerSelectedLabel = nil
        answerCustomText = ""
    }

    /// Le geste « Répondre » : la voie renseignée part en une livraison `ask`, puis
    /// l'état de saisie est remis à zéro.
    func submitAnswer(_ action: KanbanCardAction) {
        if let label = answerSelectedLabel {
            answer(action, selected: label)
        } else if !Self.isBlank(answerCustomText) {
            answer(action, custom: answerCustomText)
        } else {
            return
        }
        clearAnswer()
    }

    /// Le geste « Envoyer » : un texte libre non blanc part, puis le champ est vidé.
    func submitSteer(_ action: KanbanCardAction) {
        guard !Self.isBlank(steerText) else { return }
        sendText(action, text: steerText)
        steerText = ""
    }

    // --- émissions : livraisons (S-1, S-2) -----------------------------------

    /// Dépose la réponse à une question en vol (libellé d'option).
    func answer(_ action: KanbanCardAction, selected: String) {
        guard let run = action.run, let inbox = run.inbox,
              let toolCallId = run.pendingAsk?.toolCallId else { return }
        emitDelivery(
            inbox: inbox,
            kindLabel: ActionsText.answerLabel,
            target: run.label,
            delivery: .ask(toolCallId: toolCallId, answer: .selected(selected))
        )
    }

    /// Dépose la réponse à une question en vol (texte libre) — la garde du texte
    /// blanc s'applique aussi ici (S-1).
    func answer(_ action: KanbanCardAction, custom text: String) {
        guard !Self.isBlank(text) else { return }
        guard let run = action.run, let inbox = run.inbox,
              let toolCallId = run.pendingAsk?.toolCallId else { return }
        emitDelivery(
            inbox: inbox,
            kindLabel: ActionsText.answerLabel,
            target: run.label,
            delivery: .ask(toolCallId: toolCallId, answer: .custom(text))
        )
    }

    /// Dépose un texte libre sur un run vivant sans question en vol.
    func sendText(_ action: KanbanCardAction, text: String) {
        guard !Self.isBlank(text) else { return }
        guard let run = action.run, let inbox = run.inbox else { return }
        emitDelivery(
            inbox: inbox,
            kindLabel: ActionsText.textLabel,
            target: run.label,
            delivery: .text(text: text)
        )
    }

    // --- émissions : commandes (S-4 … S-8) -----------------------------------

    /// Émet `{kind:"verdict", verdict:"v"}` — le jalon specs.
    func validate(_ action: KanbanCardAction) {
        guard let slug = action.slug, let repoRoot = action.repoRoot else { return }
        emitVerdict(slug: slug, repoRoot: repoRoot, verdict: .specs, kindLabel: ActionsText.specsLabel)
    }

    /// Émet `{kind:"verdict", verdict:"y"}` — le jalon de revue.
    func accept(_ action: KanbanCardAction) {
        guard let slug = action.slug, let repoRoot = action.repoRoot else { return }
        emitVerdict(slug: slug, repoRoot: repoRoot, verdict: .review, kindLabel: ActionsText.reviewLabel)
    }

    /// Émet `{kind:"stop"}` — adressé au DÉPÔT (le canal n'a pas d'arrêt par run).
    func stopLot(_ action: KanbanCardAction) {
        guard action.slug != nil, let repoRoot = action.repoRoot else { return }
        let sentAt = clock.nowMs()
        let salt = salt()
        let command = OutgoingCommand.stop(
            id: PipelineId.console(sentAt: sentAt, salt: salt),
            repo: realpathOr(repoRoot)
        )
        emitCommand(
            kindLabel: ActionsText.stopLabel,
            target: Self.repoName(repoRoot),
            command: command,
            sentAt: sentAt,
            salt: salt
        )
    }

    /// Émet `{kind:"launch"}` : le slug est dérivé par le DÉPÔT, jamais par l'app.
    func launch(title: String, description: String, repoRoot: String) {
        guard !Self.isBlank(title), !Self.isBlank(description) else { return }
        let sentAt = clock.nowMs()
        let salt = salt()
        let command = OutgoingCommand.launch(
            id: PipelineId.console(sentAt: sentAt, salt: salt),
            repo: realpathOr(repoRoot),
            title: title,
            description: description
        )
        emitCommand(
            kindLabel: ActionsText.launchLabel,
            target: title,
            command: command,
            sentAt: sentAt,
            salt: salt
        )
        launchFormShown = false
        launchTitle = ""
        launchDescription = ""
    }

    // --- sondage des accusés (S-4) -------------------------------------------

    /// Une passe de sondage : met à jour chaque entrée en attente dont l'accusé est
    /// lisible, puis éteint le minuteur dès qu'il ne reste plus rien à attendre.
    func pollAcks() {
        for index in journal.indices {
            guard journal[index].state == .awaitingAck else { continue }
            guard let ack = writer.readAck(id: journal[index].id) else { continue }
            journal[index].state = ack.state == .taken ? .taken : .refused(reason: ack.reason)
        }
        if !journal.contains(where: { $0.state == .awaitingAck }) { stopTimer() }
    }

    // --- outillage -----------------------------------------------------------

    private func emitVerdict(
        slug: String,
        repoRoot: String,
        verdict: MilestoneVerdict,
        kindLabel: String
    ) {
        let sentAt = clock.nowMs()
        let salt = salt()
        let command = OutgoingCommand.verdict(
            id: PipelineId.console(sentAt: sentAt, salt: salt),
            repo: realpathOr(repoRoot),
            slug: slug,
            verdict: verdict
        )
        emitCommand(kindLabel: kindLabel, target: slug, command: command, sentAt: sentAt, salt: salt)
    }

    private func emitDelivery(
        inbox: String,
        kindLabel: String,
        target: String,
        delivery: OutgoingDelivery
    ) {
        let sentAt = clock.nowMs()
        let salt = salt()
        let id = "delivery-\(sentAtMillis(sentAt))-\(salt)"
        do {
            try writer.writeDelivery(inbox: inbox, delivery: delivery, sentAt: sentAt, salt: salt)
            append(ActionJournalEntry(
                id: id, kindLabel: kindLabel, targetLabel: target, state: .delivered, at: sentAt
            ))
        } catch {
            append(ActionJournalEntry(
                id: id, kindLabel: kindLabel, targetLabel: target,
                state: .failed(reason: Self.motif(of: error)), at: sentAt
            ))
        }
    }

    private func emitCommand(
        kindLabel: String,
        target: String,
        command: OutgoingCommand,
        sentAt: Double,
        salt: String
    ) {
        do {
            try writer.writeCommand(command, sentAt: sentAt, salt: salt)
            append(ActionJournalEntry(
                id: command.id, kindLabel: kindLabel, targetLabel: target, state: .awaitingAck, at: sentAt
            ))
            armTimer()
        } catch {
            append(ActionJournalEntry(
                id: command.id, kindLabel: kindLabel, targetLabel: target,
                state: .failed(reason: Self.motif(of: error)), at: sentAt
            ))
        }
    }

    /// Le motif d'un échec d'écriture : celui de `PipelineWriter`, jamais une
    /// `localizedDescription`.
    private static func motif(of error: Error) -> String {
        (error as? PipelineWriteFailure)?.reason ?? "écriture impossible (\(error))"
    }

    private func append(_ entry: ActionJournalEntry) {
        journal.insert(entry, at: 0)
        if journal.count > Self.journalLimit {
            journal.removeLast(journal.count - Self.journalLimit)
        }
    }

    private func armTimer() {
        guard timer == nil else { return }
        let timer = Timer(timeInterval: ackPollMs / 1000, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.pollAcks() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    private static func isBlank(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Le nom du dépôt d'une cible du journal d'arrêt : le dernier segment du
    /// chemin réel.
    private static func repoName(_ root: String) -> String {
        let path = realpathOr(root)
        let trimmed = path.hasSuffix("/") ? String(path.dropLast()) : path
        guard let slash = trimmed.lastIndex(of: "/") else { return trimmed }
        return String(trimmed[trimmed.index(after: slash)...])
    }
}
