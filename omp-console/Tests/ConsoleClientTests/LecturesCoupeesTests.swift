// Une lecture du serveur de pipelines coupée par le passage de l'app en arrière-plan, ou partie pendant
// l'arrière-plan, attend le retour puis est refaite UNE fois, sans bandeau ; une lecture annulée (écran
// quitté, actualisation relancée) ne touche pas le bandeau d'avant. Sur la doublure à latence fixe : elle
// est annulable (`Task.sleep`), comme une tâche URLSession annulée par `suspendStreams`.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private let readLatency = Duration.milliseconds(300)

/// Un modèle relié sans `configure` : l'adresse et le jeton sont déjà enregistrés, `load()` relie.
@MainActor
private func lecturesModel(_ transport: LatencyHarnessTransport) -> HarnessModel {
    HarnessModel(
        transport: transport,
        preferences: InMemoryClientPreferences([HarnessModel.addressKey: "https://vps.example"]),
        tokens: InMemoryTokenStore([HarnessModel.tokenAccount: "t"]),
        retryDelay: .seconds(3600), refreshDelay: .milliseconds(10), reporter: .off
    )
}

/// La lecture est-elle finie ? Un drapeau lu par le test, posé par la tâche lancée.
@MainActor
private final class Finished {
    var value = false
}

/// `/v1/status` rend deux dépôts : la relecture publiée se distingue de la première lecture.
private let twoReposStatus = #"{"runs":{"merged":2},"live":[],"scheduler":{},"repos":[{"name":"demo","scope":"src"},{"name":"autre","scope":null}],"oracle":{"configured":false,"ok":false}}"#

private let providersJSON = #"""
{"providers":[
  {"name":"openai","kind":"openai","source":"api","baseUrl":null,"api":null,"models":[],"capacity":null,"refillPerMinute":null,
   "keyVariable":"OPENAI_API_KEY","hasKey":true,"keyHint":"9f3c","updatedBy":"admin"}],
 "models":{"fast":[],"standard":[],"heavy":[]},
 "modelsSource":"api","kinds":["anthropic","openai"],"apis":["openai-completions"]}
