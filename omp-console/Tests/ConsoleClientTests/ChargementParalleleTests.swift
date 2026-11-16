// Le chargement de l'app iOS sur une doublure à LATENCE FIXE (`LatencyHarnessTransport`) : ouverture,
// retour au premier plan et « tirer pour actualiser » lisent leurs routes en même temps, chacune une
// seule fois, en un temps borné par la plus longue chaîne de lectures dépendantes (profondeur 2) et non
// par la somme. Sérialisée : les tests mesurent un temps.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

/// La latence fixe L de la doublure, et la borne de trois latences (deux allers-retours enchaînés + marge).
private let latency = Duration.milliseconds(300)
private let bound = latency * 3

private let spaceJSON = #"{"id":"s1","name":"Perso","repos":["demo"],"poste":true,"jiraProjects":[],"dailyBudgetUsd":null,"autonomy":null,"by":null,"createdAt":1,"updatedAt":1,"rev":1,"memoryScopes":[],"stats":{"working":0,"yours":0,"queued":0,"mergedWeek":0,"failedWeek":0,"cancelledWeek":0,"costToday":0,"costWeek":0,"budgetLeftToday":null}}"#

private let workstationJSON = #"""
{"online":true,"lastSeenAt":1761730000000,"extensionVersion":"0.1.0","observedSeconds":14400,"thresholdHours":8,
 "autonomy":{"setting":"auto","effective":"observe"},"paused":false,"selfIdentities":["moi@exemple.fr"],"pending":0,
 "profileUpdatedAt":null,"lastShift":null,"nextShiftAt":null}
"""#

private let profileJSON = #"""
{"profile":{"version":3,"updatedAt":1761730000000,"summary":"Commercial B2B.","habits":["Mails le matin"],
  "tools":[{"name":"Gmail","usage":"échanges clients"}],"schedule":"9 h – 18 h","repetitiveTasks":[],
  "clientNeeds":[],"preferences":[]},
 "stats":{"observedSeconds":14400,"since":1761000000000,"topSites":[],
  "activeHours":[0,0,0,0,0,0,0,0,0,3600,1800,0,0,0,0,0,0,0,0,0,0,0,0,0],"sequences":[]}}
"""#

private let vigieJSON = #"{"settings":{"mode":"shadow","maxIssuesPerDay":5,"maxLiveRuns":2,"dailyBudgetUsd":10,"repos":[]},"heartbeat":{"at":1,"version":null,"client":"vigie","silent":true,"silentSince":2},"today":{"since":0,"issues":0,"liveRuns":0,"spentUsd":0},"incidents":{"new":1}}"#

private let atlassianJSON = #"""
{"atlassian":{"enabled":true,"connected":true,"site":{"cloudId":"c1","url":"https://exemple.atlassian.net"},
 "accountId":"712020:abc","connectedAt":1762600000000,"connectedBy":"mac","expiresAt":1762628800000,"lastError":null,
 "redirectUri":"http://127.0.0.1:53682/callback","pasteBack":true,"pending":null,
 "plan":{"hour":8,"weekdaysOnly":true,"lastAt":null},"knowledge":{"everyHours":24,"lastAt":null,"lastSummary":null},"proposed":0}}
"""#

private let briefJSON = #"{"brief":{"since":1000,"until":2000,"seenAt":null,"headline":"du serveur","delivered":[],"waiting":[],"failed":[],"stopped":[],"decided":[],"blocked":[],"proposals":0,"cost":0}}"#

private let catalogStatusJSON = #"{"runs":{"merged":2},"live":[],"scheduler":{},"repos":[{"name":"demo","scope":"src"}],"oracle":{"configured":false,"ok":false}}"#
private let catalogProjectsJSON = #"{"projects":[]}"#
private let catalogAuditsJSON = #"{"audits":[]}"#
private let catalogStatsJSON = #"""
{"runs":{"total":3,"byState":{"merged":2,"failed":1},"mergedLast7Days":2,"mergeRate":0.67,"medianLeadSec":3600,"fixesPerMerged":0.5},
 "steps":{"impl":{"count":3,"failed":1,"medianSec":900}},
 "tests":{"total":4,"cached":1,"byOutcome":{"pass":3,"fail":1},"retried":0},
 "decisions":{"auto":1},"escalations":{"open":0},"audits":{"proposed":1},"projects":{"active":1},
 "scheduler":{"runner":{"used":1,"capacity":5,"labels":["r1"]},"heavy":{"used":0,"capacity":2,"labels":[]},"memAvailableMiB":null,"providers":{}}}
