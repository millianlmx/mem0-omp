// MULTI-CLIENT côté client : la portée d'espace (gardée et restaurée par serveur, `?space=`
// sur ce que le serveur compose, relecture au changement), les capacités (`space-scope`,
// `space-knowledge`, `space-workstation`, `space-policy`), chaque forme JSON ajoutée — et
// le serveur antérieur, qui ne reçoit ni paramètre ni route qu'il ne connaît pas.

@testable import ConsoleClient
import Foundation
import Testing

private let allCapabilities = ["spaces", "space-scope", "space-knowledge", "space-policy", "space-workstation"]

private func healthJSON(_ features: [String]) -> String {
    let list = features.map { "\"\($0)\"" }.joined(separator: ",")
    return #"{"ok":true,"version":"1.38.0","features":["# + list
        + #"],"checks":{"db":{"ok":true},"scheduler":{"ok":true,"ageSec":1},"disk":{"ok":true,"freeMiB":1000}}}"#
}

/// Un espace tel que le serveur multi-client l'écrit dans la liste.
private func fullSpaceJSON(_ id: String, name: String, repos: [String], rev: Int = 1, poste: Bool = false) -> String {
    let list = repos.map { "\"\($0)\"" }.joined(separator: ",")
    return #"{"id":""# + id + #"","name":""# + name + #"","repos":["# + list + #"],"poste":\#(poste),"identities":["moi@acme.example"],"#
        + #""jiraProjects":["ACME"],"dailyBudgetUsd":50,"autonomy":null,"policy":{"privacy":"local-only","providers":["omlx"],"models":{"heavy":["omlx/qwen3-coder"]}},"#
        + #""by":"mac","createdAt":1,"updatedAt":2,"rev":\#(rev),"memoryScopes":["acme"],"#
        + #""stats":{"working":1,"yours":2,"queued":0,"mergedWeek":3,"failedWeek":0,"cancelledWeek":1,"costToday":0.99,"costWeek":4.5,"costMonth":12.25,"budgetLeftToday":49.01},"#
        + #""isolation":{"sealed":false,"gaps":[{"code":"global_memory_token","repo":"acme-web","text":"Le dépôt acme-web n'a pas de jeton mémoire."},{"code":"no_browser","repo":null,"text":"Cet espace n'a aucun navigateur."},{"code":"futur","repo":null,"text":"?"}]},"#
        + #""atlassian":{"connected":true,"site":"https://acme.atlassian.net"}}"#
}

private let acmeJSON = fullSpaceJSON("e-acme", name: "Client Acme", repos: ["acme-web", "acme-api"], rev: 3)
private let persoJSON = fullSpaceJSON("e-perso", name: "Perso", repos: ["demo"])
private let twoSpacesJSON = #"{"spaces":["# + persoJSON + "," + acmeJSON + "]}"

private func briefJSON(headline: String = "du serveur") -> String {
    #"{"brief":{"since":1000,"until":2000,"seenAt":null,"headline":""# + headline + #"","#
        + #""delivered":[{"runId":"r1","repo":"acme-web","title":"Export","prUrl":null,"at":1500,"cost":1.5,"alone":true},{"runId":"r2","repo":"demo","title":"Thème","prUrl":null,"at":1600,"cost":4,"alone":false}],"#
        + #""waiting":[{"runId":"r3","repo":"demo","title":"Panier","wait":"specs","since":1600}],"#
        + #""failed":[{"runId":"r4","repo":"acme-api","title":"Cache","reason":"x","at":1700}],"stopped":[],"decided":[],"blocked":[],"proposals":3,"cost":5.5}}"#
}

private let proposalsJSON = #"""
{"proposals":[{"id":"retry.1","source":"retry","repo":"acme-web","title":"Relancer","detail":"","url":null,"createdAt":2,"action":"retry"},
 {"id":"issue.2","source":"issue","repo":"demo","title":"Issue","detail":"","url":null,"createdAt":1,"action":"launch"},
 {"id":"signal.3","source":"signal","repo":null,"title":"Signalement","detail":"","url":null,"createdAt":0,"action":"confirm"}]}
"""#

private let scoreboardJSON = #"""
{"scoreboard":{"since":1000,"until":2000,"merged":10,"mergedAlone":4,"aloneRate":0.4,"decisions":6,"medianDecisionMs":540000,
 "started":20,"startedAlone":5,"startedAloneRate":0.25,"cancelled":7,"cancelCauses":{"none":7},
 "repos":[{"repo":"demo","merged":8,"mergedAlone":4,"cancelled":5,"failed":1,"successRate":0.57,"suggestion":null},
          {"repo":"acme-web","merged":2,"mergedAlone":1,"cancelled":2,"failed":0,"successRate":null,"suggestion":null}]}}
