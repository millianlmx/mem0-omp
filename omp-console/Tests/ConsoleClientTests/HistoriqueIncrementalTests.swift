// L'historique des features se relit par morceaux (`GET /v1/runs?since=`, omp-harness
// apps-temps-reel/AC-2) : après une lecture complète, un événement ne fait plus télécharger
// tout l'historique, seulement les runs écrits depuis, fusionnés par id. `refresh()` (ouverture,
// retour au premier plan) relit tout ; un serveur sans `since` rend tout et la liste est remplacée.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private final class PathTransport: HarnessTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String] = []
    let bodies: [String: String]

    init(_ bodies: [String: String]) { self.bodies = bodies }

    var paths: [String] { lock.withLock { recorded } }

    func send(_ call: HarnessCall, server: HarnessServer) async throws -> HarnessReply {
        lock.withLock { recorded.append(call.path) }
        guard let body = bodies[call.path] else { return HarnessReply(status: 404, body: Data("{}".utf8)) }
        return HarnessReply(status: 200, body: Data(body.utf8))
    }

    func events(_ call: HarnessCall, server: HarnessServer) async throws -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { $0.finish() }
    }
}

private func json(_ id: String, _ state: String, _ at: Int) -> String {
    #"{"id":"\#(id)","repo":"demo","slug":"\#(id)","title":"\#(id)","request":"r","state":"\#(state)","fixes":0,"modules":[],"createdAt":\#(at),"updatedAt":\#(at)}"#
}

private func run(_ id: String, _ state: String) -> HarnessRun {
    HarnessRun(id: id, repo: "demo", slug: id, title: id, request: "r", state: state)
}

@Suite("Historique incrémental")
@MainActor
struct HistoriqueIncrementalTests {
    @Test("après une lecture complète, la relecture ne demande que les runs écrits depuis `at` et les fusionne par id ; refresh relit tout")
    func incremental() async {
        let inbox = #"{"cursor":0,"batches":[],"awaiting":[],"decisions":[],"runs":[]}"#
        let transport = PathTransport([
            "/v1/inbox": inbox,
            "/v1/runs": #"{"runs":[\#(json("r1", "running", 1)),\#(json("r2", "queued", 2))],"at":1000}"#,
            "/v1/runs?since=1000": #"{"runs":[\#(json("r1", "merged", 1)),\#(json("r3", "queued", 3))],"at":2000,"since":1000}"#,
        ])
        let server = HarnessModel(
            transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(),
            retryDelay: .seconds(3600), refreshDelay: .milliseconds(1)
        )
        #expect(await server.configure(address: "vps.example", token: "t"))
        await server.history.refresh()
        #expect(server.history.runs.map(\.id) == ["r1", "r2"])

        await server.history.reload()
        #expect(transport.paths.contains("/v1/runs?since=1000"))
        #expect(server.history.runs.map(\.id) == ["r1", "r2", "r3"])
        #expect(server.history.run("r1")?.state == "merged")

        let before = transport.paths.filter { $0 == "/v1/runs" }.count
        await server.history.refresh()
        #expect(transport.paths.filter { $0 == "/v1/runs" }.count == before + 1, "refresh relit tout")
    }

    @Test("la fusion remplace à sa place, ajoute l'inconnu à la fin dans l'ordre du serveur, et ne touche rien sans changement")
    func merging() {
        let current = [run("a", "running"), run("b", "queued")]
        #expect(HarnessRunsHistory.merging([], into: current) == current)
        let merged = HarnessRunsHistory.merging([run("c", "queued"), run("a", "merged"), run("d", "queued")], into: current)
        #expect(merged.map(\.id) == ["a", "b", "c", "d"])
        #expect(merged.first?.state == "merged")
    }
}
