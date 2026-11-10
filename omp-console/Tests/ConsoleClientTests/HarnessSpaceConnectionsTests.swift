// Ce qui se branche PAR ESPACE côté client : la connexion Atlassian d'un espace (chaque
// lecture et chaque geste de connexion avec `?space=`, la connexion par défaut intacte) et
// le poste d'un espace (le navigateur rattaché, la demande posée dans un espace, son
// profil) — et le serveur antérieur, qui n'en reçoit rien.

@testable import ConsoleClient
import Foundation
import Testing

private func health(_ features: [String]) -> HarnessReply {
    let list = features.map { "\"\($0)\"" }.joined(separator: ",")
    return osJSON(#"{"ok":true,"version":"1.38.0","features":["# + list + #"],"checks":{"db":{"ok":true},"scheduler":{"ok":true},"disk":{"ok":true}}}"#)
}

private func atlassianStatus(space: String?, connected: Bool = true) -> String {
    let owner = space.map { "\"\($0)\"" } ?? "null"
    let scope = space.map { "corpo:\($0)" } ?? "corpo"
    return #"{"atlassian":{"enabled":true,"connected":\#(connected),"site":{"cloudId":"c1","url":"https://"# + (space ?? "defaut") + #".atlassian.net"},"#
        + #""redirectUri":"https://vps.example/v1/atlassian/callback","pasteBack":false,"pending":null,"plan":{"hour":8,"weekdaysOnly":true,"lastAt":null},"#
        + #""knowledge":{"everyHours":null,"lastAt":null,"lastSummary":null},"proposed":1,"space":"# + owner + #","scope":""# + scope + #""}}"#
}

private func writes(space: String?) -> String {
    let owner = space.map { "\"\($0)\"" } ?? "null"
    let id = space ?? "defaut"
    return #"{"writes":[{"id":"w-"# + id + #"","space":"# + owner + #","kind":"comment","issueKey":"ACME-1","body":"Fait.","why":"suivi","state":"proposed","by":"agent","createdAt":1,"updatedAt":1}]}"#
}

private let acme = HarnessSpace(id: "e-acme", name: "Client Acme", repos: ["acme-web"])

/// Un serveur dont chaque connexion Atlassian (par défaut, ou d'un espace) a son état et ses écritures.
private func atlassianServer(features: [String], spaces: String? = nil) -> ScriptedHarnessTransport {
    osTransport { call in
        let space = call.path.contains("space=e-acme") ? "e-acme" : nil
        let route = call.path.split(separator: "?").first.map(String.init) ?? call.path
        switch (call.method, route) {
        case ("GET", "/v1/health"): return health(features)
        case ("GET", "/v1/spaces"): return spaces.map { osJSON($0) }
        case ("GET", "/v1/atlassian"): return osJSON(atlassianStatus(space: space))
        case ("GET", "/v1/atlassian/writes"): return osJSON(writes(space: space))
        case ("GET", "/v1/atlassian/plan"): return osJSON(#"{"plan":{"id":"p1","space":"# + (space.map { "\"\($0)\"" } ?? "null") + #","createdAt":1,"trigger":"auto","by":"agent","summary":"s","items":[]}}"#)
        case ("POST", "/v1/atlassian/connect"): return osJSON(#"{"authorizeUrl":"https://auth.atlassian.com/authorize?state=x","pasteBack":false}"#)
        case ("POST", "/v1/atlassian/callback"), ("DELETE", "/v1/atlassian"): return osJSON(atlassianStatus(space: space, connected: false))
        case ("POST", "/v1/atlassian/plan"), ("POST", "/v1/atlassian/knowledge"): return osJSON(#"{"queued":true}"#, status: 202)
        case ("POST", "/v1/atlassian/writes/w-e-acme/approve"), ("POST", "/v1/atlassian/writes/w-e-acme/dismiss"):
            return osJSON(#"{"write":{"id":"w-e-acme","space":"e-acme","kind":"comment","issueKey":"ACME-1","body":"Fait.","why":"suivi","state":"sent","by":"agent","createdAt":1,"updatedAt":2}}"#)
        default: return nil
        }
    }
}

private let workstationStatus = #"""
{"online":true,"lastSeenAt":10,"extensionVersion":"0.9.0","observedSeconds":0,"thresholdHours":8,"autonomy":{"setting":"auto","effective":"observe"},
 "paused":false,"selfIdentities":[],"pending":0,"profileUpdatedAt":null,"lastShift":null,"nextShiftAt":null,"stopped":null,
 "browsers":[{"id":"b-perso","label":"Perso","online":true,"lastSeenAt":10,"firstSeenAt":1,"extensionVersion":"0.9.0","isDefault":true,"space":null},
             {"id":"b-acme","label":"Acme","online":false,"lastSeenAt":5,"firstSeenAt":2,"extensionVersion":"0.9.0","isDefault":false,"space":"e-acme"}],
 "defaultBrowser":"b-perso","mirrorBrowser":null,"allowedHosts":[],"exfiltrationGuard":true,"navigationSource":{"allowedHosts":"config","exfiltrationGuard":"config"}}
"""#

private func workstationServer(features: [String]) -> ScriptedHarnessTransport {
    osTransport { call in
        switch (call.method, call.path) {
        case ("GET", "/v1/health"): health(features)
        case ("GET", "/v1/workstation"), ("GET", "/v1/workstation?space=e-acme"): osJSON(workstationStatus)
        case ("GET", "/v1/workstation/actions?state=awaiting_approval&limit=200"): osJSON(#"{"actions":[]}"#)
        case ("PUT", "/v1/workstation/browsers/b-perso"), ("PUT", "/v1/workstation/browsers/b-acme"):
            osJSON(#"{"browser":{"id":"b-perso","label":"Perso","online":true,"lastSeenAt":10,"firstSeenAt":1,"extensionVersion":"0.9.0","isDefault":true,"space":"e-acme"}}"#)
        case ("POST", "/v1/workstation/requests"):
            osJSON(#"{"request":{"id":"q1","createdAt":1,"updatedAt":1,"by":"mac","instruction":"Relancer","automationId":null,"browserId":"b-acme","space":"e-acme","state":"queued","reason":null,"report":null,"startedAt":null,"endedAt":null}}"#, status: 201)
        case ("GET", "/v1/workstation/profile?space=e-acme"):
            osJSON(#"{"profile":null,"stats":{"observations":0,"visits":0,"focusSeconds":0,"topSites":[],"activeHours":[]},"browsers":[]}"#)
        case ("POST", "/v1/workstation/profile/rebuild?space=e-acme"): osJSON(#"{"queued":true}"#, status: 202)
        case ("GET", "/v1/spaces"): osJSON(#"{"spaces":[]}"#)
        default: nil
        }
    }
}

@Suite("Multi-client — Atlassian et poste par espace")
@MainActor
struct HarnessSpaceConnectionsTests {
    @Test("la connexion Atlassian d'un espace lit son état, ses écritures et son plan avec `?space=` ; la connexion par défaut se lit comme avant")
    func spaceConnectionReads() async throws {
        let transport = atlassianServer(features: ["atlassian", "space-knowledge"])
        let model = await osConnected(transport)
        let connection = model.atlassianConnection(for: acme)
        #expect(connection === model.atlassianConnection(for: acme), "le même modèle à chaque appel")
        #expect(connection !== model.atlassian && connection.space == "e-acme" && model.atlassian.space == nil)

        await connection.refresh()
        #expect(connection.availability == .available)
        #expect(transport.last("GET", "/v1/atlassian?space=e-acme") != nil)
        #expect(transport.last("GET", "/v1/atlassian/writes?state=proposed&limit=200&space=e-acme") != nil)
        #expect(transport.last("GET", "/v1/atlassian/plan?space=e-acme") != nil)
        #expect(connection.status?.space == "e-acme" && connection.status?.scope == "corpo:e-acme")
        #expect(connection.status?.site?.url == "https://e-acme.atlassian.net")
        #expect(connection.proposals.map(\.id) == ["w-e-acme"] && connection.proposals.first?.space == "e-acme")
        #expect(connection.plan?.space == "e-acme")

        await model.atlassian.refresh()
        #expect(transport.last("GET", "/v1/atlassian") != nil && transport.last("GET", "/v1/atlassian/plan") != nil)
        #expect(model.atlassian.status?.space == nil && model.atlassian.status?.scope == "corpo")
        #expect(model.atlassian.proposals.map(\.id) == ["w-defaut"] && model.atlassian.proposals.first?.space == nil)
        #expect(connection.proposals.map(\.id) == ["w-e-acme"], "rien ne passe d'une connexion à l'autre")
    }

    @Test("relire les connexions lit celle par défaut et celle de chaque espace branché ; ce qui attend l'humain se lit par espace, ou toutes connexions confondues")
    func connectionsInScope() async throws {
        let space: (String, String, Bool) -> String = { id, name, connected in
            #"{"id":""# + id + #"","name":""# + name + #"","repos":[],"poste":false,"jiraProjects":[],"dailyBudgetUsd":null,"autonomy":null,"by":null,"createdAt":1,"updatedAt":1,"rev":1,"atlassian":{"connected":\#(connected),"site":null}}"#
        }
        let transport = atlassianServer(
            features: ["atlassian", "spaces", "space-knowledge"],
            spaces: #"{"spaces":["# + space("e-acme", "Client Acme", true) + "," + space("e-perso", "Perso", false) + "]}"
        )
        let model = await osConnected(transport)
        await model.spaces.refresh()
        #expect(model.atlassianProposals(in: nil).isEmpty, "rien n'est lu encore")

        await model.refreshAtlassianConnections()
        #expect(transport.count("GET", "/v1/atlassian") == 1 && transport.count("GET", "/v1/atlassian?space=e-acme") == 1)
        #expect(transport.calls.filter { $0.path.contains("space=e-perso") }.isEmpty, "un espace sans connexion n'est pas lu")
        let acme = try #require(model.spaces.spaces.first { $0.id == "e-acme" })
        let perso = try #require(model.spaces.spaces.first { $0.id == "e-perso" })
        #expect(model.atlassianProposals(in: acme).map(\.id) == ["w-e-acme"])
        #expect(model.atlassianProposals(in: perso).isEmpty)
        #expect(model.atlassianProposals(in: nil).map(\.id) == ["w-defaut", "w-e-acme"])
        #expect(model.atlassianProposals(in: nil).map(\.space) == [nil, "e-acme"])
    }

    @Test("connecter, coller le retour, déconnecter, demander le plan ou le savoir d'un espace portent `?space=` ; trancher une écriture se fait par son identifiant, sans")
    func spaceConnectionGestures() async throws {
        let transport = atlassianServer(features: ["atlassian", "space-knowledge"])
        let model = await osConnected(transport)
        let connection = model.atlassianConnection(for: acme)
        await connection.refresh()

        #expect(await connection.connect()?.host == "auth.atlassian.com")
        #expect(transport.last("POST", "/v1/atlassian/connect?space=e-acme") != nil)
        #expect(await connection.submitCallback("https://vps.example/v1/atlassian/callback?code=c&state=s"))
        #expect(transport.last("POST", "/v1/atlassian/callback?space=e-acme") != nil)
        #expect(await connection.runPlan())
        #expect(await connection.runKnowledge())
        #expect(transport.last("POST", "/v1/atlassian/plan?space=e-acme") != nil && transport.last("POST", "/v1/atlassian/knowledge?space=e-acme") != nil)
        #expect(await connection.approve("w-e-acme", body: "Fait, merci."))
        #expect(transport.last("POST", "/v1/atlassian/writes/w-e-acme/approve") != nil)
        #expect(await connection.dismiss("w-e-acme"))
        #expect(transport.last("POST", "/v1/atlassian/writes/w-e-acme/dismiss") != nil)
        #expect(await connection.disconnect())
        #expect(transport.last("DELETE", "/v1/atlassian?space=e-acme") != nil)
        #expect(transport.calls.filter { $0.method != "GET" && !$0.path.contains("space=") }.map(\.path) == ["/v1/atlassian/writes/w-e-acme/approve", "/v1/atlassian/writes/w-e-acme/dismiss"])

        // La connexion par défaut garde ses routes d'avant.
        await model.atlassian.refresh()
        _ = await model.atlassian.connect()
        #expect(transport.last("POST", "/v1/atlassian/connect") != nil)
    }

    @Test("sur un serveur qui n'annonce pas `space-knowledge`, la connexion d'un espace est absente sans rien lire ni rien envoyer — jamais la connexion par défaut à sa place")
    func spaceConnectionOnOlderServer() async {
        let transport = atlassianServer(features: ["atlassian"])
        let model = await osConnected(transport)
        let connection = model.atlassianConnection(for: acme)
        await connection.refresh()
        #expect(connection.availability == .absent && connection.status == nil && connection.proposals.isEmpty && connection.failure == nil)
        #expect(await connection.connect() == nil)
        #expect(await connection.disconnect() == false)
        #expect(await connection.runPlan() == false)
        #expect(transport.calls.filter { $0.path.hasPrefix("/v1/atlassian") }.isEmpty)

        await model.atlassian.refresh()
        #expect(model.atlassian.availability == .available, "la connexion par défaut reste servie")
    }

    @Test("les événements Atlassian font relire la connexion d'un espace déjà lue ; changer de serveur l'oublie")
    func spaceConnectionLiveAndReset() async {
        let transport = atlassianServer(features: ["atlassian", "space-knowledge"])
        let model = await osConnected(transport)
        let connection = model.atlassianConnection(for: acme)
        await connection.refresh()
        let reads = transport.count("GET", "/v1/atlassian?space=e-acme")
        transport.push(events: ["atlassian_write"])
        model.startLive()
        #expect(await eventually { transport.count("GET", "/v1/atlassian?space=e-acme") > reads })
        model.stopLive()

        _ = await model.configure(address: "autre.example", token: "t")
        #expect(connection.availability == .unknown && connection.status == nil)
        #expect(model.atlassianConnection(for: acme) !== connection, "un autre serveur, une autre connexion")
    }

    @Test("un navigateur du poste dit son espace ; le rattacher envoie `{space}`, le détacher `null` ; une demande posée dans un espace porte `space` et le relit")
    func workstationSpace() async throws {
        let transport = workstationServer(features: ["workstation", "space-workstation"])
        let model = await osConnected(transport)
        await model.workstation.refresh()
        let browsers = try #require(model.workstation.status?.browsers)
        #expect(browsers.map(\.space) == [nil, "e-acme"])

        #expect(await model.workstation.setBrowserSpace(id: "b-perso", space: "e-acme"))
        #expect(transport.rawBody("PUT", "/v1/workstation/browsers/b-perso") == #"{"space":"e-acme"}"#)
        #expect(await model.workstation.setBrowserSpace(id: "b-acme", space: nil))
        #expect(transport.rawBody("PUT", "/v1/workstation/browsers/b-acme") == #"{"space":null}"#)
        #expect(transport.count("GET", "/v1/workstation") == 3, "le poste est relu après chaque rattachement")

        let posed = try #require(await model.workstation.createRequest(" Relancer ", space: "e-acme"))
        #expect(posed.space == "e-acme" && posed.browserId == "b-acme")
        var body = try #require(transport.body("POST", "/v1/workstation/requests"))
        #expect(body.keys.sorted() == ["instruction", "space"] && body["space"] as? String == "e-acme" && body["instruction"] as? String == "Relancer")
        _ = await model.workstation.createRequest("Relancer", browserId: "b-perso")
        body = try #require(transport.body("POST", "/v1/workstation/requests"))
        #expect(body.keys.sorted() == ["browserId", "instruction"], "sans espace : le corps d'avant")

        #expect(await model.workstation.spaceStatus("e-acme")?.browsers.count == 2)
        #expect(transport.last("GET", "/v1/workstation?space=e-acme") != nil)
        #expect(await model.workstation.spaceProfile("e-acme") != nil)
        #expect(await model.workstation.rebuildProfile(space: "e-acme"))
        #expect(transport.last("POST", "/v1/workstation/profile/rebuild?space=e-acme") != nil)

        let old = #"{"id":"q0","createdAt":1,"updatedAt":1,"by":"mac","instruction":"x","automationId":null,"browserId":null,"state":"done","reason":null,"report":null,"startedAt":null,"endedAt":null}"#
        #expect(try JSONDecoder().decode(WorkstationRequest.self, from: Data(old.utf8)).space == nil, "hors espace, la clé est absente")
        #expect(try JSONDecoder().decode(WorkstationBrowser.self, from: Data(#"{"id":"b1","online":true,"lastSeenAt":1}"#.utf8)).space == nil)
    }

    @Test("sur un serveur qui n'annonce pas `space-workstation`, rien du poste par espace ne part : ni rattachement, ni `space` d'une demande, ni profil d'espace")
    func workstationOnOlderServer() async throws {
        let transport = workstationServer(features: ["workstation"])
        let model = await osConnected(transport)
        await model.workstation.refresh()
        #expect(await model.workstation.setBrowserSpace(id: "b-perso", space: "e-acme") == false)
        #expect(await model.workstation.spaceProfile("e-acme") == nil)
        #expect(await model.workstation.spaceStatus("e-acme") == nil)
        #expect(await model.workstation.rebuildProfile(space: "e-acme") == false)
        _ = await model.workstation.createRequest("Relancer", space: "e-acme")
        #expect(try #require(transport.body("POST", "/v1/workstation/requests")).keys.sorted() == ["instruction"])
        #expect(transport.calls.filter { $0.path.contains("/browsers/") || $0.path.contains("space=") }.isEmpty)
        #expect(model.workstation.failure == nil)
    }
}
