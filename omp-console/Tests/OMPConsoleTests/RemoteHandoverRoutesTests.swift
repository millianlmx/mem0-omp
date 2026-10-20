// Les quatre routes de bascule de l'API distante du Mac (S-5 de
// orchestrator-living-in-a-vps) : relayées au service local, avec ses codes, ses
// motifs et ses corps — ceux que le VPS sert en direct (omp-mem0-req/remoteHandover.ts).
// `GET /v1/repos` porte l'identité et la bascule de chaque dépôt, et `repos.json`
// ajoute les dépôts adoptés aux dépôts connus.

import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

/// Un vrai dépôt git dont l'`origin` est `url`, publié comme lot du magasin.
@MainActor
private func publishRepo(_ store: StoreFixture, name: String, origin: String?) throws -> String {
    let repoRoot = store.root + "/" + name
    try FileManager.default.createDirectory(atPath: repoRoot, withIntermediateDirectories: true)
    try runGit(["init", "-q"], in: repoRoot)
    if let origin { try runGit(["remote", "add", "origin", origin], in: repoRoot) }
    return realpathOr(repoRoot)
}

private func runGit(_ arguments: [String], in directory: String) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    process.arguments = ["-C", directory] + arguments
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    #expect(process.terminationStatus == 0)
}

private func stubHandoverService(_ transport: ScriptedServiceTransport) {
    transport.stubJSON("POST", "/handover", [
        "id": "h1", "identity": "github.com/o/r",
        "features": [["slug": "alpha", "description": "À faire", "modelReqSpecs": "m1"]],
    ])
    transport.stubJSON("POST", "/handover/h1/commit", ["removed": ["alpha"]])
    transport.stubJSON("DELETE", "/handover/h1", ["cancelled": true])
    transport.stubJSON("POST", "/v1/repos/adopt", [
        "repoKey": "k", "repoRoot": "/tmp/r", "cloned": false, "launched": ["alpha"],
        "refused": [["slug": "beta", "reason": "déjà lancée"]],
    ])
}

@MainActor
private struct HandoverRemote {
    let store: StoreFixture
    let stack: RemoteStack
    let token: String
    let repoKey: String
    let repoRoot: String
    let transport: ScriptedServiceTransport
}

@MainActor
private func handoverStack(origin: String? = "https://github.com/O/R.git") async throws -> HandoverRemote {
    let store = StoreFixture()
    let repoRoot = try publishRepo(store, name: "depot-bascule", origin: origin)
    store.publish(.lots, "\(fixtureId(0xB5)).json", object: lotObject(id: fixtureId(0xB5), repoRoot: repoRoot))
    let transport = ScriptedServiceTransport()
    stubHandoverService(transport)
    let stack = try await RemoteStack.make(
        stateDir: store.root,
        environment: ["PATH": "/usr/bin:/bin"],
        makeServiceClient: { scriptedClient(transport) }
    )
    let token = try await stack.pair()
    let repos = try await stack.call("GET", "/v1/repos", token: token)
    let row = try #require(try repos.json(RemoteReposPayload.self).rows.first { $0.repoRoot == repoRoot })
    return HandoverRemote(store: store, stack: stack, token: token, repoKey: row.repoKey, repoRoot: repoRoot, transport: transport)
}

@MainActor
@Test("bascule distante du Mac : les quatre routes relaient au service local et rendent ses corps")
func macHandoverRoutesRelayToTheLocalService() async throws {
    let remote = try await handoverStack()
    defer { remote.stack.stop() }
    let base = "/v1/repos/\(remote.repoKey)"

    let frozen = try await remote.stack.call("POST", "\(base)/handover", token: remote.token, json: ["to": "vps"])
    #expect(frozen.status == 200)
    let charge = try frozen.json(HandoverCharge.self)
    #expect(charge == HandoverCharge(
        id: "h1",
        identity: "github.com/o/r",
        features: [HandoverFeatureCharge(slug: "alpha", description: "À faire", modelReqSpecs: "m1")]
    ))

    let committed = try await remote.stack.call("POST", "\(base)/handover/h1/commit", token: remote.token, json: ["slugs": ["alpha"]])
    #expect(committed.status == 200)
    #expect(try committed.json(RemoteHandoverCommittedPayload.self).removed == ["alpha"])

    let cancelled = try await remote.stack.call("DELETE", "\(base)/handover/h1", token: remote.token)
    #expect(cancelled.status == 200)
    #expect(try cancelled.json(RemoteHandoverCancelledPayload.self).cancelled)

    let adopted = try await remote.stack.call("POST", "/v1/repos/adopt", token: remote.token, json: [
        "identity": "github.com/o/r",
        "features": [["slug": "alpha", "description": "À faire"]],
    ])
    #expect(adopted.status == 200)
    let adoption = try adopted.json(HandoverAdoption.self)
    #expect(adoption.launched == ["alpha"])
    #expect(adoption.refused == [HandoverRefusal(slug: "beta", reason: "déjà lancée")])

    // Ce que le service a reçu : la racine du dépôt (UN segment), le corps du geste.
    let sent = remote.transport.requests
    #expect(sent.count == 4)
    #expect(sent[0].method == "POST" && sent[0].path == "/v1/repos/\(remote.repoRoot)/handover")
    #expect(sent[0].body?["to"] as? String == "vps")
    #expect(sent[1].body?["slugs"] as? [String] == ["alpha"])
    #expect(sent[2].method == "DELETE" && sent[2].path == "/v1/repos/\(remote.repoRoot)/handover/h1")
    #expect(sent[3].body?["identity"] as? String == "github.com/o/r")
    #expect((sent[3].body?["features"] as? [[String: Any]])?.first?["slug"] as? String == "alpha")
}

