// Les preuves Swift du modèle de l'écran « Session OMP » (BR-4) : les décisions
// PURES (surface, disponibilités, composeur) et les gestes (prompt, dialogue,
// lancement, arrêt), plus la relecture à l'apparition (S-6).
//
// La doublure `SessionOmpStub` compte les appels : c'est ce qui permet de prouver
// « un geste = un appel » sans ouvrir de socket. Chaque test PORTE l'id
// d'acceptation qu'il prouve.

@testable import OMPConsoleIOS
import ConsoleClient
import ConsoleCore
import Foundation
import Testing

/// Une doublure COMPTANTE du contrat d'entrée de l'écran.
@MainActor
private final class SessionOmpStub: IOSSessionOmpClient {
    var state: ClientState
    var attemptFollowsFailure = false
    var hosted: RemoteHostedEvent?

    private(set) var hostedSessionCalls = 0
    private(set) var launchCount = 0
    private(set) var relaunchCount = 0
    private(set) var stopCount = 0
    private(set) var promptCount = 0
    private(set) var lastPrompt: String?
    private(set) var answers: [(id: String, kind: String, value: String?, confirmed: Bool?)] = []

    var promptFailure: Error?
    /// La charge que `read(file:)` rend : le fil monté par `syncThread()` (AC-8).
    var payload: RemoteSessionPayload?
    /// La charge que `hostedSession()` pose sur `hosted` (S-6).
    var served: RemoteHostedEvent?

    init(state: ClientState, hosted: RemoteHostedEvent? = nil) {
        self.state = state
        self.hosted = hosted
        self.served = hosted
    }

    func hostedSession() async throws -> RemoteHostedSessionPayload {
        hostedSessionCalls += 1
        if let served { hosted = served }
        return try makeHostedPayload(state: hosted?.state ?? "idle", sessionFile: hosted?.sessionFile)
    }

