// Les preuves des routes de LECTURE (S-7) : le magasin, les sessions et les
// documents, servis à l'instant de la requête depuis les couches existantes.
//
// Tout passe par la pile RÉELLE du harnais (`RemoteStack`) sur un magasin jetable
// peuplé AVANT la construction de la pile : le hub lit à sa naissance, et c'est
// ce premier instantané que l'API doit rendre — jamais une relecture disque.

import ConsoleCore
import Foundation
import Testing

@testable import OMPConsole

@Suite("Remote lectures")
@MainActor
struct RemoteReadRoutesTests {

    // MARK: - Outillage

    private static func write(_ path: String, _ text: String) throws {
        let directory = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        try Data(text.utf8).write(to: URL(fileURLWithPath: path))
    }

    private static func writeSession(_ path: String, lines: [String]) throws {
        try write(path, lines.joined(separator: "\n") + "\n")
    }

    /// Le chemin percent-encodé d'un segment : `%2F` reste DANS le segment (S-1),
    /// sinon un chemin de session se briserait en deux.
    private static func encoded(_ segment: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return segment.addingPercentEncoding(withAllowedCharacters: allowed) ?? segment
    }

    /// Un répertoire de dépôt RÉEL : les appariements passent par `realpath`, donc
    /// le chemin doit exister.
    private static func makeRepo(_ fixture: StoreFixture) throws -> String {
        let root = joinPath(fixture.root, "depot")
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
        return root
    }

    // MARK: - AC-6

    @Test("api-distante-du-console/AC-6 : l'appareil appairé obtient le magasin, les sessions et les documents à l'instant de la requête")
    func storeSessionsAndDocumentsAtRequestTime() async throws {
        let fixture = StoreFixture()
        let repoRoot = try Self.makeRepo(fixture)
        let repoKey = ProjectPaths.key(forRoot: repoRoot)
        let sessionPath = joinPath(joinPath(fixture.root, "sessions"), "2026-09-28T15-07-55-136Z_01a0e88e.jsonl")
        try Self.writeSession(sessionPath, lines: [
            ViewerLines.header(id: "session-1"),
            ViewerLines.user("bonjour le magasin"),
        ])

        fixture.publish(
            .running,
            "\(fixtureId(1)).json",
            object: runningObject(
                id: fixtureId(1),
                cwd: repoRoot,
                phaseStartedAt: fixtureT0,
                updatedAt: fixtureT0,
                ownerPid: Double(getpid()),
                sessionFile: sessionPath
            )
        )
        fixture.publish(
            .projects,
            "\(fixtureId(2)).json",
            object: projectObject(
                repoKey: repoKey,
                repoRoot: repoRoot,
                segments: [[
                    "name": "Segment",
                    "features": [projectFeatureObject(slug: "feature-a")],
                ]],
                current: 0
            )
        )

        // Les DEUX documents : `PROJECT.md` du magasin, contrat de la racine du projet.
        try Self.write(ProjectPaths.docFile(stateDir: fixture.root, repoKey: repoKey), "# Projet\n")
        try Self.write(joinPath(repoRoot, ".omp/pipeline/contract.md"), "# Contrat\n")

        let stack = try await RemoteStack.make(stateDir: fixture.root)
        defer { stack.stop() }
        let token = try await stack.pair()

        // (1) Le magasin : EXACTEMENT l'instantané du hub, octet pour octet.
        let storeReply = try await stack.call("GET", "/v1/store", token: token)
        #expect(storeReply.status == 200)
        #expect(storeReply.headers["x-console-protocol-version"] == "1")
        #expect((try? JSONSerialization.jsonObject(with: storeReply.body)) != nil)
        let expectedBody = try HTTPJSON.encode(RemoteStorePayload(snapshot: stack.storeHub.current()))
        #expect(storeReply.body == expectedBody)
        let store = try storeReply.json(RemoteStorePayload.self)
        #expect(store.snapshot.root == .present)
        #expect(store.snapshot.running.entries.compactMap(\.sessionFile) == [sessionPath])
        #expect(store.snapshot.projects.projects.map(\.repoKey) == [repoKey])

        // (2) Les sessions : la liste de `storeRuns`, même ordre, même contenu.
        let sessionsReply = try await stack.call("GET", "/v1/sessions", token: token)
        #expect(sessionsReply.status == 200)
        let sessions = try sessionsReply.json(RemoteSessionsPayload.self)
        #expect(sessions.runs.map(\.sessionFile) == storeRuns(of: stack.storeHub.current()).map(\.sessionFile))
        #expect(sessions.runs.map(\.sessionFile) == [sessionPath])

        // (3) Une session : la conversation, bornée, non tronquée.
        let sessionReply = try await stack.call("GET", "/v1/sessions/\(Self.encoded(sessionPath))", token: token)
        #expect(sessionReply.status == 200)
        let session = try sessionReply.json(RemoteSessionPayload.self)
        #expect(session.header?.id == "session-1")
        #expect(session.entries.count == 1)
        #expect(session.entries.first?.kind == "user")
        #expect(session.truncated == false)

        // (4) Les documents : DEUX, dans l'ordre `PROJECT.md` puis `contract.md`.
        let docsReply = try await stack.call("GET", "/v1/projects/\(repoKey)/documents", token: token)
        #expect(docsReply.status == 200)
        let docs = try docsReply.json(RemoteDocumentsPayload.self)
        #expect(docs.documents.map(\.name) == ["PROJECT.md", "contract.md"])
        #expect(docs.documents.map(\.state) == ["text", "text"])
        #expect(docs.documents[0].content?.contains("Projet") == true)
        #expect(docs.documents[1].content?.contains("Contrat") == true)
        #expect(docs.documents.allSatisfy { $0.reason == nil })
    }

