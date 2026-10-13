// Les preuves de la dictée Siri vers la session OMP depuis l'iPhone
// (siri-dictee-session-omp, S-5) : un vrai `ConsoleClientModel` sur les doublures
// de `ClientTestDoubles.swift` (Mac prêt par `HelloStreamTransport`, Mac muet par
// `ScriptedClientTransport` et `ReturningPacer`, trousseau `CountingTokenStore`),
// et la livraison de l'intent réel (`IOSSessionPromptIntent().applyVoicePolicy`).
// Les attendus viennent du noyau vocal (`VoiceIssue`, `VoiceSpeechText`) ; les
// motifs de refus sont les messages 409 du Mac (S-3). La reconnaissance vocale
// réelle (AC-1, AC-8, AC-10) se recette à la main sur iPhone (README, R-1, R-3, R-4).

import AppIntents
import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsoleIOS

// MARK: - Le Mac scripté

private let promptMacAddress = "127.0.0.1:18787"
private let promptPath = "/v1/session/prompt"
private let dictated = "fais avancer le lot"

/// Les lectures de fond qu'un client lance en ouvrant son flux (faits de
/// l'Accueil, état des PR) : elles ne sont pas des envois de l'intent.
private let connectionReads: Set<String> = [
    "GET /v1/stream", "GET /v1/components", "GET /v1/journal", "POST /v1/pull-request-states/refresh",
]

/// Les quatre refus 409 du geste `hosted.prompt` (S-3), mot pour mot.
private let noSession = "aucune session OMP n'est lancée"
private let stopped = "la session OMP est arrêtée"
private let notRunning = "la session n'est pas en marche"
private let dialogPending = "un dialogue de la session attend une réponse"

