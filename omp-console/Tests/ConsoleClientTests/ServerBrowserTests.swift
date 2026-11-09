// Le client du NAVIGATEUR DU SERVEUR (routes `/v1/workstation/vps/*` d'omp-harness) :
// l'état des comptes et la copie du profil Chrome lus dans le statut du poste, le choix de
// la source de la copie, le contrat JSON de la connexion interactive, les corps des gestes
// renvoyés à la page, le passage des clics de l'image aux 1280 × 720 de la fenêtre du
// serveur, et les gestes du modèle (méthode, chemin, corps, échecs) — sur la doublure de
// transport du serveur de pipelines, sans réseau.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private func reply(_ json: String, status: Int = 200) -> HarnessReply { HarnessReply(status: status, body: Data(json.utf8)) }

private let emptyInbox = #"{"batches":[],"awaiting":[],"decisions":[],"runs":[],"cursor":42}"#

/// Le statut du poste tel que le serveur l'écrit : le navigateur d'une extension (sans
/// `accounts`) puis celui du serveur, avec ses deux comptes.
private let statusJSON = #"""
{"online":true,"observedSeconds":0,"thresholdHours":8,"autonomy":{"setting":"auto","effective":"observe"},"paused":false,
 "selfIdentities":[],"pending":0,"stopped":null,
 "browsers":[
  {"id":"b1","label":"Perso","online":true,"lastSeenAt":5,"firstSeenAt":1,"extensionVersion":"0.4.0","isDefault":true},
  {"id":"vps","label":"VPS","online":true,"lastSeenAt":9,"firstSeenAt":2,"extensionVersion":null,"isDefault":false,"mirroredAt":1761730060000,
   "accounts":[{"domain":"slack.com","state":"connected","changedAt":1761730000000},
               {"domain":"google.com","state":"disconnected","changedAt":null}]}],
 "defaultBrowser":"b1","mirrorBrowser":"b1","allowedHosts":[],"exfiltrationGuard":true,"navigationSource":{"allowedHosts":"config","exfiltrationGuard":"config"}}
"""#

/// Le statut d'un serveur qui n'a pas de navigateur du serveur.
private let plainStatusJSON = #"""
{"online":true,"observedSeconds":0,"thresholdHours":8,"autonomy":{"setting":"auto","effective":"observe"},"paused":false,
 "selfIdentities":[],"pending":0,"browsers":[{"id":"b1","label":"Perso","online":true,"lastSeenAt":5,"firstSeenAt":1,"isDefault":true}]}
