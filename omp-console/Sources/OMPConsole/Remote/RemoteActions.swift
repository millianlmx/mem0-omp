// Les routes de GESTE (S-10, S-11, S-12) : les gestes de la coque, servis à
// distance. Ils passent EXCLUSIVEMENT par les méthodes publiques des modèles
// existants — `ActionsModel`, `ProjectConsoleModel`, `SessionConsoleModel` — et
// n'ouvrent aucune seconde voie d'écriture : pas d'écriture directe dans
// `<stateDir>`, pas de process lancé (les gestes partent au service par son API).

import ConsoleCore
import Foundation

@MainActor
final class RemoteActions {
    private let kanban: KanbanModel
    private let actions: ActionsModel
    private let session: SessionConsoleModel
    private let project: ProjectConsoleModel
    private let hub: StoreHub
    private let environment: [String: String]
    private let clock: RemoteClock

    init(
        kanban: KanbanModel,
        actions: ActionsModel,
        session: SessionConsoleModel,
        project: ProjectConsoleModel,
        hub: StoreHub,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        clock: RemoteClock = .live
    ) {
        self.kanban = kanban
        self.actions = actions
        self.session = session
        self.project = project
        self.hub = hub
        self.environment = environment
        self.clock = clock
    }

    // MARK: - Cartes

    private func card(_ id: String) throws -> KanbanCard {
        guard let card = kanban.state.card(id) else { throw ConsoleAPIError.notFound("carte inconnue") }
        return card
    }

    private func action(_ card: KanbanCard) throws -> KanbanCardAction {
        guard let action = card.action else { throw ConsoleAPIError.conflict("carte sans geste") }
        return action
    }

    /// Le journal dit l'échec d'écriture du canal : la route ne rend jamais un 202
    /// mensonger (S-10). L'entrée écrite par le geste est repérée par son IDENTITÉ
    /// (le journal est BORNÉ à 20 entrées : comparer les comptes est faux quand il
    /// est plein, le compte ne bouge plus).
    private func checkJournal(since id: String?) throws {
        guard let entry = actions.journal.first, entry.id != id else { return }
        if case .failed(let reason) = entry.state {
            throw ConsoleAPIError.server(reason)
        }
    }

