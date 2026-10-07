// Le modèle d'action (BR-2, puis S-7/S-8/S-10 de omp-console-redesign) : le
// journal borné des gestes, les émissions (livraisons et commandes), le sondage
// des accusés, l'état de la feuille de lancement et la sollicitation du pilote.
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
import ConsoleCore
import Foundation

// `ActionJournalState` et `ActionJournalEntry` vivent désormais dans le noyau
// partagé (`ConsoleCore/Actions/ActionJournal.swift`) : les deux coques emploient
// les mêmes types, `Codable` (S-1, S-5).

@MainActor
final class ActionsModel: ObservableObject {
    /// Journal borné à 20 entrées, la plus récente en tête (S-4).
    static let journalLimit = 20

    /// Cadence du sondage des accusés (S-4).
    let ackPollMs: Double = 500

    /// Au-delà, une commande sans accusé est dite `unacknowledged` (S-8) : aucun
    /// pilote ne l'a prise. Elle reste sondée — un accusé tardif la rattrape.
    let ackTimeoutMs: Double = 20_000

    @Published private(set) var journal: [ActionJournalEntry] = []
    /// La bulle « Activité » de la barre d'outils de Pipelines.
    @Published var journalExpanded = false

    // État de la feuille de lancement (S-6, `@State` interdit sous CLT).
    @Published var launchFormShown = false
    @Published var launchTitle = ""
    @Published var launchDescription = ""
    @Published var launchRepoRoot: String?
    /// Le refus du dernier dossier choisi (pas une racine git), `nil` sinon.
    @Published var launchRepoError: String?
    /// Les deux choix de modèle de la feuille de lancement (`nil` = défaut OMP).
    @Published var launchModelReqSpecs: String?
    @Published var launchModelImplReview: String?

    /// L'état du catalogue `omp models --json` (S-5), partagé par les deux
    /// feuilles qui offrent les deux sélecteurs.
    @Published private(set) var modelCatalog: ModelCatalogState = .loading
    /// Les deux choix de la feuille d'édition des modèles d'une feature (S-5),
    /// pré-positionnés sur les valeurs courantes résolues à l'ouverture.
    @Published var editModelReqSpecs: String?
    @Published var editModelImplReview: String?

    // État de la zone d'action : au plus UNE voie renseignée (S-3).
    @Published var answerSelectedLabel: String?
    @Published var answerCustomText = ""
    @Published var steerText = ""
    /// La réponse à une question en TEXTE d'un maillon terminé (S-10).
    @Published var replyText = ""

    private let writer: PipelineWriter
    private let clock: StoreClock
    private let salt: @Sendable () -> String
    /// Qui fait conduire un dépôt sans pilote vivant (S-7) ; `nil` = aucun
    /// conducteur (les commandes attendent un pilote lancé ailleurs).
    private let pilot: PipelinePilot?
    /// Le chargement du catalogue de modèles (S-5) ; injectable pour les tests.
    private let loadModels: @Sendable () async -> Result<[String], ModelCatalogError>
    private var timer: Timer?

    /// La dernière sollicitation du pilote en vol : un test l'attend au lieu de
    /// deviner quand la tâche a fini.
    private(set) var pilotTask: Task<Void, Never>?
    /// Le dernier chargement du catalogue en vol.
    private(set) var modelCatalogTask: Task<Void, Never>?

