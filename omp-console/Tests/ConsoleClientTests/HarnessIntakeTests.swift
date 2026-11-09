// La Demande côté client (routes `/v1/intake*` d'omp-harness) : première entrée de la
// palette, file d'« À traiter » (classement, question, plan, réponse, échec), gestes
// Confirmer / Répondre / Annuler / Écarter, et serveur antérieur dit en français — sur
// la doublure de transport.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private func reply(_ json: String, status: Int = 200) -> HarnessReply { HarnessReply(status: status, body: Data(json.utf8)) }

private func intakeJSON(_ id: String, state: String, extra: String = "") -> String {
    #"{"id":""# + id + #"","text":"corrige le bug X","source":"console","repo":null,"requestedRepo":null,"state":""# + state
        + #"","kind":null,"plan":null,"question":null,"answer":null,"exchanges":[],"statement":"corrige le bug X","created":null,"reason":null,"by":"mac","createdAt":1,"updatedAt":2"#
        + extra + "}"
}

private let plannedJSON = #"""
{"id":"i3","text":"corrige le bug X dans demo","source":"console","repo":"demo","requestedRepo":null,"state":"planned","kind":"bug",
 "plan":{"kind":"bug","repo":"demo","title":"Corriger X","statement":"corrige le bug X dans demo","creates":"Un run « Corriger X » sur demo"},
 "question":null,"answer":null,"exchanges":[],"statement":"corrige le bug X dans demo","created":null,"reason":null,"by":"mac","createdAt":3,"updatedAt":4}