    private static func isBlank(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: - Répondre, texte, jalon

    func answer(cardId: String, body: Data) async throws -> RemoteAcceptedPayload {
        let card = try card(cardId)
        let action = try action(card)
        guard let ask = action.run?.pendingAsk else {
            throw ConsoleAPIError.conflict("aucune question en vol")
        }
        let request = try Self.decode(RemoteAnswerRequest.self, body)
        switch request.kind {
        case "selected":
            guard let label = request.label, ask.options.contains(where: { $0.label == label }) else {
                throw ConsoleAPIError.badRequest("libellé hors des options de la question")
            }
            if let toolCallId = request.toolCallId, toolCallId != ask.toolCallId {
                throw ConsoleAPIError.conflict("la question a changé depuis la demande")
            }
            let before = actions.journal.first?.id
            actions.answer(action, selected: label)
            try checkJournal(since: before)
        case "custom":
            guard let text = request.text, !Self.isBlank(text) else {
                throw ConsoleAPIError.badRequest("texte vide")
            }
            if let toolCallId = request.toolCallId, toolCallId != ask.toolCallId {
                throw ConsoleAPIError.conflict("la question a changé depuis la demande")
            }
            let before = actions.journal.first?.id
            actions.answer(action, custom: text)
            try checkJournal(since: before)
        default:
            throw ConsoleAPIError.badRequest("kind inconnu")
        }
        return RemoteAcceptedPayload(accepted: true)
    }

    func reply(cardId: String, body: Data) async throws -> RemoteAcceptedPayload {
        let card = try card(cardId)
        let action = try action(card)
        guard action.waitPrompt != nil else { throw ConsoleAPIError.conflict("cette carte n'attend pas de réponse") }
        let request = try Self.decode(RemoteTextRequest.self, body)
        guard !Self.isBlank(request.text) else { throw ConsoleAPIError.badRequest("texte vide") }
        let before = actions.journal.first?.id
        actions.replyText = request.text
        actions.submitReply(action)
        try checkJournal(since: before)
        return RemoteAcceptedPayload(accepted: true)
    }

    func text(cardId: String, body: Data) async throws -> RemoteAcceptedPayload {
        let card = try card(cardId)
        let action = try action(card)
        guard action.run?.inbox != nil else { throw ConsoleAPIError.conflict("aucun run vivant sur cette carte") }
        let request = try Self.decode(RemoteTextRequest.self, body)
        guard !Self.isBlank(request.text) else { throw ConsoleAPIError.badRequest("texte vide") }
        let before = actions.journal.first?.id
        actions.sendText(action, text: request.text)
        try checkJournal(since: before)
        return RemoteAcceptedPayload(accepted: true)
    }

    func verdict(cardId: String, body: Data) async throws -> RemoteAcceptedPayload {
        let card = try card(cardId)
        let action = try action(card)
        let request = try Self.decode(RemoteVerdictRequest.self, body)
        let before = actions.journal.first?.id
        switch request.verdict {
        case "specs":
            guard action.waitKind == .specs else { throw ConsoleAPIError.conflict("ce jalon n'est pas attendu") }
            actions.validate(action)
        case "review":
            guard action.waitKind == .review else { throw ConsoleAPIError.conflict("ce jalon n'est pas attendu") }
            actions.accept(action)
        default:
            throw ConsoleAPIError.badRequest("verdict inconnu")
        }
        try checkJournal(since: before)
        return RemoteAcceptedPayload(accepted: true)
    }

    func resume(cardId: String) async throws -> RemoteAcceptedPayload {
        let card = try card(cardId)
        let action = try action(card)
        guard action.repoRoot != nil else { throw ConsoleAPIError.conflict("carte sans dépôt") }
        guard let entryId = actions.resume(action) else {
            // Carte sans dépôt : le geste n'a rien à armer (l'effet de bord
            // observable est l'entrée de journal, S-10).
            return RemoteAcceptedPayload(accepted: true)
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
            throw ConsoleAPIError.server("le geste de reprise n'a rien consigné")
        }
        if case .failed(let reason) = entry.state {
            // Le motif du journal préfixe la traduction du service : la route rend
            // le message utilisateur du client (S-10).
            let message = reason.hasPrefix("pilote : ")
                ? String(reason.dropFirst("pilote : ".count))
                : reason
            throw ConsoleAPIError.unavailable(message)
        }
        return RemoteAcceptedPayload(accepted: true)
    }

    func stop(cardId: String) async throws -> RemoteAcceptedPayload {
        let card = try card(cardId)
        let action = try action(card)
        guard action.slug != nil, action.repoRoot != nil else {
            throw ConsoleAPIError.conflict("carte sans lot")
        }
        let before = actions.journal.first?.id
        actions.stopLot(action)
        try checkJournal(since: before)
        return RemoteAcceptedPayload(accepted: true)
    }

    func launch(body: Data) async throws -> RemoteAcceptedPayload {
        let request = try Self.decode(RemoteFeatureRequest.self, body)
        guard !Self.isBlank(request.title) else { throw ConsoleAPIError.badRequest("titre vide") }
        // MÊME règle que la feuille « Nouvelle feature » : le titre ET la
        // description doivent être non blancs — sinon `ActionsModel.launch` sort
        // sans déposer de commande, et un 202 serait mensonger (S-10).
        guard !Self.isBlank(request.description) else {
            throw ConsoleAPIError.badRequest("description vide")
        }
        guard !request.repoRoot.isEmpty, LaunchRepo.isGitRoot(path: request.repoRoot) else {
            throw ConsoleAPIError.badRequest("racine de dépôt git invalide")
        }
        let before = actions.journal.first?.id
        actions.launch(
            title: request.title,
            description: request.description,
            repoRoot: request.repoRoot,
            modelReqSpecs: request.modelReqSpecs,
            modelImplReview: request.modelImplReview
        )
        try checkJournal(since: before)
        return RemoteAcceptedPayload(accepted: true)
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

    /// Répond à l'escalade `{id}` (S-4, S-5). La validation dépend de la forme de
    /// l'escalade ; le contrôle d'identité ET l'écriture de la réponse sont faits
    /// dans la MÊME exécution du `@MainActor` (`ProjectConsoleModel.answer` est
    /// synchrone) : la file ne peut pas glisser entre les deux.
    func answerDialog(id: String, body: Data) async throws -> RemoteAcceptedPayload {
        let request = try Self.decode(RemoteDialogAnswerRequest.self, body)
        guard let dialog = self.project.pendingDialog else {
            throw ConsoleAPIError.conflict("aucun dialogue en attente")
        }
        guard dialog.id == id else {
            throw ConsoleAPIError.conflict("l'escalade a changé depuis la demande")
        }
        let response: RpcDialogResponse
        switch request.kind {
        case "value":
            guard let value = request.value else { throw ConsoleAPIError.badRequest("valeur absente") }
            switch dialog.method {
            case .select:
                guard dialog.options.contains(value) else {
                    throw ConsoleAPIError.badRequest("libellé hors des options de l'escalade")
                }
            case .input:
                guard !Self.isBlank(value) else { throw ConsoleAPIError.badRequest("texte vide") }
            case .editor:
                // Une valeur VIDE est acceptée : c'est la coque qui juge le plan.
                break
            case .confirm:
                throw ConsoleAPIError.badRequest("cette escalade n'attend pas de valeur")
            }
            response = .value(id: id, value: value)
        case "confirmed":
            guard dialog.method == .confirm else {
                throw ConsoleAPIError.badRequest("cette escalade n'attend pas de confirmation")
            }
            guard let confirmed = request.confirmed else { throw ConsoleAPIError.badRequest("confirmation absente") }
            response = .confirmed(id: id, confirmed: confirmed)
        case "cancelled":
            response = .cancelled(id: id)
        default:
            throw ConsoleAPIError.badRequest("kind inconnu")
        }
        guard self.project.answer(dialogId: id, response: response) else {
            throw ConsoleAPIError.conflict("l'escalade a changé depuis la demande")
        }
        return RemoteAcceptedPayload(accepted: true)
    }

    func startConduite(repoKey: String, body: Data) async throws -> RemoteConduitePayload {
        // Le dépôt est résolu contre les dépôts CONNUS (S-8) : un dépôt jamais cadré
        // est accepté, la clé venant de la coque (le client ne la calcule jamais).
        guard let repo = knownRepos().first(where: { $0.repoKey == repoKey }) else {
            throw ConsoleAPIError.notFound("dépôt inconnu")
        }
        let request = try Self.decode(RemoteConduiteRequest.self, body)
        guard !Self.isBlank(request.name) else { throw ConsoleAPIError.badRequest("nom vide") }
        // Le refus d'un second démarrage se décide AVANT l'appel : `refusal` est un
        // état d'UI COLLANT (posé par `refuse()`, remis à `nil` seulement par
        // `dismissRefusal()`), donc le relire APRÈS rendrait un 409 mensonger dès
        // qu'un refus antérieur n'a pas été acquitté à l'écran — alors que le
        // démarrage, lui, a réellement eu lieu (S-10).
        guard self.project.canStartConduite else { throw self.conduiteConflict() }
        await self.project.startConduite(repoRoot: URL(fileURLWithPath: repo.repoRoot), name: request.name)
        switch self.project.state {
        case .live: return RemoteConduitePayload(state: "live")
        case .starting: return RemoteConduitePayload(state: "starting")
        default: throw ConsoleAPIError.conflict(self.project.statusMessage)
        }
    }

    func closeConduite(repoKey: String) async throws -> RemoteConduitePayload {
        // Seul le projet de la conduite VIVE peut être fermé : on décide sur
        // l'IDENTITÉ VIVE, sans consulter le magasin — une conduite ouverte sur un
        // dépôt jamais cadré doit pouvoir être fermée (S-10).
        guard let identity = self.project.identity,
              KanbanRepoKey.key(forRoot: identity.repoRoot.path) == repoKey else {
            throw ConsoleAPIError.conflict("aucun projet conduit")
        }
        await self.project.closeConduite()
        return RemoteConduitePayload(state: "closed")
    }

    private func projectRecord(_ repoKey: String) throws -> Project {
        guard let project = hub.current().projects.projects.first(where: { $0.repoKey == repoKey }) else {
            throw ConsoleAPIError.notFound("projet inconnu")
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
    private func conduiteConflict() -> ConsoleAPIError {
        if let refusal = self.project.refusal { return .conflict(refusal.message) }
        if let identity = self.project.identity {
            return .conflict(ProjectViewText.refusal(
                name: identity.name,
                path: ConsoleFormat.path(identity.repoRoot.path)
            ))
        }
        return .conflict(ProjectViewText.refusalTitle)
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

    func prompt(body: Data) async throws -> RemoteSentPayload {
        let request = try Self.decode(RemotePromptRequest.self, body)
        guard !Self.isBlank(request.message) else { throw ConsoleAPIError.badRequest("message vide") }
        let host = session.host
        guard host.state == .running else { throw ConsoleAPIError.conflict("la session n'est pas en marche") }
        do {
            try await host.send(prompt: request.message)
        } catch {
            throw ConsoleAPIError.unavailable(ServiceSessionModel.userMessage(of: error))
        }
        return RemoteSentPayload(sent: true)
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
    func launchHostedSession(body: Data) async throws -> RemoteHostedSessionPayload {
        let request = try Self.decode(RemoteHostedLaunchRequest.self, body)
        guard let repo = knownRepos().first(where: { $0.repoKey == request.repoKey }) else {
            throw ConsoleAPIError.notFound("dépôt inconnu")
        }
        guard session.canStart else { throw ConsoleAPIError.conflict(SessionConsoleText.launchBusy) }
        do {
            try await session.launch(projectRoot: URL(fileURLWithPath: repo.repoRoot))
        } catch {
            throw ConsoleAPIError.unavailable(ServiceSessionModel.userMessage(of: error))
        }
        return hostedSession()
    }

    /// La relance d'une session `dead` (S-1) : `canRelaunch` est la règle du Mac,
    /// et elle REPREND le même fichier de session.
    func relaunchHostedSession() async throws -> RemoteHostedSessionPayload {
        guard session.canRelaunch else { throw ConsoleAPIError.conflict(SessionConsoleText.relaunchNotDead) }
        do {
            try await session.relaunchSession()
        } catch {
            throw ConsoleAPIError.unavailable(ServiceSessionModel.userMessage(of: error))
        }
        return hostedSession()
    }

    /// L'arrêt de la session hébergée (S-7) : idempotent — `host.stop()` est un
    /// no-op dans `idle/stopped` — et rend l'état courant.
    func stopHostedSession() async throws -> RemoteHostedSessionPayload {
        await session.stopSession()
        return hostedSession()
    }

    /// Répond à un dialogue de la session hébergée (S-5). Mêmes contrôles et mêmes
    /// messages que `answerDialog` (conduite), appliqués à `SessionConsoleModel` :
    /// le contrôle d'identité (tête de file) et l'écriture sont faits dans la MÊME
    /// exécution du `@MainActor`.
    func answerHostedDialog(id: String, body: Data) async throws -> RemoteAcceptedPayload {
        let request = try Self.decode(RemoteDialogAnswerRequest.self, body)
        guard let dialog = session.host.dialogQueue.first else {
            throw ConsoleAPIError.conflict("aucun dialogue en attente")
        }
        guard dialog.id == id else {
            throw ConsoleAPIError.conflict("le dialogue a changé depuis la demande")
        }
        let response: RpcDialogResponse
        switch request.kind {
        case "value":
            guard let value = request.value else { throw ConsoleAPIError.badRequest("valeur absente") }
            switch dialog.method {
            case .select:
                guard dialog.options.contains(value) else {
                    throw ConsoleAPIError.badRequest("libellé hors des options du dialogue")
                }
            case .input:
                guard !Self.isBlank(value) else { throw ConsoleAPIError.badRequest("texte vide") }
            case .editor:
                // Une valeur VIDE est acceptée : c'est la session qui juge.
                break
            case .confirm:
                throw ConsoleAPIError.badRequest("ce dialogue n'attend pas de valeur")
            }
            response = .value(id: id, value: value)
        case "confirmed":
            guard dialog.method == .confirm else {
                throw ConsoleAPIError.badRequest("ce dialogue n'attend pas de confirmation")
            }
            guard let confirmed = request.confirmed else { throw ConsoleAPIError.badRequest("confirmation absente") }
            response = .confirmed(id: id, confirmed: confirmed)
        case "cancelled":
            response = .cancelled(id: id)
        default:
            throw ConsoleAPIError.badRequest("kind inconnu")
        }
        guard session.answer(dialogId: id, response: response) else {
            throw ConsoleAPIError.conflict("le dialogue a changé depuis la demande")
        }
        return RemoteAcceptedPayload(accepted: true)
    }

    // MARK: - PR

    func pullRequests(repoKey: String) async throws -> RemotePullRequestsPayload {
        let project = try projectRecord(repoKey)
        guard isConduiteLive(project) else { throw ConsoleAPIError.conflict("aucun projet conduit") }
        await self.project.refreshPRs()
        return RemotePullRequestsPayload(
            rows: self.project.prRows,
            failure: self.project.prFailure,
            stale: self.project.prRows.contains { $0.freshness == .stale }
        )
    }

    func merge(repoKey: String, slug: String, body: Data) async throws -> RemoteMergedPayload {
        let project = try projectRecord(repoKey)
        guard isConduiteLive(project) else { throw ConsoleAPIError.conflict("aucun projet conduit") }
        let request = try Self.decode(RemoteMergeRequest.self, body)
        guard Self.isSHA(request.headOid) else { throw ConsoleAPIError.badRequest("headOid mal formé") }
        guard let row = self.project.prRows.first(where: { $0.slug == slug }) else {
            throw ConsoleAPIError.notFound("PR inconnue")
        }
        // Une adresse de PR invalide est un 404 (S-12), jamais le 500 qu'une
        // relecture en échec produirait.
        guard validatedPRURL(row.url) != nil else {
            throw ConsoleAPIError.notFound("adresse de PR invalide")
        }
        try Self.refuseIfGhMissing(environment)

        await self.project.beginMerge(slug: slug)
        guard let proposal = self.project.pendingMerge else {
            if let failure = self.project.prActionFailure { throw ConsoleAPIError.conflict(failure) }
            if let failure = self.project.prFailure {
                throw ConsoleAPIError.server(failure)
            }
            throw ConsoleAPIError.notFound("PR inconnue")
        }
        guard proposal.headOid == request.headOid else {
            self.project.cancelMerge()
            throw ConsoleAPIError.conflict("la PR a changé depuis la demande ; relisez-la")
        }
        await self.project.confirmMerge()
        if let failure = self.project.prActionFailure { throw ConsoleAPIError.server(failure) }
        return RemoteMergedPayload(merged: true, number: proposal.number ?? row.number, url: row.url)
    }

    /// Le rafraîchissement manuel des faits de PR (S-6 de pipelines-livrees) :
    /// lancé SANS être attendu, accepté même quand `gh` est absent — le résultat
    /// arrive par la trame `pull-request-states`.
    func refreshPullRequestStates() -> RemoteAcceptedPayload {
        kanban.refreshPullRequestStates()
        return RemoteAcceptedPayload(accepted: true)
    }

    /// `gh` absent : la route le dit en `503`, jamais en `500` (S-12).
    static func refuseIfGhMissing(_ environment: [String: String]) throws {
        if case .failure(let error) = GhBinary.resolve(environment: environment) {
            throw ConsoleAPIError.unavailable(error.userMessage)
        }
    }

    static func isSHA(_ raw: String) -> Bool {
        raw.count == 40 && raw.allSatisfy { $0.isHexDigit && ($0.isNumber || $0.isLowercase) }
    }

    // MARK: - Aides

    private static func decode<T: Decodable>(_ type: T.Type, _ body: Data) throws -> T {
        guard !body.isEmpty else { throw ConsoleAPIError.badRequest("corps JSON absent") }
        do {
            return try HTTPJSON.decoder.decode(T.self, from: body)
        } catch {
            throw ConsoleAPIError.badRequest("corps JSON illisible")
        }
    }
}
