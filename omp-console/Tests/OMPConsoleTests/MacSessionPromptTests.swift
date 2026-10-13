// Preuves Mac de la dictée vers la session OMP (siri-dictee-session-omp, S-3 et
// S-4) : UNE règle d'acceptation d'un prompt, celle du champ de saisie, partagée
// par le geste typé `RemoteActions.prompt(message:)`, la route
// `POST /v1/session/prompt` et l'intent `MacSessionPromptIntent`. Les helpers de
// fixture (session hébergée dans un état donné, compteur de POST de prompt)
// servent aux trois volets.

import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

/// L'état de la session hébergée qu'une preuve installe.
enum HostedPromptState: String, CaseIterable, Sendable {
    case idle, launching, running, runningWithDialog, stopping, stopped, dead, failed
}

/// Le refus attendu pour chaque état (`nil` = le prompt part), écrit À LA MAIN.
private let promptRefusals: [(state: HostedPromptState, refusal: GestureRefusal?, message: String?)] = [
    (.idle, .noHostedSession, "aucune session OMP n'est lancée"),
    (.launching, .sessionNotRunning, "la session n'est pas en marche"),
    (.running, nil, nil),
    (.runningWithDialog, .hostedDialogPending, "un dialogue de la session attend une réponse"),
    (.stopping, .sessionNotRunning, "la session n'est pas en marche"),
    (.stopped, .hostedSessionStopped, "la session OMP est arrêtée"),
    (.dead, .hostedSessionStopped, "la session OMP est arrêtée"),
    (.failed, .hostedSessionStopped, "la session OMP est arrêtée"),
]

/// Les états d'une session arrêtée (AC-5).
private let stoppedStates: [HostedPromptState] = [.stopped, .dead, .failed]

/// Ce que Siri dit à l'issue de la dictée, pour chaque état, écrit À LA MAIN.
private let intentPhrases: [(state: HostedPromptState, phrase: String)] = [
    (.idle, "Le Mac a refusé la demande\u{00A0}: aucune session OMP n'est lancée."),
    (.launching, "Le Mac a refusé la demande\u{00A0}: la session n'est pas en marche."),
    (.running, "Reçu."),
    (.runningWithDialog, "Le Mac a refusé la demande\u{00A0}: un dialogue de la session attend une réponse."),
    (.stopping, "Le Mac a refusé la demande\u{00A0}: la session n'est pas en marche."),
    (.stopped, "Le Mac a refusé la demande\u{00A0}: la session OMP est arrêtée."),
    (.dead, "Le Mac a refusé la demande\u{00A0}: la session OMP est arrêtée."),
    (.failed, "Le Mac a refusé la demande\u{00A0}: la session OMP est arrêtée."),
]

/// Les messages absents qui font demander le message (AC-10).
private let missingMessages: [String?] = [nil, "", " \n"]

/// Le port `ask` de Siri, scripté : rend ses réponses dans l'ordre (puis `""`)
/// et garde les questions posées.
@MainActor
private final class ScriptedAsk {
    private(set) var prompts: [String] = []
    private var answers: [String]

    init(_ answers: [String] = []) {
        self.answers = answers
    }

    func ask(_ prompt: String) async throws -> String {
        prompts.append(prompt)
        return answers.isEmpty ? "" : answers.removeFirst()
    }
}

/// La dictée du Mac sur `fixture`, avec le `deliver` de l'intent réel : sa porte
/// `applyVoicePolicy` puis l'issue du geste. L'intent est construit par `init()`
/// et son contexte `voice` n'est jamais lu hors d'une exécution d'intent.
@MainActor
private func dictate(_ fixture: HostedPromptFixture, message: String?, asker: ScriptedAsk) async throws -> String {
    let intent = MacSessionPromptIntent()
    return try await MacSessionPrompt.run(
        actions: fixture.stack.remoteActions,
        message: message,
        ask: { try await asker.ask($0) },
        deliver: { text, send in
            VoiceIssue(
                try await intent.applyVoicePolicy(target: text, send: send),
                gesture: MacSessionPromptIntent.voiceGesture,
                target: text
            )
        }
    )
}

