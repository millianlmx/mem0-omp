// L'écran Canaux côté client (routes `/v1/workstation/channels*` d'omp-harness) : état des
// trois canaux avec compte, dernière lecture et phrase du serveur ; gestes de l'appareil
// approbateur (client OAuth, connexion complète ou d'un seul canal Google, recollage,
// blocage) avec leurs corps exacts ; refus d'un jeton ordinaire rendu au geste ; aucune
// copie du secret ; écran absent sur un serveur sans la route — sur la doublure de transport.
// Aucune donnée réelle : comptes, identifiants et adresses sont inventés.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private func reply(_ json: String, status: Int = 200) -> HarnessReply { HarnessReply(status: status, body: Data(json.utf8)) }

private let blockedPhrase = "bloqué par l’administrateur de l’entreprise : la veille ne lit pas ce canal, le poste continue par le navigateur"

/// L'état tel que le serveur l'écrit (clé inconnue comprise) : Gmail bloqué, Agenda connecté,
/// Slack non connecté ; Google a une connexion en attente, Slack n'a pas de client.
private let viewJSON = #"""
{"channels":[
  {"id":"gmail","connection":"google","state":"blocked","account":null,"lastReadAt":null,"error":"\#(blockedPhrase)"},
  {"id":"calendar","connection":"google","state":"connected","account":"moi@exemple.fr","lastReadAt":1762600000000,"error":null,"inconnu":1},
  {"id":"slack","connection":"slack","state":"disconnected","account":null,"lastReadAt":null,"error":null}],
 "connections":[
  {"id":"google","clientId":"1234-abcdef.apps.googleusercontent.com","clientConfigured":true,
   "login":{"id":"cl1","connection":"google","state":"waiting","url":"https://accounts.google.com/o/oauth2/v2/auth?state=s1","startedAt":1,"expiresAt":2,"error":null}},
  {"id":"slack","clientId":null,"clientConfigured":false,"login":null}]}
