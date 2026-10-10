// L'ancienne pile mémoire (S-6, BR-7 ; AC-6) : découverte et arrêt SUR ORDRE.
//
// Deux preuves distinctes : la DÉCOUVERTE (`running`, `locatedStorage`) — par la
// doublure `DockerCurlDouble` et par le repli disque, comme `StackMigrationTests` —
// et l'ARRÊT (`stop`) qui tolère 204/304/404 et nomme tout autre code. Plus la
// garde de S-6 : tant qu'un conteneur legacy TOURNE, la migration ne copie pas sa
// base et ne l'arrête jamais.

import Foundation
import Testing

@testable import OMPConsole

// MARK: - Fixtures

private func tempRoot() throws -> URL {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("omp-legacy-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
}

/// Écrit `<storage>/collections/<doc>/storage.sqlite` (la forme mesurée de
/// `qdrant_storage`).
@discardableResult
private func writeCollections(at storage: URL, docs: [String] = ["d1"]) throws -> URL {
    for doc in docs {
        let directory = storage.appendingPathComponent("collections/\(doc)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("point de \(doc)".utf8).write(to: directory.appendingPathComponent("storage.sqlite"))
    }
    return storage.appendingPathComponent("collections", isDirectory: true)
}

private func inspectJSON(source: String) -> String {
    """
    {"Id":"q1","Mounts":[{"Type":"bind","Source":"\(source)","Destination":"/qdrant/storage"}],"Config":{"Labels":{}}}
    """
}

private let bothContainers = """
[
  {"Id":"q1","Names":["/mem0-qdrant"],"State":"running"},
  {"Id":"h1","Names":["/mem0-http"],"State":"exited"}
]
"""

// MARK: - La découverte

@Test("bug-embedded-podman-machine/AC-6 : `running` rend les noms des conteneurs legacy qui TOURNENT, dans l'ordre figé")
@MainActor
func runningListsTheRunningLegacyContainers() async throws {
    let home = try tempRoot()
    defer { try? FileManager.default.removeItem(at: home) }

    let double = DockerCurlDouble()
    double.route = { _, url in
        if url.hasSuffix("/containers/json?all=true") { return ProcessRun(code: 0, stdout: bothContainers, stderr: "", timedOut: false) }
        return ProcessRun(code: 7, stdout: "", stderr: "", timedOut: false)
    }

    let running = await LegacyStack.running(environment: ["HOME": home.path], run: double.runner)
    #expect(running == ["mem0-qdrant"])
}

@Test("bug-embedded-podman-machine/AC-6 : `locatedStorage` lit le montage `/qdrant/storage` du premier socket qui répond")
@MainActor
func locatedStorageReadsTheMount() async throws {
    let home = try tempRoot()
    defer { try? FileManager.default.removeItem(at: home) }
    // Un conteneur ARRÊTÉ : la découverte inspecte quand même pour retrouver la base.
    let storage = home.appendingPathComponent("legacy/qdrant_storage", isDirectory: true)

    let double = DockerCurlDouble()
    double.route = { _, url in
        if url.hasSuffix("/containers/json?all=true") { return ProcessRun(code: 0, stdout: bothContainers, stderr: "", timedOut: false) }
        if url.hasSuffix("/containers/mem0-qdrant/json") { return ProcessRun(code: 0, stdout: inspectJSON(source: storage.path), stderr: "", timedOut: false) }
        return ProcessRun(code: 7, stdout: "", stderr: "", timedOut: false)
    }

    let located = await LegacyStack.locatedStorage(environment: ["HOME": home.path], run: double.runner)
    #expect(located == storage)
}

@Test("bug-embedded-podman-machine/AC-6 : aucun socket ne répond ⇒ `locatedStorage` retombe sur la première base disque non vide")
@MainActor
func locatedStorageFallsBackToDisk() async throws {
    let home = try tempRoot()
    defer { try? FileManager.default.removeItem(at: home) }
    // Le DEUXIÈME candidat porte une base ; le premier (`Experiments`) est absent.
    let legacy = home.appendingPathComponent("dev/mem0-omp/mem0-stack/qdrant_storage", isDirectory: true)
    try writeCollections(at: legacy)

    let double = DockerCurlDouble()
    double.route = { _, _ in ProcessRun(code: 7, stdout: "", stderr: "curl: (7)", timedOut: false) }

    let located = await LegacyStack.locatedStorage(environment: ["HOME": home.path], run: double.runner)
    #expect(located == legacy)
    // Le repli disque ne « tourne » pas : aucun conteneur n'est déclaré en marche.
    let running = await LegacyStack.running(environment: ["HOME": home.path], run: double.runner)
    #expect(running.isEmpty)
}

// MARK: - L'arrêt

@Test("bug-embedded-podman-machine/AC-6 : `stop` tolère 204 et 304, dans l'ordre figé des conteneurs")
@MainActor
func stopToleratesStoppedAndAlreadyStopped() async throws {
    let home = try tempRoot()
    defer { try? FileManager.default.removeItem(at: home) }
    let running = """
    [
      {"Id":"q1","Names":["/mem0-qdrant"],"State":"running"},
      {"Id":"h1","Names":["/mem0-http"],"State":"running"}
    ]
    """

    let double = DockerCurlDouble()
    double.route = { _, url in
        if url.hasSuffix("/containers/json?all=true") { return ProcessRun(code: 0, stdout: running, stderr: "", timedOut: false) }
        if url.hasSuffix("/containers/mem0-qdrant/stop?t=10") { return ProcessRun(code: 0, stdout: "204", stderr: "", timedOut: false) }
        if url.hasSuffix("/containers/mem0-http/stop?t=10") { return ProcessRun(code: 0, stdout: "304", stderr: "", timedOut: false) }
        return ProcessRun(code: 7, stdout: "", stderr: "", timedOut: false)
    }

    let stopped = try await LegacyStack.stop(environment: ["HOME": home.path], run: double.runner)
    #expect(stopped == ["mem0-qdrant", "mem0-http"])
    // L'ordre des `POST …/stop` suit `containerNames`.
    let stopUrls = double.calls.compactMap { $0.arguments.last }.filter { $0.hasSuffix("/stop?t=10") }
    #expect(stopUrls == ["http://localhost/containers/mem0-qdrant/stop?t=10", "http://localhost/containers/mem0-http/stop?t=10"])
}

@Test("bug-embedded-podman-machine/AC-6 : `stop` tolère 404 (absent) sans le consigner")
@MainActor
func stopToleratesAbsent() async throws {
    let home = try tempRoot()
    defer { try? FileManager.default.removeItem(at: home) }

    let double = DockerCurlDouble()
    double.route = { _, url in
        if url.hasSuffix("/containers/json?all=true") { return ProcessRun(code: 0, stdout: bothContainers, stderr: "", timedOut: false) }
        if url.hasSuffix("/containers/mem0-qdrant/stop?t=10") { return ProcessRun(code: 0, stdout: "404", stderr: "", timedOut: false) }
        return ProcessRun(code: 7, stdout: "", stderr: "", timedOut: false)
    }

    let stopped = try await LegacyStack.stop(environment: ["HOME": home.path], run: double.runner)
    #expect(stopped.isEmpty)
}

@Test("bug-embedded-podman-machine/AC-6 : un stop qui rend 500 lève `stopFailed(container:detail:)`")
@MainActor
func stopFailureRaisesStopFailed() async throws {
    let home = try tempRoot()
    defer { try? FileManager.default.removeItem(at: home) }

    let double = DockerCurlDouble()
    double.route = { _, url in
        if url.hasSuffix("/containers/json?all=true") { return ProcessRun(code: 0, stdout: bothContainers, stderr: "", timedOut: false) }
        if url.hasSuffix("/containers/mem0-qdrant/stop?t=10") { return ProcessRun(code: 0, stdout: "500", stderr: "", timedOut: false) }
        return ProcessRun(code: 7, stdout: "", stderr: "", timedOut: false)
    }

    await #expect(throws: LegacyStackError.stopFailed(container: "mem0-qdrant", detail: "code HTTP 500")) {
        _ = try await LegacyStack.stop(environment: ["HOME": home.path], run: double.runner)
    }
    // L'arrêt s'interrompt au premier échec : `mem0-http` n'est jamais visé.
    #expect(!double.calls.contains { $0.arguments.last?.hasSuffix("/containers/mem0-http/stop?t=10") == true })
}

// MARK: - La garde de la migration

@Test("bug-embedded-podman-machine/AC-6 : garde — un conteneur legacy qui TOURNE interdit la copie et n'est jamais arrêté")
@MainActor
func migrationGuardCopiesOnlyWhenNoLegacyContainerRuns() async throws {
    let root = try tempRoot()
    let home = try tempRoot()
    let legacy = home.appendingPathComponent("legacy", isDirectory: true)
    let storage = legacy.appendingPathComponent("qdrant_storage", isDirectory: true)
    try writeCollections(at: storage, docs: ["vivante"])
    defer {
        try? FileManager.default.removeItem(at: root)
        try? FileManager.default.removeItem(at: home)
    }

    let running = """
    [{"Id":"q1","Names":["/mem0-qdrant"],"State":"running"}]
    """
    let double = DockerCurlDouble()
    double.route = { _, url in
        if url.hasSuffix("/containers/json?all=true") { return ProcessRun(code: 0, stdout: running, stderr: "", timedOut: false) }
        if url.hasSuffix("/containers/mem0-qdrant/json") { return ProcessRun(code: 0, stdout: inspectJSON(source: storage.path), stderr: "", timedOut: false) }
        return ProcessRun(code: 7, stdout: "", stderr: "", timedOut: false)
    }

    let paths = AppPaths(supportRoot: root)
    let migration = StackMigration(paths: paths, environment: ["HOME": home.path], run: double.runner)
    var steps: [MigrationStep] = []
    let outcome = try await migration.run(progress: { steps.append($0) })

    #expect(outcome.legacyStorage == storage)
    #expect(outcome.copied == false)
    #expect(steps.isEmpty)
    #expect(!FileManager.default.fileExists(atPath: paths.qdrantStorage.path))
    // Aucun arrêt automatique : la doublure n'a reçu aucun `POST …/stop`.
    #expect(!double.calls.contains { $0.arguments.last?.hasSuffix("/stop?t=10") == true })
}
