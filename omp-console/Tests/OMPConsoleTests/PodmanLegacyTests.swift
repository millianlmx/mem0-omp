// La migration unique de la pile podman (omp-console-sans-podman, S-4 ; AC-2,
// AC-6, AC-7, AC-8, AC-9). Aucun podman, mem0-rs ni Qdrant réel : la doublure
// `LegacyDouble` route par binaire ABSOLU (le podman de la racine jetable, le
// mem0-rs embarqué) et tient un JOURNAL ORDONNÉ de chaque appel — sonde `/readyz`
// comprise —, ce qui fige l'ordre « l'import précède l'arrêt ».

import CryptoKit
import Foundation
import Testing

@testable import OMPConsole

// MARK: - La doublure

/// Un podman, un mem0-rs et une sonde `/readyz` scriptés. `@unchecked Sendable` :
/// tous les accès viennent du MainActor (les tests y vivent).
final class LegacyDouble: @unchecked Sendable {
    struct Call {
        /// `machine inspect`, `container start`, `cp`, `stop`, `readyz`, `import`…
        var label: String
        var arguments: [String]
        var environment: [String: String]
    }

    let podman: String
    let mem0rs: String
    let switchState: URL

    private(set) var calls: [Call] = []
    /// `machine inspect` : nil ⇒ machine absente (exit 125).
    var machine: String? = "[{\"Name\":\"omp-console\",\"State\":\"stopped\"}]"
    var machineStart = LegacyDouble.run(0)
    /// `container inspect omp-console-qdrant` : nil ⇒ conteneur absent (exit 125).
    var qdrant: String? = "[{\"State\":{\"Status\":\"exited\",\"Running\":false}}]"
    var qdrantStart = LegacyDouble.run(0)
    /// Le statut de `/readyz` ; nil ⇒ aucune réponse.
    var ready: Int? = 200
    /// `podman cp` : en code 0, la doublure écrit la copie à la destination.
    var copy = LegacyDouble.run(0)
    var importRun = LegacyDouble.run(0, importSucceeded)
    var stop = LegacyDouble.run(0)
    var machineStop = LegacyDouble.run(0)
    /// `bascule.json` existait-il au moment de `stop` puis de `machine stop` ?
    private(set) var switchStateAtStop: [Bool] = []
    /// Les clés `api-key` reçues par `/readyz`.
    private(set) var readyKeys: [String] = []

    @MainActor
    init(sandbox: LegacySandbox) {
        podman = sandbox.legacy.podmanBinary.path
        mem0rs = sandbox.executable.path
        switchState = sandbox.paths.switchState
    }

    static func run(_ code: Int32, _ stdout: String = "", _ stderr: String = "", timedOut: Bool = false) -> ProcessRun {
        ProcessRun(code: code, stdout: stdout, stderr: stderr, timedOut: timedOut)
    }

    var journal: [String] { calls.map(\.label) }

    func call(_ label: String) -> Call? { calls.first { $0.label == label } }

    var runner: CommandRunner {
        CommandRunner { [self] binary, arguments, environment, _ in
            switch binary.path {
            case podman:
                return podmanRun(arguments, environment)
            case mem0rs:
                calls.append(Call(label: "import", arguments: arguments, environment: environment))
                return importRun
            default:
                Issue.record("binaire inattendu : \(binary.path)")
                return Self.run(127)
            }
        }
    }

    var readyProbe: @Sendable (URL, String) async -> Int? {
        { [self] url, apiKey in
            calls.append(Call(label: "readyz", arguments: [url.absoluteString], environment: [:]))
            readyKeys.append(apiKey)
            return ready
        }
    }

    private func podmanRun(_ arguments: [String], _ environment: [String: String]) -> ProcessRun {
        let nouns = ["machine", "container"]
        let label = nouns.contains(arguments[0]) ? "\(arguments[0]) \(arguments[1])" : arguments[0]
        calls.append(Call(label: label, arguments: arguments, environment: environment))
        switch label {
        case "machine inspect":
            return machine.map { Self.run(0, $0) } ?? Self.run(125, "[]", "Error: omp-console: VM does not exist")
        case "machine start":
            return machineStart
        case "container inspect":
            return qdrant.map { Self.run(0, $0) } ?? Self.run(125, "[]", "Error: no such container omp-console-qdrant")
        case "container start":
            return qdrantStart
        case "cp":
            if copy.code == 0 {
                try? Data("copie de history.db".utf8).write(to: URL(fileURLWithPath: arguments[2]))
            }
            return copy
        case "stop":
            switchStateAtStop.append(FileManager.default.fileExists(atPath: switchState.path))
            return stop
        case "machine stop":
            switchStateAtStop.append(FileManager.default.fileExists(atPath: switchState.path))
            return machineStop
        default:
            Issue.record("commande podman inattendue : \(arguments)")
            return Self.run(125)
        }
    }
}