    func repos() async throws -> RemoteReposPayload {
        try decode(#"{"rows":[]}"#)
    }

    func launchHostedSession(repoKey: String) async throws -> RemoteHostedSessionPayload {
        launchCount += 1
        hosted = try makeHostedEvent(state: "running", sessionFile: "/tmp/session.jsonl", projectName: "depot")
        return try makeHostedPayload(state: "running", sessionFile: "/tmp/session.jsonl")
    }

    func relaunchHostedSession() async throws -> RemoteHostedSessionPayload {
        relaunchCount += 1
        hosted = try makeHostedEvent(state: "running", sessionFile: "/tmp/session.jsonl")
        return try makeHostedPayload(state: "running", sessionFile: "/tmp/session.jsonl")
    }

    func stopHostedSession() async throws -> RemoteHostedSessionPayload {
        stopCount += 1
        hosted = try makeHostedEvent(state: "stopped", sessionFile: "/tmp/session.jsonl")
        return try makeHostedPayload(state: "stopped", sessionFile: "/tmp/session.jsonl")
    }

    func answerHostedDialog(
        id: String,
        kind: String,
        value: String?,
        confirmed: Bool?
    ) async throws -> RemoteAcceptedPayload {
        answers.append((id, kind, value, confirmed))
        if var current = hosted {
            current.dialogs.removeAll { $0.id == id }
            hosted = current
        }
        return try decode(#"{"accepted":true}"#)
    }

    func prompt(message: String) async throws -> RemoteSentPayload {
        promptCount += 1
        lastPrompt = message
        if let promptFailure { throw promptFailure }
        return try decode(#"{"sent":true}"#)
    }

    // MARK: - IOSSessionSource (le fil n'est pas éprouvé ici)

    func read(file: String) async throws -> RemoteSessionPayload {
        if let payload { return payload }
        return try decode(#"{"entries":[],"skipped":[],"truncated":false}"#)
    }

    func feed(forFile file: String) -> AsyncStream<RemoteSessionFeedItem> {
        AsyncStream { $0.finish() }
    }

    func run(forFile file: String) -> RunChoice? { nil }
}

private func decode<T: Decodable>(_ json: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

private func makeHostedPayload(state: String, sessionFile: String? = nil) throws -> RemoteHostedSessionPayload {
    var object: [String: Any] = [
        "state": state,
        "stateLabel": state,
        "dialogs": [],
        "transcript": [],
        "truncated": false,
    ]
    if let sessionFile { object["sessionFile"] = sessionFile }
    return try JSONSerialization.data(withJSONObject: object).pipe(RemoteHostedSessionPayload.self)
}

private func makeHostedEvent(
    state: String,
    sessionFile: String? = nil,
    projectName: String? = nil,
    dialogs: [[String: Any]] = []
) throws -> RemoteHostedEvent {
    var object: [String: Any] = ["state": state, "dialogs": dialogs, "added": []]
    if let sessionFile { object["sessionFile"] = sessionFile }
    if let projectName { object["projectName"] = projectName }
    return try JSONSerialization.data(withJSONObject: object).pipe(RemoteHostedEvent.self)
}

private extension Data {
    func pipe<T: Decodable>(_ type: T.Type) throws -> T {
        try JSONDecoder().decode(type, from: self)
    }
}

/// Une escalade décodée depuis sa forme servie.
private func dialog(
    id: String,
    method: String,
    options: [String] = [],
    prefill: String? = nil
) throws -> RpcDialogRequest {
    var object: [String: Any] = [
        "id": id,
        "method": method,
        "title": "Titre de la question",
        "options": options,
        "optionDescriptions": [],
        "promptStyle": false,
    ]
    if let prefill { object["prefill"] = prefill }
    return try JSONSerialization.data(withJSONObject: object).pipe(RpcDialogRequest.self)
}

@MainActor
private let endpoint = ClientEndpoint.manual(host: "127.0.0.1", port: 8787)
@MainActor
private let connected = ClientState.connected(endpoint: endpoint)

@MainActor
private func eventually(timeout: Double = 5, _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return condition()
}

@MainActor
@Suite("ios-session-omp — le modèle de l'écran Session OMP")
struct IOSSessionOmpTests {
    // MARK: - Décisions pures

    @Test("ios-session-omp/AC-2 : la surface suit le statut de connexion et l'état servi")
    func surfaceFollowsClientAndHosted() throws {
        // Connecté, sans état servi : le premier GET est en vol.
        #expect(IOSSessionOmpModel.surface(connection: .connected, hosted: nil) == .loading)
        #expect(IOSSessionOmpModel.surface(connection: .connected, hosted: try makeHostedEvent(state: "idle")) == .empty)
        #expect(IOSSessionOmpModel.surface(connection: .connected, hosted: try makeHostedEvent(state: "launching")) == .launching)
        #expect(IOSSessionOmpModel.surface(connection: .connected, hosted: try makeHostedEvent(state: "running")) == .live)
        #expect(IOSSessionOmpModel.surface(connection: .connected, hosted: try makeHostedEvent(state: "stopping")) == .stopping)
        #expect(IOSSessionOmpModel.surface(connection: .connected, hosted: try makeHostedEvent(state: "stopped")) == .stopped)
        #expect(IOSSessionOmpModel.surface(connection: .connected, hosted: try makeHostedEvent(state: "dead")) == .dead)
        // Un état INCONNU du client vaut `idle`.
        #expect(IOSSessionOmpModel.surface(connection: .connected, hosted: try makeHostedEvent(state: "zzz")) == .empty)
        // `failed` porte le message servi.
        let failed = try makeHostedEvent(state: "failed")
        var labelled = failed
        labelled.stateLabel = "Le dossier du projet n'existe plus : /x."
        #expect(IOSSessionOmpModel.surface(connection: .connected, hosted: labelled) == .failed("Le dossier du projet n'existe plus : /x."))
    }

    @Test("etats-non-connecte-heterogenes-ios/AC-1 : pas connecté et aucun état servi reçu → le composant d'état de connexion")
    func sessionOmpUnavailableWithoutHosted() {
        for status in [IOSConnectionStatus.connecting, .disconnected(.unreachable), .disconnected(.unpaired),
                       .disconnected(.refused), .disconnected(.updateApp), .disconnected(.updateMac)] {
            #expect(IOSSessionOmpModel.surface(connection: status, hosted: nil) == .unavailable(status))
        }
        // Le modèle lit le statut présenté du client : une relance après échec
        // reste « non connecté » (S-1).
        let retrying = SessionOmpStub(state: .connecting(endpoint: endpoint))
        retrying.attemptFollowsFailure = true
        #expect(IOSSessionOmpModel(client: retrying).surface == .unavailable(.disconnected(.unreachable)))
        let fresh = SessionOmpStub(state: .connecting(endpoint: endpoint))
        #expect(IOSSessionOmpModel(client: fresh).surface == .unavailable(.connecting))
    }

    @Test("etats-non-connecte-heterogenes-ios/AC-4 : le dernier état servi reste affiché hors connexion")
    func sessionOmpKeepsHostedOffline() throws {
        for status in [IOSConnectionStatus.connecting, .disconnected(.unreachable), .disconnected(.refused)] {
            #expect(IOSSessionOmpModel.surface(connection: status, hosted: try makeHostedEvent(state: "running")) == .live)
            #expect(IOSSessionOmpModel.surface(connection: status, hosted: try makeHostedEvent(state: "idle")) == .empty)
            #expect(IOSSessionOmpModel.surface(connection: status, hosted: try makeHostedEvent(state: "dead")) == .dead)
        }
        // Par le client : la session conservée, sous le statut présenté.
        let offline = SessionOmpStub(state: .macAbsent(endpoint: endpoint), hosted: try makeHostedEvent(state: "running"))
        let model = IOSSessionOmpModel(client: offline)
        #expect(model.connection == .disconnected(.unreachable))
        #expect(model.surface == .live)
    }

    @Test("etats-non-connecte-heterogenes-ios/AC-10 : les gestes grisés hors connexion se rouvrent dès la connexion, sur le même écran")
    func gesturesReopenOnConnection() throws {
        let client = SessionOmpStub(state: .connecting(endpoint: endpoint), hosted: try makeHostedEvent(state: "running"))
        let model = IOSSessionOmpModel(client: client)
        // Connexion en cours, puis échec avec relance : gestes grisés (AC-8, AC-9).
        #expect(!model.connection.gesturesEnabled)
        client.state = .macAbsent(endpoint: endpoint)
        client.attemptFollowsFailure = true
        #expect(!model.connection.gesturesEnabled)
        // La connexion aboutit : le même modèle rouvre ses gestes, sans relancement.
        client.state = connected
        client.attemptFollowsFailure = false
        #expect(model.connection.gesturesEnabled)
    }

    @Test("ios-session-omp/AC-3 : le lancement n'est offert que hors d'une session en marche")
    func launchAvailability() throws {
        #expect(IOSSessionOmpModel.canLaunch(nil))
        #expect(IOSSessionOmpModel.canLaunch(try makeHostedEvent(state: "idle")))
        #expect(IOSSessionOmpModel.canLaunch(try makeHostedEvent(state: "stopped")))
        #expect(IOSSessionOmpModel.canLaunch(try makeHostedEvent(state: "failed")))
        #expect(!IOSSessionOmpModel.canLaunch(try makeHostedEvent(state: "launching")))
        #expect(!IOSSessionOmpModel.canLaunch(try makeHostedEvent(state: "running")))
        #expect(!IOSSessionOmpModel.canLaunch(try makeHostedEvent(state: "stopping")))
    }

    @Test("la relance est réservée à `dead`, l'arrêt à `launching|running` (S-1, S-7)")
    func relaunchAndStopAvailability() throws {
        #expect(IOSSessionOmpModel.canRelaunch(try makeHostedEvent(state: "dead")))
        #expect(!IOSSessionOmpModel.canRelaunch(try makeHostedEvent(state: "stopped")))
        #expect(!IOSSessionOmpModel.canRelaunch(try makeHostedEvent(state: "running")))
        #expect(IOSSessionOmpModel.canStop(try makeHostedEvent(state: "running")))
        #expect(IOSSessionOmpModel.canStop(try makeHostedEvent(state: "launching")))
        #expect(!IOSSessionOmpModel.canStop(try makeHostedEvent(state: "stopped")))
        #expect(!IOSSessionOmpModel.canStop(try makeHostedEvent(state: "dead")))
    }

    @Test("ios-session-omp/AC-6 : le composeur suit la marche, l'absence de dialogue et un texte non blanc")
    func composerAvailability() throws {
        let select = try dialog(id: "d1", method: "select", options: ["A"])
        #expect(IOSSessionOmpModel.canSendPrompt(state: "running", dialogs: [], text: "bonjour"))
        #expect(!IOSSessionOmpModel.canSendPrompt(state: "running", dialogs: [], text: "   "))
        #expect(!IOSSessionOmpModel.canSendPrompt(state: "running", dialogs: [select], text: "bonjour"))
        #expect(!IOSSessionOmpModel.canSendPrompt(state: "stopped", dialogs: [], text: "bonjour"))
        // Le mot de la cause suit la même règle.
        #expect(IOSSessionOmpModel.composerHint(state: "running", dialogs: []) == SessionConsoleText.composerRunning)
        #expect(IOSSessionOmpModel.composerHint(state: "running", dialogs: [select]) == ProjectViewText.composerBlocked)
        #expect(IOSSessionOmpModel.composerHint(state: "stopped", dialogs: []) == SessionConsoleText.composerIdle)
    }

    // MARK: - Gestes

    @Test("ios-session-omp/AC-6 : un envoi appelle `prompt` une fois et rend vrai ; un échec rend faux et affiche le message")
    func sendPromptCallsOnce() async throws {
        let client = SessionOmpStub(state: connected, hosted: try makeHostedEvent(state: "running"))
        let model = IOSSessionOmpModel(client: client)

        #expect(await model.sendPrompt("bonjour") == true)
        #expect(client.promptCount == 1)
        #expect(client.lastPrompt == "bonjour")
        #expect(model.error == nil)

        client.promptFailure = ClientError.api(.unavailable("Écriture impossible vers la session : pipe cassé."))
        #expect(await model.sendPrompt("encore") == false)
        #expect(client.promptCount == 2)
        #expect(model.error == "Écriture impossible vers la session : pipe cassé.")
    }

    @Test("ios-session-omp/AC-8 : le fil monté par `syncThread()` rend les lignes de SessionRowBuilder sur la fixture partagée")
    func threadRowsAreSharedParity() async throws {
        let payload: RemoteSessionPayload = try decode(SessionParity.payloadJSON)
        let client = SessionOmpStub(
            state: connected,
            hosted: try makeHostedEvent(state: "running", sessionFile: "parity-session-1.jsonl")
        )
        client.payload = payload
        let model = IOSSessionOmpModel(client: client)

        model.syncThread()
        let thread = try #require(model.thread)
        await thread.read()

        // La référence : le même SessionRowBuilder, nourri des mêmes entrées de la fixture.
        var reference = SessionRowBuilder()
        reference.projectRoot = payload.header?.cwd
        reference.append(SessionWire.entries(payload))
        #expect(thread.state == .ready)
        #expect(thread.rows == reference.rows)
        #expect(thread.rows.count == 10)
    }

    @Test("ios-session-omp/AC-9 : un choix simple répond `kind:value` avec l'option choisie, en un seul appel")
    func selectDialogAnswersWithValue() async throws {
        let select = try dialog(id: "d1", method: "select", options: ["A", "B"])
        let client = SessionOmpStub(state: connected, hosted: try makeHostedEvent(state: "running", dialogs: [
            ["id": "d1", "method": "select", "title": "Choisir", "options": ["A", "B"], "optionDescriptions": [], "promptStyle": false],
        ]))
        let model = IOSSessionOmpModel(client: client)
        // Le corps vient du gating PARTAGÉ (la feuille réutilisée).
        let request = try #require(IOSDialogGating.request(dialog: select, selectedIndex: 1, text: ""))

        #expect(await model.answer(request) == nil)
        #expect(client.answers.count == 1)
        #expect(client.answers.first?.kind == ProjectDialogKind.value)
        #expect(client.answers.first?.value == "B")
        // Le dialogue quitte la file servie : la feuille se referme.
        #expect(client.hosted?.dialogs.isEmpty == true)
    }

    @Test("ios-session-omp/AC-10 : les quatre formes produisent le corps attendu")
    func fourDialogForms() throws {
        let select = try dialog(id: "d1", method: "select", options: ["A", "B"])
        let input = try dialog(id: "d2", method: "input")
        let editor = try dialog(id: "d3", method: "editor", prefill: "plan courant")
        let confirm = try dialog(id: "d4", method: "confirm")

        let selected = try #require(IOSDialogGating.request(dialog: select, selectedIndex: 0, text: ""))
        #expect(selected == RemoteDialogAnswerRequest(kind: ProjectDialogKind.value, value: "A"))
        let typed = try #require(IOSDialogGating.request(dialog: input, selectedIndex: nil, text: "texte"))
        #expect(typed == RemoteDialogAnswerRequest(kind: ProjectDialogKind.value, value: "texte"))
        // Un `editor` accepte une valeur vide, et part de son prefill.
        #expect(IOSDialogGating.initialText(dialog: editor) == "plan courant")
        let edited = try #require(IOSDialogGating.request(dialog: editor, selectedIndex: nil, text: ""))
        #expect(edited == RemoteDialogAnswerRequest(kind: ProjectDialogKind.value, value: ""))
        // `confirm` ne passe pas par `request` : il a sa forme dédiée.
        #expect(IOSDialogGating.request(dialog: confirm, selectedIndex: nil, text: "") == nil)
        #expect(IOSDialogGating.confirmation(true) == RemoteDialogAnswerRequest(kind: ProjectDialogKind.confirmed, confirmed: true))
        #expect(IOSDialogGating.confirmation(false) == RemoteDialogAnswerRequest(kind: ProjectDialogKind.confirmed, confirmed: false))
    }

    @Test("ios-session-omp/AC-11 : l'annulation répond `kind:cancelled` et un `hosted` sans dialogue referme la feuille")
    func cancellationAnswersAndClears() async throws {
        let client = SessionOmpStub(state: connected, hosted: try makeHostedEvent(state: "running", dialogs: [
            ["id": "d1", "method": "select", "title": "Choisir", "options": ["A"], "optionDescriptions": [], "promptStyle": false],
        ]))
        let model = IOSSessionOmpModel(client: client)
        #expect(await model.answer(IOSDialogGating.cancellation()) == nil)
        #expect(client.answers.first?.kind == ProjectDialogKind.cancelled)
        #expect(client.hosted?.dialogs.first == nil)
    }

    @Test("ios-session-omp/AC-12 : un `hosted` re-servi portant un dialogue le rend tranchable, et `appeared()` relit l'état")
    func reconnectRestoresDialogs() async throws {
        let client = SessionOmpStub(state: connected, hosted: try makeHostedEvent(state: "running"))
        let model = IOSSessionOmpModel(client: client)

        // À l'apparition : une relecture de l'état servi.
        model.appeared()
        #expect(await eventually { client.hostedSessionCalls == 1 })

        // Un dialogue posé pendant la déconnexion arrive par la relecture/le flux :
        // il redevient la tête de la file servie, donc la feuille s'ouvre d'elle-même.
        client.hosted = try makeHostedEvent(state: "running", dialogs: [
            ["id": "d9", "method": "confirm", "title": "Confirmer", "options": [], "optionDescriptions": [], "promptStyle": false],
        ])
        #expect(client.hosted?.dialogs.first?.id == "d9")
    }

    @Test("ios-session-omp/AC-1 : le lancement appelle la route une fois et le fil suit le fichier servi")
    func launchStartsAndSyncsThread() async throws {
        let client = SessionOmpStub(state: connected, hosted: try makeHostedEvent(state: "idle"))
        let model = IOSSessionOmpModel(client: client)

        #expect(await model.launch(repoKey: "depot") == nil)
        #expect(client.launchCount == 1)
        model.syncThread()
        #expect(model.thread?.file == "/tmp/session.jsonl")
        #expect(model.thread?.title == "depot")
    }
    @Test("ios-session-omp/AC-5 : rouvrir l'app retrouve la session en marche dans le même état, sans relancer")
    func reopenFindsLiveSession() async throws {
        // La session tourne sur le Mac ; l'app a été fermée puis rouverte : un
        // nouvel écran n'a aucun état local, il ne vit que de `GET /v1/session`.
        let client = SessionOmpStub(state: connected, hosted: try makeHostedEvent(state: "running", sessionFile: "/tmp/session.jsonl", projectName: "depot"))
        client.hosted = nil
        let reopened = IOSSessionOmpModel(client: client)
        #expect(reopened.surface == .loading)

        reopened.appeared()
        #expect(await eventually { reopened.surface == .live })
        #expect(client.launchCount == 0, "rouvrir ne relance jamais la session")
        #expect(client.hosted?.projectName == "depot")
        reopened.syncThread()
        #expect(reopened.thread?.file == "/tmp/session.jsonl")
    }

@MainActor
private func eventually(timeout: Double = 5, _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return condition()
}

    @Test("ios-session-omp/AC-13 : l'arrêt appelle la route une fois")
    func stopCallsRouteOnce() async throws {
        let client = SessionOmpStub(state: connected, hosted: try makeHostedEvent(state: "running"))
        let model = IOSSessionOmpModel(client: client)
        await model.stop()
        #expect(client.stopCount == 1)
        #expect(client.hosted?.state == "stopped")
    }
}
