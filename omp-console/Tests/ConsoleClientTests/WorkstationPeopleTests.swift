// La page Personnes côté client (routes `/v1/workstation/people*` d'omp-harness) : la liste
// avec chaque champ, sa révision et ses champs corrigés ; une correction qui ne porte que les
// champs changés (`null` pour relâcher) avec la révision lue en If-Match ; 412 qui fait
// relire ; page absente sur un serveur sans la route ou pour un jeton restreint — sur la
// doublure de transport. Aucune donnée réelle : noms et adresses sont inventés (exemple.fr).

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private func reply(_ json: String, status: Int = 200) -> HarnessReply { HarnessReply(status: status, body: Data(json.utf8)) }

private let corrected = #"{"name":false,"emails":false,"slackIds":false,"role":true,"team":false,"projects":false,"tone":false,"delegation":false,"topics":false}"#
private func personJSON(rev: Int, tone: String = "null") -> String {
    #"{"id":"pp1","name":"Alice Martin","emails":["alice@exemple.fr"],"slackIds":["U0ALICE"],"role":"cheffe de projet","team":null,"projects":["Atlas"],"tone":\#(tone),"delegation":"jamais","topics":[],"corrected":\#(corrected),"rev":\#(rev),"createdAt":1,"updatedAt":2}"#
}
private let listJSON = #"{"people":[\#(personJSON(rev: 3))]}"#

private func peopleServer(_ overrides: [String: HarnessReply] = [:]) -> @Sendable (HarnessCall) -> HarnessReply {
    { call in
        if let forced = overrides["\(call.method) \(call.path)"] { return forced }
        switch (call.method, call.path) {
        case ("GET", "/v1/inbox"): return reply(#"{"batches":[],"awaiting":[],"decisions":[],"runs":[],"cursor":1}"#)
        case ("GET", "/v1/me"): return reply(#"{"client":{"name":"app","role":"admin","repos":"*","createdAt":0,"approver":true}}"#)
        case ("GET", "/v1/workstation/people"): return reply(listJSON)
        case ("PATCH", "/v1/workstation/people/pp1"): return reply(#"{"person":\#(personJSON(rev: 4, tone: "\"tutoiement\""))}"#)
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

@Suite("Page Personnes — client")
@MainActor
struct WorkstationPeopleTests {
    @Test("graphe-personnes/AC-6 : la page lit les personnes avec leurs champs, leur révision et leurs champs corrigés ; workstation_person fait relire")
    func readsPeople() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(peopleServer())
        let server = await connected(transport)
        let people = server.people
        await people.refresh()
        #expect(people.availability == .available && people.failure == nil)
        let alice = try #require(people.people.first)
        #expect(alice.name == "Alice Martin" && alice.emails == ["alice@exemple.fr"] && alice.slackIds == ["U0ALICE"])
        #expect(alice.rev == 3 && alice.isCorrected(.role) && !alice.isCorrected(.tone))
        #expect(alice.text(.projects) == "Atlas" && alice.text(.team) == "")
        #expect(PeopleText.delegation("réponse") == "Réponse sur les sujets listés" && PeopleText.field("inconnu") == "inconnu")

        let reads = { transport.calls.filter { $0.path == "/v1/workstation/people" }.count }
        let before = reads()
        people.receive(["workstation_channel"])
        people.receive(["workstation_person"])
        try await Task.sleep(for: .milliseconds(100))
        #expect(reads() == before + 1)
    }

    @Test("graphe-personnes/AC-6 : corriger n'envoie que les champs changés, null pour relâcher, avec la révision lue en If-Match")
    func correctsChangedFields() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(peopleServer())
        let server = await connected(transport)
        let people = server.people
        await people.refresh()
        let alice = try #require(people.people.first)
        let written = try await people.correct(alice, [.tone: .set(" tutoiement "), .topics: .set("planning, , devis"), .role: .release])
        let call = try #require(transport.calls.last { $0.method == "PATCH" })
        #expect(call.path == "/v1/workstation/people/pp1" && call.headers["If-Match"] == "\"3\"")
        let data = try #require(call.body)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["tone", "topics", "role"])
        #expect(body["tone"] as? String == "tutoiement" && body["topics"] as? [String] == ["planning", "devis"] && body["role"] is NSNull)
        #expect(written.rev == 4 && people.people.first?.tone == "tutoiement")
    }

    @Test("graphe-personnes/AC-6 : une personne changée depuis (412) fait relire ; sans la route (404) la page est absente, pour un jeton restreint (403) rien n'est montré, sans échec")
    func staleAbsentReserved() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(peopleServer(["PATCH /v1/workstation/people/pp1": reply(#"{"error":"la personne a changé"}"#, status: 412)]))
        let server = await connected(transport)
        let people = server.people
        await people.refresh()
        let alice = try #require(people.people.first)
        let before = transport.calls.filter { $0.path == "/v1/workstation/people" }.count
        await #expect(throws: HarnessFailure.stale) { try await people.correct(alice, [.tone: .set("x")]) }
        #expect(transport.calls.filter { $0.path == "/v1/workstation/people" }.count == before + 1)

        let absent = ScriptedHarnessTransport()
        absent.respond(peopleServer(["GET /v1/workstation/people": reply(#"{"error":"route inconnue"}"#, status: 404)]))
        let old = await connected(absent)
        await old.people.refresh()
        #expect(old.people.availability == .absent && old.people.failure == nil && old.people.people.isEmpty)

        let narrow = ScriptedHarnessTransport()
        narrow.respond(peopleServer(["GET /v1/workstation/people": reply(#"{"error":"le poste est réservé au propriétaire"}"#, status: 403)]))
        let restricted = await connected(narrow)
        await restricted.people.refresh()
        #expect(restricted.people.availability == .reserved && restricted.people.failure == nil)
    }
}
