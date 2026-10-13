// Les routes de GESTE (S-10, S-11, S-12) : les gestes de la coque, servis à
// distance. Ils passent EXCLUSIVEMENT par les méthodes publiques des modèles
// existants — `ActionsModel`, `ProjectConsoleModel`, `SessionConsoleModel`,
// `AuditConsoleModel` — et n'ouvrent aucune seconde voie d'écriture : pas
// d'écriture directe dans `<stateDir>`, pas de process lancé (les gestes partent
// au service par son API).

import ConsoleCore
import Foundation

@MainActor
final class RemoteActions {
    private let kanban: KanbanModel
    private let actions: ActionsModel
    private let session: SessionConsoleModel
    private let project: ProjectConsoleModel
    private let audit: AuditConsoleModel
    private let hub: StoreHub
    private let environment: [String: String]
    private let clock: RemoteClock

    init(
        kanban: KanbanModel,
        actions: ActionsModel,
        session: SessionConsoleModel,
        project: ProjectConsoleModel,
        audit: AuditConsoleModel,
        hub: StoreHub,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        clock: RemoteClock = .live
    ) {
        self.kanban = kanban
        self.actions = actions
        self.session = session
        self.project = project
        self.audit = audit
        self.hub = hub
        self.environment = environment
        self.clock = clock
    }

    // MARK: - Cartes

    private func card(_ id: String) throws(GestureRefusal) -> KanbanCard {
        guard let card = kanban.state.card(id) else { throw .unknownCard }
        return card
    }

    private func action(_ card: KanbanCard) throws(GestureRefusal) -> KanbanCardAction {
        guard let action = card.action else { throw .cardWithoutGesture }
        return action
    }

    /// Le journal dit l'échec d'écriture du canal : la route ne rend jamais un 202
    /// mensonger (S-10). L'entrée écrite par le geste est repérée par son IDENTITÉ
    /// (le journal est BORNÉ à 20 entrées : comparer les comptes est faux quand il
    /// est plein, le compte ne bouge plus).
    private func checkJournal(since id: String?) throws(GestureRefusal) {
        guard let entry = actions.journal.first, entry.id != id else { return }
        if case .failed(let reason) = entry.state {
            throw .journalFailure(reason)
        }
    }

