// Le modèle d'action (BR-2, puis S-7/S-8/S-9/S-10 de omp-console-redesign) : le
// journal borné des gestes, les émissions (livraisons et commandes), l'état de la
// feuille de lancement.
//
// Deux invariants de forme :
//   - l'app n'écrit QUE par `PipelineWriter` : une livraison dans la boîte d'un run
//     vivant, et — pour un geste de carte — une commande POSTÉE au service (S-9) ;
//     jamais un état de lot, jamais un accusé de fichier ;
//   - aucune phrase n'est composée ici : la mise en texte d'une entrée est
//     `ActionsText.journalLine(for:)`.
//
// L'horloge et le nonce sont INJECTABLES (patron `StoreClock`).

import Combine
import ConsoleCore
import Foundation

// `ActionJournalState` et `ActionJournalEntry` vivent dans le noyau partagé
// (`ConsoleCore/Actions/ActionJournal.swift`) : les deux coques emploient les
// mêmes types, `Codable` (S-1, S-5).

@MainActor
final class ActionsModel: ObservableObject {
    /// Journal borné à 20 entrées, la plus récente en tête (S-4).
    static let journalLimit = 20

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
    /// Les noms lisibles du catalogue (sélecteur → nom), `[:]` tant qu'il n'est
    /// pas chargé ou en échec : chaque surface retombe alors sur le sélecteur.
    @Published private(set) var modelNames: [String: String] = [:]
    /// Les deux choix de la feuille d'édition des modèles d'une feature (S-5).
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
    /// Le chargement du catalogue de modèles (S-5) ; injectable pour les tests.
    private let loadModels: @Sendable () async -> Result<ModelCatalogListing, ModelCatalogError>

    /// La dernière émission de commande en vol : un test l'attend au lieu de
    /// deviner quand la tâche a fini.
    private(set) var commandTask: Task<Void, Never>?
    /// Le dernier chargement du catalogue en vol.
    private(set) var modelCatalogTask: Task<Void, Never>?

    init(
        writer: PipelineWriter = PipelineWriter(),
        clock: StoreClock = .live,
        salt: @escaping @Sendable () -> String = ActionsModel.randomSalt,
        modelCatalogLoader: (@Sendable () async -> Result<ModelCatalogListing, ModelCatalogError>)? = nil
    ) {
        self.writer = writer
        self.clock = clock
        self.salt = salt
        self.loadModels = modelCatalogLoader ?? { await ModelCatalogLoader.loadListing() }
    }

