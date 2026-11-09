// Le pont corpo ↔ usine côté client (routes `/v1/signals*` et `GET /v1/runs/{id}/origin`
// d'omp-harness) : propositions comptées au badge d'« À traiter », rien pour un jeton qui
// n'est pas celui du propriétaire, aperçu puis confirmation vers le dépôt choisi, refus
// d'approbateur rendu au geste, origine d'une feature — sur la doublure de transport.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private func reply(_ json: String, status: Int = 200) -> HarnessReply { HarnessReply(status: status, body: Data(json.utf8)) }

/// Une proposition telle que le serveur l'écrit (champs internes absents, clé inconnue).
private let proposalJSON = #"""
{"id":"sg1","createdAt":1762600000000,"updatedAt":1762600001000,"channel":"slack","threadRef":"slack:C1/1762.1",
 "url":"https://exemple.slack.com/archives/C1/p1762","personRef":"paul@exemple.fr","excerpt":"Le bouton Exporter plante depuis hier.",
 "state":"proposed","reason":null,"error":null,"repo":"demo","kind":"bug","title":"Exporter plante","body":"Le bouton Exporter échoue.",
 "issue":null,"runId":null,"confirmedBy":null,"confirmedAt":null,"inconnu":1}
"""#

private let listJSON = #"{"signals":["# + proposalJSON + #"]}"#

private let previewJSON = #"""
{"repo":"demo","policy":{"declared":"redacted","applied":"redacted","note":null},"title":"Exporter plante","body":"Le bouton Exporter échoue.","issue":null}
"""#

private let confirmedJSON = #"""
{"signal":{"id":"sg1","createdAt":1,"updatedAt":2,"channel":"slack","threadRef":"t","url":"","personRef":null,"excerpt":"e","state":"confirmed",
  "reason":null,"error":null,"repo":"autre","kind":"bug","title":"T","body":"B","issue":{"repo":"autre","number":12,"url":"https://github.com/moi/autre/issues/12"},
  "runId":"r9","confirmedBy":"app-approbateur","confirmedAt":3},
 "issue":{"repo":"autre","number":12,"url":"https://github.com/moi/autre/issues/12"},"run":{"id":"r9"},
 "policy":{"declared":"redacted","applied":"redacted","note":null}}
"""#

private let originJSON = #"""
{"origin":{"signalId":"sg1","channel":"gmail","threadRef":"gmail:abc","url":"https://mail.google.com/mail/u/0/#inbox/abc","personRef":"paul@exemple.fr",
 "excerpt":"Le bouton Exporter plante.","issue":{"repo":"demo","number":12,"url":"https://github.com/moi/demo/issues/12"},
 "confirmedBy":"app-approbateur","confirmedAt":1762600000000}}