"""#

/// Une boîte au curseur donné (la fixture d'`OSTestSupport` est au curseur 42).
private func inboxJSON(cursor: Int) -> String {
    osInboxJSON.replacingOccurrences(of: #""cursor":42"#, with: #""cursor":\#(cursor)"#)
}

/// Un serveur où toutes les routes du chargement répondent 200 ; ce qu'il ne connaît pas rend 404.
private func shellRoutes(inboxCursor: Int = 42) -> @Sendable (HarnessCall) -> HarnessReply {
    { call in
        let path = call.path
        guard call.method == "GET" else { return osJSON(#"{"error":"route inconnue"}"#, status: 404) }
        if path.hasPrefix("/v1/intake?") { return osJSON(#"{"intakes":[]}"#) }
        if path.hasPrefix("/v1/vigie/incidents") { return osJSON(#"{"incidents":[]}"#) }
        if path.hasPrefix("/v1/workstation/actions") { return osJSON(#"{"actions":[]}"#) }
        if path.hasPrefix("/v1/atlassian/writes") { return osJSON(#"{"writes":[]}"#) }
        if path.hasPrefix("/v1/proposals") { return osJSON(#"{"proposals":[]}"#) }
        if path.hasPrefix("/v1/brief") { return osJSON(briefJSON) }
        switch path {
        case "/v1/inbox": return osJSON(inboxJSON(cursor: inboxCursor))
        case "/v1/me": return osJSON(#"{"client":{"name":"admin","role":"admin","repos":"*","createdAt":0,"approver":false}}"#)
        case "/v1/runs?recent=500": return osJSON(#"{"runs":["# + osRunJSON("r1") + "]}")
        case "/v1/workstation": return osJSON(workstationJSON)
        case "/v1/workstation/profile": return osJSON(profileJSON)
        case "/v1/workstation/meetings?limit=20": return osJSON(#"{"meetings":[]}"#)
        case "/v1/vigie": return osJSON(vigieJSON)
        case "/v1/atlassian": return osJSON(atlassianJSON)
        case "/v1/atlassian/plan":
            return osJSON(#"{"plan":{"id":"p1","createdAt":1762600000000,"trigger":"auto","by":"poste:plan","summary":"Trois tickets.","items":[]}}"#)
        case "/v1/local-sessions": return osJSON(#"{"sessions":[]}"#)
        case "/v1/spaces": return osJSON(#"{"spaces":["# + spaceJSON + "]}")
        case "/v1/status": return osJSON(catalogStatusJSON)
        case "/v1/projects": return osJSON(catalogProjectsJSON)
        case "/v1/audits": return osJSON(catalogAuditsJSON)
        case "/v1/stats": return osJSON(catalogStatsJSON)
        case "/v1/pause": return osJSON(#"{"pause":{"paused":false,"by":null,"at":null,"reason":null,"now":false}}"#)
        case "/v1/rules": return osJSON(#"{"rules":[]}"#)
        case "/v1/autonomy": return osJSON(#"{"repos":[],"validations":[],"proposals":[]}"#)
        case "/v1/health":
            return osJSON(
                #"{"ok":true,"version":"1.38.0","features":[""# + HarnessCapability.spaceScope.rawValue
                    + #""],"checks":{"db":{"ok":true},"scheduler":{"ok":true,"ageSec":1},"disk":{"ok":true,"freeMiB":1000}}}"#
            )
        case "/v1/runs/r1/session": return osJSON(#"{"runId":"r1","live":true,"cursor":42,"entries":[]}"#)
        case "/v1/runs/r1/tests/live": return osJSON(#"{"runId":"r1","cursor":42,"jobs":[]}"#)
        default: return osJSON(#"{"error":"route inconnue"}"#, status: 404)
        }
    }
}

/// Un modèle relié sans `configure` : l'adresse et le jeton sont déjà enregistrés, `load()` relie.
/// `space` : l'espace gardé pour ce serveur.
@MainActor
private func makeModel(_ transport: LatencyHarnessTransport, space: String? = nil) -> HarnessModel {
    let preferences = InMemoryClientPreferences([HarnessModel.addressKey: "https://vps.example"])
    if let space { ConsoleSpacePreference(preferences: preferences).choose(space, forServer: "https://vps.example") }
    return HarnessModel(
        transport: transport, preferences: preferences, tokens: InMemoryTokenStore([HarnessModel.tokenAccount: "t"]),
        retryDelay: .seconds(3600), refreshDelay: .milliseconds(10), reporter: .off
    )
}

/// Attend que l'adresse soit posée par `load()` : `.task(id: server.address)` de la coque part à ce moment.
@MainActor
private func untilConfigured(_ model: HarnessModel) async {
    while !model.isConfigured { await Task.yield() }
}

/// L'ouverture de l'app iOS : `RootView` lit la boîte (`load()`), `IOSOSRootView.load` lit la coque,
/// en même temps ; `pulse` démarre avec la coque, comme `workspace.pulse.start()`.
@MainActor
private func openApp(_ model: HarnessModel, pulse: OSPulse? = nil) async {
    async let inbox: Void = model.load()
    await untilConfigured(model)
    pulse?.start()
    await model.readShell(.opening)
    await inbox
}

/// Chaque modèle de B-2 a lu quelque chose de lisible : une fixture illisible ferait échouer le test.
@MainActor
private func expectShellFilled(_ model: HarnessModel) {
    #expect(model.inbox != nil)
    #expect(model.history.runs.count == 1)
    #expect(model.workstation.availability == .available && model.workstation.status != nil)
    #expect(model.vigie.availability == .available && model.vigie.view != nil)
    #expect(model.intakes.availability == .available)
    #expect(model.atlassian.availability == .available && model.atlassian.status != nil && model.atlassian.plan != nil)
    #expect(model.localSessions.availability == .available)
    #expect(model.spaces.availability == .available && model.spaces.spaces.count == 1)
    #expect(model.proposals.availability == .available)
    #expect(model.repos.count == 1)
    #expect(model.client?.role == "admin")
}

/// Aucune route GET lue plus d'une fois depuis `mark`.
private func expectEachReadOnce(_ transport: LatencyHarnessTransport, after mark: Int) {
    for (path, count) in transport.gets(after: mark) { #expect(count <= 1, "\(path) lu \(count) fois") }
}

@Suite("Chargement iOS en parallèle", .serialized)
@MainActor
struct ChargementParalleleTests {
    @Test("lenteurs-et-timeouts-du-chargement-sur-i/AC-2 : le chargement initial iOS publie toutes ses lectures en moins de 3 × L")
    func openingIsBoundedByChainDepth() async {
        let transport = LatencyHarnessTransport(latency: latency, shellRoutes())
        let model = makeModel(transport)
        let elapsed = await ContinuousClock().measure { await openApp(model) }
        #expect(elapsed < bound, "chargement en \(elapsed)")
        expectShellFilled(model)
        model.stopLive()

        // Un espace gardé : la portée est restaurée pendant que les capacités se lisent, la lecture suit.
        let kept = LatencyHarnessTransport(latency: latency, shellRoutes())
        let keptModel = makeModel(kept, space: "s1")
        let keptElapsed = await ContinuousClock().measure { await openApp(keptModel) }
        #expect(keptElapsed < bound, "chargement avec espace gardé en \(keptElapsed)")
        #expect(keptModel.proposals.availability == .available)
        #expect(kept.count("GET", "/v1/proposals?space=s1") == 1)
        #expect(kept.count("GET", "/v1/spaces") == 1)
        keptModel.stopLive()
    }

    @Test("lenteurs-et-timeouts-du-chargement-sur-i/AC-3 : au chargement initial iOS, aucune route GET n'est lue deux fois, Radar compris")
    func openingReadsEachRouteOnce() async {
        let transport = LatencyHarnessTransport(latency: latency, shellRoutes())
        let model = makeModel(transport)
        let pulse = OSPulse(harness: model)
        // Le Radar (vue partagée) lit de lui-même, au même instant que la coque.
        func radarReads() async {
            async let paused: Void = model.pause.refresh()
            async let local: Void = model.localSessions.refresh()
            async let clients: Void = model.spaces.refresh()
            _ = await (paused, local, clients)
        }
        async let boot: Void = model.load()
        await untilConfigured(model)
        pulse.start()
        async let radar: Void = radarReads()
        await model.readShell(.opening)
        await radar
        await boot
        model.startLive()
        // L'accueil part après `isLoaded` : le brief.
        await model.brief.refresh()
        _ = await eventually(timeout: 5) { model.isLive && pulse.isLive }

        expectEachReadOnce(transport, after: 0)
        #expect(transport.opened("/v1/events?after=42") == 1)
        #expect(transport.openedPaths.filter { $0.hasPrefix("/v1/events?live=1") }.count == 1, "un seul flux de pouls")
        expectShellFilled(model)
        pulse.stop()
        model.stopLive()
    }

    @Test("lenteurs-et-timeouts-du-chargement-sur-i/AC-4 : retour au premier plan — données gardées, lectures en moins de 3 × L, aucune route lue deux fois, flux ouverts une fois")
    func returningToForeground() async {
        let transport = LatencyHarnessTransport(latency: latency, shellRoutes())
        let model = makeModel(transport)
        let pulse = OSPulse(harness: model)
        let lifecycle = HarnessAppLifecycle()
        await openApp(model, pulse: pulse)
        model.startLive()
        model.followSession(runId: "r1")
        #expect(await eventually(timeout: 8) { model.isLive && pulse.isLive && model.direct.isLive })
        defer {
            pulse.stop()
            model.stopSession()
            model.stopLive()
        }

        // Le serveur a avancé pendant l'absence : boîte au curseur 50, événements manqués à rejouer sur l'ancien curseur.
        transport.respond { call in call.path == "/v1/inbox" ? osJSON(inboxJSON(cursor: 50)) : shellRoutes()(call) }
        transport.replay(
            ["workstation_changed", "atlassian", "intake_state", "local_session", "pause", "vigie_changed"].map { Data("event: \($0)\ndata: {}\n\n".utf8) },
            on: "/v1/events?after=42"
        )
        let before = model.inbox
        lifecycle.phaseChanged(to: .background, harness: model)
        pulse.phaseChanged(to: .background)
        lifecycle.phaseChanged(to: .inactive, harness: model)
        pulse.phaseChanged(to: .inactive)
        #expect(await eventually { transport.openStreams == 0 }, "l'arrière-plan ferme tous les flux")

        let mark = transport.mark()
        let pulsesBefore = transport.openedPaths.filter { $0.hasPrefix("/v1/events?live=1") }.count
        let directBefore = transport.openedPaths.filter { $0.hasPrefix("/v1/events?run=r1") }.count
        let started = ContinuousClock.now
        pulse.phaseChanged(to: .active)
        let task = lifecycle.phaseChanged(to: .active, harness: model)
        #expect(task != nil)

        // À L/2, rien n'est vidé : la relecture se fait derrière les données affichées.
        try? await Task.sleep(for: latency / 2)
        #expect(model.inbox == before && model.workstation.status != nil && !model.spaces.spaces.isEmpty)
        #expect(model.isLoaded)

        await task?.value
        let elapsed = ContinuousClock.now - started
        #expect(elapsed < bound, "retour en \(elapsed)")
        #expect(model.eventCursor == 50)

        // Les flux rouverts finissent de s'ouvrir (le direct lit encore son tampon et ses tests).
        _ = await eventually(timeout: 8) { model.isLive && pulse.isLive && model.direct.isLive }
        try? await Task.sleep(for: bound)
        expectEachReadOnce(transport, after: mark)
        #expect(transport.gets(after: mark)["/v1/runs/r1/session"] == 1, "le tampon du direct est lu une fois")
        #expect(transport.opened("/v1/events?after=50") == 1)
        #expect(transport.opened("/v1/events?after=42") == 1, "l'ancien curseur n'est pas rouvert")
        #expect(transport.openedPaths.filter { $0.hasPrefix("/v1/events?live=1") }.count == pulsesBefore + 1)
        #expect(transport.openedPaths.filter { $0.hasPrefix("/v1/events?run=r1") }.count == directBefore + 1)
        #expect(transport.openStreams == 3, "boîte, pouls et direct : un flux vivant chacun")
        #expect(model.isLive && pulse.isLive && model.direct.isLive)
    }

    @Test("lenteurs-et-timeouts-du-chargement-sur-i/AC-5 : une lecture en échec au retour garde la dernière donnée et pose l'échec d'aujourd'hui")
    func failingReadKeepsData() async {
        let transport = LatencyHarnessTransport(latency: latency, shellRoutes())
        let model = makeModel(transport)
        let lifecycle = HarnessAppLifecycle()
        await openApp(model)
        model.startLive()
        defer { model.stopLive() }

        let inboxBefore = model.inbox
        let statusBefore = model.workstation.status
        #expect(inboxBefore != nil && statusBefore != nil)
        lifecycle.phaseChanged(to: .background, harness: model)
        transport.failing = ["/v1/inbox", "/v1/workstation"]
        lifecycle.phaseChanged(to: .inactive, harness: model)
        let task = lifecycle.phaseChanged(to: .active, harness: model)
        await task?.value

        #expect(model.inbox == inboxBefore)
        #expect(model.failure == .rejected("panne"))
        #expect(model.workstation.status == statusBefore)
        #expect(model.workstation.failure == .rejected("panne"))
        transport.failing = []
    }

    @Test("lenteurs-et-timeouts-du-chargement-sur-i/AC-6 : tirer pour actualiser relit tout en moins de 3 × L, chaque route une fois")
    func pullToRefreshIsBounded() async {
        let transport = LatencyHarnessTransport(latency: latency, shellRoutes())
        let model = makeModel(transport)
        await openApp(model)
        defer { model.stopLive() }

        let mark = transport.mark()
        let elapsed = await ContinuousClock().measure {
            // Le corps de `IOSOSRootView.reload()`.
            async let shell: Void = model.readShell(.refreshing)
            await model.refresh()
            await shell
        }
        #expect(elapsed < bound, "actualisation en \(elapsed)")
        #expect(!transport.gets(after: mark).isEmpty)
        expectEachReadOnce(transport, after: mark)
    }

    @Test("lenteurs-et-timeouts-du-chargement-sur-i/AC-12 : le chargement initial du Mac ne fait pas plus d'appels ni ne dure plus qu'avant")
    func macOpeningIsNotSlowerThanBefore() async {
        let transport = LatencyHarnessTransport(latency: latency, shellRoutes())
        let model = makeModel(transport)

        // Les trois suites du Mac, en même temps (`ConsoleRootView`, `OSRootView`) : la boîte puis le flux ;
        // poste, Jira, demandes, vigie ; historique, poste, vigie, demandes, Jira, sessions, espaces, catalogue.
        // Chacune sous sa `ReadChain` : la doublure compte sa profondeur de chaîne, pas un temps mural.
        func inboxSuite() async {
            await model.load()
            model.startLive()
        }
        func posteSuite() async {
            await untilConfigured(model)
            await model.workstation.refresh()
            await model.atlassian.refresh()
            await model.intakes.refresh()
            await model.vigie.refresh()
        }
        func osSuite() async {
            await untilConfigured(model)
            await model.history.refresh()
            await model.workstation.load()
            await model.vigie.load()
            await model.intakes.refresh()
            await model.atlassian.refresh()
            await model.localSessions.refresh()
            await model.spaces.refresh()
            await model.refreshCatalog()
        }
        async let inbox: Void = LatencyHarnessTransport.$chain.withValue(ReadChain()) { await inboxSuite() }
        async let poste: Void = LatencyHarnessTransport.$chain.withValue(ReadChain()) { await posteSuite() }
        async let os: Void = LatencyHarnessTransport.$chain.withValue(ReadChain()) { await osSuite() }
        _ = await (inbox, poste, os)
        model.stopLive()

        // Avant la feature, la suite (c) enchaînait 13 lectures : historique 1, poste 2, vigie 2, demandes 1,
        // Jira 3, sessions 1, espaces 2 (`/v1/spaces` puis `/v1/health`), catalogue 1. Jira en 2 la ramène à 12.
        let depth = transport.chainDepth
        #expect(depth > 0, "aucune lecture comptée dans une chaîne")
        #expect(depth <= 12, "chargement Mac en \(depth) × L")
        // Au plus deux lectures pour ce que deux suites lisent (poste, Jira, demandes, vigie), une pour le reste.
        let twice = ["/v1/workstation", "/v1/atlassian", "/v1/intake?", "/v1/vigie"]
        for (path, count) in transport.gets(after: 0) {
            #expect(count <= (twice.contains { path.hasPrefix($0) } ? 2 : 1), "\(path) lu \(count) fois")
        }
        // Les attentes d'`expectShellFilled`, sauf les propositions : le Mac ne lit pas `/v1/proposals` ici.
        #expect(model.inbox != nil)
        #expect(model.history.runs.count == 1)
        #expect(model.workstation.availability == .available && model.workstation.status != nil)
        #expect(model.vigie.availability == .available && model.vigie.view != nil)
        #expect(model.intakes.availability == .available)
        #expect(model.atlassian.availability == .available && model.atlassian.status != nil && model.atlassian.plan != nil)
        #expect(model.localSessions.availability == .available)
        #expect(model.spaces.availability == .available && model.spaces.spaces.count == 1)
        #expect(model.repos.count == 1)
        #expect(model.client?.role == "admin")
    }

    @Test("lenteurs-et-timeouts-du-chargement-sur-i/AC-14 : inactif puis actif sans arrière-plan ne relit rien et ne coupe aucun flux")
    func inactiveIsNotAReturn() async {
        let transport = LatencyHarnessTransport(latency: latency, shellRoutes())
        let model = makeModel(transport)
        let pulse = OSPulse(harness: model)
        await openApp(model, pulse: pulse)
        model.startLive()
        #expect(await eventually(timeout: 5) { model.isLive && pulse.isLive })
        defer {
            pulse.stop()
            model.stopLive()
        }

        let lifecycle = HarnessAppLifecycle()
        let mark = transport.mark()
        let streams = transport.openStreams
        let opened = transport.openedPaths
        #expect(lifecycle.phaseChanged(to: .inactive, harness: model) == nil)
        pulse.phaseChanged(to: .inactive)
        #expect(lifecycle.phaseChanged(to: .active, harness: model) == nil)
        pulse.phaseChanged(to: .active)
        // Un lancement à froid (`.active` sans arrière-plan préalable) ne relit rien non plus.
        #expect(HarnessAppLifecycle().phaseChanged(to: .active, harness: model) == nil)
        try? await Task.sleep(for: latency * 2)

        #expect(transport.mark() == mark, "aucun appel depuis la marque")
        #expect(transport.openStreams == streams)
        #expect(transport.openedPaths == opened, "aucun flux rouvert")
        #expect(model.isLive && pulse.isLive)
    }
}
