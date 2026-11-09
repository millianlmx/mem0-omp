// La veille du poste côté client (routes `/v1/workstation/watch*` d'omp-harness) : « À
// traiter » lit les réponses proposées, validées en attente d'envoi et non envoyées avec
// leurs nouveaux champs ; écarter et valider partent avec leurs corps exacts et l'If-Match
// de la révision lue ; un refus (412, 409, 403) revient au geste et la liste est relue ;
// l'action « Valider » d'une notification part sans corps ni If-Match — sur la doublure
// de transport. Aucune donnée réelle : sujets, textes et identifiants sont inventés.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private func reply(_ json: String, status: Int = 200) -> HarnessReply { HarnessReply(status: status, body: Data(json.utf8)) }

private let listPath = "/v1/workstation/watch?state=open,validated,failed&limit=200"

private let openJSON = #"{"kind":"reply","id":"wv1","state":"open","ready":true,"channel":"gmail","topic":"devis","subject":"Re: devis","text":"Bonjour,\nc’est noté.","draft":{"kind":"gmail","id":"d1","error":null},"rev":3,"createdAt":1762600000000,"requestId":null,"validatedAt":null,"sendError":null,"request":null}"#
private let validatedJSON = #"{"kind":"followup","id":"wv2","state":"validated","ready":false,"channel":"slack","topic":null,"subject":null,"text":"Une relance.","draft":{"kind":"slack"},"rev":5,"createdAt":1762600000500,"requestId":"wr1","validatedAt":1762600001000,"sendError":null,"request":{"id":"wr1","state":"queued","reason":"extension hors ligne"}}"#
private let failedJSON = #"{"kind":"reply","id":"wv3","state":"failed","ready":false,"channel":"gmail","topic":null,"subject":"Re: point","text":"Merci.","draft":null,"rev":7,"createdAt":1762600000200,"requestId":"wr0","validatedAt":1762600000300,"sendError":"les destinataires ont changé","request":{"id":"wr0","state":"failed","reason":null}}"#
private let sentJSON = #"{"kind":"reply","id":"wv4","state":"sent","ready":true,"channel":"gmail","text":"Envoyée.","rev":9,"createdAt":1762600000100}"#
private let itemReply = reply(#"{"item":\#(openJSON)}"#)
private let approverOnly = reply(#"{"error":"seul l'appareil approbateur (OMP Console appairée avec le code de `harness.sh approver`) peut approuver, refuser ou régler le poste"}"#, status: 403)

/// Un serveur qui sert la boîte et la veille ; `overrides` remplace une réponse par « MÉTHODE chemin ».
private func watchServer(approver: Bool = true, _ overrides: [String: HarnessReply] = [:]) -> @Sendable (HarnessCall) -> HarnessReply {
    { call in
        if let forced = overrides["\(call.method) \(call.path)"] { return forced }
        switch (call.method, call.path) {
        case ("GET", "/v1/inbox"): return reply(#"{"batches":[],"awaiting":[],"decisions":[],"runs":[],"cursor":1}"#)
        case ("GET", "/v1/me"): return reply(#"{"client":{"name":"app","role":"admin","repos":"*","createdAt":0,"approver":\#(approver)}}"#)
        case ("GET", listPath): return reply(#"{"items":[\#(openJSON),\#(validatedJSON),\#(failedJSON),\#(sentJSON)]}"#)
        case ("POST", "/v1/workstation/watch/wv1/dismiss"), ("POST", "/v1/workstation/watch/wv3/dismiss"): return itemReply
        case ("POST", "/v1/workstation/watch/wv1/validate"), ("POST", "/v1/workstation/watch/wv3/validate"):
            return reply(#"{"item":\#(openJSON),"request":{"id":"wr2","state":"queued"}}"#, status: 201)
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

@Suite("Veille du poste — validation des réponses")
@MainActor
struct WorkstationWatchTests {
    @Test("« À traiter » lit les réponses proposées, validées et non envoyées avec la demande rattachée ; le badge ne compte pas ce qui attend l'envoi")
    func readsOpenValidatedAndFailed() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(watchServer())
        let server = await connected(transport)
        let watch = server.watch
        await watch.refresh()
        #expect(watch.availability == .available && watch.failure == nil)
        #expect(transport.calls.contains { $0.method == "GET" && $0.path == listPath })
        #expect(watch.items.map(\.id) == ["wv1", "wv2", "wv3"], "une réponse envoyée n'est plus à traiter")
        let open = watch.items[0]
        #expect(open.isDecidable && open.requestId == nil && open.request == nil)
        #expect(open.text == "Bonjour,\nc’est noté.")
        let validated = watch.items[1]
        #expect(!validated.isDecidable)
        #expect(validated.requestId == "wr1" && validated.validatedAt == 1_762_600_001_000)
        #expect(validated.request == WorkstationWatchRequest(id: "wr1", state: "queued", reason: "extension hors ligne"))
        let failed = watch.items[2]
        #expect(failed.isDecidable, "un envoi non abouti se revalide")
        #expect(failed.sendError == "les destinataires ont changé")
        #expect(watch.pendingCount == 2)
        #expect(watch.isApprover)
    }

    @Test("valider part avec l'If-Match de la révision lue : corps {} pour le texte proposé, {text} modifié ; écarter part sans corps ; la liste est relue après chaque geste")
    func gestures() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(watchServer())
        let server = await connected(transport)
        let watch = server.watch
        await watch.refresh()
        let open = watch.items[0]
        let reads = { transport.calls.filter { $0.path == listPath }.count }
        let validate = { transport.calls.last { $0.path == "/v1/workstation/watch/wv1/validate" } }

        var before = reads()
        try await watch.validate(open, text: nil)
        #expect(validate()?.method == "POST")
        #expect(validate()?.headers["If-Match"] == "\"3\"")
        #expect(try body(validate()).isEmpty, "texte proposé tel quel : corps {}")
        #expect(reads() == before + 1)

        try await watch.validate(open, text: "  Bonjour,\nc’est noté.\n ")
        #expect(try body(validate()).isEmpty, "un texte inchangé (aux blancs près) part comme le proposé")

        try await watch.validate(open, text: " Bonjour, c’est noté, merci. ")
        #expect(try body(validate())["text"] as? String == "Bonjour, c’est noté, merci.")
        #expect(validate()?.headers["If-Match"] == "\"3\"")

        before = reads()
        try await watch.dismiss(watch.items[2])
        let dismissed = transport.calls.last { $0.path == "/v1/workstation/watch/wv3/dismiss" }
        #expect(dismissed?.method == "POST" && dismissed?.body == nil)
        #expect(reads() == before + 1)
        #expect(watch.busy.isEmpty)
    }

    @Test("un refus revient au geste et fait relire : 412 réponse changée, 409 motif du serveur, 403 appareil non approbateur")
    func refusals() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(watchServer(approver: false, [
            "POST /v1/workstation/watch/wv1/validate": reply(#"{"error":"périmé"}"#, status: 412),
            "POST /v1/workstation/watch/wv3/validate": reply(#"{"error":"le poste est en pause : la réponse reste proposée"}"#, status: 409),
            "POST /v1/workstation/watch/wv1/dismiss": approverOnly,
        ]))
        let server = await connected(transport)
        let watch = server.watch
        await watch.refresh()
        #expect(!watch.isApprover)
        let reads = { transport.calls.filter { $0.path == listPath }.count }

        var before = reads()
        await #expect(throws: HarnessFailure.stale) { try await watch.validate(watch.items[0], text: nil) }
        #expect(reads() == before + 1, "412 : la liste est relue")

        before = reads()
        await #expect(throws: HarnessFailure.rejected("le poste est en pause : la réponse reste proposée")) {
            try await watch.validate(watch.items[2], text: nil)
        }
        #expect(reads() == before + 1)

        await #expect(throws: HarnessFailure.approverOnly) { try await watch.dismiss(watch.items[0]) }
        #expect(watch.availability == .available, "un geste refusé ne cache pas la veille")
    }

    @Test("l'action « Valider » d'une notification omp.reply valide le texte proposé sans corps ni If-Match ; refusée, elle rend faux")
    func notificationValidation() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(watchServer(["POST /v1/workstation/watch/wv9/validate": reply(#"{"error":"le poste est en pause"}"#, status: 409)]))
        let server = await connected(transport)

        #expect(await server.execute(.validateReply(watchId: "wv1")))
        let call = try #require(transport.calls.last { $0.path == "/v1/workstation/watch/wv1/validate" })
        #expect(call.method == "POST" && call.body == nil && call.headers["If-Match"] == nil)

        #expect(await server.execute(.validateReply(watchId: "wv9")) == false)
        #expect(server.watch.failure == .rejected("le poste est en pause"))
    }
}