    private static func isBlank(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: - Répondre, texte, jalon

    /// L'identifiant de question est OBLIGATOIRE (protocole 2) : absent ou blanc,
    /// il est refusé. Le routeur s'en sert aussi pour qu'un identifiant manquant
    /// prime sur un `kind` inconnu.
    static func requireQuestionId(_ toolCallId: String?) throws(GestureRefusal) -> String {
        guard let toolCallId, !isBlank(toolCallId) else { throw .missingQuestionId }
        return toolCallId
    }

    /// Répond à la question en vol de la carte. L'identifiant de question est
    /// obligatoire et se contrôle après la question en vol, AVANT le libellé : une
    /// réponse tardive vise une question qui n'est plus en vol, elle est périmée
    /// même si son libellé n'existe pas dans la nouvelle question. Aucun refus ne
    /// livre quoi que ce soit à la pipeline.
    func answer(cardId: String, toolCallId: String, answer: CardAnswer) async throws(GestureRefusal) {
        let card = try card(cardId)
        let action = try action(card)
        guard let ask = action.run?.pendingAsk else { throw .noQuestionInFlight }
        guard try Self.requireQuestionId(toolCallId) == ask.toolCallId else { throw .staleQuestion }
        let before = actions.journal.first?.id
        switch answer {
        case .selected(let label):
            guard ask.options.contains(where: { $0.label == label }) else { throw .labelNotInOptions }
            actions.answer(action, selected: label)
        case .custom(let text):
            guard !Self.isBlank(text) else { throw .emptyText }
            actions.answer(action, custom: text)
        }
        try checkJournal(since: before)
    }

    func reply(cardId: String, text: String) async throws(GestureRefusal) {
        let card = try card(cardId)
        let action = try action(card)
        guard action.waitPrompt != nil else { throw .notAwaitingReply }
        guard !Self.isBlank(text) else { throw .emptyText }
        let before = actions.journal.first?.id
        actions.replyText = text
        actions.submitReply(action)
        try checkJournal(since: before)
    }

    func text(cardId: String, text: String) async throws(GestureRefusal) {
        let card = try card(cardId)
        let action = try action(card)
        guard action.run?.inbox != nil else { throw .noLiveRun }
        guard !Self.isBlank(text) else { throw .emptyText }
        let before = actions.journal.first?.id
        actions.sendText(action, text: text)
        try checkJournal(since: before)
    }

    func verdict(cardId: String, verdict: MilestoneVerdict) async throws(GestureRefusal) {
        let card = try card(cardId)
        let action = try action(card)
        let before = actions.journal.first?.id
        switch verdict {
        case .specs:
            guard action.waitKind == .specs else { throw .milestoneNotAwaited }
            actions.validate(action)
        case .review:
            guard action.waitKind == .review else { throw .milestoneNotAwaited }
            actions.accept(action)
        }
        try checkJournal(since: before)
    }

    func resume(cardId: String) async throws(GestureRefusal) {
        let card = try card(cardId)
        let action = try action(card)
        // Une feature de lot en échec ou bloquée se RELANCE par la commande de
        // service `relaunch` (S-3 de accueil-en-cours-melange-pause-et-compte) :
        // même route, même charge utile, donc un client iOS déjà installé obtient
        // la relance sans mise à jour. Toute autre carte garde la reprise du pilote.
        if KanbanActionPresentation.relaunchable(card) {
            try await relaunch(action)
            return
        }
        guard action.repoRoot != nil else { throw .cardWithoutRepository }
        guard let entryId = actions.resume(action) else {
            // Carte sans dépôt : le geste n'a rien à armer (l'effet de bord
            // observable est l'entrée de journal, S-10).
            return
        }
        // La réponse attend la FIN RÉELLE du geste, jamais une borne devinée : le
        // service peut légitimement mettre du temps à adopter le lot, donc une
        // attente plus courte rendrait un 202 mensonger sur une panne tardive.
        // L'entrée est ensuite relue par SON identifiant — le journal est partagé
        // par tous les gestes et borné à 20 entrées, donc sa tête n'est pas celle
        // de ce geste.
        let task = actions.commandTask
        await task?.value
        guard let entry = actions.journal.first(where: { $0.id == entryId }) else {
            throw .nothingRecorded
        }
        if case .failed(let reason) = entry.state {
            // Le motif du journal préfixe la traduction du service : la route rend
            // le message utilisateur du client (S-10).
            let message = reason.hasPrefix("pilote : ")
                ? String(reason.dropFirst("pilote : ".count))
                : reason
            throw .serviceFailure(message)
        }
    }

    /// La relance d'une carte relançable : la réponse attend l'accusé du service
    /// (`commandTask`), puis relit l'entrée de journal par l'identifiant de la
    /// commande. Un refus est un 409 au motif du service, une panne d'envoi un 503.
    private func relaunch(_ action: KanbanCardAction) async throws(GestureRefusal) {
        guard let entryId = actions.relaunch(action) else { throw .nothingRecorded }
        let task = actions.commandTask
        await task?.value
        guard let entry = actions.journal.first(where: { $0.id == entryId }) else {
            throw .nothingRecorded
        }
        switch entry.state {
        case .refused(let reason):
            throw .relaunchRefused(reason)
        case .failed(let reason):
            throw .serviceFailure(reason)
        default:
            return
        }
    }

    func stop(cardId: String) async throws(GestureRefusal) {
        let card = try card(cardId)
        let action = try action(card)
        guard action.slug != nil, action.repoRoot != nil else { throw .cardWithoutLot }
        let before = actions.journal.first?.id
        actions.stopLot(action)
        try checkJournal(since: before)
    }

    func launch(
        repoRoot: String,
        title: String,
        description: String,
        modelReqSpecs: String?,
        modelImplReview: String?
    ) async throws(GestureRefusal) {
        guard !Self.isBlank(title) else { throw .emptyTitle }
        // MÊME règle que la feuille « Nouvelle feature » : le titre ET la
        // description doivent être non blancs — sinon `ActionsModel.launch` sort
        // sans déposer de commande, et un 202 serait mensonger (S-10).
        guard !Self.isBlank(description) else { throw .emptyDescription }
        guard !repoRoot.isEmpty, LaunchRepo.isGitRoot(path: repoRoot) else { throw .invalidRepoRoot }
        let before = actions.journal.first?.id
        actions.launch(
            title: title,
            description: description,
            repoRoot: repoRoot,
            modelReqSpecs: modelReqSpecs,
            modelImplReview: modelImplReview
        )
        try checkJournal(since: before)
    }

    // MARK: - Conduite

    /// Les dépôts connus de la coque (S-8) : les lots du magasin ∪ les projets du
    /// magasin, `realpath`és, filtrés par la règle « racine git » de `LaunchRepo`,
    /// dédupliqués par chemin puis triés. La clé est celle du pilote
    /// (`KanbanRepoKey`, seule implémentation), jamais recalculée.
    func knownRepos() -> [RemoteRepoRow] {
        KnownProjects.roots(in: hub.current()).map { path in
            RemoteRepoRow(
                repoKey: KanbanRepoKey.key(forRoot: path),
                repoRoot: path,
                name: (path as NSString).lastPathComponent
            )
        }
    }

    /// L'état réduit de la conduite (S-11, S-9) : même source que l'en-tête macOS,
    /// donc les mots sont identiques par construction.
    func conduite() -> RemoteConduiteStatePayload {
        Self.conduitePayload(self.project)
    }

    static func conduitePayload(_ project: ProjectConsoleModel) -> RemoteConduiteStatePayload {
        RemoteConduiteStatePayload(
            state: conduiteStateName(project.state),
            repoKey: project.identity.map { KanbanRepoKey.key(forRoot: $0.repoRoot.path) },
            name: project.identity?.name,
            repoRoot: project.identity?.repoRoot.path,
            status: project.sessionStatus,
            dialogs: project.host.dialogQueue
        )
    }

    static func conduiteStateName(_ state: ConduiteState) -> String {
        switch state {
        case .none: return "none"
        case .starting: return "starting"
        case .live: return "live"
        case .closing: return "closing"
        case .closed: return "closed"
        }
    }

    /// Répond à l'escalade `{id}` de la conduite (S-4). La validation dépend de la
    /// forme de l'escalade ; le contrôle d'identité ET l'écriture de la réponse
    /// sont faits dans la MÊME exécution du `@MainActor` (`ProjectConsoleModel.answer`
    /// est synchrone, aucun `await` entre les deux) : la file ne peut pas glisser.
    func answerDialog(id: String, answer: DialogAnswer) async throws(GestureRefusal) {
        guard let dialog = self.project.pendingDialog else { throw .noPendingDialog }
        let response = try Self.dialogResponse(dialog, id: id, answer: answer, queue: .conduite)
        guard self.project.answer(dialogId: id, response: response) else { throw .staleDialog(.conduite) }
    }

    /// Les règles communes aux dialogues de la conduite et de la session hébergée :
    /// identité de la tête de file, puis forme de la réponse selon la méthode.
    private static func dialogResponse(
        _ dialog: RpcDialogRequest,
        id: String,
        answer: DialogAnswer,
        queue: DialogQueue
    ) throws(GestureRefusal) -> RpcDialogResponse {
        guard dialog.id == id else { throw .staleDialog(queue) }
        switch answer {
        case .value(let value):
            switch dialog.method {
            case .select:
                guard dialog.options.contains(value) else { throw .dialogLabelNotInOptions(queue) }
            case .input:
                guard !isBlank(value) else { throw .emptyText }
            case .editor:
                // Une valeur VIDE est acceptée : c'est la coque (ou la session) qui juge.
                break
            case .confirm:
                throw .valueNotExpected(queue)
            }
            return .value(id: id, value: value)
        case .confirmed(let confirmed):
            guard dialog.method == .confirm else { throw .confirmationNotExpected(queue) }
            return .confirmed(id: id, confirmed: confirmed)
        case .cancelled:
            return .cancelled(id: id)
        }
    }

    func startConduite(repoKey: String, name: String) async throws(GestureRefusal) -> RemoteConduitePayload {
        // Le dépôt est résolu contre les dépôts CONNUS (S-8) : un dépôt jamais cadré
        // est accepté, la clé venant de la coque (le client ne la calcule jamais).
        guard let repo = knownRepos().first(where: { $0.repoKey == repoKey }) else {
            throw .unknownRepository
        }
        guard !Self.isBlank(name) else { throw .emptyName }
        // Le refus d'un second démarrage se décide AVANT l'appel : `refusal` est un
        // état d'UI COLLANT (posé par `refuse()`, remis à `nil` seulement par
        // `dismissRefusal()`), donc le relire APRÈS rendrait un 409 mensonger dès
        // qu'un refus antérieur n'a pas été acquitté à l'écran — alors que le
        // démarrage, lui, a réellement eu lieu (S-10).
        guard self.project.canStartConduite else { throw .conduiteRefused(self.conduiteConflict()) }
        await self.project.startConduite(repoRoot: URL(fileURLWithPath: repo.repoRoot), name: name)
        switch self.project.state {
        case .live: return RemoteConduitePayload(state: "live")
        case .starting: return RemoteConduitePayload(state: "starting")
        default: throw .conduiteNotLive(self.project.statusMessage)
        }
    }

    func closeConduite(repoKey: String) async throws(GestureRefusal) -> RemoteConduitePayload {
        // Seul le projet de la conduite VIVE peut être fermé : on décide sur
        // l'IDENTITÉ VIVE, sans consulter le magasin — une conduite ouverte sur un
        // dépôt jamais cadré doit pouvoir être fermée (S-10).
        guard let identity = self.project.identity,
              KanbanRepoKey.key(forRoot: identity.repoRoot.path) == repoKey else {
            throw .noConductedProject
        }
        await self.project.closeConduite()
        return RemoteConduitePayload(state: "closed")
    }

    private func projectRecord(_ repoKey: String) throws(GestureRefusal) -> Project {
        guard let project = hub.current().projects.projects.first(where: { $0.repoKey == repoKey }) else {
            throw .unknownProject
        }
        return project
    }

    /// Vrai quand ce projet est celui de la conduite vive.
    private func isConduiteLive(_ project: Project) -> Bool {
        guard let identity = self.project.identity else { return false }
        return realpathOr(identity.repoRoot.path) == realpathOr(project.repoRoot)
    }

    /// Le motif d'un second démarrage refusé (S-10) : le refus de la coque quand il
    /// existe (c'est le `ConduiteRefusal` que la spec nomme), sinon le même texte
    /// recomposé depuis l'identité de la conduite vive — jamais un `refusal` lu
    /// APRÈS l'appel, qui est collant.
    private func conduiteConflict() -> String {
        if let refusal = self.project.refusal { return refusal.message }
        if let identity = self.project.identity {
            return ProjectViewText.refusal(
                name: identity.name,
                path: ConsoleFormat.path(identity.repoRoot.path)
            )
        }
        return ProjectViewText.refusalTitle
    }

    // MARK: - Audits

    /// Démarre un audit (S-7) : la clé est résolue contre les dépôts CONNUS (comme
    /// `startConduite`), puis la requête part au service par le MÊME geste que la
    /// feuille de lancement du Mac (`AuditConsoleModel.startAudit`).
    func startAudit(repoKey: String, orientation: String) async throws(GestureRefusal) -> RemoteAuditStartedPayload {
        guard let repo = knownRepos().first(where: { $0.repoKey == repoKey }) else {
            throw .unknownRepository
        }
        let id = try await Self.auditGesture {
            try await self.audit.startAudit(repoRoot: repo.repoRoot, orientation: orientation)
        }
        return RemoteAuditStartedPayload(id: id)
    }

    /// Lance les propositions cochées avec le brief validé (S-7).
    func launchAudit(id: String, selected: [String], brief: String) async throws(GestureRefusal) -> RemoteAuditLaunchPayload {
        try Self.requireAuditId(id)
        let launches = try await Self.auditGesture {
            try await self.audit.launchAudit(id: id, selected: selected, brief: brief)
        }
        return RemoteAuditLaunchPayload(launches: launches)
    }

    /// Répond à une escalade d'une feature de l'audit (S-7) : la clé de
    /// l'escalade est renvoyée telle quelle, le service juge sa fraîcheur.
    func answerAudit(
        id: String,
        slug: String,
        key: String,
        answer: String?,
        decision: AuditMilestoneDecision?
    ) async throws(GestureRefusal) {
        try Self.requireAuditId(id)
        try await Self.auditGesture {
            try await self.audit.answerEscalation(
                auditId: id,
                slug: slug,
                key: key,
                answer: answer,
                decision: decision
            )
        }
    }

    /// Arrête l'audit (S-7) : l'issue du service, recopiée.
    func stopAudit(id: String) async throws(GestureRefusal) -> RemoteAuditStopPayload {
        try Self.requireAuditId(id)
        let outcome = try await Self.auditGesture { try await self.audit.stopAudit(id: id) }
        return RemoteAuditStopPayload(
            cancelled: outcome.cancelled,
            kept: outcome.kept,
            refused: outcome.refused.map { RemoteAuditStopRefusal(slug: $0.slug, reason: $0.reason) }
        )
    }

    /// Un identifiant hors forme ne peut désigner aucun audit : refus sans appel
    /// au service.
    private static func requireAuditId(_ id: String) throws(GestureRefusal) {
        guard isAuditId(id) else { throw .unknownAudit }
    }

    /// Les refus du service se recopient (400, 404, 409) ; tout autre échec — service
    /// arrêté, injoignable, réponse illisible — est une panne du service, comme le
    /// lancement de la session hébergée. La closure reste non typée (l'inférence du
    /// type lancé par une closure n'existe pas) : la conversion se fait ici.
    private static func auditGesture<T>(_ gesture: () async throws -> T) async throws(GestureRefusal) -> T {
        do {
            return try await gesture()
        } catch ServiceClientError.badRequest(let reason) {
            throw .serviceBadRequest(reason)
        } catch ServiceClientError.notFound(let reason) {
            throw .serviceNotFound(reason)
        } catch ServiceClientError.conflict(let reason) {
            throw .serviceConflict(reason)
        } catch {
            throw .serviceFailure(ServiceSessionModel.userMessage(of: error))
        }
    }

    // MARK: - Session hébergée

    func hostedSession() -> RemoteHostedSessionPayload {
        let host = session.host
        return RemoteHostedSessionPayload(
            state: Self.stateName(host.state),
            stateLabel: SessionConsoleModel.statusText(for: host.state),
            sessionId: host.sessionId,
            sessionFile: host.sessionFile,
            // Plus de protocole RPC : la session est servie par l'API du service
            // (S-6), dont le fil vivant est le fichier `.jsonl` — lu par les routes
            // `sessions`/`session` (S-2). Le champ reste pour la compatibilité du
            // client iOS, jamais deviné.
            protocolVersion: nil,
            projectName: session.projectRoot?.lastPathComponent,
            dialogs: host.dialogQueue,
            transcript: [],
            truncated: false
        )
    }

    /// Envoie une invite à la session hébergée, selon la règle du champ de saisie
    /// (`SessionConsoleModel.promptRefusal(for:)`) : le contrôle et l'appel de
    /// `host.send` se font sans suspension intermédiaire.
    func prompt(message: String) async throws(GestureRefusal) {
        if let refusal = session.promptRefusal(for: message) { throw refusal }
        let host = session.host
        do {
            try await host.send(prompt: message)
        } catch {
            throw .serviceFailure(ServiceSessionModel.userMessage(of: error))
        }
    }

    static func stateName(_ state: ServiceSessionModel.State) -> String {
        switch state {
        case .idle: return "idle"
        case .launching: return "launching"
        case .running: return "running"
        case .stopping: return "stopping"
        case .stopped: return "stopped"
        case .dead: return "dead"
        case .failed: return "failed"
        }
    }

    /// Le lancement de la session hébergée depuis l'iPad (S-1) : la clé est
    /// résolue contre les dépôts CONNUS (comme `startConduite`), la décision
    /// d'exclusivité est prise AVANT l'appel, et la charge rendue est l'état APRÈS
    /// le démarrage. Un dossier disparu ne lève pas : `ServiceSessionModel.start`
    /// pose `.failed(message)` et rend 200.
    func launchHostedSession(repoKey: String) async throws(GestureRefusal) -> RemoteHostedSessionPayload {
        guard let repo = knownRepos().first(where: { $0.repoKey == repoKey }) else {
            throw .unknownRepository
        }
        guard session.canStart else { throw .sessionBusy }
        do {
            try await session.launch(projectRoot: URL(fileURLWithPath: repo.repoRoot))
        } catch {
            throw .serviceFailure(ServiceSessionModel.userMessage(of: error))
        }
        return hostedSession()
    }

    /// La relance d'une session `dead` (S-1) : `canRelaunch` est la règle du Mac,
    /// et elle REPREND le même fichier de session.
    func relaunchHostedSession() async throws(GestureRefusal) -> RemoteHostedSessionPayload {
        guard session.canRelaunch else { throw .sessionNotRelaunchable }
        do {
            try await session.relaunchSession()
        } catch {
            throw .serviceFailure(ServiceSessionModel.userMessage(of: error))
        }
        return hostedSession()
    }

    /// L'arrêt de la session hébergée (S-7) : idempotent — `host.stop()` est un
    /// no-op dans `idle/stopped` — et rend l'état courant.
    func stopHostedSession() async -> RemoteHostedSessionPayload {
        await session.stopSession()
        return hostedSession()
    }

    /// Répond à un dialogue de la session hébergée (S-4). Mêmes règles que
    /// `answerDialog` (conduite), appliquées à `SessionConsoleModel` : le contrôle
    /// d'identité (tête de file) et l'écriture sont faits dans la MÊME exécution
    /// du `@MainActor`.
    func answerHostedDialog(id: String, answer: DialogAnswer) async throws(GestureRefusal) {
        guard let dialog = session.host.dialogQueue.first else { throw .noPendingDialog }
        let response = try Self.dialogResponse(dialog, id: id, answer: answer, queue: .hosted)
        guard session.answer(dialogId: id, response: response) else { throw .staleDialog(.hosted) }
    }

    // MARK: - PR

    func pullRequests(repoKey: String) async throws(GestureRefusal) -> RemotePullRequestsPayload {
        let project = try projectRecord(repoKey)
        guard isConduiteLive(project) else { throw .noConductedProject }
        await self.project.refreshPRs()
        return RemotePullRequestsPayload(
            rows: self.project.prRows,
            failure: self.project.prFailure,
            stale: self.project.prRows.contains { $0.freshness == .stale }
        )
    }

    func merge(repoKey: String, slug: String, headOid: String) async throws(GestureRefusal) -> RemoteMergedPayload {
        let project = try projectRecord(repoKey)
        guard isConduiteLive(project) else { throw .noConductedProject }
        guard Self.isSHA(headOid) else { throw .malformedHeadOid }
        guard let row = self.project.prRows.first(where: { $0.slug == slug }) else {
            throw .unknownPullRequest
        }
        // Une adresse de PR invalide est un refus (404, S-12), jamais le 500 qu'une
        // relecture en échec produirait.
        guard validatedPRURL(row.url) != nil else { throw .invalidPullRequestURL }
        try Self.refuseIfGhMissing(environment)

        await self.project.beginMerge(slug: slug)
        guard let proposal = self.project.pendingMerge else {
            if let failure = self.project.prActionFailure { throw .mergeRefused(failure) }
            if let failure = self.project.prFailure { throw .mergeFailed(failure) }
            throw .unknownPullRequest
        }
        guard proposal.headOid == headOid else {
            self.project.cancelMerge()
            throw .pullRequestChanged
        }
        await self.project.confirmMerge()
        if let failure = self.project.prActionFailure { throw .mergeFailed(failure) }
        return RemoteMergedPayload(merged: true, number: proposal.number ?? row.number, url: row.url)
    }

    /// Le rafraîchissement manuel des faits de PR (S-6 de pipelines-livrees) :
    /// lancé SANS être attendu, accepté même quand `gh` est absent — le résultat
    /// arrive par la trame `pull-request-states`.
    func refreshPullRequestStates() {
        kanban.refreshPullRequestStates()
    }

    /// `gh` absent : la route le dit en `503`, jamais en `500` (S-12).
    static func refuseIfGhMissing(_ environment: [String: String]) throws(GestureRefusal) {
        if case .failure(let error) = GhBinary.resolve(environment: environment) {
            throw .ghMissing(error.userMessage)
        }
    }

    static func isSHA(_ raw: String) -> Bool {
        raw.count == 40 && raw.allSatisfy { $0.isHexDigit && ($0.isNumber || $0.isLowercase) }
    }
}