/// Le rapport d'un import sans rejet (forme DOC-4).
let importSucceeded = #"{"agents":[{"agent_id":"a1","importes":2,"deja_presents":0,"rejetes":[],"revisions":1,"messages":0},{"agent_id":"a2","importes":1,"deja_presents":0,"rejetes":[],"revisions":0,"messages":0}],"totaux":{"importes":3,"deja_presents":0,"rejetes":0,"revisions":1,"messages":0}}"# + "\n"

/// Le rapport réel d'un import avec rejets (test Rust `rapport_json` de
/// mem0-stack/mem0-rs/src/import.rs) : deux rejets chez deux agents.
let importWithRejects = #"{"agents":[{"agent_id":"B","importes":1,"deja_presents":0,"rejetes":[],"revisions":0,"messages":0},"#
    + #"{"agent_id":"b","importes":1,"deja_presents":0,"rejetes":[{"element":"message","id":"m2","raison":"champ_invalide","detail":"content"}],"revisions":1,"messages":1},"#
    + #"{"agent_id":"é","importes":0,"deja_presents":0,"rejetes":[{"element":"souvenir","id":"4","raison":"texte_absent","detail":"payload sans texte"}],"revisions":0,"messages":0},"#
    + #"{"agent_id":null,"importes":1,"deja_presents":0,"rejetes":[],"revisions":0,"messages":0}],"#
    + #""totaux":{"importes":3,"deja_presents":0,"rejetes":2,"revisions":1,"messages":1}}"#
    + "\n"

/// Une racine jetable : podman et mem0-rs exécutables, `stack/env` de recette, et
/// (par défaut) une collection Qdrant `omp_memory` avec un fichier témoin.
@MainActor
struct LegacySandbox {
    let root: URL
    let paths: AppPaths
    let executable: URL
    let legacy: PodmanLegacy

    init(collection: Bool = true) throws {
        let fileManager = FileManager.default
        root = fileManager.temporaryDirectory.appendingPathComponent("omp-legacy-\(UUID().uuidString)", isDirectory: true)
        paths = AppPaths(supportRoot: root.appendingPathComponent("support", isDirectory: true))
        executable = root.appendingPathComponent("OMP Console.app/Contents/Resources/mem0-rs")
        legacy = PodmanLegacy(paths: paths, executable: executable)
        try Self.writeExecutable(executable)
        try Self.writeExecutable(legacy.podmanBinary)
        try fileManager.createDirectory(at: paths.stackRoot, withIntermediateDirectories: true)
        try Data("QDRANT_API_KEY=cle-de-recette\nEMBEDDING_DIMS=768\n".utf8).write(to: paths.stackEnv)
        if collection {
            let segments = paths.qdrantStorage.appendingPathComponent("collections/omp_memory/0/segments", isDirectory: true)
            try fileManager.createDirectory(at: segments, withIntermediateDirectories: true)
            try Data("témoin du segment".utf8).write(to: segments.appendingPathComponent("témoin.bin"))
            try Data("{\"term\":3}".utf8).write(to: paths.qdrantStorage.appendingPathComponent("raft_state.json"))
        }
    }

    private static func writeExecutable(_ url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("#!/bin/sh\n".utf8).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    }

    func remove() {
        try? FileManager.default.removeItem(at: root)
    }

    /// Chemin relatif → SHA-256 de chaque fichier (« dossier » pour un dossier).
    func qdrantTree() throws -> [String: String] {
        let base = paths.qdrantStorage.resolvingSymlinksInPath().path
        var tree: [String: String] = [:]
        let enumerator = try #require(FileManager.default.enumerator(at: paths.qdrantStorage, includingPropertiesForKeys: [.isDirectoryKey]))
        for case let url as URL in enumerator {
            let relative = String(url.resolvingSymlinksInPath().path.dropFirst(base.count))
            if try url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true {
                tree[relative] = "dossier"
            } else {
                tree[relative] = SHA256.hash(data: try Data(contentsOf: url)).map { String(format: "%02x", $0) }.joined()
            }
        }
        return tree
    }