"""#

/// Les préfixes des 13 lectures de la coque (`failing` ne sait dire que des chemins entiers, et ceux de l'intake et du brief portent une requête).
private let shellReadPrefixes = [
    "/v1/inbox", "/v1/status", "/v1/workstation", "/v1/vigie", "/v1/intake", "/v1/atlassian", "/v1/local-sessions",
    "/v1/spaces", "/v1/proposals", "/v1/pause", "/v1/brief", "/v1/rules", "/v1/autonomy",
]

/// Les 13 lectures de la coque ont toutes posé l'échec « panne » (celui du serveur, 500).
@MainActor
private func expectAllRejected(_ model: HarnessModel) {
    let panne = HarnessFailure.rejected("panne")
    #expect(model.failure == panne)
    #expect(model.workstation.failure == panne)
    #expect(model.vigie.failure == panne)
    #expect(model.intakes.failure == panne)
    #expect(model.atlassian.failure == panne)
    #expect(model.localSessions.failure == panne)
    #expect(model.spaces.failure == panne)
    #expect(model.proposals.failure == panne)
    #expect(model.pause.failure == panne)
    #expect(model.brief.failure == panne)
    #expect(model.rules.failure == panne)
    #expect(model.autonomy.failure == panne)
}

@Suite("Lectures coupées par l'arrière-plan", .serialized)
@MainActor
struct LecturesCoupeesTests {
    @Test("delais-depasses-sur-ios-cause-prouvee-le/AC-3 : la lecture coupée, catalogue compris, est relue une fois au retour et publiée, les données d'avant restent")
    func cutReadsAreReadOnceOnReturn() async {
        let transport = LatencyHarnessTransport(latency: readLatency, shellRoutes())
        let model = lecturesModel(transport)
        let lifecycle = HarnessAppLifecycle()
        await openApp(model)
        defer { model.stopLive() }
        transport.respond { call in call.path == "/v1/status" ? osJSON(twoReposStatus) : shellRoutes()(call) }

        // Le catalogue (hors du lot du retour) et l'historique (dans le lot) sont en vol quand l'app part.
        let mark = transport.mark()
        let catalog = Task { await model.refreshCatalog() }
        let history = Task { await model.history.refresh() }
        try? await Task.sleep(for: .milliseconds(100))
        lifecycle.phaseChanged(to: .background, harness: model)
        lifecycle.phaseChanged(to: .inactive, harness: model)
        let back = lifecycle.phaseChanged(to: .active, harness: model)

        try? await Task.sleep(for: .milliseconds(150))
        #expect(model.repos.count == 1, "les données d'avant restent visibles pendant la relecture")
        await back?.value
        await catalog.value
        await history.value

        #expect(model.failure == nil)
        #expect(model.repos.count == 2, "la relecture est publiée")
        let cut: Set = ["/v1/status", "/v1/projects", "/v1/audits", "/v1/stats", "/v1/runs"]
        let counts = transport.gets(after: mark)
        for path in cut { #expect(counts[path] == 2, "\(path) coupée, puis refaite une fois") }
        for (path, count) in counts where !cut.contains(path) { #expect(count <= 1, "\(path) lu \(count) fois") }
    }

    @Test("delais-depasses-sur-ios-cause-prouvee-le/AC-3 : la lecture coupée attend le retour")
    func cutReadWaitsForReturn() async {
        let transport = LatencyHarnessTransport(latency: readLatency, shellRoutes())
        let model = lecturesModel(transport)
        let lifecycle = HarnessAppLifecycle()
        await openApp(model)
        defer { model.stopLive() }

        let mark = transport.mark()
        let finished = Finished()
        let catalog = Task {
            await model.refreshCatalog()
            finished.value = true
        }
        try? await Task.sleep(for: .milliseconds(100))
        lifecycle.phaseChanged(to: .background, harness: model)
        try? await Task.sleep(for: .milliseconds(600))
        #expect(!finished.value, "la lecture coupée n'est pas relancée pendant l'arrière-plan")
        #expect(transport.gets(after: mark)["/v1/status"] == 1)

        let back = lifecycle.phaseChanged(to: .active, harness: model)
        await catalog.value
        await back?.value
        #expect(finished.value)
        #expect(transport.gets(after: mark)["/v1/status"] == 2)
    }

    @Test("delais-depasses-sur-ios-cause-prouvee-le/AC-3 : une lecture partie pendant l'arrière-plan attend le retour")
    func readStartedInBackgroundWaitsForReturn() async {
        let transport = LatencyHarnessTransport(latency: readLatency, shellRoutes())
        let model = lecturesModel(transport)
        let lifecycle = HarnessAppLifecycle()
        await openApp(model)
        defer { model.stopLive() }

        let mark = transport.mark()
        lifecycle.phaseChanged(to: .background, harness: model)
        let finished = Finished()
        let catalog = Task {
            await model.refreshCatalog()
            finished.value = true
        }
        try? await Task.sleep(for: .milliseconds(600))
        #expect(!finished.value)
        #expect(transport.gets(after: mark)["/v1/status", default: 0] == 0, "aucun appel de transport avant le retour")

        let back = lifecycle.phaseChanged(to: .active, harness: model)
        await catalog.value
        await back?.value
        #expect(transport.gets(after: mark)["/v1/status"] == 1)
        #expect(model.failure == nil)
    }

    @Test("delais-depasses-sur-ios-cause-prouvee-le/AC-3 : une réponse à une notification lit pendant l'arrière-plan", .timeLimit(.minutes(1)))
    func notificationAnswerReadsInBackground() async {
        let transport = LatencyHarnessTransport(latency: readLatency, shellRoutes())
        let model = lecturesModel(transport)
        let lifecycle = HarnessAppLifecycle()
        await openApp(model)
        defer { model.stopLive() }

        let mark = transport.mark()
        lifecycle.phaseChanged(to: .background, harness: model)
        await HarnessModel.$answeringNotification.withValue(true) { await model.refreshInbox() }
        #expect(transport.gets(after: mark)["/v1/inbox"] == 1)
    }

    @Test("delais-depasses-sur-ios-cause-prouvee-le/AC-10 : une lecture de la coque annulée garde le bandeau d'avant et les données")
    func cancelledShellReadsKeepBannerAndData() async {
        let transport = LatencyHarnessTransport(latency: readLatency, shellRoutes())
        let model = lecturesModel(transport)
        await openApp(model)
        defer { model.stopLive() }

        // Chacune des 13 lectures pose d'abord l'échec « panne ».
        transport.respond { call in
            shellReadPrefixes.contains { call.path.hasPrefix($0) } ? osJSON(#"{"error":"panne"}"#, status: 500) : shellRoutes()(call)
        }
        await model.readShell(.refreshing)
        await model.refresh()
        await model.refreshCatalog()
        expectAllRejected(model)

        let inbox = model.inbox
        let status = model.workstation.status
        let repos = model.repos.count
        let spaces = model.spaces.spaces.count
        let runs = model.history.runs.count

        // Le serveur répond de nouveau ; la lecture est annulée en vol : aucune réponse ne la guérit ni ne l'efface.
        transport.respond(shellRoutes())
        let reading = Task {
            await model.readShell(.refreshing)
            await model.refresh()
            await model.refreshCatalog()
        }
        try? await Task.sleep(for: .milliseconds(100))
        reading.cancel()
        await reading.value

        expectAllRejected(model)
        #expect(model.inbox == inbox)
        #expect(model.workstation.status == status)
        #expect(model.repos.count == repos)
        #expect(model.spaces.spaces.count == spaces)
        #expect(model.history.runs.count == runs)
    }

    @Test("delais-depasses-sur-ios-cause-prouvee-le/AC-10 : une lecture coupée dont l'écran est quitté pendant l'arrière-plan n'est ni annoncée ni relue")
    func cutReadOfLeftScreenIsNotReread() async {
        let transport = LatencyHarnessTransport(latency: readLatency, shellRoutes())
        let model = lecturesModel(transport)
        let lifecycle = HarnessAppLifecycle()
        await openApp(model)
        defer { model.stopLive() }

        let mark = transport.mark()
        let catalog = Task { await model.refreshCatalog() }
        try? await Task.sleep(for: .milliseconds(100))
        lifecycle.phaseChanged(to: .background, harness: model)
        catalog.cancel()
        await catalog.value
        #expect(model.failure == nil)

        let back = lifecycle.phaseChanged(to: .active, harness: model)
        await back?.value
        #expect(model.failure == nil)
        #expect(transport.gets(after: mark)["/v1/status"] == 1, "le retour ne relit pas la lecture d'un écran quitté")
    }

    @Test("delais-depasses-sur-ios-cause-prouvee-le/AC-10 : une lecture annulée garde le bandeau partagé que d'autres écrans ont posé")
    func cancelledRunViewAndProvidersKeepSharedBanner() async {
        let transport = LatencyHarnessTransport(latency: readLatency, shellRoutes())
        let model = lecturesModel(transport)
        await model.load()
        defer { model.stopLive() }

        transport.failing = ["/v1/runs/r1"]
        _ = await model.runView("r1")
        #expect(model.failure == .rejected("panne"))

        // « Comprendre » puis Fournisseurs lisent, puis l'écran est quitté en cours de lecture.
        transport.failing = []
        transport.respond { call in
            switch call.path {
            case "/v1/runs/r1": osJSON(#"{"run":"# + osRunJSON("r1") + #","artifacts":[]}"#)
            case "/v1/providers": osJSON(providersJSON)
            default: shellRoutes()(call)
            }
        }
        let reading = Task {
            _ = await model.runView("r1")
            await model.refreshProviders()
        }
        try? await Task.sleep(for: .milliseconds(100))
        reading.cancel()
        await reading.value
        #expect(model.failure == .rejected("panne"))
    }
}
