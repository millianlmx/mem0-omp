// Feature onglet-preuves : les preuves d'une feature (Mac et iOS) côté client — le
// découpage en tours de revue, l'avant/après apparié par critère, le rapport de tests
// par critère, rien sur un 404,
// l'échec visible sur une réponse illisible, et le nombre de preuves dans la
// notification locale d'un verdict. Sur la doublure de transport, avec les formes
// JSON que le serveur écrit (omp-harness/proofs.ts, test-report.ts).

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private final class Transport: HarnessTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [HarnessCall] = []
    let reply: @Sendable (HarnessCall) -> HarnessReply

    init(_ reply: @escaping @Sendable (HarnessCall) -> HarnessReply) { self.reply = reply }

    var paths: [String] { lock.withLock { recorded.map(\.path) } }

    func send(_ call: HarnessCall, server: HarnessServer) async throws -> HarnessReply {
        lock.withLock { recorded.append(call) }
        return reply(call)
    }

    func events(_ call: HarnessCall, server: HarnessServer) async throws -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { $0.finish() }
    }
}

private func ok(_ json: String, status: Int = 200) -> HarnessReply { HarnessReply(status: status, body: Data(json.utf8)) }

private let inbox = #"{"cursor":0,"batches":[],"awaiting":[],"decisions":[],"runs":[]}"#

private func timeline(_ steps: [(kind: String, at: Int)]) -> String {
    let rows = steps.enumerated().map { index, step in
        #"{"id":\#(index + 1),"kind":"\#(step.kind)","attempt":0,"status":"done","model":null,"startedAt":\#(step.at),"endedAt":null}"#
    }
    return #"{"runId":"r1","title":"A","state":"awaiting_human","live":false,"createdAt":0,"updatedAt":0,"now":100,"steps":[\#(rows.joined(separator: ","))],"tests":[],"decisions":[],"events":[],"cost":0,"costByStep":{}}"#
}