    func switchStateOnDisk() throws -> SwitchState {
        try JSONDecoder().decode(SwitchState.self, from: Data(contentsOf: paths.switchState))
    }
}

@MainActor
private func makeLegacy(_ sandbox: LegacySandbox, _ double: LegacyDouble) -> PodmanLegacy {
    let legacy = PodmanLegacy(
        paths: sandbox.paths,
        executable: sandbox.executable,
        environment: ["HOME": "/Users/recette", "PATH": "/usr/bin:/bin"],
        run: double.runner,
        readyProbe: double.readyProbe
    )
    legacy.readyBudget = 0.05
    legacy.pollInterval = 0.01
    return legacy
}

/// Les verbes qui ARRÊTENT ou SUPPRIMENT quelque chose de la pile podman.
private let destructive: Set<String> = ["stop", "machine stop", "machine rm", "container rm", "rm"]

// MARK: - AC-6 : l'import précède l'arrêt

@MainActor
@Test("omp-console-sans-podman/AC-6 : l'import précède l'arrêt — ordre exact machine, qdrant, readyz, cp, import, stop, machine stop, bascule.json")
func ac6ImportPrecedesStop() async throws {
    let sandbox = try LegacySandbox()
    defer { sandbox.remove() }
    let double = LegacyDouble(sandbox: sandbox)
    let legacy = makeLegacy(sandbox, double)
    var steps: [MigrationStep] = []

    let outcome = try await legacy.migrate { steps.append($0) }

    #expect(outcome == .switched)
    #expect(steps == [.start, .importing, .stop])
    #expect(double.journal == [
        "machine inspect", "machine start",
        "container inspect", "container start",
        "readyz", "cp", "import",
        "stop", "machine stop",
    ])
    // bascule.json n'est écrit qu'APRÈS l'arrêt.
    #expect(double.switchStateAtStop == [false, false])
    #expect(try sandbox.switchStateOnDisk().source == "podman")
    #expect(try sandbox.switchStateOnDisk().rejected == 0)
    #expect(try sandbox.switchStateOnDisk().forced == false)
    #expect(try sandbox.switchStateOnDisk().version == 1)

    // Les argv exacts.
    let paths = sandbox.paths
    #expect(double.call("machine inspect")?.arguments == ["machine", "inspect", "omp-console"])
    #expect(double.call("machine start")?.arguments == ["machine", "start", "omp-console"])
    #expect(double.call("container inspect")?.arguments == ["container", "inspect", "omp-console-qdrant", "--format", "json"])
    #expect(double.call("container start")?.arguments == ["container", "start", "omp-console-qdrant"])
    #expect(double.call("readyz")?.arguments == ["http://127.0.0.1:6333/readyz"])
    #expect(double.readyKeys == ["cle-de-recette"])
    #expect(double.call("cp")?.arguments == ["cp", "omp-console-mem0-http:/home/mem0/.mem0/history.db", paths.podmanHistoryCopy.path])
    #expect(double.call("stop")?.arguments == ["stop", "--ignore", "omp-console-mem0-http", "omp-console-qdrant"])
    #expect(double.call("machine stop")?.arguments == ["machine", "stop", "omp-console"])

    // L'import : argv et environnement exacts (base + base de l'agent, dimension et
    // clé de stack/env), jamais l'isolation podman.
    let importCall = try #require(double.call("import"))
    #expect(importCall.arguments == [
        "import",
        "--history-db", paths.podmanHistoryCopy.path,
        "--qdrant-url", "http://127.0.0.1:6333",
        "--collection", "omp_memory",
        "--json",
    ])
    #expect(importCall.environment == [
        "HOME": "/Users/recette",
        "PATH": "/usr/bin:/bin",
        "MEM0_DB_PATH": paths.mem0Database.path,
        "EMBEDDING_DIMS": "768",
        "QDRANT_API_KEY": "cle-de-recette",
    ])

    // Chaque commande podman porte l'environnement ISOLÉ (DOC-3).
    for call in double.calls where !["readyz", "import"].contains(call.label) {
        #expect(call.environment["XDG_CONFIG_HOME"] == paths.configDir.path, "\(call.label)")
        #expect(call.environment["XDG_DATA_HOME"] == paths.dataDir.path, "\(call.label)")
        #expect(call.environment["TMPDIR"] == paths.tmpDir.path, "\(call.label)")
        #expect(call.environment["HOME"] == "/Users/recette", "\(call.label)")
    }
    let conf = try String(contentsOf: paths.configDir.appendingPathComponent("containers/containers.conf"), encoding: .utf8)
    #expect(conf == "[engine]\nhelper_binaries_dir = [\"\(PodmanLegacy.podmanRoot(paths).appendingPathComponent("6.1.3").path)/bin\"]\n")

    // Les artefacts : la copie de l'historique et le rapport brut.
    #expect(FileManager.default.fileExists(atPath: paths.podmanHistoryCopy.path))
    #expect(try String(contentsOf: paths.podmanImportReport, encoding: .utf8) == importSucceeded)
}

