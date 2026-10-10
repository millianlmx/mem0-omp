// L'orchestration de l'union (S-8, BR-5 ; AC-9) : doublure podman (`FakePodman`),
// bac à sable (`StackSandbox`) et doublure HTTP pilotée par port — aucun socket,
// aucun conteneur réel. On y prouve les SAUTS (source absente, ancienne pile en
// marche, empreinte inchangée), le passage complet (lecteur + marqueur) et le
// refus (aucun marqueur).
//
// La suite s'appelle `MemoryUnionRunnerTests` : c'est ce nom que `swift test
// --filter` sélectionne.

import Foundation
import Testing

@testable import OMPConsole

/// Un `URLProtocol` piloté par (méthode, port, chemin) — la même lecture de corps
/// que `StubURLProtocol`.
final class RunnerURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) -> (Int, Data)?)?

    static func reset() { handler = nil }

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RunnerURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var request = request
        if let stream = request.httpBodyStream {
            request.httpBody = Self.drain(stream)
        }
        guard let (status, body) = Self.handler?(request) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func drain(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

/// Le dossier de la base de l'ancienne pile, sous le HOME du bac à sable.
@discardableResult
private func makeLegacyStorage(in root: URL) throws -> URL {
    let storage = root.appendingPathComponent("Experiments/mem0-omp/mem0-stack/qdrant_storage")
    let collection = storage.appendingPathComponent("collections/omp_memory", isDirectory: true)
    try FileManager.default.createDirectory(at: collection, withIntermediateDirectories: true)
    try Data("segment".utf8).write(to: collection.appendingPathComponent("segment.bin"))
    return storage
}

@MainActor
private func makeUnionRunner(sandbox: StackSandbox, fake: FakePodman, session: URLSession) -> MemoryUnionRunner {
    let runner = MemoryUnionRunner(
        paths: sandbox.paths,
        manifest: .current,
        environment: ["HOME": sandbox.root.path],
        run: fake.runner(),
        session: session
    )
    runner.readyBudget = 2
    runner.pollInterval = 0.01
    runner.probeTimeout = 1
    return runner
}

@MainActor
struct MemoryUnionRunnerTests {
    @Test("bug-embedded-podman-machine/AC-9 : source absente rend .nothingToDo et n'appelle AUCUNE commande podman")
    func runnerSkipsWhenSourceAbsent() async {
        guard let sandbox = try? StackSandbox() else { Issue.record("bac à sable"); return }
        defer { sandbox.remove() }
        let fake = FakePodman()

        let outcome = await makeUnionRunner(sandbox: sandbox, fake: fake, session: RunnerURLProtocol.session()).run()

        #expect(outcome == .nothingToDo)
        #expect(fake.podmanCalls.isEmpty)
    }

    @Test("bug-embedded-podman-machine/AC-9 : l'ancienne pile qui tourne rend .nothingToDo sans lancer de lecteur")
    func runnerSkipsWhenLegacyStackRuns() async {
        guard let sandbox = try? StackSandbox() else { Issue.record("bac à sable"); return }
        defer { sandbox.remove() }
        let fake = FakePodman()
        fake.dockerContainersJSON = #"[{"Names":["/mem0-qdrant"],"Id":"x","State":"running","Ports":[{"PublicPort":6333}]}]"#

        let outcome = await makeUnionRunner(sandbox: sandbox, fake: fake, session: RunnerURLProtocol.session()).run()

        #expect(outcome == .nothingToDo)
        #expect(!fake.podmanCalls.contains { $0.arguments.contains("omp-console-union") })
    }

    @Test("bug-embedded-podman-machine/AC-9 : une empreinte inchangée rend .nothingToDo")
    func runnerSkipsWhenFingerprintUnchanged() async throws {
        let sandbox = try StackSandbox()
        defer { sandbox.remove() }
        let fake = FakePodman()
        let storage = try makeLegacyStorage(in: sandbox.root)
        try FileManager.default.createDirectory(at: sandbox.paths.stackRoot, withIntermediateDirectories: true)
        let fingerprint = MemoryUnionRunner.sourceFingerprint(of: storage)
        let marker: [String: Any] = [
            "version": 1, "source": storage.path, "fingerprint": fingerprint, "copied": 0,
            "date": "2026-10-06T00:00:00Z",
        ]
        try JSONSerialization.data(withJSONObject: marker).write(to: sandbox.paths.unionState)

        let outcome = await makeUnionRunner(sandbox: sandbox, fake: fake, session: RunnerURLProtocol.session()).run()

        #expect(outcome == .nothingToDo)
        #expect(fake.podmanCalls.isEmpty)
    }

    @Test("bug-embedded-podman-machine/AC-9 : un passage réussi lance le lecteur, le retire et écrit union.json")
    func runnerRunsReaderAndWritesMarker() async throws {
        let sandbox = try StackSandbox()
        defer { sandbox.remove() }
        let fake = FakePodman()
        let storage = try makeLegacyStorage(in: sandbox.root)

        RunnerURLProtocol.reset()
        RunnerURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            if path == "/readyz" { return (200, Data("{}".utf8)) }
            if path == "/collections" {
                return (200, Data(#"{"result":{"collections":[{"name":"omp_memory"}]}}"#.utf8))
            }
            if path.hasSuffix("/points/scroll") {
                return (200, Data(#"{"result":{"points":[],"next_page_offset":null}}"#.utf8))
            }
            return (200, Data("{}".utf8))
        }

        let outcome = await makeUnionRunner(sandbox: sandbox, fake: fake, session: RunnerURLProtocol.session()).run()

        #expect(outcome == .nothingCopied(source: storage.path, fingerprint: MemoryUnionRunner.sourceFingerprint(of: storage)))
        // Le lecteur a été lancé puis retiré.
        #expect(fake.podmanCalls.contains { $0.arguments.contains("omp-console-union") })
        #expect(fake.contains(["container", "rm", "-f", "omp-console-union"]))
        // Le marqueur est écrit et porte la source et l'empreinte.
        let data = try #require(try? Data(contentsOf: sandbox.paths.unionState))
        let marker = try #require(try? JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(marker["source"] as? String == storage.path)
        #expect(marker["fingerprint"] as? String == MemoryUnionRunner.sourceFingerprint(of: storage))
        #expect((marker["copied"] as? NSNumber)?.intValue == 0)
        #expect(marker["version"] as? Int == 1)
        // Le staging est retiré.
        let remaining = (try? FileManager.default.contentsOfDirectory(atPath: sandbox.paths.unionStagingRoot.path)) ?? []
        #expect(remaining.isEmpty)
    }

    @Test("bug-embedded-podman-machine/AC-9 : un lot refusé rend .incomplete et n'écrit AUCUN union.json")
    func runnerDoesNotWriteMarkerOnRefusedBatch() async throws {
        let sandbox = try StackSandbox()
        defer { sandbox.remove() }
        let fake = FakePodman()
        _ = try makeLegacyStorage(in: sandbox.root)

        RunnerURLProtocol.reset()
        RunnerURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            let port = request.url?.port
            if path == "/readyz" { return (200, Data("{}".utf8)) }
            if path == "/collections" {
                return (200, Data(#"{"result":{"collections":[{"name":"omp_memory"}]}}"#.utf8))
            }
            if path.hasSuffix("/points/scroll") {
                // La source (6335) porte un id ; la cible (6333) est vide.
                if port == 6335 {
                    return (200, Data(#"{"result":{"points":[{"id":1}],"next_page_offset":null}}"#.utf8))
                }
                return (200, Data(#"{"result":{"points":[],"next_page_offset":null}}"#.utf8))
            }
            if path.hasSuffix("/points") {
                if request.httpMethod == "PUT" {
                    return (500, Data(#"{"status":{"error":"refused"}}"#.utf8))
                }
                return (200, Data(#"{"result":[{"id":1,"vector":[0.5],"payload":{}}]}"#.utf8))
            }
            return (200, Data("{}".utf8))
        }

        let outcome = await makeUnionRunner(sandbox: sandbox, fake: fake, session: RunnerURLProtocol.session()).run()

        #expect(outcome == .incomplete(copied: 0, reason: "500 {\"status\":{\"error\":\"refused\"}}"))
        #expect(!FileManager.default.fileExists(atPath: sandbox.paths.unionState.path))
        // Le nettoyage a quand même eu lieu.
        #expect(fake.contains(["container", "rm", "-f", "omp-console-union"]))
    }
}
