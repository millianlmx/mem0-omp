// Les tests hermétiques de l'AUTONOMIE PAR PALIERS côté client : le lancement typé
// (`kind`, `labels`), la validation prise seule portée par une décision et la page
// Système › Autonomie (`GET /v1/autonomy`), masquée sur un serveur qui ne la sert pas.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private final class Transport: HarnessTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [HarnessCall] = []
    let reply: @Sendable (HarnessCall) -> HarnessReply

    init(_ reply: @escaping @Sendable (HarnessCall) -> HarnessReply) { self.reply = reply }

    var calls: [HarnessCall] { lock.withLock { recorded } }

    func send(_ call: HarnessCall, server: HarnessServer) async throws -> HarnessReply {
        lock.withLock { recorded.append(call) }
        return reply(call)
    }

    func events(_ call: HarnessCall, server: HarnessServer) async throws -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { $0.finish() }
    }

    func lastBody(_ method: String, _ path: String) -> [String: Any]? {
        guard let data = calls.last(where: { $0.method == method && $0.path == path })?.body else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}

private let runJSON = #"{"id":"r1","repo":"demo","slug":"a","title":"A","request":"a","state":"merged","fixes":0,"modules":[],"rev":3,"kind":"bug","labels":["urgent"],"createdAt":0,"updatedAt":0}"#
private let inbox = #"{"cursor":0,"batches":[],"awaiting":[],"decisions":[],"runs":[]}"#
private let reviewProof = #"{"gate":"review","rule":{"rank":1,"match":{"kind":"bug","maxDiffLines":50},"require":{"reproTest":true,"greenChecks":true},"gates":{"specs":"human","review":"auto"}},"proofs":{"kind":"bug","labels":["urgent"],"diffLines":40,"reviewMaxDiffLines":30,"ruleMaxDiffLines":50,"fullTests":"pass","reproTests":["test/x.test.ts"],"provenCriteria":["AC-1","AC-2"],"reviewSha":"0123456789abcdef"}}"#
private let validation = #"{"id":7,"runId":"r1","seq":2,"question":"Valider le verdict et fusionner sans geste humain (autonomie) ?","options":["valider","laisser à l'humain"],"chosen":"valider","rationale":"Règle 1 de demo","context":"- type de travail : bug","impacts":[],"step":"review","category":"reversible","status":"auto","createdAt":5,"autonomy":\#(reviewProof)}"#
private let autonomyJSON = #"{"repos":[{"repo":"demo","rules":[{"match":{"kind":"bug","maxDiffLines":50,"labels":["urgent"]},"require":{"reproTest":true},"gates":{"specs":"human","review":"auto"}}]},{"repo":"docs","rules":[]}],"validations":[\#(validation)],"proposals":[{"repo":"demo","kind":"docs","gate":"review","direction":"raise","current":"human","rule":null,"runs":12,"passages":14,"corrections":0,"rate":0,"changes":[{"path":"repos.demo.autonomy.rules[+]","value":{"match":{"kind":"docs","maxDiffLines":600},"gates":{"specs":"human","review":"auto"}}}]},{"repo":"demo","kind":"bug","gate":"review","direction":"lower","current":"auto","rule":1,"runs":10,"passages":10,"corrections":2,"rate":0.2,"changes":[{"path":"repos.demo.autonomy.rules[0].gates.review","value":"human"}]}]}"#

private func ok(_ json: String, status code: Int = 200) -> HarnessReply { HarnessReply(status: code, body: Data(json.utf8)) }

@MainActor private func model(_ transport: Transport) -> HarnessModel {
    HarnessModel(
        transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(),
        retryDelay: .seconds(3600), refreshDelay: .milliseconds(1), sessionPollDelay: .milliseconds(5), reporter: .off
    )
}