@MainActor
@Test("omp-console-sans-podman/AC-6 : machine et Qdrant qui tournent déjà ⇒ aucun start ; un « already running » de machine start est un succès")
func ac6RunningStackIsNotRestarted() async throws {
    let sandbox = try LegacySandbox()
    defer { sandbox.remove() }
    let double = LegacyDouble(sandbox: sandbox)
    double.machine = "[{\"Name\":\"omp-console\",\"State\":\"running\"}]"
    double.qdrant = "[{\"State\":{\"Status\":\"running\",\"Running\":true}}]"

    #expect(try await makeLegacy(sandbox, double).migrate { _ in } == .switched)
    #expect(double.journal == ["machine inspect", "container inspect", "readyz", "cp", "import", "stop", "machine stop"])

    // Course : la machine se démarre entre l'inspect et le start.
    let raced = try LegacySandbox()
    defer { raced.remove() }
    let racing = LegacyDouble(sandbox: raced)
    racing.machineStart = LegacyDouble.run(125, "", "Error: unable to start \"omp-console\": machine omp-console: VM already running or starting")
    #expect(try await makeLegacy(raced, racing).migrate { _ in } == .switched)
}

@MainActor
@Test("omp-console-sans-podman/AC-6 : un machine stop en échec n'empêche pas la bascule")
func ac6MachineStopFailureIsTolerated() async throws {
    let sandbox = try LegacySandbox()
    defer { sandbox.remove() }
    let double = LegacyDouble(sandbox: sandbox)
    double.machineStop = LegacyDouble.run(125, "", "Error: machine stop a échoué")

    #expect(try await makeLegacy(sandbox, double).migrate { _ in } == .switched)
    #expect(try sandbox.switchStateOnDisk().source == "podman")
}

// MARK: - AC-7 : une seule fois, source intacte

@MainActor
@Test("omp-console-sans-podman/AC-7 : bascule.json présent ⇒ aucune commande podman ni import, même conteneurs relancés")
func ac7SwitchStatePreventsSecondImport() async throws {
    let sandbox = try LegacySandbox()
    defer { sandbox.remove() }
    let first = LegacyDouble(sandbox: sandbox)
    #expect(try await makeLegacy(sandbox, first).migrate { _ in } == .switched)
    let marker = try Data(contentsOf: sandbox.paths.switchState)
    let report = try Data(contentsOf: sandbox.paths.podmanImportReport)

    // Les conteneurs ont été relancés à la main : tout tourne de nouveau.
    let second = LegacyDouble(sandbox: sandbox)
    second.machine = "[{\"Name\":\"omp-console\",\"State\":\"running\"}]"
    second.qdrant = "[{\"State\":{\"Status\":\"running\",\"Running\":true}}]"
    var steps: [MigrationStep] = []

    #expect(try await makeLegacy(sandbox, second).migrate { steps.append($0) } == .alreadyDone)
    #expect(second.calls.isEmpty)
    #expect(steps.isEmpty)
    #expect(try Data(contentsOf: sandbox.paths.switchState) == marker)
    #expect(try Data(contentsOf: sandbox.paths.podmanImportReport) == report)
}