@MainActor
@Test("bascule distante du Mac : le Mac refuse comme le VPS, avec le code et le motif du service")
func macHandoverRoutesRefuseLikeTheVps() async throws {
    let store = StoreFixture()
    let repoRoot = try publishRepo(store, name: "depot-refus", origin: "https://github.com/o/r.git")
    store.publish(.lots, "\(fixtureId(0xB9)).json", object: lotObject(id: fixtureId(0xB9), repoRoot: repoRoot))
    let base = "/v1/repos/\(KanbanRepoKey.key(forRoot: repoRoot))"
    let fresh = ScriptedServiceTransport()
    fresh.stubStatus("POST", "/v1/repos/adopt", status: 409, json: ["error": "conflict", "reason": "dépôt absent de ce Mac"])
    fresh.stubStatus("POST", "/handover", status: 409, json: ["error": "conflict", "reason": "dépôt sans dépôt distant GitHub"])
    fresh.stubStatus("POST", "/commit", status: 404, json: ["error": "not_found", "reason": "bascule inconnue"])
    fresh.stubStatus("DELETE", "/handover/h1", status: 409, json: ["error": "conflict", "reason": "bascule déjà terminée"])
    let isolated = try await RemoteStack.make(
        stateDir: store.root,
        environment: ["PATH": "/usr/bin:/bin"],
        makeServiceClient: { scriptedClient(fresh) }
    )
    defer { isolated.stop() }
    let token = try await isolated.pair()

    let absent = try await isolated.call("POST", "/v1/repos/adopt", token: token, json: ["identity": "github.com/o/absent", "features": []])
    #expect(absent.status == 409)
    #expect(absent.errorCode == "conflict")
    #expect(absent.errorMessage == "dépôt absent de ce Mac")

    let noRemote = try await isolated.call("POST", "\(base)/handover", token: token, json: ["to": "vps"])
    #expect(noRemote.status == 409)
    #expect(noRemote.errorMessage == "dépôt sans dépôt distant GitHub")

    let unknownHandover = try await isolated.call("POST", "\(base)/handover/zz/commit", token: token, json: ["slugs": []])
    #expect(unknownHandover.status == 404)
    #expect(unknownHandover.errorMessage == "bascule inconnue")

    let done = try await isolated.call("DELETE", "\(base)/handover/h1", token: token)
    #expect(done.status == 409)
    #expect(done.errorMessage == "bascule déjà terminée")

    // Refus de la coque, avant tout appel au service.
    let unknownRepo = try await isolated.call("POST", "/v1/repos/inconnu/handover", token: token, json: ["to": "vps"])
    #expect(unknownRepo.status == 404)
    #expect(unknownRepo.errorMessage == "dépôt inconnu")
    let badTarget = try await isolated.call("POST", "\(base)/handover", token: token, json: ["to": 3])
    #expect(badTarget.status == 400)
    #expect(badTarget.errorMessage == "machine cible invalide")
    let badSlugs = try await isolated.call("POST", "\(base)/handover/h1/commit", token: token, json: ["slugs": [1]])
    #expect(badSlugs.status == 400)
    #expect(badSlugs.errorMessage == #"corps attendu : {"slugs":["…"]}"#)
    let badAdopt = try await isolated.call("POST", "/v1/repos/adopt", token: token, json: ["identity": 3])
    #expect(badAdopt.status == 400)
    #expect(badAdopt.errorMessage == #"corps attendu : {"identity":"github.com/<owner>/<name>","features":[…]}"#)
    // Sans corps.
    let empty = try await isolated.call("POST", "\(base)/handover", token: token)
    #expect(empty.status == 400)
    #expect(empty.errorMessage == "corps JSON absent")
}