    /// Quatre hexadécimaux minuscules : le nom d'un fichier de livraison doit
    /// porter un `salt` du motif `<4 hex>`.
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
    /// adressée au dépôt de la feature.
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
        emitCommand(kindLabel: ActionsText.answerLabel, target: slug, repoRoot: repoRoot, command: command, sentAt: sentAt)
    }

    /// Le geste « Reprendre » (S-9) : `POST /v1/repos/{repo}/pilot`. Le journal dit
    /// le résultat.
    ///
    /// Rend l'identifiant de l'entrée de journal du geste (`nil` quand la carte n'a
    /// pas de dépôt) : l'appelant qui doit attendre la FIN RÉELLE du geste attend
    /// `commandTask` puis relit CETTE entrée — jamais la tête du journal, qui est
    /// partagé par tous les gestes et borné à 20 entrées (S-10 de la coque).
    @discardableResult
    func resume(_ action: KanbanCardAction) -> String? {
        guard let repoRoot = action.repoRoot else { return nil }
        let at = clock.nowMs()
        let id = "resume-\(sentAtMillis(at))-\(salt())"
        let target = Self.repoName(repoRoot)
        let writer = self.writer
        commandTask = Task { @MainActor [weak self] in
            let state: ActionJournalState
            do {
                try await writer.pilot(repo: realpathOr(repoRoot))
                state = .taken
            } catch {
                state = .failed(reason: Self.pilotMotif(of: error))
            }
            self?.append(ActionJournalEntry(
                id: id, kindLabel: ActionsText.resumeLabel, targetLabel: target, state: state, at: at
            ))
        }
        return id
    }

    /// Le geste « Reprendre » d'une feature en ÉCHEC ou BLOQUÉE (S-3 de
    /// accueil-en-cours-melange-pause-et-compte) : émet `{kind:"relaunch"}`, que
    /// le service accepte sur une feature `failed`/`blocked` et qui la remet
    /// `running` (session reprise, compteurs remis à zéro).
    ///
    /// Rend l'identifiant de la commande, qui est aussi celui de son entrée de
    /// journal (même usage que `resume`), ou `nil` sans rien journaliser quand la
    /// carte n'est pas une feature de lot en échec ou bloquée.
    @discardableResult
    func relaunch(_ action: KanbanCardAction) -> String? {
        guard let slug = action.slug, let repoRoot = action.repoRoot,
              action.featureState == .failed || action.featureState == .blocked
        else { return nil }
        let sentAt = clock.nowMs()
        let salt = salt()
        let command = OutgoingCommand.relaunch(
            id: PipelineId.console(sentAt: sentAt, salt: salt),
            repo: realpathOr(repoRoot),
            slug: slug
        )
        emitCommand(
            kindLabel: ActionsText.resumeLabel,
            target: slug,
            repoRoot: repoRoot,
            command: command,
            sentAt: sentAt
        )
        return command.id
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

    /// Dépose la réponse à une question en vol (texte libre).
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

    // --- émissions : commandes (S-4 … S-9) -----------------------------------

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

    /// Émet `{kind:"stop"}` — adressé au DÉPÔT.
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
            repoRoot: repoRoot,
            command: command,
            sentAt: sentAt
        )
    }

    /// Émet `{kind:"launch"}` : le slug est dérivé par le DÉPÔT, jamais par l'app.
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
        emitCommand(
            kindLabel: ActionsText.launchLabel,
            target: title,
            repoRoot: repoRoot,
            command: command,
            sentAt: sentAt
        )
        launchFormShown = false
        launchTitle = ""
        launchDescription = ""
        launchModelReqSpecs = nil
        launchModelImplReview = nil
    }

    // --- modèles (S-5) -------------------------------------------------------

    /// Lance le chargement du catalogue `omp models --json` et publie son état
    /// et ses noms lisibles.
    func loadModelCatalog() {
        modelCatalog = .loading
        let loader = loadModels
        modelCatalogTask = Task { @MainActor [weak self] in
            let result = await loader()
            guard let self else { return }
            switch result {
            case .success(let listing):
                self.modelCatalog = .loaded(listing.selectors)
                self.modelNames = listing.names
            case .failure(let error):
                self.modelCatalog = .failed(error.reason)
                self.modelNames = [:]
            }
        }
    }

    /// Pré-positionne la feuille d'édition sur les valeurs courantes RÉSOLUES.
    func beginModelsEdit(_ slots: ModelSlots?) {
        editModelReqSpecs = slots?.reqSpecs
        editModelImplReview = slots?.implReview
    }

    /// Émet `{kind:"models"}` (S-5) : remplace les deux modèles d'une feature.
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
        emitCommand(
            kindLabel: ActionsText.modelsLabel,
            target: slug,
            repoRoot: repoRoot,
            command: command,
            sentAt: sentAt
        )
    }

    /// Un sélecteur de modèle : `nil` pour une valeur absente ou blanche.
    private static func normalizedModel(_ value: String?) -> String? {
        guard let value, !isBlank(value) else { return nil }
        return value
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
        emitCommand(kindLabel: kindLabel, target: slug, repoRoot: repoRoot, command: command, sentAt: sentAt)
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

    /// Poste la commande au service (S-9) : l'entrée entre d'abord en attente,
    /// puis prend l'accusé rendu par la réponse — ou échoue avec le motif.
    private func emitCommand(
        kindLabel: String,
        target: String,
        repoRoot: String,
        command: OutgoingCommand,
        sentAt: Double
    ) {
        append(ActionJournalEntry(
            id: command.id, kindLabel: kindLabel, targetLabel: target, state: .awaitingAck, at: sentAt
        ))
        let writer = self.writer
        let repo = realpathOr(repoRoot)
        let id = command.id
        commandTask = Task { @MainActor [weak self] in
            do {
                let ack = try await writer.postCommand(repo: repo, command: command, sentAt: sentAt)
                self?.settle(id: id, with: ack)
            } catch {
                self?.settle(id: id, with: .failed(reason: Self.motif(of: error)))
            }
        }
    }

    /// Applique le résultat d'une commande à son entrée : prise en charge, refus
    /// au motif VERBATIM, ou échec local.
    private func settle(id: String, with ack: ServiceCommandAck) {
        guard let index = journal.firstIndex(where: { $0.id == id }) else { return }
        journal[index].state = ack.state == .taken ? .taken : .refused(reason: ack.reason)
    }

    private func settle(id: String, with state: ActionJournalState) {
        guard let index = journal.firstIndex(where: { $0.id == id }) else { return }
        journal[index].state = state
    }

    /// Le motif d'un échec d'écriture de livraison : celui de `PipelineWriter`.
    private static func motif(of error: Error) -> String {
        if let failure = error as? PipelineWriteFailure { return failure.reason }
        return ServiceSessionModel.userMessage(of: error)
    }

    /// `pilote : <message>` — le message utilisateur d'une erreur du service.
    private static func pilotMotif(of error: Error) -> String {
        "pilote : \(ServiceSessionModel.userMessage(of: error))"
    }

    private func append(_ entry: ActionJournalEntry) {
        journal.insert(entry, at: 0)
        if journal.count > Self.journalLimit {
            journal.removeLast(journal.count - Self.journalLimit)
        }
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