@MainActor
@Test("omp-console-sans-podman/AC-7 : la migration ne modifie aucun fichier de stack/qdrant_storage")
func ac7QdrantStorageIsUntouched() async throws {
    // Succès.
    let sandbox = try LegacySandbox()
    defer { sandbox.remove() }
    let before = try sandbox.qdrantTree()
    #expect(before.count == 6)
    #expect(try await makeLegacy(sandbox, LegacyDouble(sandbox: sandbox)).migrate { _ in } == .switched)
    #expect(try sandbox.qdrantTree() == before)

    // Échec (import en erreur), puis rejets.
    let failing = try LegacySandbox()
    defer { failing.remove() }
    let failingBefore = try failing.qdrantTree()
    let double = LegacyDouble(sandbox: failing)
    double.importRun = LegacyDouble.run(1, "", "erreur : Qdrant a refusé la clé")
    await #expect(throws: PodmanMigrationError.self) { try await makeLegacy(failing, double).migrate { _ in } }
    #expect(try failing.qdrantTree() == failingBefore)
    double.importRun = LegacyDouble.run(3, importWithRejects)
    _ = try await makeLegacy(failing, double).migrate { _ in }
    #expect(try failing.qdrantTree() == failingBefore)
}

// MARK: - AC-8 : échecs

private struct FailureCase {
    var name: String
    var setup: (LegacyDouble) -> Void
    var expected: PodmanMigrationError
    var lastCall: String
}

@MainActor
@Test("omp-console-sans-podman/AC-8 : machine qui ne démarre pas, Qdrant injoignable, cp ou import en erreur ⇒ erreur typée, aucun stop, aucun bascule.json")
func ac8FailuresLeaveStackInPlace() async throws {
    let cases: [FailureCase] = [
        FailureCase(name: "machine absente", setup: { $0.machine = nil },
                    expected: .machineFailed(detail: "machine omp-console absente"), lastCall: "machine inspect"),
        FailureCase(name: "machine qui ne démarre pas", setup: { $0.machineStart = LegacyDouble.run(125, "", "Error: vfkit exited unexpectedly\n") },
                    expected: .machineFailed(detail: "Error: vfkit exited unexpectedly"), lastCall: "machine start"),
        FailureCase(name: "conteneur Qdrant absent", setup: { $0.qdrant = nil },
                    expected: .qdrantUnreachable(detail: "conteneur omp-console-qdrant absent"), lastCall: "container inspect"),
        FailureCase(name: "Qdrant qui ne démarre pas", setup: { $0.qdrantStart = LegacyDouble.run(125, "", "Error: port busy") },
                    expected: .qdrantUnreachable(detail: "Error: port busy"), lastCall: "container start"),
        FailureCase(name: "Qdrant muet", setup: { $0.ready = nil },
                    expected: .qdrantUnreachable(detail: "readyz sans réponse en 1 s"), lastCall: "readyz"),
        FailureCase(name: "cp en erreur", setup: { $0.copy = LegacyDouble.run(125, "", "Error: no such file history.db") },
                    expected: .historyCopyFailed(detail: "Error: no such file history.db"), lastCall: "cp"),
        FailureCase(name: "import en erreur", setup: { $0.importRun = LegacyDouble.run(1, "", "la collection omp_memory est introuvable\n") },
                    expected: .importFailed(code: 1, detail: "la collection omp_memory est introuvable"), lastCall: "import"),
        FailureCase(name: "import hors délai", setup: { $0.importRun = LegacyDouble.run(15, "", "", timedOut: true) },
                    expected: .importFailed(code: -1, detail: "délai dépassé (600 s)"), lastCall: "import"),
        FailureCase(name: "import illisible en code 3", setup: { $0.importRun = LegacyDouble.run(3, "pas un rapport") },
                    expected: .importFailed(code: 3, detail: "rapport illisible"), lastCall: "import"),
    ]
    for failure in cases {
        let sandbox = try LegacySandbox()
        defer { sandbox.remove() }
        let double = LegacyDouble(sandbox: sandbox)
        failure.setup(double)
        let legacy = makeLegacy(sandbox, double)

        var thrown: PodmanMigrationError?
        do {
            let outcome = try await legacy.migrate { _ in }
            Issue.record("\(failure.name) : migrate a rendu \(outcome)")
        } catch let error as PodmanMigrationError {
            thrown = error
        }
        if case .importFailed(3, let detail) = thrown, case .importFailed(3, let prefix) = failure.expected {
            #expect(detail.hasPrefix(prefix), "\(failure.name)")
        } else {
            #expect(thrown == failure.expected, "\(failure.name)")
        }
        #expect(double.journal.last == failure.lastCall, "\(failure.name)")
        #expect(destructive.isDisjoint(with: double.journal), "\(failure.name) : \(double.journal)")
        #expect(!FileManager.default.fileExists(atPath: sandbox.paths.switchState.path), "\(failure.name)")
    }
}