@MainActor
@Test("bascule distante du Mac : un clonage impossible ou un service arrêté est un 503 avec son motif")
func macHandoverRoutesReportAnUnavailableService() async throws {
    let store = StoreFixture()
    let repoRoot = try publishRepo(store, name: "depot-panne", origin: nil)
    store.publish(.lots, "\(fixtureId(0xB6)).json", object: lotObject(id: fixtureId(0xB6), repoRoot: repoRoot))
    let transport = ScriptedServiceTransport()
    transport.stubStatus("POST", "/v1/repos/adopt", status: 503, json: ["error": "unavailable", "reason": "clonage impossible : fatal"])
    let stack = try await RemoteStack.make(stateDir: store.root, makeServiceClient: { scriptedClient(transport) })
    defer { stack.stop() }
    let token = try await stack.pair()
    let refused = try await stack.call("POST", "/v1/repos/adopt", token: token, json: ["identity": "github.com/o/r", "features": []])
    #expect(refused.status == 503)
    #expect(refused.errorMessage == "clonage impossible : fatal")

    // Le service local est arrêté : 503, jamais un 500.
    let stopped = try await RemoteStack.make(stateDir: store.root)
    defer { stopped.stop() }
    let stoppedToken = try await stopped.pair()
    let down = try await stopped.call("POST", "/v1/repos/adopt", token: stoppedToken, json: ["identity": "github.com/o/r", "features": []])
    #expect(down.status == 503)
}

@MainActor
@Test("bascule distante du Mac : GET /v1/repos porte l’identité de l’origin et la bascule inscrite, repos.json ajoute les dépôts adoptés")
func macReposRowsCarryIdentityHandoverAndAdoptedRepos() async throws {
    let store = StoreFixture()
    let withOrigin = try publishRepo(store, name: "depot-github", origin: "git@github.com:Org/Depot.git")
    let withoutOrigin = try publishRepo(store, name: "depot-local", origin: nil)
    let adopted = try publishRepo(store, name: "depot-adopte", origin: nil)
    store.publish(.lots, "\(fixtureId(0xB7)).json", object: lotObject(id: fixtureId(0xB7), repoRoot: withOrigin))
    store.publish(.lots, "\(fixtureId(0xB8)).json", object: lotObject(id: fixtureId(0xB8), repoRoot: withoutOrigin))
    let adoptedKey = KanbanRepoKey.key(forRoot: adopted)
    let handoverKey = KanbanRepoKey.key(forRoot: withOrigin)
    try Data(#"{"version":1,"repos":[{"identity":"github.com/org/adopte","repoRoot":"\#(adopted)","adoptedAt":"2026-10-20T10:00:00Z"}]}"#.utf8)
        .write(to: URL(fileURLWithPath: store.root + "/repos.json"))
    try Data(#"{"version":1,"repos":{"\#(handoverKey)":{"id":"h9","to":"vps","state":"frozen","identity":"github.com/org/depot","at":"2026-10-20T10:00:00Z"}}}"#.utf8)
        .write(to: URL(fileURLWithPath: store.root + "/handovers.json"))
    let stack = try await RemoteStack.make(stateDir: store.root, environment: ["PATH": "/usr/bin:/bin"])
    defer { stack.stop() }
    let token = try await stack.pair()

    let rows = try await stack.call("GET", "/v1/repos", token: token).json(RemoteReposPayload.self).rows
    let byRoot = Dictionary(uniqueKeysWithValues: rows.map { ($0.repoRoot, $0) })
    #expect(rows.count == 3)
    #expect(byRoot[withOrigin]?.identity == "github.com/org/depot")
    #expect(byRoot[withOrigin]?.handover == RepoHandover(id: "h9", to: .vps, state: .frozen))
    #expect(byRoot[withoutOrigin]?.identity == nil)
    #expect(byRoot[withoutOrigin]?.handover == nil)
    // Le dépôt adopté est connu (sans lot ni projet) et garde l'identité de `repos.json`.
    #expect(byRoot[adopted]?.repoKey == adoptedKey)
    #expect(byRoot[adopted]?.identity == "github.com/org/adopte")
    // Les clés absentes ne sont pas sérialisées : seules deux lignes portent une identité.
    let raw = try await stack.call("GET", "/v1/repos", token: token).text
    #expect(raw.components(separatedBy: #""identity""#).count - 1 == 2)
    #expect(raw.components(separatedBy: #""handover""#).count - 1 == 1)
}