"""#

private let ownerOnly = reply(#"{"error":"le poste est réservé au propriétaire"}"#, status: 403)
private let approverOnly = reply(#"{"error":"seul l'appareil approbateur (OMP Console appairée avec le code de `harness.sh approver`) peut approuver, refuser ou régler le poste"}"#, status: 403)

/// Un serveur qui sert la boîte et les signalements ; `overrides` remplace une réponse par « MÉTHODE chemin ».
private func signalServer(_ overrides: [String: HarnessReply] = [:]) -> @Sendable (HarnessCall) -> HarnessReply {
    { call in
        if let forced = overrides["\(call.method) \(call.path)"] { return forced }
        switch (call.method, call.path) {
        case ("GET", "/v1/inbox"): return reply(#"{"batches":[],"awaiting":[],"decisions":[],"runs":[],"cursor":1}"#)
        case ("GET", "/v1/signals?state=proposed&limit=200"): return reply(listJSON)
        case ("POST", "/v1/signals/sg1/preview"): return reply(previewJSON)
        case ("POST", "/v1/signals/sg1/confirm"): return reply(confirmedJSON, status: 201)
        case ("POST", "/v1/signals/sg1/dismiss"): return reply(#"{"signal":"# + proposalJSON.replacingOccurrences(of: "\"proposed\"", with: "\"dismissed\"") + "}")
        case ("GET", "/v1/runs/r1/origin"): return reply(originJSON)
        case ("GET", "/v1/runs/r2/origin"): return reply(#"{"origin":null}"#)
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

@Suite("Pont corpo ↔ usine — client")
@MainActor
struct CorporateSignalsTests {
    @Test("pont-corpo-console/AC-1 : une proposition apparaît dans À traiter, comptée au badge ; un jeton restreint ou un serveur antérieur n'affiche rien, sans échec")
    func proposalsAreListedAndCounted() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(signalServer())
        let server = await connected(transport)
        let signals = server.signals
        #expect(signals.pendingCount == 0 && signals.availability == .unknown)

        await signals.refresh()
        #expect(signals.availability == .available)
        let proposal = try #require(signals.proposals.first)
        #expect(proposal.id == "sg1" && proposal.repo == "demo" && proposal.personRef == "paul@exemple.fr")
        #expect(signals.pendingCount == 1)
        #expect(SignalText.proposal(repo: proposal.repo).contains("demo"))
        #expect(SignalText.channel("slack") == "Slack" && SignalText.channel("teams") == "teams", "un canal inconnu se rend tel quel")

        // Un événement `signal` du flux fait relire la liste.
        let before = transport.calls.filter { $0.path.hasPrefix("/v1/signals") }.count
        signals.receive(["signal"])
        try await Task.sleep(for: .milliseconds(100))
        #expect(transport.calls.filter { $0.path.hasPrefix("/v1/signals") }.count == before + 1)

        // Un client restreint : 403 propriétaire, rien n'est montré et aucun échec n'est levé.
        transport.respond(signalServer(["GET /v1/signals?state=proposed&limit=200": ownerOnly]))
        await signals.refresh()
        #expect(signals.availability == .reserved && signals.proposals.isEmpty && signals.pendingCount == 0)
        #expect(signals.failure == nil && server.failure == nil)

        // Un serveur antérieur au pont : la route n'existe pas.
        transport.respond(signalServer(["GET /v1/signals?state=proposed&limit=200": reply(#"{"error":"route inconnue"}"#, status: 404)]))
        await signals.refresh()
        #expect(signals.availability == .absent && signals.pendingCount == 0 && signals.failure == nil)
    }

    @Test("pont-corpo-console/AC-2 : la feuille lit l'aperçu exact, puis confirme vers le dépôt choisi ; un refus d'approbateur revient au geste, la proposition reste")
    func confirmsToTheChosenRepo() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(signalServer())
        let server = await connected(transport)
        let signals = server.signals
        await signals.refresh()
        let proposal = try #require(signals.proposals.first)

        // Le texte de départ : l'aperçu de la proposition, sans titre ni corps envoyés.
        let start = try await signals.preview(proposal, repo: "demo", title: nil, body: nil)
        #expect(start.title == "Exporter plante" && start.policy.applied == "redacted" && start.issue == nil)
        let first = try body(transport.calls.last { $0.path == "/v1/signals/sg1/preview" })
        #expect(first["repo"] as? String == "demo" && first["title"] == nil && first["body"] == nil)
        // Après modification : le texte modifié repart pour être relu.
        _ = try await signals.preview(proposal, repo: "autre", title: "Titre modifié", body: "Corps modifié")
        let edited = try body(transport.calls.last { $0.path == "/v1/signals/sg1/preview" })
        #expect(edited["repo"] as? String == "autre" && edited["title"] as? String == "Titre modifié" && edited["body"] as? String == "Corps modifié")

        // Un jeton ordinaire : le serveur refuse, l'échec est celui de l'approbateur, rien ne bouge.
        transport.respond(signalServer(["POST /v1/signals/sg1/confirm": approverOnly]))
        await #expect(throws: HarnessFailure.approverOnly) {
            _ = try await signals.confirm(proposal, repo: "autre", title: "T", body: "B")
        }
        #expect(signals.proposals.map(\.id) == ["sg1"] && signals.busy.isEmpty)
        #expect(server.failure == nil, "aucun bandeau global")
        #expect(!SignalText.approverOnly.isEmpty)

        // L'appareil approbateur confirme vers le dépôt choisi.
        transport.respond(signalServer())
        let done = try await signals.confirm(proposal, repo: "autre", title: "T", body: "B")
        let sent = try body(transport.calls.last { $0.path == "/v1/signals/sg1/confirm" })
        #expect(sent["repo"] as? String == "autre" && sent["title"] as? String == "T" && sent["body"] as? String == "B")
        #expect(done.issue.repo == "autre" && done.issue.number == 12 && done.signal.runId == "r9")

        // Écarter : la raison facultative part, nettoyée ; vide, elle est absente.
        try await signals.dismiss(proposal, reason: "  doublon  ")
        let dismissed = try body(transport.calls.last { $0.path == "/v1/signals/sg1/dismiss" })
        #expect(dismissed["reason"] as? String == "doublon")
        try await signals.dismiss(proposal)
        #expect(try body(transport.calls.last { $0.path == "/v1/signals/sg1/dismiss" }).isEmpty)
    }

    @Test("pont-corpo-console/AC-3 : la page d'une feature lit son origine (canal, personne, lien, extrait) ; rien sans origine ni pour un jeton restreint")
    func readsTheOriginOfARun() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(signalServer())
        let server = await connected(transport)
        let signals = server.signals

        await signals.loadOrigin(runId: "r1")
        let origin = try #require(signals.origins["r1"])
        #expect(origin.channel == "gmail" && origin.personRef == "paul@exemple.fr")
        #expect(origin.url.hasPrefix("https://mail.google.com") && origin.excerpt == "Le bouton Exporter plante.")
        #expect(origin.issue.number == 12 && origin.confirmedBy == "app-approbateur")
        #expect(SignalText.channel(origin.channel) == "Gmail")

        await signals.loadOrigin(runId: "r2")
        #expect(signals.origins["r2"] == nil, "un run sans origine : rien de plus")

        transport.respond(signalServer(["GET /v1/runs/r1/origin": ownerOnly]))
        await signals.loadOrigin(runId: "r1")
        #expect(signals.origins["r1"] == nil && signals.failure == nil && server.failure == nil)

        // Un jeton déjà reconnu restreint ne demande plus l'origine.
        transport.respond(signalServer(["GET /v1/signals?state=proposed&limit=200": ownerOnly]))
        await signals.refresh()
        let asked = transport.calls.filter { $0.path.hasSuffix("/origin") }.count
        await signals.loadOrigin(runId: "r1")
        #expect(transport.calls.filter { $0.path.hasSuffix("/origin") }.count == asked)
    }
}