@Suite("Autonomie par paliers — client")
@MainActor
struct HarnessAutonomyTests {
    @Test("le lancement envoie le type de travail et les labels lus comme le serveur ; vides, ils restent hors du corps")
    func typedLaunch() async throws {
        let transport = Transport { call in
            switch (call.method, call.path) {
            case (_, "/v1/inbox"): ok(inbox)
            case ("POST", "/v1/runs"): ok(#"{"run":\#(runJSON)}"#, status: 201)
            default: ok("{}", status: 404)
            }
        }
        let server = model(transport)
        #expect(await server.configure(address: "vps.example", token: "t"))

        let draft = HarnessLaunchDraft(kind: .bug, labels: " urgent, paiement,urgent ,\n , client ")
        let options = try #require(draft.options)
        #expect(options.kind == .bug && options.labels == ["urgent", "paiement", "client"])
        let run = await server.launchRun(repo: "demo", title: "T", request: "r", options: options)
        #expect(run?.kind == "bug" && run?.labels == ["urgent"])
        let body = try #require(transport.lastBody("POST", "/v1/runs"))
        #expect(body["kind"] as? String == "bug")
        #expect(body["labels"] as? [String] == ["urgent", "paiement", "client"])

        _ = await server.launchRun(repo: "demo", title: "T", request: "r", options: try #require(HarnessLaunchDraft().options))
        let plain = try #require(transport.lastBody("POST", "/v1/runs"))
        #expect(plain["kind"] == nil && plain["labels"] == nil, "sans type ni label, le corps est celui d'avant")

        #expect(HarnessLaunchDraft(labels: (1 ... 21).map { "l\($0)" }.joined(separator: ",")).problem == .labels)
        #expect(HarnessLaunchDraft(labels: String(repeating: "x", count: 51)).problem == .labels)
        #expect(HarnessLaunchDraft(labels: String(repeating: "x", count: 50)).problem == nil)
        #expect(HarnessWorkKind.allCases.map(\.rawValue) == ["bug", "feature", "docs", "deps", "test"])
    }

    @Test("une validation prise seule nomme la porte franchie, la règle et chaque preuve avec sa valeur")
    func decisionProof() throws {
        let decision = try JSONDecoder().decode(HarnessDecision.self, from: Data(validation.utf8))
        let proof = try #require(decision.autonomy)
        #expect(proof.gateLine == "Porte franchie\u{00A0}: revue")
        #expect(proof.ruleLine == "Règle 1\u{00A0}: Bogue · 50 lignes de différences au plus")
        #expect(proof.rule.require.summary == "Exige\u{00A0}: test de reproduction, suite complète verte")
        #expect(proof.rule.gates.summary == "Specs\u{00A0}: humain · revue\u{00A0}: autonomie")
        #expect(proof.proofLines == [
            "Type de travail\u{00A0}: Bogue",
            "Labels\u{00A0}: urgent",
            "Lignes de différences\u{00A0}: 40 (seuil du serveur 30, de la règle 50)",
            "Suite complète\u{00A0}: verte sur 01234567",
            "Test de reproduction\u{00A0}: test/x.test.ts",
            "Critères prouvés\u{00A0}: AC-1, AC-2",
        ])

        let specs = HarnessAutonomyProof(
            gate: "specs",
            rule: HarnessAutonomyRuleSnapshot(rank: 2, match: HarnessAutonomyMatch(kind: "docs"), gates: HarnessAutonomyGates(specs: "auto")),
            proofs: HarnessAutonomyProofs(kind: "docs", labels: [], gateReasons: [])
        )
        #expect(specs.proofLines == ["Type de travail\u{00A0}: Documentation", "Labels\u{00A0}: aucun", "Raisons de porte des specs\u{00A0}: aucune"])

        let agent = try JSONDecoder().decode(HarnessDecision.self, from: Data(#"{"id":1,"runId":"r1","seq":1,"question":"Q","options":["a"],"chosen":"a","rationale":"r","category":"reversible","status":"auto","createdAt":0,"autonomy":null}"#.utf8))
        #expect(agent.autonomy == nil)
    }

    @Test("la page Autonomie décode règles, validations et propositions avec leur modification ; un 404 la retire du hub")
    func page() async throws {
        let transport = Transport { call in
            switch (call.method, call.path) {
            case (_, "/v1/inbox"): ok(inbox)
            case ("GET", "/v1/autonomy"): ok(autonomyJSON)
            default: ok("{}", status: 404)
            }
        }
        let server = model(transport)
        #expect(await server.configure(address: "vps.example", token: "t"))
        await server.autonomy.refresh()
        #expect(server.autonomy.availability == .available)
        let view = try #require(server.autonomy.view)
        #expect(view.repos.map(\.repo) == ["demo", "docs"] && view.repos[1].rules.isEmpty)
        #expect(view.repos[0].rules[0].match.summary == "Bogue · 50 lignes de différences au plus · labels\u{00A0}: urgent")
        #expect(view.validations.first?.autonomy?.rule.rank == 1)
        let raise = view.proposals[0]
        #expect(raise.title == "Documentation · revue\u{00A0}: passer à l’autonomie")
        #expect(raise.changes[0].valueText == #"{"gates":{"review":"auto","specs":"human"},"match":{"kind":"docs","maxDiffLines":600}}"#)
        let lower = view.proposals[1]
        #expect(lower.title == "Bogue · revue\u{00A0}: rendre à l’humain")
        #expect(lower.stats.hasPrefix("Jugées\u{00A0}: 10 · corrigées\u{00A0}: 2 (20"))
        #expect(lower.changes[0].valueText == #""human""#)
        #expect(SystemPage.visible(isAdmin: false, autonomy: server.autonomy.isServed).contains(.autonomy))

        let old = model(Transport { call in call.path == "/v1/inbox" ? ok(inbox) : ok("{}", status: 404) })
        #expect(await old.configure(address: "vps.example", token: "t"))
        await old.autonomy.refresh()
        #expect(old.autonomy.availability == .absent && old.autonomy.view == nil)
        #expect(!SystemPage.visible(isAdmin: true, autonomy: old.autonomy.isServed).contains(.autonomy))
        #expect(SystemPage.visible(isAdmin: true, autonomy: old.autonomy.isServed).contains(.vigie))
    }
}
