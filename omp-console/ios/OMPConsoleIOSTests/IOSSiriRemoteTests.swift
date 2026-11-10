// Les preuves Swift de la télécommande par Siri, Raccourcis et le bouton Action : ce
// que répondent « Demander à l'OS », « Tout suspendre », « Reprendre » et « Décisions
// en attente », et ce qu'ils envoient au serveur — sur une doublure de transport, sans
// Mac. La confirmation de « Tout suspendre » est le dialogue du système : seule la
// table qui décide d'agir ou non est éprouvée ici.

import AppIntents
import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsoleIOS

/// Un faux serveur : il répond par `routes` (« MÉTHODE chemin »), sert une boîte vide, rend
/// 404 « route inconnue » pour le reste, et retient les appels partis.
private final class ScriptedTransport: HarnessTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [HarnessCall] = []
    private let routes: [String: HarnessReply]

    init(_ routes: [String: HarnessReply] = [:]) {
        self.routes = routes
    }

    var calls: [HarnessCall] { lock.withLock { recorded } }

    func body(_ method: String, _ path: String) -> [String: Any]? {
        guard let data = calls.last(where: { $0.method == method && $0.path == path })?.body else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    func send(_ call: HarnessCall, server: HarnessServer) async throws -> HarnessReply {
        lock.withLock { recorded.append(call) }
        if let reply = routes["\(call.method) \(call.path)"] { return reply }
        if call.method == "GET", call.path == "/v1/inbox" { return json(#"{"batches":[],"awaiting":[],"decisions":[],"runs":[],"cursor":1}"#) }
        return json(#"{"error":"route inconnue"}"#, status: 404)
    }

    func events(_ call: HarnessCall, server: HarnessServer) async throws -> AsyncThrowingStream<Data, Error> {
        throw URLError(.cannotConnectToHost)
    }
}

private func json(_ text: String, status: Int = 200) -> HarnessReply { HarnessReply(status: status, body: Data(text.utf8)) }

/// Un modèle relié au faux serveur (par le serveur de la machine : rien d'enregistré).
/// L'adresse est normalisée par le client : aucune n'est écrite en dur dans la coque iOS.
@MainActor
private func linked(_ transport: ScriptedTransport) -> HarnessModel {
    HarnessModel(
        transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(),
        fallback: { (HarnessModel.normalizedAddress("vps.example") ?? "", "t") }, reporter: .off
    )
}

@MainActor
private func unlinked() -> HarnessModel {
    HarnessModel(transport: ScriptedTransport(), preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(), reporter: .off)
}

private func run(_ id: String, _ title: String, state: String = "awaiting_human", step: String = "review") -> HarnessRun {
    HarnessRun(id: id, repo: "demo", slug: id, title: title, request: title, state: state, step: step)
}

private func question(_ id: Int, _ runId: String) -> HarnessEscalation {
    HarnessEscalation(id: id, runId: runId, category: "reversible", question: "Laquelle ?", options: ["a", "b"], recommended: "a")
}

private let intakeReply = #"{"intake":{"id":"i9","text":"corrige le bandeau","source":"voice","repo":null,"requestedRepo":null,"state":"classifying","kind":null,"plan":null,"question":null,"answer":null,"exchanges":[],"statement":"corrige le bandeau","created":null,"reason":null,"by":"iphone","createdAt":1,"updatedAt":2}}"#

private func pauseReply(_ paused: Bool) -> String {
    #"{"pause":{"paused":"# + (paused ? "true" : "false") + #","by":"# + (paused ? #""iphone""# : "null") + #","at":null,"reason":null,"now":false}}"#
}

@Suite("télécommande iOS — Siri, Raccourcis, bouton Action")
@MainActor
struct IOSSiriRemoteTests {
    @Test("« Demander à l'OS » pose la demande dictée au serveur relié, de source vocale, et le confirme")
    func askSubmitsTheRequest() async throws {
        let transport = ScriptedTransport(["POST /v1/intake": json(intakeReply, status: 201)])
        let answer = await IOSSiriRemote.ask("  corrige le bandeau  ", on: linked(transport))
        #expect(answer == "Demande transmise à l’OS")
        let body = try #require(transport.body("POST", "/v1/intake"))
        #expect(body["text"] as? String == "corrige le bandeau")
        #expect(body["source"] as? String == "voice")
        #expect(body["context"] == nil)
    }

    @Test("« Demander à l'OS » dit pourquoi rien n'est parti : aucun serveur, demande vide, serveur antérieur, refus")
    func askSaysWhyNothingLeft() async {
        #expect(await IOSSiriRemote.ask("corrige le bandeau", on: unlinked()) == IOSSiriText.unconfigured)

        let silent = ScriptedTransport()
        #expect(await IOSSiriRemote.ask(" \n", on: linked(silent)) == "Dites ce que vous voulez demander")
        #expect(!silent.calls.contains { $0.path == "/v1/intake" }, "une demande vide ne part pas")

        #expect(await IOSSiriRemote.ask("corrige", on: linked(ScriptedTransport())) == IntakeText.unsupported)
        let refused = ScriptedTransport(["POST /v1/intake": json(#"{"error":"lecture seule"}"#, status: 403)])
        #expect(await IOSSiriRemote.ask("corrige", on: linked(refused)) == HarnessFailure.forbidden("lecture seule").message)
    }

    @Test("l'intent « Demander à l'OS » s'exécute avec le serveur de l'app et répond par un dialogue")
    func askIntentRuns() async throws {
        let manager = AppDependencyManager()
        let transport = ScriptedTransport(["POST /v1/intake": json(intakeReply, status: 201)])
        _ = IOSSharedServer.install(linked(transport), in: manager)
        let _: Void = try await IOSAskIntent(request: "corrige le bandeau", dependencies: manager)(donate: false)
        #expect(transport.body("POST", "/v1/intake")?["text"] as? String == "corrige le bandeau")
    }

    @Test("la pause : sans serveur, sans la fonction, sans droit ou déjà faite, l'intent le dit sans agir ; sinon il agit")
    func pauseTable() {
        func state(configured: Bool = true, _ availability: HarnessFeatureAvailability, paused: Bool = false, failure: HarnessFailure? = nil) -> IOSSiriPause {
            IOSSiriPause(isConfigured: configured, availability: availability, isPaused: paused, failure: failure)
        }
        #expect(state(configured: false, .unknown).answer(wanted: true) == .unconfigured)
        #expect(state(.absent).answer(wanted: true) == .absent)
        #expect(state(.forbidden("réservé au propriétaire")).answer(wanted: true) == .failed(HarnessFailure.forbidden("réservé au propriétaire").message))
        #expect(state(.unknown, failure: .timedOut).answer(wanted: true) == .failed(HarnessFailure.timedOut.message))
        #expect(state(.unknown).answer(wanted: false) == .failed(HarnessFailure.unreachable.message))
        #expect(state(.available, paused: true).answer(wanted: true) == .already(paused: true))
        #expect(state(.available, paused: false).answer(wanted: false) == .already(paused: false))
        #expect(state(.available, paused: false).answer(wanted: true) == .proceed)
        #expect(state(.available, paused: true).answer(wanted: false) == .proceed)

        #expect(IOSSiriPause.Answer.proceed.phrase == nil, "agir ne dit rien avant d'avoir agi")
        #expect(IOSSiriPause.Answer.absent.phrase == "Ce serveur ne propose pas la pause")
        #expect(IOSSiriPause.Answer.already(paused: true).phrase == "Tout est déjà suspendu")
        #expect(IOSSiriPause.Answer.already(paused: false).phrase == "Rien n’est suspendu")
        #expect(IOSSiriPause.Answer.unconfigured.phrase == IOSSiriText.unconfigured)
    }

    @Test("« Tout suspendre » et « Reprendre » lisent la pause du serveur, la posent ou la lèvent, et disent le résultat")
    func pauseIsReadThenSet() async throws {
        let transport = ScriptedTransport(["GET /v1/pause": json(pauseReply(false)), "POST /v1/pause": json(pauseReply(true))])
        let server = linked(transport)
        #expect(await IOSSiriPause.read(server).answer(wanted: true) == .proceed)
        #expect(await IOSSiriPause.read(server).answer(wanted: false) == .already(paused: false))
        #expect(await IOSSiriPause.set(true, on: server) == "Tout est suspendu")
        let body = try #require(transport.body("POST", "/v1/pause"))
        #expect(body["paused"] as? Bool == true)
        #expect(body["now"] == nil, "suspendre par la voix laisse finir l'étape en cours")

        let resuming = ScriptedTransport(["GET /v1/pause": json(pauseReply(true)), "POST /v1/pause": json(pauseReply(false))])
        let paused = linked(resuming)
        #expect(await IOSSiriPause.read(paused).answer(wanted: false) == .proceed)
        #expect(await IOSSiriPause.set(false, on: paused) == "Le travail reprend")

        // Un serveur antérieur à la pause, puis un jeton qui n'y a pas droit.
        #expect(await IOSSiriPause.read(linked(ScriptedTransport())).answer(wanted: true) == .absent)
        let bounded = ScriptedTransport(["GET /v1/pause": json(pauseReply(false)), "POST /v1/pause": json(#"{"error":"réservé au propriétaire"}"#, status: 403)])
        let refused = linked(bounded)
        #expect(await IOSSiriPause.read(refused).answer(wanted: true) == .proceed)
        #expect(await IOSSiriPause.set(true, on: refused) == HarnessFailure.forbidden("réservé au propriétaire").message)
    }

    @Test("« Décisions en attente » dit le compte et les premières décisions, titres nettoyés ; au-delà de trois, le reste est compté")
    func decisionsPhrase() {
        #expect(IOSSiriDecisions.phrase([]) == "Rien ne vous attend")
        let one = OSDecision.questions(HarnessEscalationBatch(run: run("r1", "Export CSV", state: "escalated"), items: [question(1, "r1")]))
        #expect(IOSSiriDecisions.phrase([one]) == "1 décision vous attend : une question sur « Export CSV »")
        let two = OSDecision.questions(HarnessEscalationBatch(run: run("r2", "Suite de « Panier »", state: "escalated"), items: [question(2, "r2"), question(3, "r2")]))
        let all: [OSDecision] = [two, .specs(run("r3", "Thème sombre", step: "specs")), .verdict(run("r4", "Recherche")), .verdict(run("r5", "Cache")), one]
        #expect(IOSSiriDecisions.phrase(all) == "5 décisions vous attendent : 2 questions sur « Panier », les specs de « Thème sombre », la revue de « Recherche », et 2 autres")
        #expect(IOSSiriDecisions.phrase(Array(all.prefix(4))).hasSuffix("et 1 autre"))
    }

    @Test("« Décisions en attente » lit la boîte du serveur relié, ou dit qu'il n'y en a pas, sans rien écrire")
    func decisionsAreReadFromTheServer() async throws {
        let inbox = #"{"cursor":1,"batches":[],"decisions":[],"runs":[],"awaiting":[{"id":"r1","repo":"demo","slug":"r1","title":"Export CSV","request":"x","state":"awaiting_human","step":"review","fixes":0,"modules":[],"createdAt":1,"updatedAt":2}]}"#
        let transport = ScriptedTransport(["GET /v1/inbox": json(inbox)])
        #expect(await IOSSiriDecisions.answer(for: linked(transport)) == "1 décision vous attend : la revue de « Export CSV »")
        #expect(transport.calls.allSatisfy { $0.method == "GET" }, "une lecture : rien n'est écrit")
        #expect(await IOSSiriDecisions.answer(for: unlinked()) == IOSSiriText.unconfigured)
        #expect(await IOSSiriDecisions.answer(for: linked(ScriptedTransport(["GET /v1/inbox": json("{}", status: 500)]))) == IOSSiriText.unreachable)

        let manager = AppDependencyManager()
        _ = IOSSharedServer.install(linked(transport), in: manager)
        let _: Void = try await IOSPendingDecisionsIntent(dependencies: manager)(donate: false)
    }
}
