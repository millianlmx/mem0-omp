// La migration de l'ancienne base vers la pile de l'app (S-3/S-6, BR-3/BR-7 ;
// AC-6).
//
// Chaque test monte une racine de support TEMPORAIRE et joue le pipeline complet de
// `StackMigration.run()` contre la doublure `DockerCurlDouble` (aucun socket réel),
// ou contre le repli disque quand aucun socket ne répond. On vérifie le résultat
// observable : la base copiée, la source INTACTE, le `.env` importé en 0600, le
// marqueur v2 — et l'INVARIANT de S-6 : la migration n'arrête JAMAIS un conteneur
// de l'ancienne pile, et ne copie pas une base dont la pile tourne encore.

import Darwin
import Foundation
import Testing

@testable import OMPConsole

// MARK: - Fixtures

/// Une racine temporaire neuve, supprimée à la fin du test.
private func tempRoot() throws -> URL {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("omp-migration-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
}

/// Écrit `<storage>/collections/<doc>/storage.sqlite` — la forme MESURÉE du dossier
/// `qdrant_storage` de l'ancienne pile.
@discardableResult
private func writeCollections(at storage: URL, docs: [String] = ["d1"]) throws -> URL {
    for doc in docs {
        let directory = storage.appendingPathComponent("collections/\(doc)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("point de \(doc)".utf8).write(to: directory.appendingPathComponent("storage.sqlite"))
    }
    return storage.appendingPathComponent("collections", isDirectory: true)
}

private func fileExists(_ url: URL) -> Bool {
    FileManager.default.fileExists(atPath: url.path)
}

/// La charge d'inspect telle que `GET /containers/{nom}/json` la rend (mesurée).
private func inspectJSON(id: String, source: String, label: String?) -> String {
    let labels = label.map { #""com.docker.compose.project.working_dir":"\#($0)""# } ?? ""
    return """
    {"Id":"\(id)","Mounts":[{"Type":"bind","Source":"\(source)","Destination":"/qdrant/storage"}],"Config":{"Labels":{\(labels)}}}
    """
}

/// Un conteneur d'ancienne pile « exited » (l'ancienne pile est arrêtée mais ses
/// données restent) : la migration peut alors copier sa base.
private let exitedQdrant = """
[{"Id":"q1","Names":["/mem0-qdrant"],"State":"exited"}]
"""

/// Un conteneur d'ancienne pile « running » : la migration ne doit JAMAIS copier
/// sa base — ni l'arrêter.
private let runningQdrant = """
[{"Id":"q1","Names":["/mem0-qdrant"],"State":"running"}]
"""

/// Le contenu d'un fichier, comparé à l'octet près (invariant « source intacte »,
/// « pas de réécriture »).
private func bytes(_ url: URL) throws -> Data {
    try Data(contentsOf: url)
}

/// Un arbre de fichiers, prêt à comparer avant/après.
private func tree(_ root: URL) throws -> [String: Data] {
    var result: [String: Data] = [:]
    let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isDirectoryKey])
    while let url = enumerator?.nextObject() as? URL {
        let isDirectory = (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
        if !isDirectory { result[url.path.replacingOccurrences(of: root.path, with: "")] = try bytes(url) }
    }
    return result
}

// MARK: - Le pipeline par socket

@Test("bug-embedded-podman-machine/AC-6 : la découverte par socket copie la base d'une ancienne pile arrêtée, sans jamais l'arrêter")
@MainActor
func migrationOverSocketCopiesWithoutStopping() async throws {
    let root = try tempRoot()
    let home = try tempRoot()
    let legacy = home.appendingPathComponent("Experiments/mem0-omp/mem0-stack", isDirectory: true)
    let storage = legacy.appendingPathComponent("qdrant_storage", isDirectory: true)
    try writeCollections(at: storage, docs: ["memories", "projects"])
    try Data("OMLX_LLM_MODEL=LFM2.5-1.2B-Instruct-4bit\nOMLX_API_TOKEN=secret\n".utf8)
        .write(to: legacy.appendingPathComponent(".env"))
    defer {
        try? FileManager.default.removeItem(at: root)
        try? FileManager.default.removeItem(at: home)
    }

    let socket = "\(home.path)/.docker/run/docker.sock"
    let double = DockerCurlDouble()
    double.route = { _, url in
        if url.hasSuffix("/containers/json?all=true") {
            return ProcessRun(code: 0, stdout: exitedQdrant, stderr: "", timedOut: false)
        }
        if url.hasSuffix("/containers/mem0-qdrant/json") {
            return ProcessRun(code: 0, stdout: inspectJSON(id: "q1", source: storage.path, label: legacy.path), stderr: "", timedOut: false)
        }
        return ProcessRun(code: 7, stdout: "", stderr: "route absente", timedOut: false)
    }

    let paths = AppPaths(supportRoot: root)
    let migration = StackMigration(paths: paths, environment: ["HOME": home.path], run: double.runner)
    var steps: [MigrationStep] = []
    let outcome = try await migration.run(progress: { steps.append($0) })

    #expect(outcome.legacyStorage == storage)
    #expect(outcome.copied)
    #expect(outcome.configImported)
    #expect(steps == [.copy])

    // AUCUN arrêt automatique : la doublure n'a jamais reçu de `POST …/stop`.
    #expect(!double.calls.contains { $0.arguments.last?.hasSuffix("/stop?t=10") == true })
    #expect(double.calls.contains { $0.arguments == ["--silent", "--show-error", "--max-time", "10", "--unix-socket", socket, "http://localhost/containers/json?all=true"] })

    // La copie est complète et fidèle.
    #expect(fileExists(paths.qdrantStorage.appendingPathComponent("collections/memories/storage.sqlite")))
    #expect(try bytes(paths.qdrantStorage.appendingPathComponent("collections/projects/storage.sqlite"))
        == Data("point de projects".utf8))

    // L'import garde les valeurs réelles et met les clés absentes aux défauts.
    let config = try #require(StackEnvStore.load(at: paths.stackEnv))
    #expect(config.omlxLLMModel == "LFM2.5-1.2B-Instruct-4bit")
    #expect(config.omlxApiToken == "secret")
    #expect(config.qdrantApiKey == StackConfig.defaults.qdrantApiKey)
    #expect(config.omlxEmbedModel == StackConfig.defaults.omlxEmbedModel)
    let attributes = try FileManager.default.attributesOfItem(atPath: paths.stackEnv.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)

    // Le marqueur porte les quatre champs du contrat (version 2, plus de
    // `stoppedContainers`).
    let markerData = try bytes(paths.migrationState)
    let marker = try #require(try JSONSerialization.jsonObject(with: markerData) as? [String: Any])
    #expect(marker["version"] as? Int == 2)
    #expect(marker["source"] as? String == storage.path)
    #expect(marker["copied"] as? Bool == true)
    #expect(marker["stoppedContainers"] == nil)
    #expect((marker["date"] as? String)?.isEmpty == false)
}

@Test("bug-embedded-podman-machine/AC-6 : un conteneur legacy qui TOURNE interdit la copie et n'est jamais arrêté")
@MainActor
func runningLegacyBlocksCopyAndIsNeverStopped() async throws {
    let root = try tempRoot()
    let home = try tempRoot()
    let legacy = home.appendingPathComponent("legacy", isDirectory: true)
    let storage = legacy.appendingPathComponent("qdrant_storage", isDirectory: true)
    try writeCollections(at: storage, docs: ["vivante"])
    defer {
        try? FileManager.default.removeItem(at: root)
        try? FileManager.default.removeItem(at: home)
    }

    let double = DockerCurlDouble()
    double.route = { _, url in
        if url.hasSuffix("/containers/json?all=true") { return ProcessRun(code: 0, stdout: runningQdrant, stderr: "", timedOut: false) }
        if url.hasSuffix("/containers/mem0-qdrant/json") { return ProcessRun(code: 0, stdout: inspectJSON(id: "q1", source: storage.path, label: legacy.path), stderr: "", timedOut: false) }
        return ProcessRun(code: 7, stdout: "", stderr: "", timedOut: false)
    }

    let paths = AppPaths(supportRoot: root)
    let migration = StackMigration(paths: paths, environment: ["HOME": home.path], run: double.runner)
    var steps: [MigrationStep] = []
    let outcome = try await migration.run(progress: { steps.append($0) })

    // La source est vue, mais RIEN n'est copié tant que la pile tourne…
    #expect(outcome.legacyStorage == storage)
    #expect(outcome.copied == false)
    #expect(steps.isEmpty)
    #expect(!fileExists(paths.qdrantStorage))
    // …et la doublure n'a reçu AUCUN arrêt.
    #expect(!double.calls.contains { $0.arguments.last?.hasSuffix("/stop?t=10") == true })
}

// MARK: - Les gardes de la copie

@Test("bug-embedded-podman-machine/AC-6 : une base déjà présente n'est JAMAIS recouverte")
@MainActor
func existingBaseIsNeverOverwritten() async throws {
    let root = try tempRoot()
    let home = try tempRoot()
    let legacy = home.appendingPathComponent("legacy", isDirectory: true)
    let storage = legacy.appendingPathComponent("qdrant_storage", isDirectory: true)
    try writeCollections(at: storage, docs: ["ancienne"])
    let paths = AppPaths(supportRoot: root)
    try writeCollections(at: paths.qdrantStorage, docs: ["deja-la"])
    let sentinel = paths.qdrantStorage.appendingPathComponent("collections/deja-la/storage.sqlite")
    defer {
        try? FileManager.default.removeItem(at: root)
        try? FileManager.default.removeItem(at: home)
    }

    let double = DockerCurlDouble()
    double.route = { _, url in
        if url.hasSuffix("/containers/json?all=true") { return ProcessRun(code: 0, stdout: exitedQdrant, stderr: "", timedOut: false) }
        if url.hasSuffix("/containers/mem0-qdrant/json") { return ProcessRun(code: 0, stdout: inspectJSON(id: "q1", source: storage.path, label: legacy.path), stderr: "", timedOut: false) }
        return ProcessRun(code: 7, stdout: "", stderr: "", timedOut: false)
    }

    let migration = StackMigration(paths: paths, environment: ["HOME": home.path], run: double.runner)
    var steps: [MigrationStep] = []
    let outcome = try await migration.run(progress: { steps.append($0) })

    #expect(outcome.legacyStorage == storage)
    #expect(outcome.copied == false)
    #expect(steps.isEmpty)                               // jamais de `.copy`
    #expect(try bytes(sentinel) == Data("point de deja-la".utf8))
    #expect(fileExists(paths.qdrantStorage.appendingPathComponent("collections/deja-la/storage.sqlite")))
    #expect(!fileExists(paths.qdrantStorage.appendingPathComponent("collections/ancienne")))
}

@Test("bug-embedded-podman-machine/AC-6 : la copie ne touche JAMAIS la source")
@MainActor
func copyLeavesTheSourceIntact() async throws {
    let root = try tempRoot()
    let home = try tempRoot()
    let legacy = home.appendingPathComponent("legacy", isDirectory: true)
    let storage = legacy.appendingPathComponent("qdrant_storage", isDirectory: true)
    try writeCollections(at: storage, docs: ["a", "b"])
    try Data("raft".utf8).write(to: storage.appendingPathComponent("raft_state.json"))
    let before = try tree(storage)
    defer {
        try? FileManager.default.removeItem(at: root)
        try? FileManager.default.removeItem(at: home)
    }

    let double = DockerCurlDouble()
    double.route = { _, url in
        if url.hasSuffix("/containers/json?all=true") { return ProcessRun(code: 0, stdout: exitedQdrant, stderr: "", timedOut: false) }
        if url.hasSuffix("/containers/mem0-qdrant/json") { return ProcessRun(code: 0, stdout: inspectJSON(id: "q1", source: storage.path, label: legacy.path), stderr: "", timedOut: false) }
        return ProcessRun(code: 7, stdout: "", stderr: "", timedOut: false)
    }

    let migration = StackMigration(paths: AppPaths(supportRoot: root), environment: ["HOME": home.path], run: double.runner)
    _ = try await migration.run()

    #expect(try tree(storage) == before)
}

@Test("bug-embedded-podman-machine/AC-6 : l'import lit le `.env` du parent de `qdrant_storage`")
@MainActor
func importFallsBackToStorageParent() async throws {
    let root = try tempRoot()
    let home = try tempRoot()
    let host = home.appendingPathComponent("depot", isDirectory: true)
    let storage = host.appendingPathComponent("qdrant_storage", isDirectory: true)
    try writeCollections(at: storage)
    try Data("QDRANT_API_KEY=cle-du-lab\n".utf8).write(to: host.appendingPathComponent(".env"))
    defer {
        try? FileManager.default.removeItem(at: root)
        try? FileManager.default.removeItem(at: home)
    }

    let double = DockerCurlDouble()
    double.route = { _, url in
        if url.hasSuffix("/containers/json?all=true") { return ProcessRun(code: 0, stdout: exitedQdrant, stderr: "", timedOut: false) }
        if url.hasSuffix("/containers/mem0-qdrant/json") { return ProcessRun(code: 0, stdout: inspectJSON(id: "q1", source: storage.path, label: nil), stderr: "", timedOut: false) }
        return ProcessRun(code: 7, stdout: "", stderr: "", timedOut: false)
    }

    let paths = AppPaths(supportRoot: root)
    let migration = StackMigration(paths: paths, environment: ["HOME": home.path], run: double.runner)
    let outcome = try await migration.run()

    #expect(outcome.configImported)
    #expect(StackEnvStore.load(at: paths.stackEnv)?.qdrantApiKey == "cle-du-lab")
}

@Test("bug-embedded-podman-machine/AC-6 : sans `.env` à côté de la source, aucune configuration n'est écrite")
@MainActor
func withoutEnvNoConfigIsWritten() async throws {
    let root = try tempRoot()
    let home = try tempRoot()
    let legacy = home.appendingPathComponent("legacy", isDirectory: true)
    let storage = legacy.appendingPathComponent("qdrant_storage", isDirectory: true)
    try writeCollections(at: storage)
    defer {
        try? FileManager.default.removeItem(at: root)
        try? FileManager.default.removeItem(at: home)
    }

    let double = DockerCurlDouble()
    double.route = { _, url in
        if url.hasSuffix("/containers/json?all=true") { return ProcessRun(code: 0, stdout: exitedQdrant, stderr: "", timedOut: false) }
        if url.hasSuffix("/containers/mem0-qdrant/json") { return ProcessRun(code: 0, stdout: inspectJSON(id: "q1", source: storage.path, label: legacy.path), stderr: "", timedOut: false) }
        return ProcessRun(code: 7, stdout: "", stderr: "", timedOut: false)
    }

    let paths = AppPaths(supportRoot: root)
    let migration = StackMigration(paths: paths, environment: ["HOME": home.path], run: double.runner)
    let outcome = try await migration.run()

    #expect(outcome.copied)
    #expect(outcome.configImported == false)
    #expect(!fileExists(paths.stackEnv))
}

@Test("bug-embedded-podman-machine/AC-6 : un `.env` vide (ou sans clé connue) écrit les défauts de `StackConfig`")
@MainActor
func emptyEnvWritesDefaults() async throws {
    let root = try tempRoot()
    let home = try tempRoot()
    let legacy = home.appendingPathComponent("legacy", isDirectory: true)
    let storage = legacy.appendingPathComponent("qdrant_storage", isDirectory: true)
    try writeCollections(at: storage)
    try Data("# rien d'utile\n".utf8).write(to: legacy.appendingPathComponent(".env"))
    defer {
        try? FileManager.default.removeItem(at: root)
        try? FileManager.default.removeItem(at: home)
    }

    let double = DockerCurlDouble()
    double.route = { _, url in
        if url.hasSuffix("/containers/json?all=true") { return ProcessRun(code: 0, stdout: exitedQdrant, stderr: "", timedOut: false) }
        if url.hasSuffix("/containers/mem0-qdrant/json") { return ProcessRun(code: 0, stdout: inspectJSON(id: "q1", source: storage.path, label: legacy.path), stderr: "", timedOut: false) }
        return ProcessRun(code: 7, stdout: "", stderr: "", timedOut: false)
    }

    let paths = AppPaths(supportRoot: root)
    let migration = StackMigration(paths: paths, environment: ["HOME": home.path], run: double.runner)
    _ = try await migration.run()

    #expect(StackEnvStore.load(at: paths.stackEnv) == .defaults)
}

// MARK: - Le repli disque

@Test("bug-embedded-podman-machine/AC-6 : aucun socket ne répond ⇒ repli disque sur le premier candidat qui a des `collections`")
@MainActor
func diskFallbackPicksTheFirstCandidateWithCollections() async throws {
    let root = try tempRoot()
    let home = try tempRoot()
    // Deux candidats portent une base : le PREMIER de l'ordre figé gagne.
    try writeCollections(at: home.appendingPathComponent("dev/mem0-omp/mem0-stack/qdrant_storage"), docs: ["dev"])
    try writeCollections(at: home.appendingPathComponent("Experiments/mem0-omp/mem0-stack/qdrant_storage"), docs: ["experiments"])
    // Un candidat sans `collections` est sauté : `src` n'a qu'un dossier vide.
    try FileManager.default.createDirectory(
        at: home.appendingPathComponent("src/mem0-omp/mem0-stack/qdrant_storage", isDirectory: true),
        withIntermediateDirectories: true
    )
    let legacy = home.appendingPathComponent("Experiments/mem0-omp/mem0-stack", isDirectory: true)
    try Data("OMLX_LLM_MODEL=modele-du-poste\n".utf8).write(to: legacy.appendingPathComponent(".env"))
    defer {
        try? FileManager.default.removeItem(at: root)
        try? FileManager.default.removeItem(at: home)
    }

    let double = DockerCurlDouble()
    double.route = { _, _ in ProcessRun(code: 7, stdout: "", stderr: "curl: (7) socket muet", timedOut: false) }

    let paths = AppPaths(supportRoot: root)
    let migration = StackMigration(paths: paths, environment: ["HOME": home.path], run: double.runner)
    var steps: [MigrationStep] = []
    let outcome = try await migration.run(progress: { steps.append($0) })

    #expect(outcome.legacyStorage == legacy.appendingPathComponent("qdrant_storage"))
    #expect(outcome.copied)
    #expect(steps == [.copy])                             // aucune étape d'arrêt
    #expect(fileExists(paths.qdrantStorage.appendingPathComponent("collections/experiments/storage.sqlite")))
    #expect(!fileExists(paths.qdrantStorage.appendingPathComponent("collections/dev/storage.sqlite")))
    #expect(StackEnvStore.load(at: paths.stackEnv)?.omlxLLMModel == "modele-du-poste")
}

@Test("bug-embedded-podman-machine/AC-6 : première pile absente partout ⇒ résultat vide et AUCUNE erreur")
@MainActor
func noLegacyPileYieldsAnEmptyOutcome() async throws {
    let root = try tempRoot()
    let home = try tempRoot()
    defer {
        try? FileManager.default.removeItem(at: root)
        try? FileManager.default.removeItem(at: home)
    }

    let double = DockerCurlDouble()
    double.route = { _, _ in ProcessRun(code: 7, stdout: "", stderr: "curl: (7) socket muet", timedOut: false) }

    let paths = AppPaths(supportRoot: root)
    let migration = StackMigration(paths: paths, environment: ["HOME": home.path], run: double.runner)
    var steps: [MigrationStep] = []
    let outcome = try await migration.run(progress: { steps.append($0) })

    #expect(outcome == MigrationOutcome(legacyStorage: nil, copied: false, configImported: false))
    #expect(steps.isEmpty)
    #expect(!fileExists(paths.qdrantStorage))
    // Le marqueur est le relevé INFORMATIF de la dernière migration : il est écrit
    // même sans source, et n'est jamais une garde.
    let marker = try #require(try JSONSerialization.jsonObject(with: try Data(contentsOf: paths.migrationState)) as? [String: Any])
    #expect(marker["version"] as? Int == 2)
    #expect(marker["source"] as? String == "")
    #expect(marker["copied"] as? Bool == false)
    #expect(marker["stoppedContainers"] == nil)
}

@Test("bug-embedded-podman-machine/AC-6 : un socket qui répond sans la pile fait foi — pas de repli disque")
@MainActor
func respondingSocketWinsOverDiskFallback() async throws {
    let root = try tempRoot()
    let home = try tempRoot()
    try writeCollections(at: home.appendingPathComponent("Experiments/mem0-omp/mem0-stack/qdrant_storage"))
    defer {
        try? FileManager.default.removeItem(at: root)
        try? FileManager.default.removeItem(at: home)
    }

    let double = DockerCurlDouble()
    double.route = { _, url in
        if url.hasSuffix("/containers/json?all=true") { return ProcessRun(code: 0, stdout: "[]", stderr: "", timedOut: false) }
        return ProcessRun(code: 7, stdout: "", stderr: "", timedOut: false)
    }

    let paths = AppPaths(supportRoot: root)
    let migration = StackMigration(paths: paths, environment: ["HOME": home.path], run: double.runner)
    let outcome = try await migration.run()

    // Le premier socket répond (vide) : le repli disque ne doit PAS s'exécuter.
    #expect(outcome == MigrationOutcome(legacyStorage: nil, copied: false, configImported: false))
    #expect(!fileExists(paths.qdrantStorage))
}

// MARK: - Idempotence

@Test("bug-embedded-podman-machine/AC-6 : rejouer la migration ne copie ni ne réécrit rien")
@MainActor
func migrationIsIdempotent() async throws {
    let root = try tempRoot()
    let home = try tempRoot()
    let legacy = home.appendingPathComponent("legacy", isDirectory: true)
    let storage = legacy.appendingPathComponent("qdrant_storage", isDirectory: true)
    try writeCollections(at: storage, docs: ["memoire"])
    try Data("OMLX_API_TOKEN=jeton\n".utf8).write(to: legacy.appendingPathComponent(".env"))
    defer {
        try? FileManager.default.removeItem(at: root)
        try? FileManager.default.removeItem(at: home)
    }

    // L'ancienne pile est arrêtée (aucun conteneur ne tourne) : la migration copie
    // au premier tour, puis la garde « base déjà présente » bloque le second.
    let double = DockerCurlDouble()
    double.route = { _, url in
        if url.hasSuffix("/containers/json?all=true") {
            return ProcessRun(code: 0, stdout: exitedQdrant, stderr: "", timedOut: false)
        }
        if url.hasSuffix("/containers/mem0-qdrant/json") {
            return ProcessRun(code: 0, stdout: inspectJSON(id: "q1", source: storage.path, label: legacy.path), stderr: "", timedOut: false)
        }
        return ProcessRun(code: 7, stdout: "", stderr: "", timedOut: false)
    }

    let paths = AppPaths(supportRoot: root)
    let migration = StackMigration(paths: paths, environment: ["HOME": home.path], run: double.runner)
    let first = try await migration.run()
    let storageAfterFirst = try tree(paths.qdrantStorage)
    let envAfterFirst = try bytes(paths.stackEnv)

    let second = try await migration.run()

    #expect(first.copied && first.configImported)
    #expect(second.copied == false)
    #expect(second.configImported == false)
    #expect(try tree(paths.qdrantStorage) == storageAfterFirst)
    #expect(try bytes(paths.stackEnv) == envAfterFirst)
    // La source est toujours présente, jamais supprimée.
    #expect(fileExists(storage.appendingPathComponent("collections/memoire/storage.sqlite")))
}

// MARK: - Les erreurs

@Test("bug-embedded-podman-machine/AC-6 : une copie impossible lève `copyFailed`, nettoie le dossier partiel et laisse la source intacte")
@MainActor
func copyFailureRaisesCopyFailedAndCleansUp() async throws {
    // Un test lancé en root ignore les permissions POSIX : la copie réussirait.
    try #require(getuid() != 0)
    let root = try tempRoot()
    let home = try tempRoot()
    let legacy = home.appendingPathComponent("legacy", isDirectory: true)
    let storage = legacy.appendingPathComponent("qdrant_storage", isDirectory: true)
    try writeCollections(at: storage, docs: ["memoire"])
    // Un sous-dossier ILLISIBLE fait échouer `copyItem` en cours de route : le
    // dossier temporaire reste partiellement peuplé et doit être supprimé.
    let locked = storage.appendingPathComponent("locked", isDirectory: true)
    try FileManager.default.createDirectory(at: locked, withIntermediateDirectories: true)
    try Data("inatteignable".utf8).write(to: locked.appendingPathComponent("fichier"))
    try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: locked.path)
    let sourceBefore = try tree(storage.appendingPathComponent("collections"))
    defer {
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: locked.path)
        try? FileManager.default.removeItem(at: root)
        try? FileManager.default.removeItem(at: home)
    }

    let double = DockerCurlDouble()
    double.route = { _, url in
        if url.hasSuffix("/containers/json?all=true") { return ProcessRun(code: 0, stdout: exitedQdrant, stderr: "", timedOut: false) }
        if url.hasSuffix("/containers/mem0-qdrant/json") { return ProcessRun(code: 0, stdout: inspectJSON(id: "q1", source: storage.path, label: legacy.path), stderr: "", timedOut: false) }
        return ProcessRun(code: 7, stdout: "", stderr: "", timedOut: false)
    }

    let paths = AppPaths(supportRoot: root)
    let migration = StackMigration(paths: paths, environment: ["HOME": home.path], run: double.runner)
    var didThrow = false
    do {
        _ = try await migration.run()
    } catch let error as StackMigrationError {
        if case .copyFailed = error { didThrow = true }
    }

    #expect(didThrow)
    // Aucun dossier temporaire frère ne survit, et la base de l'app n'existe pas.
    let leftovers = (try? FileManager.default.contentsOfDirectory(atPath: paths.stackRoot.path)) ?? []
    #expect(!leftovers.contains { $0.contains(".migration-") })
    #expect(!fileExists(paths.qdrantStorage))
    // La source est intacte.
    #expect(try tree(storage.appendingPathComponent("collections")) == sourceBefore)
}