    // MARK: - Complémentaires

    @Test func testStoreAbsentIsNotAnError() async throws {
        // Un magasin dont la RACINE n'existe pas : le chemin est sous un fichier.
        let blocker = joinPath(NSTemporaryDirectory(), "omp-console-blocker-\(UUID().uuidString)")
        try Data("x".utf8).write(to: URL(fileURLWithPath: blocker))
        defer { try? FileManager.default.removeItem(atPath: blocker) }

        let stack = try await RemoteStack.make(stateDir: joinPath(blocker, "pipeline"))
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/store", token: token)
        #expect(reply.status == 200)
        let payload = try reply.json(RemoteStorePayload.self)
        #expect(payload.snapshot.root == .absent)
        #expect(payload.snapshot.running.entries.isEmpty)
        #expect(payload.snapshot.history.entries.isEmpty)
        #expect(payload.snapshot.lots.lots.isEmpty)
        #expect(payload.snapshot.projects.projects.isEmpty)
        #expect(payload.snapshot.inbox.boxes.isEmpty)
        #expect(payload.snapshot.audit.relays.isEmpty)
    }

    @Test func testUnknownProjectIsNotFound() async throws {
        let fixture = StoreFixture()
        let stack = try await RemoteStack.make(stateDir: fixture.root)
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/projects/inconnu/documents", token: token)
        #expect(reply.status == 404)
        #expect(reply.errorCode == "not_found")
    }

    @Test func testUnknownSessionIsNotFound() async throws {
        let fixture = StoreFixture()
        let stack = try await RemoteStack.make(stateDir: fixture.root)
        defer { stack.stop() }
        let token = try await stack.pair()

        let missing = joinPath(fixture.root, "sessions/absente.jsonl")
        let reply = try await stack.call("GET", "/v1/sessions/\(Self.encoded(missing))", token: token)
        #expect(reply.status == 404)
        #expect(reply.errorCode == "not_found")
        #expect(reply.errorMessage == "session introuvable")
    }