/// Le Mac : `POST /v1/session/prompt` répond `status`/`json`, toute autre route 404.
private func promptMac(status: Int, json: String) -> @Sendable (ClientHTTPRequest) -> ClientHTTPResponse {
    { request in
        if request.method == "POST", request.path == promptPath {
            return ClientDoubles.response(status: status, json: json)
        }
        return ClientDoubles.response(status: 404, json: #"{"error":{"code":"not_found","message":"route"}}"#)
    }
}

private let accepted = promptMac(status: 200, json: #"{"sent":true}"#)

private func refusing(_ motive: String) -> @Sendable (ClientHTTPRequest) -> ClientHTTPResponse {
    promptMac(status: 409, json: #"{"error":{"code":"conflict","message":"\#(motive)"}}"#)
}

/// Un client appairé, à froid, face à un Mac prêt (trame `hello` de la version
/// de l'app) qui répond par `responder`.
@MainActor
private func readyClient(
    _ responder: @escaping @Sendable (ClientHTTPRequest) -> ClientHTTPResponse
) -> (client: ConsoleClientModel, transport: HelloStreamTransport) {
    let transport = HelloStreamTransport(version: ConsoleAPI.protocolVersion, responder)
    let client = ClientDoubles.pairedModel(
        tokens: CountingTokenStore(["dev-1": "tok-1"]), transport: transport, address: promptMacAddress
    )
    return (client, transport)
}

/// Le transport d'un Mac prêt dont la connexion tombe pendant l'envoi du prompt :
/// la requête part (enregistrée par `base`), puis l'échange échoue en transport.
private final class DroppedPromptTransport: ClientTransport, @unchecked Sendable {
    let base: HelloStreamTransport

    init(_ base: HelloStreamTransport) { self.base = base }

    func send(_ request: ClientHTTPRequest, to endpoint: ClientEndpoint, token: String?) async throws -> ClientHTTPResponse {
        let response = try await base.send(request, to: endpoint, token: token)
        guard request.method == "POST", request.path == promptPath else { return response }
        throw ClientError.transport(.closed("connexion fermée"))
    }

    func stream(_ request: ClientHTTPRequest, to endpoint: ClientEndpoint, token: String?) async throws -> AsyncThrowingStream<Data, Error> {
        try await base.stream(request, to: endpoint, token: token)
    }
}

// MARK: - L'intent

/// Le port `ask` : enregistre chaque question et rend `answer`.
@MainActor
private final class AskRecorder {
    private(set) var dialogs: [String] = []
    private let answer: String

    init(answer: String = "") { self.answer = answer }

    func ask(_ dialog: String) async throws -> String {
        dialogs.append(dialog)
        return answer
    }
}

/// La dictée de l'intent sur `client`, appareil déverrouillé sauf mention, avec
/// la livraison de l'intent réel : la politique de la table, puis l'envoi.
@MainActor
private func dictate(
    _ client: ConsoleClientModel,
    message: String? = dictated,
    ask recorder: AskRecorder? = nil,
    unlocked: Bool = true
) async throws -> String {
    let ask = recorder ?? AskRecorder()
    return try await IOSSiriPending.dictate(
        client: client,
        message: message,
        ask: { try await ask.ask($0) },
        deliver: { text, send in
            VoiceIssue(
                try await IOSSessionPromptIntent().applyVoicePolicy(target: text, send: send),
                gesture: IOSSessionPromptIntent.voiceGesture,
                target: text
            )
        },
        isProtectedDataAvailable: { unlocked }
    )
}

// MARK: - Outils

private func key(_ request: ClientHTTPRequest) -> String {
    "\(request.method) \(request.path)"
}

private func prompts(_ requests: [ClientHTTPRequest]) -> [ClientHTTPRequest] {
    requests.filter { $0.method == "POST" && $0.path == promptPath }
}

private func body(_ request: ClientHTTPRequest) -> [String: String] {
    request.body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] } ?? [:]
}

/// Laisse aux tâches de fond du client le temps d'émettre ce qu'elles émettraient.
private func settle() async throws {
    try await Task.sleep(for: .milliseconds(200))
}

// MARK: - Les preuves

@Suite("IOSSiriSessionPromptTests")
@MainActor
struct IOSSiriSessionPromptTests {
    /// Un refus 409 du Mac : la phrase de refus avec ce motif, UN seul POST de
    /// prompt, et après lui rien d'autre que les lectures de fond de la connexion.
    private func expectRefusal(_ motive: String) async throws {
        let (client, transport) = readyClient(refusing(motive))
        let ask = AskRecorder()
        let phrase = try await dictate(client, ask: ask)
        try await settle()
        client.stop()

        #expect(phrase == VoiceIssue.macRefused(motive: motive).phrase)
        #expect(phrase == "Le Mac a refusé la demande\u{00A0}: \(motive).")
        #expect(ask.dialogs.isEmpty)
        let requests = transport.requests
        #expect(prompts(requests).count == 1, "une seule requête vers \(promptPath)")
        let sent = try #require(requests.lastIndex { $0.method == "POST" && $0.path == promptPath })
        let after = requests[(sent + 1)...].map(key)
        #expect(after.allSatisfy(connectionReads.contains), "aucune autre route après le prompt : \(after)")
    }

    @Test("siri-dictee-session-omp/AC-1 (iPhone) : Mac prêt, 200 au prompt → « Reçu. », le corps POSTé porte le message dicté")
    func sentMessageIsReceived() async throws {
        let (client, transport) = readyClient(accepted)
        let ask = AskRecorder()
        let phrase = try await dictate(client, ask: ask)
        client.stop()

        #expect(phrase == "Reçu.")
        #expect(phrase == VoiceIssue.sent(.promptHostedSession, target: dictated).phrase)
        #expect(ask.dialogs.isEmpty, "le message fourni n'est pas redemandé")
        let sent = try #require(prompts(transport.requests).first)
        #expect(prompts(transport.requests).count == 1)
        #expect(body(sent) == ["message": dictated])
    }

    @Test("siri-dictee-session-omp/AC-4 (iPhone) : aucune session → « Le Mac a refusé la demande : aucune session OMP n'est lancée. », rien d'autre")
    func noSessionIsSaid() async throws {
        try await expectRefusal(noSession)
    }

    @Test("siri-dictee-session-omp/AC-5 (iPhone) : session arrêtée → « Le Mac a refusé la demande : la session OMP est arrêtée. », rien d'autre")
    func stoppedSessionIsSaid() async throws {
        try await expectRefusal(stopped)
    }

    @Test("siri-dictee-session-omp/AC-6 (iPhone) : le refus du geste est dit tel quel (pas en marche, dialogue en attente) ; accepté → « Reçu. »")
    func gestureRefusalIsSaid() async throws {
        try await expectRefusal(notRunning)
        try await expectRefusal(dialogPending)

        let (client, transport) = readyClient(accepted)
        let phrase = try await dictate(client)
        client.stop()
        #expect(phrase == "Reçu.")
        #expect(prompts(transport.requests).count == 1)
    }

    @Test("siri-dictee-session-omp/AC-7 : non appairé, appairage refusé, Mac injoignable, version incompatible, envoi coupé, 401 → la phrase typée du noyau")
    func connectionCausesAreSaid() async throws {
        let local = ConsoleAPI.protocolVersion

        // Non appairé : aucun jeton.
        let unpairedTransport = ScriptedClientTransport(accepted)
        let unpaired = try await dictate(ClientDoubles.model(transport: unpairedTransport, address: promptMacAddress))
        #expect(unpaired == VoiceIssue.notPaired.phrase)
        #expect(prompts(unpairedTransport.requests).isEmpty)

        // Mac injoignable : le flux échoue, l'échéance tombe aussitôt.
        let silentTransport = ScriptedClientTransport(accepted)
        let silentClient = ClientDoubles.pairedModel(
            tokens: CountingTokenStore(["dev-1": "tok-1"]), transport: silentTransport,
            address: promptMacAddress, readinessPacer: ReturningPacer()
        )
        let unreachable = try await dictate(silentClient)
        silentClient.stop()
        #expect(unreachable == VoiceIssue.macUnreachable.phrase)
        #expect(prompts(silentTransport.requests).isEmpty)

        // Version incompatible : le Mac salue en version suivante.
        let newerTransport = HelloStreamTransport(version: local + 1, accepted)
        let newerClient = ClientDoubles.pairedModel(
            tokens: CountingTokenStore(["dev-1": "tok-1"]), transport: newerTransport, address: promptMacAddress
        )
        let incompatible = try await dictate(newerClient)
        newerClient.stop()
        #expect(incompatible == VoiceIssue.incompatibleVersion(local: local, remote: local + 1).phrase)
        #expect(prompts(newerTransport.requests).isEmpty)

        // Envoi coupé en transport : le POST part, l'échange échoue.
        let droppedBase = HelloStreamTransport(version: local, accepted)
        let droppedClient = ClientDoubles.pairedModel(
            tokens: CountingTokenStore(["dev-1": "tok-1"]), transport: DroppedPromptTransport(droppedBase), address: promptMacAddress
        )
        let dropped = try await dictate(droppedClient)
        droppedClient.stop()
        #expect(dropped == VoiceIssue.macUnreachable.phrase)
        #expect(prompts(droppedBase.requests).count == 1)

        // 401 au prompt : « non appairé » ; le jeton est alors refusé, et la dictée
        // suivante s'arrête à l'attente (`.pairingRefused`) sans rien envoyer.
        let revokedTransport = HelloStreamTransport(version: local, promptMac(status: 401, json: #"{"error":{"code":"unauthorized"}}"#))
        let revokedClient = ClientDoubles.pairedModel(
            tokens: CountingTokenStore(["dev-1": "tok-1"]), transport: revokedTransport, address: promptMacAddress
        )
        let unauthorized = try await dictate(revokedClient)
        #expect(unauthorized == VoiceIssue.notPaired.phrase)
        #expect(prompts(revokedTransport.requests).count == 1)
        for _ in 0..<200 {
            if case .refused = revokedClient.pairing { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(await revokedClient.waitUntilReady() == .pairingRefused)
        let refused = try await dictate(revokedClient)
        revokedClient.stop()
        #expect(refused == VoiceIssue.notPaired.phrase)
        #expect(prompts(revokedTransport.requests).count == 1, "aucun POST après le refus d'appairage")
    }

    @Test("siri-dictee-session-omp/AC-8 : iPhone verrouillé → la phrase de verrouillage, sans lire le jeton ni rien émettre")
    func lockedDeviceSendsNothing() async throws {
        let tokens = CountingTokenStore(["dev-1": "tok-1"])
        let transport = HelloStreamTransport(version: ConsoleAPI.protocolVersion, accepted)
        let client = ClientDoubles.pairedModel(tokens: tokens, transport: transport, address: promptMacAddress)
        let ask = AskRecorder()
        let phrase = try await dictate(client, message: nil, ask: ask, unlocked: false)
        client.stop()

        #expect(phrase == "Cet appareil est verrouillé. Déverrouillez-le, puis réessayez.")
        #expect(phrase == VoiceIssue.deviceLocked.phrase)
        #expect(await tokens.reads == 0)
        #expect(transport.requests.isEmpty)
        #expect(ask.dialogs.isEmpty)
        #expect(IOSSessionPromptIntent.authenticationPolicy == .requiresLocalDeviceAuthentication)
    }

    @Test("siri-dictee-session-omp/AC-9 (iPhone) : la politique de l'intent est celle de la table, sans confirmation, et le POST part")
    func intentFollowsTheTable() async throws {
        #expect(IOSSessionPromptIntent.voiceGesture == .promptHostedSession)
        #expect(IOSSessionPromptIntent.authenticationPolicy == VoiceGesturePolicy.authenticationPolicy(for: .promptHostedSession, on: .ios))
        #expect(VoiceGesturePolicy.rule(for: .promptHostedSession, on: .ios).needsConfirmation == false)

        // La livraison passe par `IOSSessionPromptIntent().applyVoicePolicy` : une
        // confirmation demandée appellerait Siri, absent ici ; le POST part.
        let (client, transport) = readyClient(accepted)
        let ask = AskRecorder()
        let phrase = try await dictate(client, ask: ask)
        client.stop()
        #expect(phrase == "Reçu.")
        #expect(ask.dialogs.isEmpty)
        #expect(prompts(transport.requests).count == 1)
    }

    @Test("siri-dictee-session-omp/AC-10 (iPhone) : sans message, « Quel message ? » une fois, réponse vide → rien d'envoyé, « Aucun message n’a été envoyé. »")
    func emptyDictationSendsNothing() async throws {
        let (client, transport) = readyClient(accepted)
        let ask = AskRecorder(answer: "")
        let phrase = try await dictate(client, message: nil, ask: ask)
        client.stop()

        #expect(VoiceSpeechText.dictationPrompt == "Quel message\u{00A0}?")
        #expect(ask.dialogs == [VoiceSpeechText.dictationPrompt])
        #expect(phrase == "Aucun message n’a été envoyé.")
        #expect(phrase == VoiceSpeechText.dictationEmpty)
        #expect(prompts(transport.requests).isEmpty)
    }

    @Test("siri-dictee-session-omp/AC-11 (iPhone) : après le 200, « Reçu. » et plus aucune requête vers /v1/session*")
    func receivedEndsTheConversation() async throws {
        let (client, transport) = readyClient(accepted)
        let phrase = try await dictate(client)
        try await settle()
        client.stop()

        #expect(phrase == "Reçu.")
        let session = transport.requests.filter { $0.path.hasPrefix("/v1/session") }.map(key)
        #expect(session == ["POST \(promptPath)"], "ni GET /v1/session ni autre requête de session : \(session)")
    }

    @Test("siri-dictee-session-omp/AC-12 (iPhone) : « Écrire à la session OMP » a ses 3 phrases françaises, et chaque phrase d'App Shortcut porte le nom de l'app")
    func shortcutPhrasesCarryTheAppName() throws {
        let url = try #require(Bundle.main.url(forResource: "extract", withExtension: "actionsdata", subdirectory: "Metadata.appintents"))
        let json = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let shortcuts = try #require(json["autoShortcuts"] as? [[String: Any]])
        let actions = try #require(json["actions"] as? [String: Any])
        let identifier = String(describing: IOSSessionPromptIntent.self)
        #expect(actions.keys.contains(identifier))

        func keys(_ shortcut: [String: Any]) -> [String] {
            (shortcut["phraseTemplates"] as? [[String: Any]] ?? []).compactMap { $0["key"] as? String }
        }
        for shortcut in shortcuts {
            for key in keys(shortcut) {
                #expect(key.contains("${applicationName}"), "« \(key) » ne nomme pas l'app")
            }
        }
        let prompt = try #require(shortcuts.first { $0["actionIdentifier"] as? String == identifier })
        #expect(keys(prompt) == [
            "Dis à ${applicationName}",
            "Envoyer un message à ${applicationName}",
            "Écrire à ${applicationName}",
        ])
    }
}