private func proof(_ n: Int, _ kind: String, at: Int, acRef: String? = nil, side: String? = nil) -> String {
    let mime = switch kind {
    case "test_report": "application/json"
    case "log": "text/plain; charset=utf-8"
    default: "image/png"
    }
    let ac = acRef.map { #""\#($0)""# } ?? "null"
    let sd = side.map { #""\#($0)""# } ?? "null"
    return #"{"n":\#(n),"kind":"\#(kind)","title":"Preuve \#(n)","step":"review","mime":"\#(mime)","size":8,"createdAt":\#(at),"acRef":\#(ac),"side":\#(sd)}"#
}

/// La forme exacte de `testReport` (omp-harness/test-report.ts).
private let reportJSON = #"""
{"step":"fix","scope":"touched","outcome":"fail","exitCode":1,"cached":true,"skipped":false,"truncated":true,
 "criteria":[{"id":"AC-1","slug":null,"ac":"AC-1","tests":1,"passed":1,"failed":0},
             {"id":"panier/AC-2","slug":"panier","ac":"AC-2","tests":2,"passed":1,"failed":1}],
 "other":{"tests":5,"passed":5,"failed":0}}
"""#

private let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3])

@MainActor private func connected(_ transport: Transport) async -> HarnessModel {
    let model = HarnessModel(
        transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(),
        retryDelay: .seconds(3600), refreshDelay: .milliseconds(1), reporter: .off
    )
    _ = await model.configure(address: "vps.example", token: "t")
    return model
}

@Suite("Onglet Preuves — client")
@MainActor
struct OngletPreuvesTests {
    @Test("onglet-preuves/AC-90 : une feature qui attend la validation de sa revue montre ses preuves — vignettes, avant/après côte à côte par critère, rapport de tests par critère")
    func showsProofsWithPairsAndReport() async throws {
        let listed = [
            proof(1, "test_report", at: 10),
            proof(2, "screenshot", at: 11, acRef: "AC-2", side: "before"),
            proof(3, "screenshot", at: 12),
            proof(4, "screenshot", at: 13, acRef: "AC-2", side: "after"),
            proof(5, "log", at: 14),
            proof(6, "screenshot", at: 15, acRef: "AC-3"),
        ].joined(separator: ",")
        let transport = Transport { call in
            switch call.path {
            case "/v1/inbox": ok(inbox)
            case "/v1/runs/r1/proofs": ok(#"{"runId":"r1","proofs":[\#(listed)]}"#)
            case "/v1/runs/r1/timeline": ok(timeline([("impl", 5), ("review", 9)]))
            case "/v1/runs/r1/proofs/1": ok(reportJSON)
            case "/v1/runs/r1/proofs/2": HarnessReply(status: 200, body: png)
            case "/v1/runs/r1/proofs/5": ok("journal de la revue")
            default: ok(#"{"error":"route inconnue"}"#, status: 404)
            }
        }
        let server = await connected(transport)
        let proofs = HarnessRunProofs(harness: server, runId: "r1")
        await proofs.load()
        guard case .loaded(let rounds) = proofs.availability else {
            Issue.record("preuves non lues : \(proofs.availability)")
            return
        }
        let current = rounds.current
        #expect(current.pairs == [HarnessProofPair(acRef: "AC-2", before: current.proofs[1], after: current.proofs[3])])
        // Une capture sans côté ou sans critère est une vignette.
        #expect(current.captures.map(\.n) == [3, 6])
        #expect(current.reports.map(\.n) == [1])
        #expect(current.logs.map(\.n) == [5])

        await proofs.read(current.proofs[0])
        guard case .report(let report)? = proofs.contents[1] else {
            Issue.record("rapport non lu : \(String(describing: proofs.contents[1]))")
            return
        }
        #expect(report.criteria.map(\.id) == ["AC-1", "panier/AC-2"])
        #expect(report.criteria[1].passed == 1 && report.criteria[1].failed == 1)
        #expect(report.truncated)
        #expect(report.other == HarnessTestCount(tests: 5, passed: 5, failed: 0))
        await proofs.read(current.proofs[1])
        #expect(proofs.contents[2] == .image(png))
        await proofs.read(current.proofs[4])
        #expect(proofs.contents[5] == .text("journal de la revue"))
        // Une preuve que le serveur ne connaît plus ne passe pas pour une autre.
        await proofs.read(current.proofs[2])
        #expect(proofs.contents[3] == .missing)
        #expect(transport.paths.contains("/v1/runs/r1/proofs/1"))
        #expect(ProofsText.counts(passed: 1, failed: 1) == "1 réussi · 1 échoué")
        #expect(ProofsText.criterion("AC-2") == "Critère AC-2")
    }

    @Test("onglet-preuves/AC-91 : deux tours de revue — seul le tour courant (depuis la dernière implémentation ou correction) est montré d'emblée, le précédent est replié à part")
    func roundsSplitOnLastImplOrFix() async throws {
        let listed = [proof(1, "test_report", at: 15), proof(2, "log", at: 25), proof(3, "test_report", at: 30), proof(4, "log", at: 45)]
            .joined(separator: ",")
        let transport = Transport { call in
            switch call.path {
            case "/v1/inbox": ok(inbox)
            case "/v1/runs/r1/proofs": ok(#"{"runId":"r1","proofs":[\#(listed)]}"#)
            case "/v1/runs/r1/timeline": ok(timeline([("impl", 10), ("review", 20), ("fix", 30), ("review", 40)]))
            default: ok(#"{"error":"route inconnue"}"#, status: 404)
            }
        }
        let server = await connected(transport)
        let proofs = HarnessRunProofs(harness: server, runId: "r1")
        await proofs.load()
        guard case .loaded(let rounds) = proofs.availability else {
            Issue.record("preuves non lues : \(proofs.availability)")
            return
        }
        // La borne `≥` est comprise : la preuve créée au début de la correction est du tour courant.
        #expect(rounds.current.proofs.map(\.n) == [3, 4])
        #expect(rounds.previous.proofs.map(\.n) == [1, 2])
        #expect(rounds.current.reports.map(\.n) == [3])

        // Sans frise, ou sans étape d'implémentation ni de correction : un seul tour.
        let all = try JSONDecoder().decode(HarnessProofs.self, from: Data(#"{"runId":"r1","proofs":[\#(listed)]}"#.utf8)).proofs
        let alone = HarnessProofRounds(proofs: all, steps: nil)
        #expect(alone.current.proofs.map(\.n) == [1, 2, 3, 4] && alone.previous.isEmpty)
        let reviewOnly = try JSONDecoder().decode(HarnessTimeline.self, from: Data(timeline([("review", 20)]).utf8))
        let single = HarnessProofRounds(proofs: all, steps: reviewOnly.steps)
        #expect(single.current.proofs.count == 4 && single.previous.isEmpty)
    }

    @Test("onglet-preuves/AC-92 : un serveur qui ne sert pas les preuves (404) n'en montre aucune, sans aucune erreur")
    func absentRouteShowsNothing() async throws {
        let transport = Transport { call in
            call.path == "/v1/inbox" ? ok(inbox) : ok(#"{"error":"route inconnue"}"#, status: 404)
        }
        let server = await connected(transport)
        let proofs = HarnessRunProofs(harness: server, runId: "r1")
        #expect(proofs.availability == .loading)
        await proofs.load()
        #expect(proofs.availability == .absent)
        #expect(server.failure == nil)
    }

    @Test("onglet-preuves/AC-93 : une réponse indécodable se montre comme un échec")
    func unreadableAnswerIsShown() async throws {
        let transport = Transport { call in
            switch call.path {
            case "/v1/inbox": ok(inbox)
            // Une clé mal nommée : `items` au lieu de `proofs`.
            case "/v1/runs/r1/proofs": ok(#"{"runId":"r1","items":[]}"#)
            default: ok(#"{"error":"route inconnue"}"#, status: 404)
            }
        }
        let server = await connected(transport)
        let proofs = HarnessRunProofs(harness: server, runId: "r1")
        await proofs.load()
        #expect(proofs.availability == .failed(.unreadable))
        #expect(HarnessFailure.unreadable.message == PipelineServerText.unreadable)
    }

    @Test("onglet-preuves/AC-94 : la notification locale d'un verdict dit le nombre de preuves du tour — aucune preuve, 1 preuve, 3 preuves")
    func verdictNotificationCountsProofs() throws {
        func alert(_ payload: String) throws -> HarnessLocalAlert {
            let data = #"{"id":7,"runId":"r1","repo":"demo","payload":\#(payload)}"#
            return try #require(HarnessNotificationRouting.localAlert(for: HarnessStreamEvent(name: "verdict", data: Data(data.utf8)), client: nil))
        }
        let three = try alert(#"{"verdict":{"summary":"s"},"reason":"r","proofs":3}"#)
        #expect(three.title == NotificationText.verdict)
        #expect(three.body(runTitle: "Panier") == "demo · Panier · 3 preuves")
        #expect(try alert(#"{"proofs":1}"#).body(runTitle: "Panier") == "demo · Panier · 1 preuve")
        #expect(try alert(#"{"proofs":0}"#).body(runTitle: "Panier") == "demo · Panier · aucune preuve")
        // Un serveur qui ne dit pas le nombre : le corps d'avant.
        #expect(try alert(#"{"reason":"r"}"#).body(runTitle: "Panier") == "demo · Panier")
        #expect(NotificationText.proofs(3) == "3 preuves")
        #expect(L10n.text("%lld preuves", language: "en") == "%lld pieces of evidence")
    }
}