"""#

private let openList = #"{"intakes":["# + [
    intakeJSON("i1", state: "classifying"),
    intakeJSON("i2", state: "clarifying").replacingOccurrences(of: #""question":null"#, with: #""question":"Quel dépôt ?""#),
    plannedJSON,
    intakeJSON("i4", state: "failed").replacingOccurrences(of: #""reason":null"#, with: #""reason":"le classement a échoué : dépôt inconnu""#),
    intakeJSON("i5", state: "answered").replacingOccurrences(of: #""answer":null"#, with: #""answer":"Trois runs tournent.""#),
].joined(separator: ",") + "]}"

private let openPath = "/v1/intake?state=classifying,clarifying,planned,answered,failed&limit=200"

private func intakeServer(_ overrides: [String: HarnessReply] = [:]) -> @Sendable (HarnessCall) -> HarnessReply {
    { call in
        if let forced = overrides["\(call.method) \(call.path)"] { return forced }
        switch (call.method, call.path) {
        case ("GET", "/v1/inbox"): return reply(#"{"batches":[],"awaiting":[],"decisions":[],"runs":[],"cursor":1}"#)
        case ("GET", openPath): return reply(openList)
        case ("POST", "/v1/intake"): return reply(#"{"intake":"# + intakeJSON("i9", state: "classifying") + "}", status: 201)
        case ("POST", "/v1/intake/i3/confirm"):
            return reply(#"{"intake":"# + plannedJSON.replacingOccurrences(of: #""state":"planned""#, with: #""state":"confirmed""#) + "}", status: 201)
        case ("POST", "/v1/intake/i2/answer"): return reply(#"{"intake":"# + intakeJSON("i2", state: "classifying") + "}")
        case ("POST", "/v1/intake/i4/cancel"): return reply(#"{"intake":"# + intakeJSON("i4", state: "cancelled") + "}")
        default: return reply(#"{"error":"route inconnue"}"#, status: 404)
        }
    }
}

private func scripted(_ handler: @escaping @Sendable (HarnessCall) -> HarnessReply) -> ScriptedHarnessTransport {
    let transport = ScriptedHarnessTransport()
    transport.respond(handler)
    return transport
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

@Suite("Demande — client")
@MainActor
struct HarnessIntakeTests {
    @Test("demande-console/AC-17 : « Demande » est la première entrée de la palette saisie vide, et absente de la recherche ⌘F")
    func paletteStartsWithIntake() {
        let items = HarnessPalette.items(query: "", search: false, sections: ConsoleSection.allCases, inbox: nil, history: [], canAct: true, memory: true)
        #expect(items.first?.command == .intake)
        #expect(items.first?.title == IntakeText.title)
        let typed = HarnessPalette.items(query: "dem", search: false, sections: ConsoleSection.allCases, inbox: nil, history: [], canAct: true, memory: true)
        #expect(typed.contains { $0.command == .intake })
        let search = HarnessPalette.items(query: "", search: true, sections: ConsoleSection.allCases, inbox: nil, history: [], canAct: true, memory: true)
        #expect(!search.contains { $0.command == .intake })
    }

    @Test("demande-console/AC-18 : la file lit classement, question, plan, échec et réponse ; confirmer retire le plan, répondre garde la même demande, écarter appelle cancel")
    func queueAndGestures() async throws {
        let transport = scripted(intakeServer())
        let model = await connected(transport)
        await model.intakes.refresh()
        #expect(model.intakes.availability == .available)
        #expect(Set(model.intakes.open.map(\.id)) == ["i1", "i2", "i3", "i4", "i5"])
        #expect(model.intakes.pendingCount == 2)
        let planned = try #require(model.intakes.open.first { $0.id == "i3" })
        #expect(planned.isPlanned)
        #expect(planned.plan?.creates == "Un run « Corriger X » sur demo")

        try await model.intakes.confirm(planned)
        #expect(!model.intakes.open.contains { $0.id == "i3" })

        let clarifying = try #require(model.intakes.open.first { $0.id == "i2" })
        try await model.intakes.answer(clarifying, text: "  demo  ")
        #expect(try body(transport.calls.last).description.contains("demo"))
        #expect(try body(transport.calls.last)["text"] as? String == "demo")
        #expect(model.intakes.open.first { $0.id == "i2" }?.state == "classifying")
        #expect(model.intakes.open.filter { $0.id == "i2" }.count == 1)

        let failed = try #require(model.intakes.open.first { $0.id == "i4" })
        try await model.intakes.cancel(failed)
        #expect(transport.calls.last?.path == "/v1/intake/i4/cancel")
        #expect(!model.intakes.open.contains { $0.id == "i4" })
    }

    @Test("demande-console/AC-18 : l'envoi pose {text, source, repo?} ; une correction du plan part avec la confirmation, sans `creates`")
    func submitAndCorrect() async throws {
        let transport = scripted(intakeServer())
        let model = await connected(transport)
        let posted = try await model.intakes.submit(text: "  corrige le bug X \n", source: "ios", repo: "")
        #expect(posted.id == "i9")
        let sent = try body(transport.calls.last)
        #expect(sent["text"] as? String == "corrige le bug X")
        #expect(sent["source"] as? String == "ios")
        #expect(sent["repo"] == nil)
        #expect(model.intakes.open.contains { $0.id == "i9" })

        await model.intakes.refresh()
        let planned = try #require(model.intakes.open.first { $0.id == "i3" })
        var plan = try #require(planned.plan)
        plan.title = "Corriger Y"
        try await model.intakes.confirm(planned, plan: plan)
        let confirm = try body(transport.calls.last)
        let corrected = try #require(confirm["plan"] as? [String: Any])
        #expect(corrected["title"] as? String == "Corriger Y")
        #expect(corrected["creates"] == nil)
    }

    @Test("demande-console/AC-21 : un serveur sans /v1/intake (404) lève `unsupported`, dit en français, et la file reste vide sans échec")
    func olderServer() async throws {
        let transport = scripted(intakeServer([
            "GET \(openPath)": reply(#"{"error":"route inconnue"}"#, status: 404),
        ]))
        let model = await connected(transport)
        await model.intakes.refresh()
        #expect(model.intakes.availability == .absent)
        #expect(model.intakes.open.isEmpty)
        #expect(model.intakes.failure == nil)

        let older = await connected(scripted(intakeServer(["POST /v1/intake": reply(#"{"error":"route inconnue"}"#, status: 404)])))
        await #expect(throws: HarnessIntakeFailure.unsupported) {
            try await older.intakes.submit(text: "corrige le bug X", source: "console")
        }
        #expect(IntakeText.unsupported.contains("ne connaît pas encore la Demande"))
    }
}