    @Test func testMissingDocumentIsReported() async throws {
        let fixture = StoreFixture()
        let repoRoot = try Self.makeRepo(fixture)
        let repoKey = ProjectPaths.key(forRoot: repoRoot)
        fixture.publish(
            .projects,
            "\(fixtureId(3)).json",
            object: projectObject(
                repoKey: repoKey,
                repoRoot: repoRoot,
                segments: [[
                    "name": "Segment",
                    "features": [projectFeatureObject(slug: "feature-a")],
                ]],
                current: 0
            )
        )

        let stack = try await RemoteStack.make(stateDir: fixture.root)
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/projects/\(repoKey)/documents", token: token)
        #expect(reply.status == 200)
        let docs = try reply.json(RemoteDocumentsPayload.self)
        #expect(docs.documents.map(\.name) == ["PROJECT.md", "contract.md"])
        #expect(docs.documents.map(\.state) == ["missing", "missing"])
        #expect(docs.documents.allSatisfy { $0.content == nil && $0.reason == nil })
    }

    /// La troncature est RÉELLE et exercée : 2001 entrées dépassent la borne de
    /// 2000 (`RemoteLimits.sessionEntries`), la réponse le dit et borne la liste.
    @Test func testTruncationIsReported() async throws {
        let fixture = StoreFixture()
        let sessionPath = joinPath(fixture.root, "sessions/longue.jsonl")
        var lines = [ViewerLines.header(id: "longue")]
        lines.append(contentsOf: (0..<2001).map { ViewerLines.user("prompt \($0)", id: "u\($0)") })
        try Self.writeSession(sessionPath, lines: lines)

        let stack = try await RemoteStack.make(stateDir: fixture.root)
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/sessions/\(Self.encoded(sessionPath))", token: token)
        #expect(reply.status == 200)
        let payload = try reply.json(RemoteSessionPayload.self)
        #expect(payload.truncated == true)
        #expect(payload.entries.count == RemoteLimits.sessionEntries)
    }

    @Test func testDiscardedEntriesArePreserved() async throws {
        let fixture = StoreFixture()
        let broken = "\(fixtureId(9)).json"
        // Un contenu qui n'est pas du JSON : écarté, NOMMÉ, jamais rendu partiel.
        fixture.put(.running, broken, text: "ceci n'est pas du JSON")

        let stack = try await RemoteStack.make(stateDir: fixture.root)
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/store", token: token)
        #expect(reply.status == 200)
        let payload = try reply.json(RemoteStorePayload.self)
        #expect(payload.snapshot.running.entries.isEmpty)
        #expect(payload.snapshot.running.discardedEntries.map(\.file) == ["running/\(broken)"])
        #expect(payload.snapshot.running.discardedEntries.first?.reason == .unparsable)
    }

    /// La borne d'OCTETS (S-7) : trois entrées d'environ 900 Kio dépassent 2 Mio, la
    /// réponse est tronquée — et le dit — jusqu'à tenir sous la borne.
    @Test func testByteBoundTruncatesLargeSession() async throws {
        let fixture = StoreFixture()
        let sessionPath = joinPath(fixture.root, "sessions/enorme.jsonl")
        let bloc = String(repeating: "x", count: 900_000)
        try Self.writeSession(sessionPath, lines: [
            ViewerLines.header(id: "enorme"),
            ViewerLines.user(bloc, id: "u1"),
            ViewerLines.user(bloc, id: "u2"),
            ViewerLines.user(bloc, id: "u3"),
        ])

        let stack = try await RemoteStack.make(stateDir: fixture.root)
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/sessions/\(Self.encoded(sessionPath))", token: token)
        #expect(reply.status == 200)
        #expect(reply.body.count <= RemoteLimits.responseBody)
        let payload = try reply.json(RemoteSessionPayload.self)
        #expect(payload.truncated == true)
        #expect(payload.entries.count < 3)
    }