@MainActor
@Test("omp-console-sans-podman/AC-8 : podman ou mem0-rs absent ⇒ erreur typée avant toute commande")
func ac8MissingBinariesFailBeforeAnyCommand() async throws {
    let sandbox = try LegacySandbox()
    defer { sandbox.remove() }
    try FileManager.default.removeItem(at: sandbox.legacy.podmanBinary)
    let double = LegacyDouble(sandbox: sandbox)
    await #expect(throws: PodmanMigrationError.podmanMissing(path: sandbox.legacy.podmanBinary.path)) {
        try await makeLegacy(sandbox, double).migrate { _ in }
    }

    let other = try LegacySandbox()
    defer { other.remove() }
    try FileManager.default.removeItem(at: other.executable)
    let otherDouble = LegacyDouble(sandbox: other)
    await #expect(throws: MemoryAgentError.binaryMissing(path: other.executable.path)) {
        try await makeLegacy(other, otherDouble).migrate { _ in }
    }
    #expect(double.calls.isEmpty && otherDouble.calls.isEmpty)
    #expect(!FileManager.default.fileExists(atPath: sandbox.paths.switchState.path))
}

@MainActor
@Test("omp-console-sans-podman/AC-8 : la cause corrigée, migrate aboutit et bascule")
func ac8RetryAfterFixSwitches() async throws {
    let sandbox = try LegacySandbox()
    defer { sandbox.remove() }
    let double = LegacyDouble(sandbox: sandbox)
    double.ready = nil
    let legacy = makeLegacy(sandbox, double)

    await #expect(throws: PodmanMigrationError.qdrantUnreachable(detail: "readyz sans réponse en 1 s")) {
        try await legacy.migrate { _ in }
    }
    #expect(!FileManager.default.fileExists(atPath: sandbox.paths.switchState.path))

    double.ready = 200
    #expect(try await legacy.migrate { _ in } == .switched)
    #expect(double.journal.filter { $0 == "import" }.count == 1)
    #expect(double.journal.suffix(2) == ["stop", "machine stop"])
    #expect(try sandbox.switchStateOnDisk().source == "podman")
}

@MainActor
@Test("omp-console-sans-podman/AC-8 : un arrêt en échec ⇒ stopFailed et aucun bascule.json")
func ac8StopFailureWritesNoSwitchState() async throws {
    let sandbox = try LegacySandbox()
    defer { sandbox.remove() }
    let double = LegacyDouble(sandbox: sandbox)
    double.stop = LegacyDouble.run(125, "", "Error: container state improper")

    await #expect(throws: PodmanMigrationError.stopFailed(detail: "Error: container state improper")) {
        try await makeLegacy(sandbox, double).migrate { _ in }
    }
    #expect(!double.journal.contains("machine stop"))
    #expect(!FileManager.default.fileExists(atPath: sandbox.paths.switchState.path))
}

// MARK: - AC-9 : rejets

@MainActor
@Test("omp-console-sans-podman/AC-9 : un import en code 3 rend le rapport décodé sans rien arrêter ; switchOver(forced: true) arrête puis écrit forced et le nombre de rejets")
func ac9RejectedImportWaitsForChoice() async throws {
    let sandbox = try LegacySandbox()
    defer { sandbox.remove() }
    let double = LegacyDouble(sandbox: sandbox)
    double.importRun = LegacyDouble.run(3, importWithRejects, "2 éléments rejetés\n")
    let legacy = makeLegacy(sandbox, double)
    var steps: [MigrationStep] = []

    let outcome = try await legacy.migrate { steps.append($0) }

    let report = try ImportReport.parse(importWithRejects)
    #expect(outcome == .rejected(report))
    #expect(steps == [.start, .importing])
    #expect(double.journal.last == "import")
    #expect(destructive.isDisjoint(with: double.journal))
    #expect(!FileManager.default.fileExists(atPath: sandbox.paths.switchState.path))
    #expect(try String(contentsOf: sandbox.paths.podmanImportReport, encoding: .utf8) == importWithRejects)

    try await legacy.switchOver(forced: true, report: report) { steps.append($0) }

    #expect(steps == [.start, .importing, .stop])
    #expect(double.journal.suffix(2) == ["stop", "machine stop"])
    #expect(double.switchStateAtStop == [false, false])
    let state = try sandbox.switchStateOnDisk()
    #expect(state.source == "podman")
    #expect(state.forced == true)
    #expect(state.rejected == 2)
    // Une seule fois : la suite ne refait rien.
    #expect(try await legacy.migrate { _ in } == .alreadyDone)
}