"""#

private let loginJSON = #"{"login":{"id":"cl2","connection":"google","state":"waiting","url":"https://accounts.google.com/o/oauth2/v2/auth?state=s2","startedAt":3,"expiresAt":4,"error":null}}"#
private let answerJSON = #"{"login":{"id":"cl2","connection":"google","state":"done","url":null,"startedAt":3,"expiresAt":4,"error":null},"channels":[]}"#
private let clientJSON = #"{"connection":{"id":"slack","clientId":"111.222","clientConfigured":true,"login":null}}"#
private let ownerOnly = reply(#"{"error":"le poste est réservé au propriétaire"}"#, status: 403)
private let approverOnly = reply(#"{"error":"seul l'appareil approbateur (OMP Console appairée avec le code de `harness.sh approver`) peut approuver, refuser ou régler le poste"}"#, status: 403)

/// Un serveur qui sert la boîte et les canaux ; `overrides` remplace une réponse par « MÉTHODE chemin ».
private func channelServer(approver: Bool = true, _ overrides: [String: HarnessReply] = [:]) -> @Sendable (HarnessCall) -> HarnessReply {
    { call in
        if let forced = overrides["\(call.method) \(call.path)"] { return forced }
        switch (call.method, call.path) {
        case ("GET", "/v1/inbox"): return reply(#"{"batches":[],"awaiting":[],"decisions":[],"runs":[],"cursor":1}"#)
        case ("GET", "/v1/me"): return reply(#"{"client":{"name":"app","role":"admin","repos":"*","createdAt":0,"approver":\#(approver)}}"#)
        case ("GET", "/v1/workstation/channels"): return reply(viewJSON)
        case ("PUT", "/v1/workstation/channels/google/client"), ("PUT", "/v1/workstation/channels/slack/client"): return reply(clientJSON)
        case ("POST", "/v1/workstation/channels/google/login"), ("POST", "/v1/workstation/channels/slack/login"): return reply(loginJSON, status: 201)
        case ("POST", "/v1/workstation/channels/google/login/answer"), ("POST", "/v1/workstation/channels/slack/login/answer"): return reply(answerJSON)
        default: return reply(#"{"error":"route inconnue"}"#, status: 404)
        }
    }
}

@MainActor
private func connected(_ transport: ScriptedHarnessTransport) async -> HarnessModel {
    let model = HarnessModel(
        transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(),
        retryDelay: .seconds(3600), refreshDelay: .milliseconds(1)
    )
    _ = await model.configure(address: "vps.example", token: "t")
    return model
}

private func body(_ call: HarnessCall?) throws -> [String: Any] {
    let data = try #require(call?.body)
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

@Suite("Écran Canaux — client")
@MainActor
struct WorkstationChannelsTests {
    @Test("ecran-canaux/AC-1 : l'écran lit les trois canaux avec leur état, leur compte, leur dernière lecture, et la phrase du serveur pour un canal bloqué ; un événement workstation_channel fait relire")
    func readsTheThreeChannels() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(channelServer())
        let server = await connected(transport)
        let channels = server.channels
        #expect(channels.availability == .unknown)

        await channels.refresh()
        #expect(channels.availability == .available && channels.failure == nil)
        #expect(channels.channels.map(\.id) == ["gmail", "calendar", "slack"])
        let gmail = try #require(channels.channels.first)
        #expect(gmail.state == "blocked" && gmail.error == blockedPhrase)
        let calendar = channels.channels[1]
        #expect(calendar.state == "connected" && calendar.account == "moi@exemple.fr" && calendar.lastReadAt == 1_762_600_000_000)
        #expect(channels.connection("google")?.login?.state == "waiting")
        #expect(channels.connection("slack")?.clientConfigured == false)
        #expect(channels.attentionCount == 0)

        // Le vocabulaire : chaque état a son mot, l'inconnu se rend tel quel.
        #expect(ChannelText.state("blocked") == "Bloqué par l’administrateur")
        #expect(ChannelText.state("reconnect") == "À reconnecter" && ChannelText.state("disconnected") == "Non connecté")
        #expect(ChannelText.state("connected") == "Connecté" && ChannelText.state("error") == "En erreur")
        #expect(ChannelText.state("nouveau") == "nouveau" && ChannelText.channel("teams") == "teams")
        #expect(ChannelText.channel("calendar") == "Agenda" && ChannelText.status("blocked").tone == .paused)

        // `workstation_channel` fait relire ; un autre événement non.
        let reads = { transport.calls.filter { $0.path == "/v1/workstation/channels" }.count }
        let before = reads()
        channels.receive(["run"])
        channels.receive(["workstation_channel"])
        try await Task.sleep(for: .milliseconds(100))
        #expect(reads() == before + 1)
    }

    @Test("ecran-canaux/AC-1 : un événement arrivé pendant une relecture n'est pas perdu, la relecture est replanifiée")
    func replansAReloadDuringAReload() async throws {
        let transport = ScriptedHarnessTransport()
        let gate = Gate()
        transport.respond(channelServer())
        let server = await connected(transport)
        let channels = server.channels
        await channels.refresh()
        let reads = { transport.calls.filter { $0.path == "/v1/workstation/channels" }.count }
        let before = reads()
        // La relecture suivante est retenue : l'événement arrive pendant qu'elle tourne.
        transport.respond { call in
            if call.path == "/v1/workstation/channels" { gate.wait() }
            return channelServer()(call)
        }
        channels.receive(["workstation_channel"])
        try await Task.sleep(for: .milliseconds(50))
        channels.receive(["workstation_channel"])
        gate.open()
        try await Task.sleep(for: .milliseconds(200))
        #expect(reads() == before + 2)
    }

    @Test("ecran-canaux/AC-2 : les gestes appellent les routes attendues avec les corps attendus ; un jeton ordinaire n'a pas les gestes et le refus du serveur revient au geste, sans bandeau")
    func gesturesSendTheExpectedBodies() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(channelServer())
        let server = await connected(transport)
        let channels = server.channels
        await channels.refresh()
        #expect(channels.isApprover)
        let last = { (method: String, path: String) in transport.calls.last { $0.method == method && $0.path == path } }

        try await channels.setGoogleClient(.credentials(clientId: " 1234-abcdef.apps.googleusercontent.com ", clientSecret: "secret-invente"))
        let credentials = try body(last("PUT", "/v1/workstation/channels/google/client"))
        #expect(credentials["clientId"] as? String == "1234-abcdef.apps.googleusercontent.com")
        #expect(credentials["clientSecret"] as? String == "secret-invente" && credentials["json"] == nil)

        let pasted = #"{"installed":{"client_id":"1234-abcdef.apps.googleusercontent.com","client_secret":"secret-invente"}}"#
        try await channels.setGoogleClient(.json(pasted))
        let json = try body(last("PUT", "/v1/workstation/channels/google/client"))
        #expect(json["json"] as? String == pasted && json.count == 1)

        try await channels.setSlackClient(clientId: "111.222")
        #expect(try body(last("PUT", "/v1/workstation/channels/slack/client")) as NSDictionary == ["clientId": "111.222"])

        // Connexion complète (corps vide), puis d'un seul canal Google.
        let login = try await channels.startLogin("google")
        #expect(login.url?.contains("state=s2") == true)
        #expect(try body(last("POST", "/v1/workstation/channels/google/login")).isEmpty)
        _ = try await channels.startLogin("google", channels: ["calendar"])
        #expect(try body(last("POST", "/v1/workstation/channels/google/login"))["channels"] as? [String] == ["calendar"])

        // Recoller l'URL de retour, nettoyée.
        _ = try await channels.answer("google", value: "  http://127.0.0.1/omp-canaux?code=c&state=s2 \n")
        #expect(try body(last("POST", "/v1/workstation/channels/google/login/answer")) as NSDictionary == ["value": "http://127.0.0.1/omp-canaux?code=c&state=s2"])

        // Déclarer le blocage : toute la connexion, puis Gmail seul.
        _ = try await channels.declareBlocked("slack")
        #expect(try body(last("POST", "/v1/workstation/channels/slack/login/answer")) as NSDictionary == ["blocked": true])
        _ = try await channels.declareBlocked("google", channels: ["gmail"])
        #expect(try body(last("POST", "/v1/workstation/channels/google/login/answer")) as NSDictionary == ["blocked": true, "channels": ["gmail"]])
        #expect(channels.busy.isEmpty)

        // Un jeton ordinaire : pas de gestes, et le refus du serveur revient au geste.
        let plain = ScriptedHarnessTransport()
        plain.respond(channelServer(approver: false, ["POST /v1/workstation/channels/google/login": approverOnly]))
        let other = await connected(plain)
        await other.channels.refresh()
        #expect(!other.channels.isApprover)
        await #expect(throws: HarnessFailure.approverOnly) {
            _ = try await other.channels.startLogin("google")
        }
        #expect(other.channels.failure == nil && other.failure == nil, "aucun bandeau global")
        #expect(!ChannelText.approverOnly.isEmpty)
    }

    @Test("ecran-canaux/AC-3 : le secret saisi part dans le seul corps du geste, sans copie gardée par le modèle")
    func neverKeepsTheSecret() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(channelServer())
        let server = await connected(transport)
        let channels = server.channels
        try await channels.setGoogleClient(.credentials(clientId: "1234-abcdef.apps.googleusercontent.com", clientSecret: "secret-invente-42"))
        // Ce que le modèle publie ne porte pas le secret.
        let published = String(describing: (channels.channels, channels.connections, channels.failure, channels.busy))
        #expect(!published.contains("secret-invente-42"))
        let mirror = Mirror(reflecting: channels).children.map { String(describing: $0.value) }.joined()
        #expect(!mirror.contains("secret-invente-42"))
        // Il n'est parti qu'une fois, dans le corps du PUT.
        let carriers = transport.calls.filter { String(data: $0.body ?? Data(), encoding: .utf8)?.contains("secret-invente-42") == true }
        #expect(carriers.map(\.path) == ["/v1/workstation/channels/google/client"])
    }

    @Test("ecran-canaux/AC-4 : un serveur sans la route (404) ou un jeton restreint (403) n'a pas d'écran, sans échec")
    func absentWithoutTheRoute() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(channelServer(["GET /v1/workstation/channels": reply(#"{"error":"route inconnue"}"#, status: 404)]))
        let server = await connected(transport)
        let channels = server.channels
        await channels.refresh()
        #expect(channels.availability == .absent && channels.channels.isEmpty && channels.failure == nil && server.failure == nil)
        // Absent : les événements ne font plus rien relire.
        let reads = transport.calls.filter { $0.path == "/v1/workstation/channels" }.count
        channels.receive(["workstation_channel"])
        try await Task.sleep(for: .milliseconds(50))
        #expect(transport.calls.filter { $0.path == "/v1/workstation/channels" }.count == reads)

        transport.respond(channelServer(["GET /v1/workstation/channels": ownerOnly]))
        await channels.refresh()
        #expect(channels.availability == .reserved && channels.connections.isEmpty && channels.failure == nil && server.failure == nil)
    }
}

/// Une barrière que la doublure de transport attend (thread du transport), ouverte par le test.
private final class Gate: @unchecked Sendable {
    private let semaphore = DispatchSemaphore(value: 0)
    private var opened = false
    private let lock = NSLock()

    func wait() {
        lock.lock()
        let isOpen = opened
        lock.unlock()
        if !isOpen { semaphore.wait() }
    }

    func open() {
        lock.lock()
        opened = true
        lock.unlock()
        semaphore.signal()
    }
}