/// Un transport scripté qui RETIENT la première requête `method` dont le chemin
/// finit par `suffix`, jusqu'à `release()` : la session reste en `launching`
/// (création) ou en `stopping` (fermeture) le temps de la preuve.
final class HeldServiceTransport: ServiceTransport, @unchecked Sendable {
    let base: ScriptedServiceTransport
    private let lock = NSLock()
    private var hold: (method: String, suffix: String)?
    private var held = false

    init(_ base: ScriptedServiceTransport) {
        self.base = base
    }

    func holdNext(_ method: String, _ suffix: String) {
        lock.withLock {
            hold = (method, suffix)
            held = true
        }
    }

    func release() {
        lock.withLock {
            hold = nil
            held = false
        }
    }

    func send(_ request: URLRequest) async throws -> ServiceHTTPResponse {
        let method = (request.httpMethod ?? "GET").uppercased()
        let path = request.url?.path ?? ""
        let matches = lock.withLock { hold.map { $0.method == method && path.hasSuffix($0.suffix) } ?? false }
        if matches {
            while lock.withLock({ held }) {
                try await Task.sleep(for: .milliseconds(10))
            }
        }
        return try await base.send(request)
    }

    func lines(_ request: URLRequest) async throws -> AsyncThrowingStream<String, Error> {
        try await base.lines(request)
    }
}

/// Une session hébergée installée dans un état, servie par une pile distante.
@MainActor
struct HostedPromptFixture {
    let transport: ScriptedServiceTransport
    let held: HeldServiceTransport
    let session: SessionConsoleModel
    let stack: RemoteStack
    let root: URL

    /// Les POST de prompt partis au service.
    var promptPosts: [ScriptedRequest] {
        transport.requests.filter { $0.method == "POST" && $0.path.hasSuffix("/prompt") }
    }

    func tearDown() {
        held.release()
        stack.stop()
        try? FileManager.default.removeItem(at: root)
    }
}

