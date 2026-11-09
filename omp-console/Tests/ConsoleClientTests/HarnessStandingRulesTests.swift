// Le SAVOIR que l'humain écrit (contrat §2.3 et §2.4) : les consignes permanentes
// (`/v1/rules`) — lecture, écriture, corps exacts, serveur antérieur — et l'écriture d'une
// règle de palier (`POST /v1/autonomy/rules`), sur la doublure de transport.

@testable import ConsoleClient
import Foundation
import Testing

private func ruleJSON(_ id: String, repo: String?, text: String, enabled: Bool = true, source: String = "manual", createdAt: Int) -> String {
    #"{"id":""# + id + #"","repo":"# + (repo.map { "\"\($0)\"" } ?? "null") + #","text":""# + text + #"","enabled":"# + (enabled ? "true" : "false")
        + #","source":""# + source + #"","sourceRunId":null,"by":"mac","createdAt":\#(createdAt),"updatedAt":\#(createdAt)}"#
}

private let rulesJSON = #"{"rules":["# + [
    ruleJSON("k1", repo: "demo", text: "Toujours en CSV.", createdAt: 10),
    ruleJSON("k2", repo: nil, text: "Jamais de dépendance nouvelle.", source: "correction", createdAt: 30),
    ruleJSON("k3", repo: "docs", text: "Vouvoyer.", enabled: false, source: "answer", createdAt: 20),
].joined(separator: ",") + "]}"