    init(
        writer: PipelineWriter = PipelineWriter(),
        clock: StoreClock = .live,
        salt: @escaping @Sendable () -> String = ActionsModel.randomSalt,
        pilot: PipelinePilot? = nil,
        modelCatalogLoader: (@Sendable () async -> Result<[String], ModelCatalogError>)? = nil
    ) {
        self.writer = writer
        self.clock = clock
        self.salt = salt
        self.pilot = pilot
        self.loadModels = modelCatalogLoader ?? { await ModelCatalogLoader.loadDefault() }
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

    /// Le geste « Répondre » d'une question en TEXTE (S-10) : une commande `reply`
    /// adressée au dépôt de la feature, puis le pilote est sollicité.
    func submitReply(_ action: KanbanCardAction) {
        guard !Self.isBlank(replyText), let slug = action.slug, let repoRoot = action.repoRoot else { return }
        let sentAt = clock.nowMs()
        let salt = salt()
        let command = OutgoingCommand.reply(
            id: PipelineId.console(sentAt: sentAt, salt: salt),
            repo: realpathOr(repoRoot),
            slug: slug,
            text: replyText
        )
        replyText = ""
        if emitCommand(kindLabel: ActionsText.answerLabel, target: slug, command: command, sentAt: sentAt, salt: salt) {
            solicitPilot(repoRoot: repoRoot, entryID: command.id)
        }
    }

    /// Le geste « Reprendre » (S-10) : aucune commande — le conducteur démarré
    /// adopte le lot à son `session_start`. Le journal dit le résultat.
    ///
    /// Rend l'identifiant de l'entrée de journal du geste (`nil` quand aucun pilote
    /// n'est configuré) : l'appelant qui doit attendre la FIN RÉELLE du geste
    /// attend `pilotTask` puis relit CETTE entrée — jamais la tête du journal, qui
    /// est partagé par tous les gestes et borné à 20 entrées (S-10).
    @discardableResult
    func resume(_ action: KanbanCardAction) -> String? {
        guard let pilot, let repoRoot = action.repoRoot else { return nil }
        let at = clock.nowMs()
        let id = "resume-\(sentAtMillis(at))-\(salt())"
        let target = Self.repoName(repoRoot)
        pilotTask = Task { @MainActor [weak self] in
            let state: ActionJournalState
            do {
                try await pilot.ensurePilot(repoRoot: repoRoot)
                state = .taken
            } catch {
                state = .failed(reason: Self.conductorMotif(of: error))
            }
            self?.append(ActionJournalEntry(
                id: id, kindLabel: ActionsText.resumeLabel, targetLabel: target, state: state, at: at
            ))
        }
        return id
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
    /// Le pilote n'est PAS sollicité : arrêter un lot sans pilote n'a pas d'objet,
    /// et démarrer un conducteur ferait reprendre ses runs (S-7).
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
    /// Les deux modèles choisis (S-5) partent en clés optionnelles, omises quand
    /// le groupe est laissé sur le défaut OMP.
    func launch(
        title: String,
        description: String,
        repoRoot: String,
        modelReqSpecs: String? = nil,
        modelImplReview: String? = nil
    ) {
        guard !Self.isBlank(title), !Self.isBlank(description) else { return }
        let sentAt = clock.nowMs()
        let salt = salt()
        let command = OutgoingCommand.launch(
            id: PipelineId.console(sentAt: sentAt, salt: salt),
            repo: realpathOr(repoRoot),
            title: title,
            description: description,
            modelReqSpecs: Self.normalizedModel(modelReqSpecs),
            modelImplReview: Self.normalizedModel(modelImplReview)
        )
        let written = emitCommand(
            kindLabel: ActionsText.launchLabel,
            target: title,
            command: command,
            sentAt: sentAt,
            salt: salt
        )
        launchFormShown = false
        launchTitle = ""
        launchDescription = ""
        launchModelReqSpecs = nil
        launchModelImplReview = nil
        if written { solicitPilot(repoRoot: repoRoot, entryID: command.id) }
    }

    // --- modèles (S-5) -------------------------------------------------------

    /// Lance le chargement du catalogue `omp models --json` et publie son état.
    /// Les deux feuilles s'en servent ; un échec laisse l'édition possible.
    func loadModelCatalog() {
        modelCatalog = .loading
        let loader = loadModels
        modelCatalogTask = Task { @MainActor [weak self] in
            let result = await loader()
            guard let self else { return }
            switch result {
            case .success(let selectors): self.modelCatalog = .loaded(selectors)
            case .failure(let error): self.modelCatalog = .failed(error.reason)
            }
        }
    }

    /// Pré-positionne la feuille d'édition sur les valeurs courantes RÉSOLUES
    /// d'une feature (`nil` = défaut OMP).
    func beginModelsEdit(_ slots: ModelSlots?) {
        editModelReqSpecs = slots?.reqSpecs
        editModelImplReview = slots?.implReview
    }

    /// Émet `{kind:"models"}` (S-5) : remplace les deux modèles d'une feature. Un
    /// groupe laissé vide part en `null` — le pilote efface la clé.
    func setModels(repoRoot: String, slug: String, modelReqSpecs: String?, modelImplReview: String?) {
        guard !Self.isBlank(slug) else { return }
        let sentAt = clock.nowMs()
        let salt = salt()
        let command = OutgoingCommand.models(
            id: PipelineId.console(sentAt: sentAt, salt: salt),
            repo: realpathOr(repoRoot),
            slug: slug,
            modelReqSpecs: Self.normalizedModel(modelReqSpecs),
            modelImplReview: Self.normalizedModel(modelImplReview)
        )
        if emitCommand(
            kindLabel: ActionsText.modelsLabel,
            target: slug,
            command: command,
            sentAt: sentAt,
            salt: salt
        ) {
            solicitPilot(repoRoot: repoRoot, entryID: command.id)
        }
    }

    /// Un sélecteur de modèle : `nil` pour une valeur absente ou blanche (le
    /// groupe est alors laissé sur le défaut OMP).
    private static func normalizedModel(_ value: String?) -> String? {
        guard let value, !isBlank(value) else { return nil }
        return value
    }

    // --- sondage des accusés (S-4, S-8) --------------------------------------

    /// Une passe de sondage : met à jour chaque entrée en attente dont l'accusé est
    /// lisible, dit `unacknowledged` celles qui attendent depuis `ackTimeoutMs`
    /// sans accusé (elles restent sondées), puis éteint le minuteur dès qu'il ne
    /// reste plus rien à attendre.
    func pollAcks() {
        let now = clock.nowMs()
        for index in journal.indices where Self.isPending(journal[index].state) {
            if let ack = writer.readAck(id: journal[index].id) {
                journal[index].state = ack.state == .taken ? .taken : .refused(reason: ack.reason)
            } else if journal[index].state == .awaitingAck, now - journal[index].at >= ackTimeoutMs {
                journal[index].state = .unacknowledged
            }
        }
        if !journal.contains(where: { Self.isPending($0.state) }) { stopTimer() }
    }

    // --- pilote (S-7) --------------------------------------------------------

    /// Sollicite le pilote APRÈS le dépôt de la commande : c'est ce qui fait armer
    /// un conducteur neuf à son `session_start`. Un échec ne touche que l'entrée
    /// `entryID`, et seulement si elle attend encore son accusé.
    private func solicitPilot(repoRoot: String, entryID: String) {
        guard let pilot else { return }
        pilotTask = Task { @MainActor [weak self] in
            do {
                try await pilot.ensurePilot(repoRoot: repoRoot)
            } catch {
                self?.pilotFailed(entryID: entryID, reason: Self.conductorMotif(of: error))
            }
        }
    }

    private func pilotFailed(entryID: String, reason: String) {
        guard let index = journal.firstIndex(where: { $0.id == entryID }),
              Self.isPending(journal[index].state) else { return }
        journal[index].state = .failed(reason: reason)
    }

    /// `conducteur : <message>` — le message utilisateur d'une erreur d'hôte.
    private static func conductorMotif(of error: Error) -> String {
        "conducteur : \((error as? SessionHostError)?.userMessage ?? String(describing: error))"
    }

    private static func isPending(_ state: ActionJournalState) -> Bool {
        state == .awaitingAck || state == .unacknowledged
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
        if emitCommand(kindLabel: kindLabel, target: slug, command: command, sentAt: sentAt, salt: salt) {
            solicitPilot(repoRoot: repoRoot, entryID: command.id)
        }
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

    /// Écrit la commande et journalise ; rend `true` quand le fichier est déposé.
    @discardableResult
    private func emitCommand(
        kindLabel: String,
        target: String,
        command: OutgoingCommand,
        sentAt: Double,
        salt: String
    ) -> Bool {
        do {
            try writer.writeCommand(command, sentAt: sentAt, salt: salt)
            append(ActionJournalEntry(
                id: command.id, kindLabel: kindLabel, targetLabel: target, state: .awaitingAck, at: sentAt
            ))
            armTimer()
            return true
        } catch {
            append(ActionJournalEntry(
                id: command.id, kindLabel: kindLabel, targetLabel: target,
                state: .failed(reason: Self.motif(of: error)), at: sentAt
            ))
            return false
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