"""#

/// Un modèle relié au faux serveur, avec les préférences données (la portée s'y garde).
@MainActor
private func connected(_ transport: ScriptedHarnessTransport, preferences: InMemoryClientPreferences = InMemoryClientPreferences(), address: String = "vps.example") async -> HarnessModel {
    let model = HarnessModel(
        transport: transport, preferences: preferences, tokens: InMemoryTokenStore(),
        retryDelay: .seconds(3600), refreshDelay: .milliseconds(1), reporter: .off
    )
    _ = await model.configure(address: address, token: "t")
    return model
}

/// Les routes d'un serveur multi-client : santé, espaces, brief, chiffres, propositions — avec ou sans `?space=`.
private func multiClientRoutes(features: [String] = allCapabilities, spaces: String = twoSpacesJSON) -> @Sendable (HarnessCall) -> HarnessReply? {
    { call in
        guard call.method == "GET" else { return nil }
        let route = call.path.split(separator: "?").first.map(String.init) ?? call.path
        switch route {
        case "/v1/health": return osJSON(healthJSON(features))
        case "/v1/spaces": return osJSON(spaces)
        case "/v1/brief": return osJSON(briefJSON(headline: call.path.contains("space=") ? "de l'espace" : "du serveur"))
        case "/v1/scoreboard": return osJSON(scoreboardJSON)
        case "/v1/proposals": return osJSON(proposalsJSON)
        case "/v1/rules": return osJSON(#"{"rules":[]}"#)
        default: return nil
        }
    }
}

@Suite("Multi-client — portée d'espace et capacités")
@MainActor
struct HarnessMultiClientTests {
    // MARK: Formes

    @Test("un espace du serveur multi-client porte sa politique, ses identités, son étanchéité, sa connexion Atlassian et le coût du mois")
    func spaceShape() throws {
        let space = try JSONDecoder().decode(HarnessSpace.self, from: Data(acmeJSON.utf8))
        #expect(space.policy == HarnessSpacePolicy(privacy: "local-only", providers: ["omlx"], models: ["heavy": ["omlx/qwen3-coder"]]))
        #expect(space.policy?.isLocalOnly == true && space.policy?.isEmpty == false)
        #expect(space.identities == ["moi@acme.example"])
        #expect(space.stats.costMonth == 12.25 && space.stats.budgetLeftToday == 49.01)
        #expect(space.atlassian == HarnessSpaceAtlassian(connected: true, site: "https://acme.atlassian.net"))
        let isolation = try #require(space.isolation)
        #expect(!isolation.sealed && space.isSealed == false)
        #expect(isolation.gaps.map(\.kind) == [.globalMemoryToken, .noBrowser, nil], "un code inconnu reste lisible")
        #expect(isolation.gaps.map(\.repo) == ["acme-web", nil, nil])
        #expect(Set(isolation.gaps.map(\.id)).count == 3)
    }

    @Test("un espace d'un serveur antérieur n'a ni politique, ni identités, ni étanchéité, ni connexion, ni coût du mois")
    func olderSpaceShape() throws {
        let old = #"{"id":"s1","name":"Perso","repos":["demo"],"poste":true,"jiraProjects":[],"dailyBudgetUsd":null,"autonomy":null,"by":null,"createdAt":1,"updatedAt":1,"rev":1,"memoryScopes":[],"stats":{"working":0,"yours":0,"queued":0,"mergedWeek":0,"failedWeek":0,"cancelledWeek":0,"costToday":0,"costWeek":0,"budgetLeftToday":null}}"#
        let space = try JSONDecoder().decode(HarnessSpace.self, from: Data(old.utf8))
        #expect(space.policy == nil && space.identities.isEmpty && space.isolation == nil && space.isSealed == nil)
        #expect(space.atlassian == nil && space.stats.costMonth == nil && space.poste)
        let nulls = #"{"id":"s2","name":"B","repos":[],"poste":false,"identities":[],"jiraProjects":[],"dailyBudgetUsd":null,"autonomy":null,"policy":null,"by":null,"createdAt":1,"updatedAt":1,"rev":1,"atlassian":null}"#
        let bounded = try JSONDecoder().decode(HarnessSpace.self, from: Data(nulls.utf8))
        #expect(bounded.policy == nil && bounded.atlassian == nil, "`null` (lecteur borné, Atlassian désactivé) se lit comme absent")
    }

    @Test("l'état du serveur porte ses avertissements ; le client du jeton et un client administré, les espaces auxquels ils sont bornés — rien d'un serveur antérieur")
    func statusAndClients() throws {
        let status = try JSONDecoder().decode(HarnessStatus.self, from: Data(#"{"repos":[],"warnings":["demo et docs partagent la portée « acme »"]}"#.utf8))
        #expect(status.warnings == ["demo et docs partagent la portée « acme »"])
        #expect(try JSONDecoder().decode(HarnessStatus.self, from: Data(#"{"repos":[]}"#.utf8)).warnings.isEmpty)

        let me = try JSONDecoder().decode(HarnessMe.self, from: Data(#"{"client":{"name":"acme","role":"operator","repos":["acme-web"],"approver":false,"pilot":false,"spaces":["e-acme"]}}"#.utf8))
        #expect(me.client.spaces == ["e-acme"] && !me.client.isOwner)
        let owner = try JSONDecoder().decode(HarnessMe.self, from: Data(#"{"client":{"name":"mac","role":"admin","repos":"*"}}"#.utf8))
        #expect(owner.client.spaces == nil && owner.client.isOwner)

        let managed = try JSONDecoder().decode(HarnessManagedClient.self, from: Data(#"{"name":"acme","role":"viewer","repos":["acme-web"],"createdAt":5,"approver":false,"pilot":false,"spaces":["e-acme"]}"#.utf8))
        #expect(managed.spaces == ["e-acme"] && managed.repos == ["acme-web"])
        let plain = try JSONDecoder().decode(HarnessManagedClient.self, from: Data(#"{"name":"mac","role":"admin","repos":"*","createdAt":5}"#.utf8))
        #expect(plain.spaces == nil && plain.repos == nil)
    }

    // MARK: Capacités

    @Test("les capacités se lisent une fois dans /v1/health ; un serveur qui n'en annonce aucune, ou sans la route, n'en a pas")
    func capabilities() async {
        let transport = osTransport(multiClientRoutes())
        let model = await connected(transport)
        #expect(model.capabilities == nil && !model.serves(.spaceScope), "inconnues tant qu'elles ne sont pas lues")
        await model.loadCapabilities()
        await model.loadCapabilities()
        #expect(transport.count("GET", "/v1/health") == 1)
        #expect(HarnessCapability.allCases.allSatisfy(model.serves))

        let old = await connected(osTransport(multiClientRoutes(features: ["spaces", "brief"])))
        await old.loadCapabilities()
        #expect(old.capabilities == ["spaces", "brief"] && !HarnessCapability.allCases.contains(where: old.serves))

        let bare = await connected(osTransport(routes: [:]))
        await bare.loadCapabilities()
        #expect(bare.capabilities == [] && !bare.serves(.spacePolicy))
    }

    @Test("lire les espaces lit aussi les capacités ; changer de serveur les oublie avec la portée")
    func capabilitiesFollowServer() async throws {
        let transport = osTransport(multiClientRoutes())
        let model = await connected(transport)
        await model.spaces.refresh()
        #expect(model.serves(.spacePolicy))
        model.setScope(try #require(model.spaces.spaces.first { $0.id == "e-acme" }))
        #expect(model.scope?.id == "e-acme")
        _ = await model.configure(address: "autre.example", token: "t")
        #expect(model.scope == nil && model.capabilities == nil)
    }

    // MARK: Portée gardée et restaurée

    @Test("la portée est gardée par serveur et restaurée quand les espaces sont lus ; « tous les espaces » l'oublie")
    func scopeKeptPerServer() async throws {
        let preferences = InMemoryClientPreferences()
        let transport = osTransport(multiClientRoutes())
        let model = await connected(transport, preferences: preferences)
        await model.spaces.refresh()
        #expect(model.scope == nil, "rien de gardé : tous les espaces")
        let acme = try #require(model.spaces.spaces.first { $0.id == "e-acme" })
        model.setScope(acme)
        #expect(model.scope == acme)
        #expect(preferences.snapshot[ConsoleSpacePreference.key(forServer: "https://vps.example")] == "e-acme")
        #expect(ConsoleSpacePreference(preferences: preferences).spaceId(forServer: "https://vps.example") == "e-acme")
        #expect(ConsoleSpacePreference(preferences: preferences).spaceId(forServer: "https://autre.example") == nil, "un autre serveur a son propre choix")

        // Au lancement suivant : la portée revient dès que les espaces sont lus.
        let relaunched = await connected(osTransport(multiClientRoutes()), preferences: preferences)
        #expect(relaunched.scope == nil)
        await relaunched.spaces.refresh()
        #expect(relaunched.scope?.id == "e-acme" && relaunched.scope?.name == "Client Acme")

        relaunched.setScope(nil)
        #expect(relaunched.scope == nil)
        #expect(preferences.snapshot[ConsoleSpacePreference.key(forServer: "https://vps.example")] == nil)
        let again = await connected(osTransport(multiClientRoutes()), preferences: preferences)
        await again.spaces.refresh()
        #expect(again.scope == nil)
    }

    @Test("un espace gardé qui n'existe plus est oublié ; la portée tombe quand son espace disparaît, et suit l'espace relu")
    func scopeForgottenWithItsSpace() async throws {
        let preferences = InMemoryClientPreferences(["os.space.https://vps.example": "e-disparu"])
        let model = await connected(osTransport(multiClientRoutes()), preferences: preferences)
        await model.spaces.refresh()
        #expect(model.scope == nil)
        #expect(preferences.snapshot["os.space.https://vps.example"] == nil, "le choix d'un espace disparu est oublié")

        let listed = LockedBox(twoSpacesJSON)
        let transport = osTransport { call in
            call.method == "GET" && call.path == "/v1/spaces" ? osJSON(listed.value) : multiClientRoutes()(call)
        }
        let live = await connected(transport, preferences: preferences)
        await live.spaces.refresh()
        live.setScope(try #require(live.spaces.spaces.first { $0.id == "e-acme" }))
        #expect(live.scope?.rev == 3)

        listed.value = #"{"spaces":["# + persoJSON + "," + fullSpaceJSON("e-acme", name: "Acme SA", repos: ["acme-web"], rev: 4) + "]}"
        await live.spaces.refresh()
        #expect(live.scope?.rev == 4 && live.scope?.name == "Acme SA" && live.scope?.repos == ["acme-web"], "la portée suit l'espace relu")

        listed.value = #"{"spaces":["# + persoJSON + "]}"
        await live.spaces.refresh()
        #expect(live.scope == nil)
        #expect(preferences.snapshot["os.space.https://vps.example"] == nil)
    }

    // MARK: `?space=` et relecture

    @Test("avec une portée, le brief, les chiffres et les propositions partent avec `?space=` ; les consignes et les espaces restent lus en entier")
    func scopedReads() async throws {
        let transport = osTransport(multiClientRoutes())
        let model = await connected(transport)
        await model.spaces.refresh()
        model.setScope(try #require(model.spaces.spaces.first { $0.id == "e-acme" }))

        await model.brief.refresh()
        await model.brief.refresh(since: 500)
        await model.scoreboard.refresh()
        await model.proposals.refresh()
        await model.rules.refresh()
        await model.spaces.refresh()
        #expect(transport.last("GET", "/v1/brief?space=e-acme") != nil)
        #expect(transport.last("GET", "/v1/brief?since=500&space=e-acme") != nil)
        #expect(transport.last("GET", "/v1/scoreboard?days=7&space=e-acme") != nil)
        #expect(transport.last("GET", "/v1/proposals?space=e-acme") != nil)
        #expect(transport.last("GET", "/v1/rules") != nil && transport.last("GET", "/v1/rules?space=e-acme") == nil)
        #expect(transport.calls.filter { $0.path.hasPrefix("/v1/spaces?") }.isEmpty)
        #expect(transport.count("GET", "/v1/brief") == 0 && transport.count("GET", "/v1/proposals") == 0)
        // Le serveur a borné lui-même : rien n'est retiré dans l'app.
        #expect(model.brief.brief?.headline == "de l'espace" && model.brief.brief?.delivered.count == 2)
        #expect(model.proposals.proposals.count == 3 && model.scoreboard.scoreboard?.merged == 10)
    }

    @Test("changer de portée vide puis relit ce que le serveur compose — une fois lu ; ce qui n'a jamais été lu ne part pas")
    func rereadOnScopeChange() async throws {
        let transport = osTransport(multiClientRoutes())
        let model = await connected(transport)
        await model.spaces.refresh()
        await model.brief.refresh(since: 500)
        await model.proposals.refresh()
        #expect(transport.count("GET", "/v1/brief?since=500") == 1 && model.brief.brief?.headline == "du serveur")

        let acme = try #require(model.spaces.spaces.first { $0.id == "e-acme" })
        model.setScope(acme)
        #expect(model.brief.brief == nil && model.proposals.proposals.isEmpty, "le contenu de l'ancienne portée ne reste pas à l'écran")
        #expect(await eventually { transport.count("GET", "/v1/brief?since=500&space=e-acme") == 1 && transport.count("GET", "/v1/proposals?space=e-acme") == 1 })
        #expect(await eventually { model.brief.brief?.headline == "de l'espace" && model.proposals.proposals.count == 3 })
        #expect(transport.calls.filter { $0.path.hasPrefix("/v1/scoreboard") }.isEmpty, "les chiffres n'avaient pas été lus")

        model.setScope(acme)
        model.setScope(try #require(model.spaces.spaces.first { $0.id == "e-perso" }))
        #expect(await eventually { transport.count("GET", "/v1/brief?since=500&space=e-perso") == 1 })
        #expect(transport.count("GET", "/v1/brief?since=500&space=e-acme") == 1, "reposer la même portée ne relit rien")

        model.setScope(nil)
        #expect(await eventually { transport.count("GET", "/v1/brief?since=500") == 2 && model.brief.brief?.headline == "du serveur" })
    }

    @Test("la portée gardée est restaurée AVANT la première lecture bornée : le brief d'un lancement part déjà pour son espace")
    func restoredBeforeFirstRead() async {
        let transport = osTransport(multiClientRoutes())
        let model = await connected(transport, preferences: InMemoryClientPreferences(["os.space.https://vps.example": "e-acme"]))
        await model.brief.refresh()
        #expect(model.scope?.id == "e-acme")
        #expect(transport.count("GET", "/v1/spaces") == 1)
        #expect(transport.count("GET", "/v1/brief") == 0 && transport.count("GET", "/v1/brief?space=e-acme") == 1)
        #expect(model.brief.brief?.headline == "de l'espace")
    }

    @Test("un serveur qui n'annonce pas `space-scope` ne reçoit jamais `?space=` : la portée est bornée dans l'app, par les dépôts de l'espace")
    func olderServerFiltersInApp() async throws {
        let transport = osTransport(multiClientRoutes(features: ["spaces", "brief", "scoreboard", "proposals"]))
        let model = await connected(transport)
        await model.spaces.refresh()
        model.setScope(try #require(model.spaces.spaces.first { $0.id == "e-acme" }))
        await model.brief.refresh()
        await model.proposals.refresh()
        await model.scoreboard.refresh()
        #expect(transport.calls.filter { $0.path.contains("space=") }.isEmpty)

        let brief = try #require(model.brief.brief)
        #expect(brief.delivered.map(\.runId) == ["r1"] && brief.waiting.isEmpty && brief.failed.map(\.runId) == ["r4"])
        #expect(brief.headline.isEmpty && brief.proposals == 0 && brief.cost == 1.5, "la phrase et les totaux de tous les espaces ne passent pas pour ceux de l'espace")
        #expect(model.proposals.proposals.map(\.id) == ["retry.1"])
        let board = try #require(model.scoreboard.scoreboard)
        #expect(board.repos.map(\.repo) == ["acme-web"] && board.merged == 2 && board.mergedAlone == 1 && board.aloneRate == 0.5 && board.cancelled == 2)
        #expect(board.decisions == 0 && board.medianDecisionMs == nil && board.started == 0 && board.cancelCauses.isEmpty)

        model.setScope(nil)
        #expect(await eventually { model.brief.brief?.delivered.count == 2 && model.proposals.proposals.count == 3 })
    }

    @Test("un espace disparu du serveur (404 sous `?space=`) fait tomber la portée ; la lecture repart pour tous les espaces, le brief reste servi")
    func vanishedSpaceDropsScope() async throws {
        let listed = LockedBox(twoSpacesJSON)
        let transport = osTransport { call in
            if call.method == "GET", call.path == "/v1/spaces" { return osJSON(listed.value) }
            if call.path.contains("space=e-acme"), listed.value != twoSpacesJSON { return osJSON(#"{"error":"espace inconnu : e-acme"}"#, status: 404) }
            return multiClientRoutes()(call)
        }
        let model = await connected(transport)
        await model.spaces.refresh()
        model.setScope(try #require(model.spaces.spaces.first { $0.id == "e-acme" }))
        await model.brief.refresh()
        #expect(model.brief.availability == .available)

        listed.value = #"{"spaces":["# + persoJSON + "]}"
        await model.brief.refresh()
        #expect(model.scope == nil)
        #expect(await eventually { model.brief.brief?.headline == "du serveur" })
        #expect(model.brief.availability == .available && model.brief.failure == nil)
    }

    // MARK: Accueil, détail, politique, identités

    @Test("accueillir un client envoie nom et dépôts — le reste seulement s'il est donné —, rend l'étanchéité et la suite, et choisit l'espace créé")
    func onboard() async throws {
        let reply = #"{"space":"# + acmeJSON + #","isolation":{"sealed":false,"gaps":[{"code":"no_atlassian","repo":null,"text":"Connecte Jira."}]},"#
            + #""next":[{"code":"global_memory_token","text":"Pose un jeton mémoire par dépôt : acme-web."},{"code":"no_atlassian","text":"Connecte Jira."},{"code":"attach_browser","text":"Rattache un navigateur."},{"code":"no_repos","text":"Ajoute un dépôt."}]}"#
        let transport = osTransport { call in
            call.method == "POST" && call.path == "/v1/spaces/onboard" ? osJSON(reply, status: 201) : multiClientRoutes()(call)
        }
        let model = await connected(transport)

        let policy = HarnessSpacePolicy(privacy: HarnessSpacePolicy.localOnly, providers: ["omlx"])
        let welcomed = try #require(await model.spaces.onboard(
            name: "  Client Acme ", repos: [" acme-web ", "acme-api", "acme-web"], jiraProjects: ["ACME"], dailyBudgetUsd: 50, autonomy: .ask, policy: policy
        ))
        let body = try #require(transport.body("POST", "/v1/spaces/onboard"))
        #expect(body["name"] as? String == "Client Acme" && body["repos"] as? [String] == ["acme-web", "acme-api"])
        #expect(body["jiraProjects"] as? [String] == ["ACME"] && body["dailyBudgetUsd"] as? Double == 50 && body["autonomy"] as? String == "ask")
        #expect((body["policy"] as? [String: Any])?["privacy"] as? String == "local-only")
        #expect(body["poste"] == nil)

        #expect(welcomed.space.id == "e-acme" && welcomed.isolation?.gaps.map(\.kind) == [.noAtlassian])
        #expect(welcomed.next.map(\.gesture) == [nil, .connectAtlassian, .attachBrowser, .addRepos])
        #expect(welcomed.next.first?.gap == .globalMemoryToken && welcomed.next.last?.gap == nil)
        #expect(model.scope?.id == "e-acme", "l'espace créé est choisi")
        #expect(transport.count("GET", "/v1/spaces") == 1, "la liste est relue")

        _ = await model.spaces.onboard(name: "Seul", repos: [])
        #expect(transport.rawBody("POST", "/v1/spaces/onboard") == #"{"name":"Seul","repos":[]}"# || transport.rawBody("POST", "/v1/spaces/onboard") == #"{"repos":[],"name":"Seul"}"#)
        let before = transport.count("POST", "/v1/spaces/onboard")
        #expect(await model.spaces.onboard(name: " ", repos: []) == nil && model.spaces.failure == .rejected(""))
        #expect(transport.count("POST", "/v1/spaces/onboard") == before)
    }

    @Test("sur un serveur qui ne sait pas accueillir, l'espace est créé par POST /v1/spaces, sans politique ni suite ; la politique et les identités ne partent pas")
    func onboardOnOlderServer() async throws {
        let created = #"{"space":{"id":"s9","name":"Client B","repos":["site"],"poste":false,"jiraProjects":[],"dailyBudgetUsd":null,"autonomy":null,"by":"mac","createdAt":1,"updatedAt":1,"rev":1}}"#
        let transport = osTransport { call in
            call.method == "POST" && call.path == "/v1/spaces" ? osJSON(created, status: 201) : multiClientRoutes(features: ["spaces"])(call)
        }
        let model = await connected(transport)
        let welcomed = try #require(await model.spaces.onboard(name: "Client B", repos: ["site"], policy: HarnessSpacePolicy(privacy: "local-only")))
        #expect(welcomed.space.id == "s9" && welcomed.isolation == nil && welcomed.next.isEmpty)
        #expect(transport.count("POST", "/v1/spaces/onboard") == 0)
        #expect(try #require(transport.body("POST", "/v1/spaces"))["policy"] == nil)
        #expect(model.scope?.id == "s9")

        await model.spaces.refresh()
        let acme = try #require(model.spaces.spaces.first { $0.id == "e-acme" })
        #expect(await model.spaces.setPolicy(acme, nil) == false)
        #expect(await model.spaces.setIdentities(acme, ["moi"]) == false)
        #expect(await model.spaces.detail("e-acme")?.id == "e-acme", "le détail est celui de la liste")
        #expect(await model.spaces.usage(spaceId: "e-acme") == nil)
        #expect(await model.spaces.usageCSV(spaceId: "e-acme") == nil)
        #expect(transport.calls.filter { $0.method == "PUT" || $0.path.hasPrefix("/v1/spaces/e-acme") }.isEmpty)
        #expect(model.spaces.failure == nil)
    }

    @Test("le détail d'un espace se relit et rejoint la liste ; la politique part seule (`null` la lève), les identités aussi, à la révision lue")
    func detailPolicyIdentities() async throws {
        let fresher = fullSpaceJSON("e-acme", name: "Client Acme", repos: ["acme-web", "acme-api"], rev: 5)
        let transport = osTransport { call in
            switch (call.method, call.path) {
            case ("GET", "/v1/spaces/e-acme"): osJSON(#"{"space":"# + fresher + "}")
            case ("PUT", "/v1/spaces/e-acme"): osJSON(#"{"space":"# + fresher + "}")
            default: multiClientRoutes()(call)
            }
        }
        let model = await connected(transport)
        await model.spaces.refresh()
        let acme = try #require(model.spaces.spaces.first { $0.id == "e-acme" })
        model.setScope(acme)

        #expect(await model.spaces.detail("e-acme")?.rev == 5)
        #expect(model.spaces.spaces.first { $0.id == "e-acme" }?.rev == 5 && model.spaces.spaces.map(\.name) == ["Client Acme", "Perso"])
        #expect(model.scope?.rev == 5, "la portée suit l'espace relu")
        #expect(await model.spaces.detail("e-inconnu") == nil)

        #expect(await model.spaces.setPolicy(acme, HarnessSpacePolicy(providers: ["anthropic"], models: ["fast": ["anthropic/haiku"]])))
        var put = try #require(transport.last("PUT", "/v1/spaces/e-acme"))
        #expect(put.headers["If-Match"] == "\"3\"")
        var body = try #require(transport.body("PUT", "/v1/spaces/e-acme"))
        #expect(body.keys.sorted() == ["policy"], "seule la politique part : le reste de l'espace ne bouge pas")
        #expect((body["policy"] as? [String: Any])?["providers"] as? [String] == ["anthropic"])
        #expect(((body["policy"] as? [String: Any])?["models"] as? [String: [String]])?["fast"] == ["anthropic/haiku"])

        #expect(await model.spaces.setPolicy(acme, nil))
        #expect(transport.rawBody("PUT", "/v1/spaces/e-acme") == #"{"policy":null}"#)
        #expect(await model.spaces.setPolicy(acme, HarnessSpacePolicy()))
        #expect(transport.rawBody("PUT", "/v1/spaces/e-acme") == #"{"policy":null}"#, "une politique vide la lève")

        #expect(await model.spaces.setIdentities(acme, [" moi@acme.example ", "", "moi@acme.example", "moi"]))
        put = try #require(transport.last("PUT", "/v1/spaces/e-acme"))
        body = try #require(transport.body("PUT", "/v1/spaces/e-acme"))
        #expect(put.headers["If-Match"] == "\"3\"" && body.keys.sorted() == ["identities"])
        #expect(body["identities"] as? [String] == ["moi@acme.example", "moi"])
    }

    // MARK: Consommation

    @Test("la consommation d'un espace se lit par jour, dépôt, modèle et nature ; le CSV revient tel que le serveur l'écrit")
    func usage() async throws {
        let json = #"""
        {"usage":{"since":1000,"until":2000,"total":3.75,
         "days":[{"day":"2026-11-01","cost":1.25,"input":1000,"output":200},{"day":"2026-11-02","cost":2.5,"input":3000,"output":400}],
         "repos":[{"repo":"acme-web","cost":2.5},{"repo":"acme-api","cost":0.75}],
         "models":[{"model":"anthropic/opus","cost":3.75,"input":4000,"output":600}],
         "kinds":[{"kind":"feature","cost":3.25},{"kind":"demande","cost":0.5},{"kind":"futur","cost":0}]}}
        """#
        let csv = "jour;espace;depot;modele;cout_usd;jetons_entree;jetons_sortie\r\n2026-11-01;Client Acme;acme-web;anthropic/opus;1.250000;1000;200\r\n"
        let transport = osTransport { call in
            guard call.method == "GET", call.path.hasPrefix("/v1/spaces/e-acme/usage") else { return multiClientRoutes()(call) }
            return call.path.contains("format=csv") ? HarnessReply(status: 200, body: Data(csv.utf8)) : osJSON(json)
        }
        let model = await connected(transport)

        let usage = try #require(await model.spaces.usage(spaceId: "e-acme"))
        #expect(transport.last("GET", "/v1/spaces/e-acme/usage") != nil, "sans fenêtre : le mois en cours du serveur")
        #expect(usage.total == 3.75 && usage.since == 1000 && usage.until == 2000)
        #expect(usage.days == [HarnessSpaceUsageDay(day: "2026-11-01", cost: 1.25, input: 1000, output: 200), HarnessSpaceUsageDay(day: "2026-11-02", cost: 2.5, input: 3000, output: 400)])
        #expect(usage.repos.map(\.repo) == ["acme-web", "acme-api"] && usage.unattributed == 0.5)
        #expect(usage.models == [HarnessSpaceUsageModel(model: "anthropic/opus", cost: 3.75, input: 4000, output: 600)])
        #expect(usage.kinds.map(\.nature) == [.feature, .demande, nil])

        _ = await model.spaces.usage(spaceId: "e-acme", since: 1_000, until: 2_000)
        #expect(transport.last("GET", "/v1/spaces/e-acme/usage?since=1000&until=2000") != nil)
        let data = try #require(await model.spaces.usageCSV(spaceId: "e-acme", since: 1_000))
        #expect(String(decoding: data, as: UTF8.self) == csv)
        #expect(transport.last("GET", "/v1/spaces/e-acme/usage?since=1000&format=csv") != nil)
        #expect(HarnessSpacesModel.usagePath(spaceId: "e/1", csv: true) == "/v1/spaces/e%2F1/usage?format=csv")

        #expect(await model.spaces.usage(spaceId: "e-inconnu") == nil)
        #expect(await model.spaces.usageCSV(spaceId: "e-inconnu") == nil)
        #expect(model.spaces.failure == nil, "un espace inconnu n'est pas une panne")
    }

    // MARK: Demande, pause, consignes, clients

    @Test("une Demande part avec son espace et le relit ; un serveur antérieur ne le reçoit pas — l'unique dépôt de l'espace la borne alors")
    func intakeSpace() async throws {
        let intake = #"{"intake":{"id":"i1","text":"Exporter","source":"console","repo":null,"requestedRepo":null,"context":null,"space":{"id":"e-acme","name":"Client Acme"},"state":"classifying","kind":null,"plan":null,"question":null,"answer":null,"exchanges":[],"statement":"Exporter","created":null,"reason":null,"by":"mac","createdAt":1,"updatedAt":1}}"#
        let routes: @Sendable ([String]) -> @Sendable (HarnessCall) -> HarnessReply? = { features in
            { call in call.method == "POST" && call.path == "/v1/intake" ? osJSON(intake, status: 201) : multiClientRoutes(features: features)(call) }
        }
        let transport = osTransport(routes(allCapabilities))
        let model = await connected(transport)
        await model.spaces.refresh()
        let acme = try #require(model.spaces.spaces.first { $0.id == "e-acme" })
        let perso = try #require(model.spaces.spaces.first { $0.id == "e-perso" })

        let posed = try await model.intakes.submit(text: " Exporter ", source: "console", space: acme, repo: "acme-web")
        #expect(posed.space == HarnessIntakeSpace(id: "e-acme", name: "Client Acme"))
        var body = try #require(transport.body("POST", "/v1/intake"))
        #expect(body["space"] as? String == "e-acme" && body["repo"] as? String == "acme-web" && body["text"] as? String == "Exporter")
        _ = try await model.intakes.submit(text: "Exporter", source: "console")
        #expect(try #require(transport.body("POST", "/v1/intake")).keys.sorted() == ["source", "text"], "sans espace : le corps d'avant")

        let oldTransport = osTransport(routes(["spaces", "intake"]))
        let old = await connected(oldTransport)
        _ = try await old.intakes.submit(text: "Exporter", source: "ios", space: acme)
        body = try #require(oldTransport.body("POST", "/v1/intake"))
        #expect(body["space"] == nil && body["repo"] == nil, "deux dépôts : rien ne borne, le serveur classe")
        _ = try await old.intakes.submit(text: "Exporter", source: "ios", space: perso)
        body = try #require(oldTransport.body("POST", "/v1/intake"))
        #expect(body["space"] == nil && body["repo"] as? String == "demo")

        let bare = #"{"id":"i2","text":"t","source":"console","repo":"demo","requestedRepo":null,"state":"planned","kind":null,"plan":null,"question":null,"answer":null,"exchanges":[],"statement":"t","created":null,"reason":null,"by":null,"createdAt":1,"updatedAt":1}"#
        #expect(try JSONDecoder().decode(HarnessIntake.self, from: Data(bare.utf8)).space == nil)
    }

    @Test("la pause dit les espaces suspendus ; suspendre un espace envoie `space` dans le corps, jamais dans l'adresse ; un serveur antérieur ne le reçoit pas")
    func spacePause() async throws {
        let paused = #"{"pause":{"paused":false,"by":null,"at":null,"reason":null,"now":false,"spaces":[{"id":"e-acme","name":"Client Acme","paused":true,"by":"mac","at":1700,"reason":"rendez-vous","now":true}]}}"#
        let transport = osTransport { call in
            call.path == "/v1/pause" ? osJSON(paused) : multiClientRoutes()(call)
        }
        let model = await connected(transport)
        await model.spaces.refresh()
        let acme = try #require(model.spaces.spaces.first { $0.id == "e-acme" })
        let perso = try #require(model.spaces.spaces.first { $0.id == "e-perso" })
        model.setScope(acme)

        await model.pause.refresh()
        #expect(transport.last("GET", "/v1/pause") != nil, "la pause se lit sans portée : elle dit tous les espaces suspendus")
        #expect(!model.pause.isPaused)
        #expect(model.pause.spacePause("e-acme") == HarnessSpacePause(id: "e-acme", name: "Client Acme", paused: true, by: "mac", at: 1700, reason: "rendez-vous", now: true))
        #expect(model.pause.spacePause("e-perso") == nil)
        #expect(model.pause.isSuspended(in: acme) && !model.pause.isSuspended(in: perso) && !model.pause.isSuspended(in: nil))

        #expect(await model.pause.setPause(paused: true, space: "e-acme", reason: " rendez-vous ", now: true))
        #expect(transport.last("POST", "/v1/pause") != nil)
        let body = try #require(transport.body("POST", "/v1/pause"))
        #expect(body["space"] as? String == "e-acme" && body["paused"] as? Bool == true && body["reason"] as? String == "rendez-vous" && body["now"] as? Bool == true)
        #expect(await model.pause.setPause(paused: true))
        #expect(try #require(transport.body("POST", "/v1/pause"))["space"] == nil, "« tout suspendre » ne porte jamais la portée")
        #expect(transport.calls.filter { $0.path.hasPrefix("/v1/pause?") }.isEmpty)

        let oldTransport = osTransport { call in call.path == "/v1/pause" ? osJSON(#"{"pause":{"paused":false,"by":null,"at":null,"reason":null}}"#) : multiClientRoutes(features: ["pause"])(call) }
        let old = await connected(oldTransport)
        await old.pause.refresh()
        #expect(old.pause.pause?.spaces.isEmpty == true && old.pause.pause?.now == false)
        #expect(await old.pause.setPause(paused: true, space: "e-acme") == false, "la pause d'un espace ne part pas : elle suspendrait tout")
        #expect(oldTransport.count("POST", "/v1/pause") == 0 && old.pause.failure == nil)
    }

    @Test("une consigne d'espace se lit et s'écrit (`space`), jamais avec un dépôt ; celles de la portée sont les siennes, celles de ses dépôts et celles de partout")
    func spaceRules() async throws {
        let rules = #"""
        {"rules":[{"id":"c1","repo":null,"space":"e-acme","text":"Chaque commit cite son ticket.","enabled":true,"source":"manual","sourceRunId":null,"by":"mac","createdAt":4,"updatedAt":4},
         {"id":"c2","repo":"acme-web","space":null,"text":"Pas de jQuery.","enabled":true,"source":"manual","sourceRunId":null,"by":"mac","createdAt":3,"updatedAt":3},
         {"id":"c3","repo":null,"space":null,"text":"En français.","enabled":true,"source":"manual","sourceRunId":null,"by":"mac","createdAt":2,"updatedAt":2},
         {"id":"c4","repo":"demo","text":"Tests d'abord.","enabled":true,"source":"manual","sourceRunId":null,"by":"mac","createdAt":1,"updatedAt":1},
         {"id":"c5","repo":null,"space":"e-perso","text":"Tutoiement.","enabled":false,"source":"manual","sourceRunId":null,"by":"mac","createdAt":0,"updatedAt":0}]}
        """#
        let made = #"{"rule":{"id":"c9","repo":null,"space":"e-acme","text":"Toujours une capture.","enabled":true,"source":"manual","sourceRunId":null,"by":"mac","createdAt":9,"updatedAt":9}}"#
        let transport = osTransport { call in
            switch (call.method, call.path) {
            case ("GET", "/v1/rules"): osJSON(rules)
            case ("POST", "/v1/rules"): osJSON(made, status: 201)
            default: multiClientRoutes()(call)
            }
        }
        let model = await connected(transport)
        await model.spaces.refresh()
        await model.rules.refresh()
        #expect(model.rules.rules.map(\.space) == ["e-acme", nil, nil, nil, "e-perso"])
        #expect(model.rules.rules.map(\.isGlobal) == [false, false, true, false, false])
        #expect(model.rules.inScope.count == 5 && model.rules.levels.space.map(\.id) == ["c1", "c5"], "sans portée : toutes")
        #expect(model.rules.active(for: "acme-api").map(\.id) == ["c1", "c3"], "son espace et partout")
        #expect(model.rules.active(for: "acme-web").map(\.id) == ["c1", "c2", "c3"])
        #expect(model.rules.active(for: "demo").map(\.id) == ["c3", "c4"], "la consigne d'espace désactivée ne s'impose pas")
        #expect(model.rules.active(for: nil).map(\.id) == ["c3"])

        model.setScope(try #require(model.spaces.spaces.first { $0.id == "e-acme" }))
        #expect(model.rules.inScope.map(\.id) == ["c1", "c2", "c3"])
        #expect(model.rules.levels == OSRuleLevels(
            space: model.rules.rules.filter { $0.id == "c1" }, repos: model.rules.rules.filter { $0.id == "c2" },
            everywhere: model.rules.rules.filter { $0.id == "c3" }
        ))

        let rule = try #require(await model.rules.create(text: " Toujours une capture. ", space: "e-acme"))
        #expect(rule.space == "e-acme" && model.rules.rules.first?.id == "c9")
        var body = try #require(transport.body("POST", "/v1/rules"))
        #expect(body.keys.sorted() == ["space", "text"] && body["space"] as? String == "e-acme")
        _ = await model.rules.create(text: "Pas de jQuery.", repo: "acme-web", space: "e-acme")
        body = try #require(transport.body("POST", "/v1/rules"))
        #expect(body.keys.sorted() == ["repo", "text"], "le dépôt l'emporte : jamais les deux")

        let oldTransport = osTransport(multiClientRoutes(features: ["os-autonomy"]))
        let old = await connected(oldTransport)
        #expect(await old.rules.create(text: "Toujours une capture.", space: "e-acme") == nil && old.rules.failure == .rejected(""))
        #expect(oldTransport.count("POST", "/v1/rules") == 0, "elle y vaudrait partout : elle ne part pas")
    }

    @Test("un client d'API se crée borné à des espaces (à la place des dépôts) ; rien ne part vers un serveur antérieur")
    func spaceBoundedClient() async throws {
        let created = #"{"client":{"name":"acme","role":"viewer","repos":["acme-web"],"createdAt":5,"approver":false,"pilot":false,"spaces":["e-acme"]},"token":"abc"}"#
        let routes: @Sendable ([String]) -> @Sendable (HarnessCall) -> HarnessReply? = { features in
            { call in
                switch (call.method, call.path) {
                case ("POST", "/v1/clients"): osJSON(created, status: 201)
                case ("GET", "/v1/me"): osJSON(#"{"client":{"name":"mac","role":"admin","repos":"*","approver":true}}"#)
                case ("GET", "/v1/clients"): osJSON(#"{"clients":[]}"#)
                case ("GET", "/v1/repos"): osJSON(#"{"repos":[]}"#)
                default: multiClientRoutes(features: features)(call)
                }
            }
        }
        let transport = osTransport(routes(allCapabilities))
        let model = await connected(transport)
        let made = try #require(await model.admin.createClient(name: "acme", role: "viewer", repos: ["ignoré"], spaces: ["e-acme"]))
        #expect(made.client.spaces == ["e-acme"])
        let body = try #require(transport.body("POST", "/v1/clients"))
        #expect(body.keys.sorted() == ["name", "role", "spaces"] && body["spaces"] as? [String] == ["e-acme"])
        _ = await model.admin.createClient(name: "ci", role: "operator", repos: ["demo"])
        #expect(try #require(transport.body("POST", "/v1/clients")).keys.sorted() == ["name", "repos", "role"])

        let oldTransport = osTransport(routes(["clients"]))
        let old = await connected(oldTransport)
        #expect(await old.admin.createClient(name: "acme", role: "viewer", repos: [], spaces: ["e-acme"]) == nil)
        #expect(oldTransport.count("POST", "/v1/clients") == 0)
    }
}

/// Une valeur changée en cours de test, lue par le faux serveur.
final class LockedBox<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value

    init(_ value: Value) { stored = value }

    var value: Value {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}