private let autonomyView = #"""
{"repos":[{"repo":"demo","rules":[]},{"repo":"docs","rules":[]}],"validations":[],"proposals":[]}
"""#
private let writtenRules = #"""
{"repo":"demo","rules":[{"match":{"kind":"docs","maxDiffLines":600},"require":{"greenChecks":true},"gates":{"specs":"human","review":"auto"}}]}
"""#

@Suite("Consignes permanentes et paliers — client")
@MainActor
struct HarnessStandingRulesTests {
    @Test("les consignes se lisent, les plus récentes d'abord ; celles qui s'imposent à un dépôt sont les siennes et les globales, actives seulement")
    func list() async throws {
        let model = await osConnected(osTransport(routes: ["GET /v1/rules": osJSON(rulesJSON)]))
        await model.rules.refresh()
        #expect(model.rules.availability == .available)
        #expect(model.rules.rules.map(\.id) == ["k2", "k3", "k1"])
        let global = try #require(model.rules.rules.first)
        #expect(global.isGlobal && global.origin == .correction && global.by == "mac")
        #expect(model.rules.active(for: "demo").map(\.id) == ["k2", "k1"])
        #expect(model.rules.active(for: "docs").map(\.id) == ["k2"], "une consigne désactivée ne s'impose plus")
        #expect(model.rules.active(for: nil).map(\.id) == ["k2"])
        #expect(HarnessStandingRuleSource.allCases.map(\.rawValue) == ["answer", "correction", "cancel", "manual"])
    }

    @Test("un serveur sans /v1/rules (404) : les consignes sont absentes, sans échec")
    func olderServer() async {
        let model = await osConnected(osTransport(routes: [:]))
        await model.rules.refresh()
        #expect(model.rules.availability == .absent && !model.rules.isServed)
        #expect(model.rules.rules.isEmpty && model.rules.failure == nil)
    }

    @Test("écrire une consigne envoie {text, repo?, source?, sourceRunId?} ; vide ou trop longue, elle ne part pas")
    func create() async throws {
        let created = ruleJSON("k9", repo: "demo", text: "Toujours tester.", source: "cancel", createdAt: 99)
        let transport = osTransport(routes: [
            "GET /v1/rules": osJSON(rulesJSON),
            "POST /v1/rules": osJSON(#"{"rule":"# + created + "}", status: 201),
        ])
        let model = await osConnected(transport)
        await model.rules.refresh()

        let rule = await model.rules.create(text: "  Toujours tester.  ", repo: " demo ", source: .cancel, sourceRunId: "r1")
        #expect(rule?.id == "k9")
        let body = try #require(transport.body("POST", "/v1/rules"))
        #expect(body["text"] as? String == "Toujours tester.")
        #expect(body["repo"] as? String == "demo")
        #expect(body["source"] as? String == "cancel")
        #expect(body["sourceRunId"] as? String == "r1")
        #expect(model.rules.rules.first?.id == "k9", "la consigne créée rejoint la liste, en tête")

        _ = await model.rules.create(text: "Partout.", repo: "")
        let global = try #require(transport.body("POST", "/v1/rules"))
        #expect(Set(global.keys) == ["text"], "sans dépôt ni origine : seulement le texte")

        let before = transport.count("POST", "/v1/rules")
        #expect(await model.rules.create(text: "  ") == nil)
        #expect(await model.rules.create(text: String(repeating: "x", count: HarnessStandingRulesModel.maxTextLength + 1)) == nil)
        #expect(transport.count("POST", "/v1/rules") == before)
        #expect(model.rules.failure == .rejected(""))
    }

    @Test("modifier n'envoie que ce qui change ; supprimer appelle DELETE et retire la consigne ; un refus relit la liste et garde sa raison")
    func updateAndRemove() async throws {
        let disabled = ruleJSON("k1", repo: "demo", text: "Toujours en CSV.", enabled: false, createdAt: 10)
        let transport = osTransport { call in
            switch (call.method, call.path) {
            case ("GET", "/v1/rules"): osJSON(rulesJSON)
            case ("PUT", "/v1/rules/k1"): osJSON(#"{"rule":"# + disabled + "}")
            case ("PUT", "/v1/rules/k2"): osJSON(#"{"error":"réservé au propriétaire"}"#, status: 403)
            case ("DELETE", "/v1/rules/k1"): osJSON(#"{"removed":true}"#)
            default: nil
            }
        }
        let model = await osConnected(transport)
        await model.rules.refresh()
        let own = try #require(model.rules.rules.first { $0.id == "k1" })
        let global = try #require(model.rules.rules.first { $0.id == "k2" })

        #expect(await model.rules.update(own, enabled: false))
        #expect(transport.rawBody("PUT", "/v1/rules/k1") == #"{"enabled":false}"#)
        #expect(model.rules.rules.first { $0.id == "k1" }?.enabled == false)

        #expect(await model.rules.update(own, text: "  En TSV.  "))
        #expect(transport.rawBody("PUT", "/v1/rules/k1") == #"{"text":"En TSV."}"#)

        let puts = transport.calls.filter { $0.method == "PUT" }.count
        #expect(await model.rules.update(own) == false, "rien à changer : rien ne part")
        #expect(await model.rules.update(own, text: " ") == false)
        #expect(transport.calls.filter { $0.method == "PUT" }.count == puts)

        #expect(await model.rules.update(global, enabled: false) == false)
        #expect(model.rules.failure == .forbidden("réservé au propriétaire"))

        #expect(await model.rules.remove(own))
        #expect(transport.last("DELETE", "/v1/rules/k1") != nil)
        #expect(!model.rules.rules.contains { $0.id == "k1" })
    }

    @Test("l'événement `standing_rule` fait relire les consignes déjà lues")
    func liveReload() async {
        let transport = osTransport(routes: ["GET /v1/rules": osJSON(rulesJSON)])
        let model = await osConnected(transport)
        await model.rules.refresh()
        let reads = transport.count("GET", "/v1/rules")
        transport.push(events: ["standing_rule"])
        model.startLive()
        #expect(await eventually { transport.count("GET", "/v1/rules") > reads })
        model.stopLive()
    }

    @Test("écrire une règle de palier envoie {repo, kind, gate, mode}, et la page montre les règles que le serveur tient désormais")
    func tierRule() async throws {
        let transport = osTransport { call in
            switch (call.method, call.path) {
            case ("GET", "/v1/autonomy"): osJSON(autonomyView)
            case ("POST", "/v1/autonomy/rules"): osJSON(writtenRules)
            default: nil
            }
        }
        let model = await osConnected(transport)
        await model.autonomy.refresh()

        #expect(await model.autonomy.setRule(repo: "demo", kind: .docs, gate: .review, mode: .auto))
        let body = try #require(transport.body("POST", "/v1/autonomy/rules"))
        #expect(body["repo"] as? String == "demo" && body["kind"] as? String == "docs")
        #expect(body["gate"] as? String == "review" && body["mode"] as? String == "auto")
        #expect(Set(body.keys) == ["repo", "kind", "gate", "mode"])
        #expect(transport.count("GET", "/v1/autonomy") == 2, "la page est relue après l'écriture")
        #expect(HarnessAutonomyGate.allCases.map(\.rawValue) == ["specs", "review"])
        #expect(HarnessAutonomyMode.allCases.map(\.rawValue) == ["human", "auto"])

        let reads = transport.count("GET", "/v1/autonomy")
        transport.push(events: ["autonomy_rule"])
        model.startLive()
        #expect(await eventually { transport.count("GET", "/v1/autonomy") > reads })
        model.stopLive()
    }

    @Test("une règle de palier refusée (configuration invalide, jeton non admin) laisse la page telle quelle et dit pourquoi")
    func tierRuleRefused() async {
        let transport = osTransport { call in
            switch (call.method, call.path) {
            case ("GET", "/v1/autonomy"): osJSON(autonomyView)
            case ("POST", "/v1/autonomy/rules"): osJSON(#"{"error":"configuration invalide"}"#, status: 400)
            default: nil
            }
        }
        let model = await osConnected(transport)
        await model.autonomy.refresh()
        let before = model.autonomy.view
        #expect(await model.autonomy.setRule(repo: "demo", kind: .bug, gate: .specs, mode: .human) == false)
        #expect(model.autonomy.failure == .rejected("configuration invalide"))
        #expect(model.autonomy.view == before)
        #expect(!model.autonomy.isSaving)
    }
}