@Test("omp-console-sans-podman/AC-9 : le rapport --json se décode en rejets aplatis dans l'ordre, avec leur total et le stdout brut ; une autre forme est refusée")
func ac9ImportReportDecodes() throws {
    let report = try ImportReport.parse(importWithRejects)
    #expect(report.rejects == [
        ImportReject(element: "message", id: "m2", raison: "champ_invalide", detail: "content"),
        ImportReject(element: "souvenir", id: "4", raison: "texte_absent", detail: "payload sans texte"),
    ])
    #expect(report.totalRejected == 2)
    #expect(report.raw == importWithRejects)

    let empty = try ImportReport.parse(#"{"agents":[],"totaux":{"importes":0,"deja_presents":0,"rejetes":0,"revisions":0,"messages":0}}"# + "\n")
    #expect(empty.rejects.isEmpty && empty.totalRejected == 0)

    #expect(throws: (any Error).self) { try ImportReport.parse(#"{"agents":[]}"#) }
    #expect(throws: (any Error).self) { try ImportReport.parse("") }
}

// MARK: - AC-2 : aucune pile à reprendre

@MainActor
@Test("omp-console-sans-podman/AC-2 : sans collections/omp_memory, aucune commande podman et bascule.json source none")
func ac2NoCollectionMeansNoPodman() async throws {
    let sandbox = try LegacySandbox(collection: false)
    defer { sandbox.remove() }
    // Ni podman ni mem0-rs ne sont nécessaires sur une racine vierge.
    try FileManager.default.removeItem(at: sandbox.legacy.podmanBinary)
    let double = LegacyDouble(sandbox: sandbox)
    var steps: [MigrationStep] = []

    #expect(try await makeLegacy(sandbox, double).migrate { steps.append($0) } == .notNeeded)
    #expect(double.calls.isEmpty)
    #expect(steps.isEmpty)
    let state = try sandbox.switchStateOnDisk()
    #expect(state.source == "none")
    #expect(state.rejected == 0)
    #expect(state.forced == false)
    #expect(!FileManager.default.fileExists(atPath: sandbox.paths.configDir.path))
    #expect(!FileManager.default.fileExists(atPath: sandbox.paths.componentsRoot.appendingPathComponent("podman/6.1.3/bin/podman").path))
    let mode = try FileManager.default.attributesOfItem(atPath: sandbox.paths.podmanMigrationRoot.path)[.posixPermissions] as? Int
    #expect(mode == 0o700)

    // Une seule fois : la seconde préparation ne refait rien.
    #expect(try await makeLegacy(sandbox, double).migrate { _ in } == .alreadyDone)
}

// MARK: - Décodage tolérant

@Test("all-in-one-app/AC-1 : `machine inspect` se décode en tableau ou en objet, tableau vide et objet vide = absente")
func machineDecodeToleratesShapes() {
    #expect(
        PodmanLegacy.decodeMachine("[{\"State\":\"running\",\"Image\":\"img\"}]")
            == MachineState(running: true, image: "img")
    )
    #expect(PodmanLegacy.decodeMachine("{\"Running\":true}") == MachineState(running: true, image: nil))
    #expect(PodmanLegacy.decodeMachine("{\"State\":\"stopped\"}") == MachineState(running: false, image: nil))
    #expect(PodmanLegacy.decodeMachine("[]") == nil)
    #expect(PodmanLegacy.decodeMachine("{}") == nil)
    #expect(PodmanLegacy.decodeMachine("pas du json") == nil)
}

@Test("all-in-one-app/AC-1 : `container inspect` lit l'image (`ImageName`, `Config.Image`) et l'état")
func containerDecodeToleratesShapes() {
    #expect(
        PodmanLegacy.decodeContainer("[{\"State\":{\"Running\":true,\"Status\":\"running\"},\"ImageName\":\"img:1\"}]")
            == ContainerState(running: true, image: "img:1")
    )
    #expect(
        PodmanLegacy.decodeContainer("{\"State\":{\"Status\":\"exited\"},\"Config\":{\"Image\":\"cfg:1\"}}")
            == ContainerState(running: false, image: "cfg:1")
    )
    #expect(PodmanLegacy.decodeContainer("[]") == nil)
}