/// Installe une session hébergée dans `state`, sur le patron `makeHostedSession`
/// de RemoteSessionRouteTests (transport scripté, flux maintenu ouvert).
@MainActor
func makeHostedPromptFixture(_ state: HostedPromptState) async throws -> HostedPromptFixture {
    let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        .appendingPathComponent("omp-console-prompt-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

    let transport = ScriptedServiceTransport()
    stubServiceSession(transport, cwd: root.path, sessionFile: "/tmp/session.jsonl")
    openServiceStream(transport, count: 2)
    let held = HeldServiceTransport(transport)
    let host = ServiceSessionModel(
        purpose: "session",
        makeClient: {
            ServiceClient(
                endpoint: ServiceEndpoint(
                    baseURL: URL(string: "http://127.0.0.1:8788/v1")!,
                    token: String(repeating: "a", count: 32),
                    pid: 4_242,
                    port: 8788,
                    stateDir: "/tmp/omp-state"
                ),
                transport: held
            )
        },
        maxAttempts: 5,
        retryDelay: { _ in projectRetryDelay }
    )
    let session = SessionConsoleModel(host: host)
    let stack = try await RemoteStack.make(sessionModel: session)
    let fixture = HostedPromptFixture(transport: transport, held: held, session: session, stack: stack, root: root)

    switch state {
    case .idle:
        break
    case .launching:
        held.holdNext("POST", "/v1/sessions")
        Task { try? await host.start(projectRoot: root, resumeFile: nil) }
        try #require(await awaitMainTrue(timeout: 5.0) { host.state == .launching })
    case .running:
        try await host.start(projectRoot: root, resumeFile: nil)
    case .runningWithDialog:
        try await host.start(projectRoot: root, resumeFile: nil)
        try #require(await awaitTrue(timeout: 5.0) { transport.streamOpenCount >= 1 })
        emitServiceDialog(transport, id: "d1", method: "select", title: "Dialogue", options: ["a", "b"])
        try #require(await awaitMainTrue(timeout: 5.0) { host.dialogQueue.first?.id == "d1" })
    case .stopping:
        try await host.start(projectRoot: root, resumeFile: nil)
        held.holdNext("DELETE", "/v1/sessions/sess-1234")
        Task { await host.stop() }
        try #require(await awaitMainTrue(timeout: 5.0) { host.state == .stopping })
    case .stopped:
        try await host.start(projectRoot: root, resumeFile: nil)
        await host.stop()
    case .dead:
        try await host.start(projectRoot: root, resumeFile: nil)
        transport.failRequests(ServiceClientError.unavailable)
        try? await host.send(prompt: "perdu")
        transport.failRequests(nil)
    case .failed:
        try? await host.start(projectRoot: root.appendingPathComponent("absent"), resumeFile: nil)
    }
    try #require(fixture.matches(state), "état installé : \(state.rawValue)")
    return fixture
}

extension HostedPromptFixture {
    /// Vrai si la session est bien dans `state`.
    func matches(_ state: HostedPromptState) -> Bool {
        let host = session.host
        switch state {
        case .idle: return host.state == .idle
        case .launching: return host.state == .launching
        case .running: return host.state == .running && host.dialogQueue.isEmpty
        case .runningWithDialog: return host.state == .running && !host.dialogQueue.isEmpty
        case .stopping: return host.state == .stopping
        case .stopped: return host.state == .stopped
        case .dead: return host.state == .dead
        case .failed:
            if case .failed = host.state { return true }
            return false
        }
    }
}

@Suite("MacSessionPromptTests")
@MainActor
struct MacSessionPromptTests {
    // --- modèle --------------------------------------------------------------

    @Test("siri-dictee-session-omp/AC-4 (modèle) : sans session lancée, le geste refuse « aucune session » et rien ne part")
    func idleRefusesWithoutPost() async throws {
        let fixture = try await makeHostedPromptFixture(.idle)
        defer { fixture.tearDown() }
        #expect(fixture.session.promptRefusal(for: "bonjour") == .noHostedSession)
        await #expect(throws: GestureRefusal.noHostedSession) {
            try await fixture.stack.remoteActions.prompt(message: "bonjour")
        }
        #expect(fixture.promptPosts.isEmpty)
    }

    @Test(
        "siri-dictee-session-omp/AC-5 (modèle) : une session arrêtée, morte ou en échec refuse « session arrêtée » et rien ne part",
        arguments: stoppedStates
    )
    func stoppedRefusesWithoutPost(state: HostedPromptState) async throws {
        let fixture = try await makeHostedPromptFixture(state)
        defer { fixture.tearDown() }
        let before = fixture.promptPosts.count
        #expect(fixture.session.promptRefusal(for: "bonjour") == .hostedSessionStopped)
        await #expect(throws: GestureRefusal.hostedSessionStopped) {
            try await fixture.stack.remoteActions.prompt(message: "bonjour")
        }
        #expect(fixture.promptPosts.count == before)
    }

    // --- route ----------------------------------------------------------------

    @Test(
        "siri-dictee-session-omp/AC-6 (route) : le champ, le geste et la route rendent le même refus, et seul running sans dialogue envoie",
        arguments: promptRefusals.indices
    )
    func fieldGestureAndRouteAgree(index: Int) async throws {
        let row = promptRefusals[index]
        let fixture = try await makeHostedPromptFixture(row.state)
        defer { fixture.tearDown() }
        let model = fixture.session

        // Parité du champ de saisie et de la règle.
        model.prompt = "x"
        #expect(model.promptRefusal(for: "x") == row.refusal)
        #expect(model.canSendPrompt == (model.promptRefusal(for: "x") == nil))
        // Le blanc est refusé avant tout contrôle d'état.
        #expect(model.promptRefusal(for: " \n") == .emptyText)

        let before = fixture.promptPosts.count
        if let refusal = row.refusal {
            await #expect(throws: refusal) {
                try await fixture.stack.remoteActions.prompt(message: "x")
            }
            let token = try await fixture.stack.pair()
            let reply = try await fixture.stack.call("POST", "/v1/session/prompt", token: token, json: ["message": "x"])
            #expect(reply.status == 409)
            #expect(reply.errorCode == "conflict")
            #expect(reply.errorMessage == row.message)
            #expect(refusal.apiError.message == row.message)
            #expect(fixture.promptPosts.count == before, "aucun prompt ne part au service")
        } else {
            #expect(model.canSendPrompt)
            try await fixture.stack.remoteActions.prompt(message: "x")
            #expect(fixture.promptPosts.count == before + 1)
            #expect(fixture.promptPosts.last?.body?["text"] as? String == "x")

            let token = try await fixture.stack.pair()
            let reply = try await fixture.stack.call("POST", "/v1/session/prompt", token: token, json: ["message": "x"])
            #expect(reply.status == 200)
            #expect(try reply.json(RemoteSentPayload.self).sent)
            #expect(fixture.promptPosts.count == before + 2)
        }
    }

    // --- intent ---------------------------------------------------------------

    @Test("siri-dictee-session-omp/AC-2 (Mac) : le message dicté part en UN POST de prompt à la session en marche, et Siri dit « Reçu. »")
    func dictationReachesRunningSession() async throws {
        let fixture = try await makeHostedPromptFixture(.running)
        defer { fixture.tearDown() }
        let asker = ScriptedAsk()
        let before = fixture.promptPosts.count

        let phrase = try await dictate(fixture, message: "fais avancer le lot", asker: asker)

        #expect(phrase == "Reçu.")
        #expect(fixture.promptPosts.count == before + 1)
        #expect(fixture.promptPosts.last?.body?["text"] as? String == "fais avancer le lot")
        #expect(asker.prompts.isEmpty)
    }

    @Test("siri-dictee-session-omp/AC-4 (Mac) : sans session lancée, rien ne part et Siri dit qu’aucune session n’est lancée")
    func dictationWithoutSession() async throws {
        let fixture = try await makeHostedPromptFixture(.idle)
        defer { fixture.tearDown() }

        let phrase = try await dictate(fixture, message: "bonjour", asker: ScriptedAsk())

        #expect(phrase == "Le Mac a refusé la demande\u{00A0}: aucune session OMP n'est lancée.")
        #expect(fixture.promptPosts.isEmpty)
    }

    @Test(
        "siri-dictee-session-omp/AC-5 (Mac) : sur une session arrêtée, morte ou en échec, rien ne part et Siri dit que la session est arrêtée",
        arguments: stoppedStates
    )
    func dictationOnStoppedSession(state: HostedPromptState) async throws {
        let fixture = try await makeHostedPromptFixture(state)
        defer { fixture.tearDown() }
        let before = fixture.promptPosts.count

        let phrase = try await dictate(fixture, message: "bonjour", asker: ScriptedAsk())

        #expect(phrase == "Le Mac a refusé la demande\u{00A0}: la session OMP est arrêtée.")
        #expect(fixture.promptPosts.count == before)
    }

    @Test(
        "siri-dictee-session-omp/AC-6 (Mac) : Siri dit le refus du geste dans chaque état où le champ refuse, sans POST, et « Reçu. » là où il accepte",
        arguments: intentPhrases.indices
    )
    func dictationSaysTheGestureRefusal(index: Int) async throws {
        let row = intentPhrases[index]
        let fixture = try await makeHostedPromptFixture(row.state)
        defer { fixture.tearDown() }
        let before = fixture.promptPosts.count
        fixture.session.prompt = "x"
        let fieldAccepts = fixture.session.canSendPrompt

        let phrase = try await dictate(fixture, message: "x", asker: ScriptedAsk())

        #expect(phrase == row.phrase)
        if let refusal = fixture.session.promptRefusal(for: "x") {
            #expect(!fieldAccepts)
            #expect(phrase == VoiceIssue.macRefused(motive: refusal.apiError.message ?? "").phrase)
            #expect(fixture.promptPosts.count == before, "rien n'est ajouté au fil")
        } else {
            #expect(fieldAccepts)
            #expect(fixture.promptPosts.count == before + 1)
            #expect(fixture.promptPosts.last?.body?["text"] as? String == "x")
        }
    }

    @Test("siri-dictee-session-omp/AC-6 (Mac) : une annulation de l’envoi se propage, toute autre erreur vaut un refus sans motif, et rien ne part")
    func deliveryErrorsAreTranslated() async throws {
        let fixture = try await makeHostedPromptFixture(.running)
        defer { fixture.tearDown() }
        let before = fixture.promptPosts.count

        await #expect(throws: CancellationError.self) {
            _ = try await MacSessionPrompt.run(
                actions: fixture.stack.remoteActions,
                message: "x",
                ask: { _ in "" },
                deliver: { _, _ in throw CancellationError() }
            )
        }
        let phrase = try await MacSessionPrompt.run(
            actions: fixture.stack.remoteActions,
            message: "x",
            ask: { _ in "" },
            deliver: { _, _ in throw URLError(.timedOut) }
        )
        #expect(phrase == "Le Mac a refusé la demande.")
        #expect(fixture.promptPosts.count == before)
    }

    @Test("siri-dictee-session-omp/AC-9 (Mac) : le littéral de l’intent suit la ligne de la table, et aucune confirmation n’est demandée tant qu’elle n’en prescrit pas")
    func intentFollowsThePolicyRow() async throws {
        #expect(MacSessionPromptIntent.voiceGesture == .promptHostedSession)
        #expect(MacSessionPromptIntent.authenticationPolicy == VoiceGesturePolicy.authenticationPolicy(for: .promptHostedSession, on: .mac))
        let rule = VoiceGesturePolicy.rule(for: .promptHostedSession, on: .mac)
        #expect(!rule.needsConfirmation)
        #expect(!rule.needsUnlock)

        let fixture = try await makeHostedPromptFixture(.running)
        defer { fixture.tearDown() }
        let asker = ScriptedAsk()
        let before = fixture.promptPosts.count

        let phrase = try await dictate(fixture, message: "bonjour", asker: asker)

        #expect(asker.prompts.isEmpty, "le message fourni n'est ni redemandé ni confirmé")
        #expect(phrase == "Reçu.")
        #expect(fixture.promptPosts.count == before + 1, "un seul envoi, sans confirmation")
    }

    @Test(
        "siri-dictee-session-omp/AC-10 (Mac) : sans message, Siri demande « Quel message ? » une fois ; une réponse vide n’envoie rien",
        arguments: missingMessages
    )
    func emptyDictationSendsNothing(message: String?) async throws {
        let fixture = try await makeHostedPromptFixture(.running)
        defer { fixture.tearDown() }
        let asker = ScriptedAsk([""])
        let before = fixture.promptPosts.count

        let phrase = try await dictate(fixture, message: message, asker: asker)

        #expect(asker.prompts == ["Quel message\u{00A0}?"])
        #expect(phrase == "Aucun message n’a été envoyé.")
        #expect(fixture.promptPosts.count == before)
    }

    @Test(
        "siri-dictee-session-omp/AC-11 (Mac) : après le POST accepté, Siri dit « Reçu. » sans attendre de trame de la session",
        .timeLimit(.minutes(1))
    )
    func receivedEndsWithoutWaiting() async throws {
        let fixture = try await makeHostedPromptFixture(.running)
        defer { fixture.tearDown() }
        let asker = ScriptedAsk()
        let before = fixture.promptPosts.count

        // Le service scripté n'émet plus aucune trame : `run` ne doit pas en attendre.
        let clock = ContinuousClock()
        let start = clock.now
        let phrase = try await dictate(fixture, message: "bonjour", asker: asker)
        let elapsed = clock.now - start

        #expect(phrase == "Reçu.")
        #expect(asker.prompts.isEmpty)
        #expect(fixture.promptPosts.count == before + 1)
        #expect(elapsed < .seconds(5))
    }
}