    /// Un document PRÉSENT mais illisible donne `unreadable` avec sa raison, jamais
    /// `missing` (S-7) : un répertoire portant le nom du document le prouve.
    @Test func testUnreadableDocumentIsReported() async throws {
        let fixture = StoreFixture()
        let repoRoot = try Self.makeRepo(fixture)
        let repoKey = ProjectPaths.key(forRoot: repoRoot)
        try FileManager.default.createDirectory(
            atPath: joinPath(repoRoot, ".omp/pipeline/contract.md"),
            withIntermediateDirectories: true
        )
        fixture.publish(
            .projects,
            "\(fixtureId(4)).json",
            object: projectObject(
                repoKey: repoKey,
                repoRoot: repoRoot,
                segments: [[
                    "name": "Segment",
                    "features": [projectFeatureObject(slug: "feature-a")],
                ]],
                current: 0
            )
        )

        let stack = try await RemoteStack.make(stateDir: fixture.root)
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/projects/\(repoKey)/documents", token: token)
        #expect(reply.status == 200)
        let docs = try reply.json(RemoteDocumentsPayload.self)
        #expect(docs.documents.map(\.state) == ["missing", "unreadable"])
        let contract = try #require(docs.documents.last)
        #expect(contract.content == nil)
        #expect(contract.reason != nil)
    }

    // MARK: - S-8 : les dépôts connus

    @Test("les dépôts connus sont triés, dédoublonnés et filtrés par la règle racine git")
    func knownReposAreSortedDedupedAndGitFiltered() async throws {
        let fixture = StoreFixture()
        // Deux racines git RÉELLES (le filtre exige `<chemin>/.git`).
        let alpha = joinPath(fixture.root, "alpha")
        let beta = joinPath(fixture.root, "beta")
        let plain = joinPath(fixture.root, "plain")
        for path in [alpha, beta] {
            try FileManager.default.createDirectory(atPath: joinPath(path, ".git"), withIntermediateDirectories: true)
        }
        try FileManager.default.createDirectory(atPath: plain, withIntermediateDirectories: true)

        // alpha n'a qu'un LOT (jamais cadré) ; beta qu'un PROJET ; alpha EST AUSSI un
        // projet pour prouver le dédoublonnage ; plain n'est pas une racine git.
        fixture.publish(.lots, "\(fixtureId(0xB1)).json", object: lotObject(id: fixtureId(0xB1), repoRoot: alpha))
        fixture.publish(.lots, "\(fixtureId(0xB2)).json", object: lotObject(id: fixtureId(0xB2), repoRoot: plain))
        fixture.publish(.projects, "\(fixtureId(0xB3)).json", object: projectObject(
            repoKey: ProjectPaths.key(forRoot: beta),
            repoRoot: beta
        ))
        fixture.publish(.projects, "\(fixtureId(0xB4)).json", object: projectObject(
            repoKey: ProjectPaths.key(forRoot: alpha),
            repoRoot: alpha
        ))

        let stack = try await RemoteStack.make(stateDir: fixture.root)
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/repos", token: token)
        #expect(reply.status == 200)
        let payload = try reply.json(RemoteReposPayload.self)
        #expect(payload.rows.map(\.repoRoot) == [realpathOr(alpha), realpathOr(beta)])
        #expect(payload.rows.map(\.name) == ["alpha", "beta"])
        #expect(payload.rows.map(\.repoKey) == [ProjectPaths.key(forRoot: alpha), ProjectPaths.key(forRoot: beta)])
    }

    @Test("un magasin sans dépôt connu rend une liste vide, jamais une erreur")
    func noKnownRepoIsAnEmptyList() async throws {
        let fixture = StoreFixture()
        let stack = try await RemoteStack.make(stateDir: fixture.root)
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/repos", token: token)
        #expect(reply.status == 200)
        #expect(try reply.json(RemoteReposPayload.self).rows.isEmpty)
    }
}