"""#

private let loginPath = "/v1/workstation/vps/login"
private let framePath = "/v1/workstation/vps/login/frame"
private let inputPath = "/v1/workstation/vps/login/input"

private let loginJSON = #"{"login":{"id":"lg_1","domain":"slack.com","host":"slack.com","startedAt":1,"error":null}}"#
private let frameJSON = #"{"seq":1,"mime":"image/png","width":1280,"height":720,"host":"slack.com","image":"iVBORw0KGgo="}"#
private let approverRefusal = #"{"error":"seul l'appareil approbateur peut le faire"}"#

/// Un serveur qui sert la boîte et le statut du poste ; `overrides` remplace une réponse
/// par « MÉTHODE chemin ».
private func vpsServer(_ overrides: [String: HarnessReply] = [:]) -> @Sendable (HarnessCall) -> HarnessReply {
    { call in
        if let forced = overrides["\(call.method) \(call.path)"] { return forced }
        switch (call.method, call.path) {
        case ("GET", "/v1/inbox"): return reply(emptyInbox)
        case ("GET", "/v1/workstation"): return reply(statusJSON)
        default: return reply(#"{"error":"route inconnue"}"#, status: 404)
        }
    }
}

@MainActor
private func connectedServer(_ transport: ScriptedHarnessTransport) async -> HarnessModel {
    let model = HarnessModel(
        transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(),
        retryDelay: .seconds(3600), refreshDelay: .milliseconds(1), reporter: .off
    )
    _ = await model.configure(address: "vps.example", token: "t")
    return model
}

/// Les appels faits au navigateur du serveur, dans l'ordre : « MÉTHODE chemin ».
private func vpsCalls(_ transport: ScriptedHarnessTransport) -> [String] {
    transport.calls.filter { $0.path.hasPrefix("/v1/workstation/vps") }.map { "\($0.method) \($0.path)" }
}

private func jsonBody(_ call: HarnessCall?) throws -> [String: Any] {
    let data = try #require(call?.body)
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

@Suite("Navigateur du serveur — client")
@MainActor
struct ServerBrowserTests {
    @Test("les comptes du navigateur du serveur se lisent dans le statut ; champ absent : aucun compte, état inconnu : lu sans échec")
    func decodesAccounts() throws {
        let decoder = JSONDecoder()
        let status = try decoder.decode(WorkstationStatus.self, from: Data(statusJSON.utf8))
        let server = try #require(status.serverBrowser)
        #expect(server.id == WorkstationBrowser.serverID && server.online)
        #expect(server.accounts.map(\.domain) == ["slack.com", "google.com"])
        #expect(server.accounts.map(\.state) == ["connected", "disconnected"])
        #expect(server.accounts[0].phase == .connected && server.accounts[1].phase == .disconnected)
        #expect(server.accounts[0].changedAt == 1_761_730_000_000 && server.accounts[1].changedAt == nil)
        let personal = try #require(status.browsers.first { $0.id == "b1" })
        #expect(personal.accounts.isEmpty, "un navigateur sans `accounts` n'a aucun compte")

        let plain = try decoder.decode(WorkstationStatus.self, from: Data(plainStatusJSON.utf8))
        #expect(plain.serverBrowser == nil, "un serveur sans navigateur du serveur n'en montre pas")

        let odd = try decoder.decode(ServerBrowserAccount.self, from: Data(#"{"domain":"slack.com","state":"suspendu"}"#.utf8))
        #expect(odd.phase == nil && odd.state == "suspendu" && odd.changedAt == nil)
        let bare = try decoder.decode(ServerBrowserAccount.self, from: Data(#"{"domain":"google.com"}"#.utf8))
        #expect(bare.phase == .disconnected && bare.id == "google.com")
        #expect(bare.loginURL == "https://accounts.google.com/")
        #expect(ServerBrowserAccount(domain: "slack.com").loginURL == "https://slack.com/signin")
    }

    @Test("la source de la copie du profil Chrome et la dernière copie reçue se lisent dans le statut ; absentes : aucune copie")
    func decodesMirror() throws {
        let decoder = JSONDecoder()
        let status = try decoder.decode(WorkstationStatus.self, from: Data(statusJSON.utf8))
        #expect(status.mirrorBrowser == "b1")
        #expect(status.serverBrowser?.mirroredAt == 1_761_730_060_000)
        #expect(status.browsers.first { $0.id == "b1" }?.mirroredAt == nil, "une extension ne reçoit pas de copie")
        #expect(status.mirrorSources.map(\.id) == ["b1"], "le navigateur du serveur n'est jamais la source de sa propre copie")

        let plain = try decoder.decode(WorkstationStatus.self, from: Data(plainStatusJSON.utf8))
        #expect(plain.mirrorBrowser == nil, "un serveur antérieur à la copie n'en dit rien")
        let off = try decoder.decode(WorkstationStatus.self, from: Data(statusJSON.replacingOccurrences(of: #""mirrorBrowser":"b1""#, with: #""mirrorBrowser":null"#).utf8))
        #expect(off.mirrorBrowser == nil)
    }

    @Test("la connexion, l'image et l'accusé se décodent tels que le serveur les écrit")
    func decodesWire() throws {
        let decoder = JSONDecoder()
        let started = try decoder.decode(ServerBrowserLoginReply.self, from: Data(#"{"login":{"id":"lg_1","domain":"slack.com","host":"slack.com","startedAt":7,"error":null,"champInconnu":1}}"#.utf8))
        #expect(started.login == ServerBrowserLogin(id: "lg_1", domain: "slack.com", host: "slack.com", startedAt: 7))
        let refused = try decoder.decode(ServerBrowserLoginReply.self, from: Data(#"{"login":{"id":"lg_2","domain":"google.com","host":"exemple.fr","startedAt":8,"error":"navigation refusée"}}"#.utf8))
        #expect(refused.login?.error == "navigation refusée")
        let none = try decoder.decode(ServerBrowserLoginReply.self, from: Data(#"{"login":null}"#.utf8))
        #expect(none.login == nil)

        let frame = try decoder.decode(ServerBrowserFrame.self, from: Data(frameJSON.utf8))
        #expect(frame.seq == 1 && frame.mime == "image/png" && frame.width == 1280 && frame.height == 720 && frame.host == "slack.com")
        #expect(frame.data?.isEmpty == false)
        let bare = try decoder.decode(ServerBrowserFrame.self, from: Data(#"{"seq":2,"image":"%%%"}"#.utf8))
        #expect(bare.width == 1280 && bare.height == 720 && bare.host.isEmpty, "une taille absente vaut la fenêtre du serveur")
        #expect(bare.data == nil || bare.data?.isEmpty == true, "un base64 illisible ne donne aucune image")

        #expect(try decoder.decode(ServerBrowserClosed.self, from: Data(#"{"closed":"slack.com"}"#.utf8)).closed == "slack.com")
        #expect(try decoder.decode(ServerBrowserClosed.self, from: Data(#"{"closed":null}"#.utf8)).closed == nil)
        _ = try decoder.decode(ServerBrowserSent.self, from: Data(#"{"sent":true}"#.utf8))
    }

    @Test("chaque geste s'écrit comme le serveur le valide : son type, puis ses champs, rien d'autre")
    func encodesInputs() throws {
        func fields(_ input: ServerBrowserInput) throws -> [String: Any] {
            let data = try JSONEncoder().encode(input)
            return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        let click = try fields(.click(x: 640.5, y: 360))
        #expect(click["type"] as? String == "click" && click["x"] as? Double == 640.5 && click["y"] as? Double == 360 && click.count == 3)
        let text = try fields(.text("bonjour"))
        #expect(text["type"] as? String == "text" && text["text"] as? String == "bonjour" && text.count == 2)
        let key = try fields(.key(.enter))
        #expect(key["type"] as? String == "key" && key["key"] as? String == "Enter" && key.count == 2)
        let scroll = try fields(.scroll(dy: -ServerBrowserInput.scrollStep))
        #expect(scroll["type"] as? String == "scroll" && scroll["dy"] as? Double == -400 && scroll.count == 2)
        #expect(ServerBrowserKey.allCases.map(\.rawValue) == ["Enter", "Tab", "Backspace"])
    }

    @Test("un clic sur l'image est ramené aux 1280 × 720 de la page ; hors de l'image, rien ne part")
    func mapsClicks() {
        let frame = ServerBrowserFrame(seq: 1, image: "")
        #expect(frame.click(atX: 320, y: 180, displayedWidth: 640, displayedHeight: 360) == ServerBrowserInput.click(x: 640, y: 360))
        #expect(frame.click(atX: 0, y: 0, displayedWidth: 640, displayedHeight: 360) == ServerBrowserInput.click(x: 0, y: 0))
        #expect(frame.click(atX: 640, y: 360, displayedWidth: 640, displayedHeight: 360) == ServerBrowserInput.click(x: 1280, y: 720))
        #expect(frame.click(atX: 641, y: 10, displayedWidth: 640, displayedHeight: 360) == nil)
        #expect(frame.click(atX: 10, y: -1, displayedWidth: 640, displayedHeight: 360) == nil)
        #expect(frame.click(atX: 10, y: 10, displayedWidth: 0, displayedHeight: 360) == nil, "une image sans surface ne reçoit aucun clic")

        let small = ServerBrowserFrame(seq: 1, width: 800, height: 600, image: "")
        #expect(small.click(atX: 100, y: 75, displayedWidth: 400, displayedHeight: 300) == ServerBrowserInput.click(x: 200, y: 150))
    }

    @Test("choisir la source de la copie part en PUT /v1/workstation/settings, `null` explicite pour aucune ; l'état rendu remplace l'ancien")
    func choosesMirrorSource() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(vpsServer(["PUT /v1/workstation/settings": reply(statusJSON)]))
        let server = await connectedServer(transport)
        let workstation = server.workstation

        #expect(await workstation.setMirrorBrowser("b1"))
        let chosen = try #require(transport.calls.last { $0.method == "PUT" })
        #expect(chosen.path == "/v1/workstation/settings")
        #expect(String(decoding: try #require(chosen.body), as: UTF8.self) == #"{"mirrorBrowser":"b1"}"#)
        #expect(workstation.status?.mirrorBrowser == "b1")

        #expect(await workstation.setMirrorBrowser(nil))
        let stopped = try #require(transport.calls.last { $0.method == "PUT" })
        #expect(String(decoding: try #require(stopped.body), as: UTF8.self) == #"{"mirrorBrowser":null}"#)

        transport.respond(vpsServer(["PUT /v1/workstation/settings": reply(approverRefusal, status: 403)]))
        #expect(await workstation.setMirrorBrowser("b1") == false)
        #expect(workstation.failure == .approverOnly)
    }

    @Test("un jeton qui n'est pas l'approbateur voit son refus ; la lecture d'une connexion ouverte se tait")
    func approverOnly() async throws {
        let refusal = reply(approverRefusal, status: 403)
        let transport = ScriptedHarnessTransport()
        transport.respond(vpsServer(["GET \(loginPath)": refusal]))
        let server = await connectedServer(transport)
        let browser = server.serverBrowser

        await browser.resumeLogin()
        #expect(browser.login == nil && browser.failure == nil, "un autre jeton n'a rien à reprendre : aucun échec")

        transport.respond(vpsServer(["POST \(loginPath)": refusal]))
        #expect(await browser.startLogin(url: "https://slack.com/signin") == false)
        #expect(browser.failure == .approverOnly && browser.login == nil)
    }

    @Test("la connexion démarre sur le domaine du compte, renvoie clics et frappes, relit l'image après chaque geste et se termine")
    func loginFlow() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(vpsServer([
            "POST \(loginPath)": reply(loginJSON, status: 201),
            "GET \(framePath)": reply(frameJSON),
            "POST \(inputPath)": reply(#"{"sent":true}"#),
            "DELETE \(loginPath)": reply(#"{"closed":"slack.com"}"#),
        ]))
        let server = await connectedServer(transport)
        let browser = server.serverBrowser

        #expect(await browser.send(.key(.enter)) == false, "aucun geste ne part sans connexion")
        #expect(await browser.startLogin(url: ServerBrowserAccount(domain: "slack.com").loginURL))
        #expect(browser.login?.id == "lg_1" && browser.frame == nil)
        let start = try #require(transport.calls.last { $0.method == "POST" && $0.path == loginPath })
        #expect(try jsonBody(start)["url"] as? String == "https://slack.com/signin")

        await browser.refreshFrame()
        #expect(browser.frame?.seq == 1 && browser.frame?.data?.isEmpty == false)

        let click = try #require(browser.frame?.click(atX: 320, y: 180, displayedWidth: 640, displayedHeight: 360))
        #expect(await browser.send(click))
        let clicked = try jsonBody(transport.calls.last { $0.path == inputPath })
        #expect(clicked["type"] as? String == "click" && clicked["x"] as? Double == 640 && clicked["y"] as? Double == 360)
        #expect(await browser.send(.text("moi@exemple.fr")))
        #expect(try jsonBody(transport.calls.last { $0.path == inputPath })["text"] as? String == "moi@exemple.fr")

        #expect(await browser.finishLogin())
        #expect(browser.login == nil && browser.frame == nil)
        #expect(vpsCalls(transport) == [
            "POST \(loginPath)",
            "GET \(framePath)",
            "POST \(inputPath)",
            "GET \(framePath)",
            "POST \(inputPath)",
            "GET \(framePath)",
            "DELETE \(loginPath)",
        ])
    }

    @Test("une connexion refusée par le serveur n'est plus rafraîchie ; une connexion fermée côté serveur se relit comme fermée")
    func refusedAndClosed() async throws {
        let refused = #"{"login":{"id":"lg_2","domain":"google.com","host":"exemple.fr","startedAt":8,"error":"navigation refusée"}}"#
        let transport = ScriptedHarnessTransport()
        transport.respond(vpsServer(["POST \(loginPath)": reply(refused, status: 201)]))
        let server = await connectedServer(transport)
        let browser = server.serverBrowser

        #expect(await browser.startLogin(url: "https://accounts.google.com/"))
        #expect(browser.login?.error == "navigation refusée")
        await browser.followLogin()
        #expect(vpsCalls(transport) == ["POST \(loginPath)"], "une connexion refusée ne relit plus d'image")

        transport.respond(vpsServer([
            "POST \(loginPath)": reply(loginJSON, status: 201),
            "GET \(framePath)": reply(#"{"error":"aucune connexion ouverte"}"#, status: 404),
            "GET \(loginPath)": reply(#"{"login":null}"#),
        ]))
        #expect(await browser.startLogin(url: "https://slack.com/signin"))
        await browser.refreshFrame()
        #expect(browser.login == nil && browser.frame == nil, "le serveur a fermé la connexion (inactivité)")
        #expect(browser.failure == .rejected("aucune connexion ouverte"))
    }

    @Test("une connexion déjà ouverte sur le serveur se reprend")
    func resumesOpenLogin() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(vpsServer(["GET \(loginPath)": reply(loginJSON)]))
        let server = await connectedServer(transport)
        let browser = server.serverBrowser

        await browser.resumeLogin()
        #expect(browser.login?.domain == "slack.com" && browser.failure == nil)

        transport.respond(vpsServer(["GET \(loginPath)": reply(#"{"login":null}"#)]))
        await browser.resumeLogin()
        #expect(browser.login == nil, "plus de connexion ouverte : rien à reprendre")
    }
}
