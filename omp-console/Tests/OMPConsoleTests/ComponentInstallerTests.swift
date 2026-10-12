// L'installateur de composants (S-1, BR-1) : la chaîne complète en doublure
// (`URLProtocol` sert des octets dont le SHA-256 est calculé par le test, un
// `CommandRunner` double rend le `--version`), les erreurs typées, l'idempotence,
// la purge des autres versions d'omp et la garde d'architecture. L'app n'installe
// plus que omp : aucune requête podman, et `components/podman` n'est jamais créé
// ni purgé. Aucune socket, aucun binaire réel : c'est la preuve d'AC-2
// (récupération + erreur explicite) et d'AC-3 (aucun chemin système pour omp).

import CryptoKit
import Foundation
import Testing

@testable import OMPConsole

// MARK: - Fixtures

private enum ComponentsFixture {
    static let ompPath = "/releases/omp-darwin-arm64"

    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func manifest(ompData: Data, ompSHA: String? = nil) -> ComponentManifest {
        ComponentManifest(
            ompVersion: "18.6.0",
            omp: RemoteFile(
                url: URL(string: "https://example.test\(ompPath)")!,
                sha256: ompSHA ?? sha256(ompData),
                bytes: Int64(ompData.count)
            )
        )
    }

    static func supportRoot(_ label: String) throws -> AppPaths {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("omp-installer-\(label)-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return AppPaths(supportRoot: root)
    }
}

/// Un `CommandRunner` double : il enregistre chaque appel (binaire + argv) — c'est
/// la preuve d'AC-3 — et rend la sortie scriptée par le test.
private final class RunnerDouble: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [(binary: URL, arguments: [String])] = []
    private var _reply: @Sendable (URL, [String]) throws -> ProcessRun

    init(reply: @escaping @Sendable (URL, [String]) throws -> ProcessRun) {
        _reply = reply
    }

    func setReply(_ reply: @escaping @Sendable (URL, [String]) throws -> ProcessRun) {
        lock.lock()
        _reply = reply
        lock.unlock()
    }

    var calls: [(binary: URL, arguments: [String])] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    func reset() {
        lock.lock()
        recorded = []
        lock.unlock()
    }

    var runner: CommandRunner {
        CommandRunner { [self] binary, arguments, _, _ in
            let reply = lock.withLock { () -> @Sendable (URL, [String]) throws -> ProcessRun in
                recorded.append((binary, arguments))
                return _reply
            }
            return try reply(binary, arguments)
        }
    }
}

/// Le comportement nominal du double : omp rend sa version attendue.
private func nominalReply(_ binary: URL, _ arguments: [String]) throws -> ProcessRun {
    switch binary.lastPathComponent {
    case "omp":
        return ProcessRun(code: 0, stdout: "omp/18.6.0\n", stderr: "", timedOut: false)
    default:
        return ProcessRun(code: 1, stdout: "", stderr: "binaire inattendu : \(binary.path)\n", timedOut: false)
    }
}

@MainActor
private func makeInstaller(
    paths: AppPaths,
    manifest: ComponentManifest,
    runner: RunnerDouble
) -> ComponentInstaller {
    ComponentInstaller(
        paths: paths,
        manifest: manifest,
        session: StubURLProtocol.session(),
        run: runner.runner
    )
}

// MARK: - AC-2

@MainActor
@Test("all-in-one-app/AC-2 : la chaîne complète télécharge, vérifie le SHA, installe et observe la progression")
func ac2FullChainInstallsOmp() async throws {
    StubURLProtocol.reset()
    let ompData = Data(repeating: 0x41, count: 4096)
    StubURLProtocol.reply(ComponentsFixture.ompPath, .init(body: ompData))

    let paths = try ComponentsFixture.supportRoot("full")
    // Une installation podman héritée : la migration `PodmanLegacy` s'en sert,
    // donc l'installateur ne doit jamais la purger.
    let legacyPodman = PodmanLegacy.podmanRoot(paths).appendingPathComponent("5.0.0").appendingPathComponent("bin/podman")
    try FileManager.default.createDirectory(at: legacyPodman.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("podman".utf8).write(to: legacyPodman)
    let runner = RunnerDouble(reply: nominalReply)
    let installer = makeInstaller(
        paths: paths,
        manifest: ComponentsFixture.manifest(ompData: ompData),
        runner: runner
    )

    var steps: [ComponentInstallStep] = []
    try await installer.install { steps.append($0) }

    let omp = try #require(installer.installedOmpBinary())
    #expect(omp.path == paths.ompDir("18.6.0").appendingPathComponent("omp").path)

    // Progression : un pas à zéro AVANT le réseau, puis les écritures, puis l'étape
    // d'installation.
    #expect(steps.first == .omp(downloaded: 0, total: Int64(ompData.count)))
    #expect(steps.last == .ompInstall)
    #expect(steps.contains { if case let .omp(downloaded, _) = $0 { return downloaded == Int64(ompData.count) }; return false })

    // Aucune requête podman, aucun `components/podman/<version du manifeste>`
    // créé, et l'installation héritée est intacte.
    #expect(StubURLProtocol.requests.map { $0.url?.path } == [ComponentsFixture.ompPath])
    #expect(!FileManager.default.fileExists(atPath: PodmanLegacy.podmanRoot(paths).appendingPathComponent("6.1.3").path))
    #expect(FileManager.default.fileExists(atPath: legacyPodman.path))

    // Le seul `--version` a été joué sur le binaire omp installé.
    #expect(runner.calls.map(\.binary.path) == [omp.path])
}

@MainActor
@Test("all-in-one-app/AC-2 : un réseau absent est une erreur explicite, aucun composant n'est installé")
func ac2NetworkFailureIsExplicitAndInstallsNothing() async throws {
    StubURLProtocol.reset()
    StubURLProtocol.reply(ComponentsFixture.ompPath, .init(error: URLError(.notConnectedToInternet)))

    let paths = try ComponentsFixture.supportRoot("network")
    let runner = RunnerDouble(reply: nominalReply)
    let installer = makeInstaller(
        paths: paths,
        manifest: ComponentsFixture.manifest(ompData: Data("a".utf8)),
        runner: runner
    )

    do {
        try await installer.install { _ in }
        Issue.record("l'installation aurait dû échouer")
    } catch let error as ComponentInstallError {
        guard case let .network(component, detail) = error else {
            Issue.record("cas attendu .network, obtenu \(error)")
            return
        }
        #expect(component == "OMP")
        #expect(!detail.isEmpty)
    }

    // Filet : aucune écriture de composant, et rien sous components/podman.
    #expect(installer.installedOmpBinary() == nil)
    #expect(!FileManager.default.fileExists(atPath: paths.componentsRoot.appendingPathComponent("podman").path))
}

@MainActor
@Test("all-in-one-app/AC-2 : un SHA divergent rend .checksum et le fichier est jeté")
func ac2ChecksumMismatchDiscardsFile() async throws {
    StubURLProtocol.reset()
    let ompData = Data(repeating: 0x41, count: 1024)
    StubURLProtocol.reply(ComponentsFixture.ompPath, .init(body: ompData))

    let paths = try ComponentsFixture.supportRoot("sha")
    let runner = RunnerDouble(reply: nominalReply)
    let installer = makeInstaller(
        paths: paths,
        manifest: ComponentsFixture.manifest(
            ompData: ompData,
            ompSHA: String(repeating: "0", count: 64)
        ),
        runner: runner
    )

    do {
        try await installer.install { _ in }
        Issue.record("l'installation aurait dû échouer")
    } catch let error as ComponentInstallError {
        #expect(error == .checksum(component: "OMP"))
    }

    #expect(installer.installedOmpBinary() == nil)
    let placed = paths.ompDir("18.6.0").appendingPathComponent("omp")
    #expect(!FileManager.default.fileExists(atPath: placed.path))
}

@MainActor
@Test("all-in-one-app/AC-2 : la deuxième installation ne fait aucune requête réseau ni téléchargement")
func ac2SecondInstallIsIdempotent() async throws {
    StubURLProtocol.reset()
    let ompData = Data(repeating: 0x41, count: 2048)
    StubURLProtocol.reply(ComponentsFixture.ompPath, .init(body: ompData))

    let paths = try ComponentsFixture.supportRoot("idempotent")
    let runner = RunnerDouble(reply: nominalReply)
    let manifest = ComponentsFixture.manifest(ompData: ompData)
    let installer = makeInstaller(paths: paths, manifest: manifest, runner: runner)

    try await installer.install { _ in }

    StubURLProtocol.reset()
    runner.reset()
    var steps: [ComponentInstallStep] = []
    try await installer.install { steps.append($0) }

    #expect(StubURLProtocol.requests.isEmpty)
    #expect(steps.isEmpty)
    #expect(runner.calls.isEmpty)
    #expect(installer.installedOmpBinary() != nil)
    #expect(!FileManager.default.fileExists(atPath: paths.componentsRoot.appendingPathComponent("podman").path))
}

@MainActor
@Test("all-in-one-app/AC-2 : les autres versions sous components/ sont purgées, stackRoot est intact")
func ac2PurgesOtherVersions() async throws {
    StubURLProtocol.reset()
    let ompData = Data(repeating: 0x41, count: 2048)
    StubURLProtocol.reply(ComponentsFixture.ompPath, .init(body: ompData))

    let paths = try ComponentsFixture.supportRoot("purge")
    let fileManager = FileManager.default
    // Une version antérieure d'omp, un podman hérité et une donnée de pile à préserver.
    let staleOmp = paths.ompDir("17.0.0").appendingPathComponent("omp")
    try fileManager.createDirectory(at: staleOmp.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("vieux".utf8).write(to: staleOmp)
    let stalePodman = PodmanLegacy.podmanRoot(paths).appendingPathComponent("5.0.0").appendingPathComponent("bin/podman")
    try fileManager.createDirectory(at: stalePodman.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("vieux".utf8).write(to: stalePodman)
    let stackMarker = paths.stackRoot.appendingPathComponent("keep.txt")
    try fileManager.createDirectory(at: paths.stackRoot, withIntermediateDirectories: true)
    try Data("pile".utf8).write(to: stackMarker)

    let runner = RunnerDouble(reply: nominalReply)
    let installer = makeInstaller(
        paths: paths,
        manifest: ComponentsFixture.manifest(ompData: ompData),
        runner: runner
    )
    try await installer.install { _ in }

    #expect(!fileManager.fileExists(atPath: paths.ompDir("17.0.0").path))
    #expect(fileManager.fileExists(atPath: paths.ompDir("18.6.0").path))
    // components/podman n'est jamais purgé : la migration `PodmanLegacy` le lit.
    #expect(fileManager.fileExists(atPath: stalePodman.path))
    #expect(!fileManager.fileExists(atPath: PodmanLegacy.podmanRoot(paths).appendingPathComponent("6.1.3").path))
    // stackRoot et ses données n'ont jamais été touchés.
    #expect(fileManager.fileExists(atPath: stackMarker.path))
}

@MainActor
@Test("all-in-one-app/AC-2 : une machine non arm64 est refusée avant toute action")
func ac2UnsupportedMacIsRefused() async throws {
    StubURLProtocol.reset()
    let paths = try ComponentsFixture.supportRoot("arch")
    let runner = RunnerDouble(reply: nominalReply)
    let installer = makeInstaller(
        paths: paths,
        manifest: ComponentsFixture.manifest(ompData: Data("a".utf8)),
        runner: runner
    )
    installer.isSupportedArchitecture = false

    do {
        try await installer.install { _ in }
        Issue.record("l'installation aurait dû échouer")
    } catch let error as ComponentInstallError {
        #expect(error == .unsupportedMac)
    }

    #expect(StubURLProtocol.requests.isEmpty)
    #expect(runner.calls.isEmpty)
    #expect(installer.installedOmpBinary() == nil)
}

// MARK: - AC-3

@MainActor
@Test("all-in-one-app/AC-3 : aucun chemin système n'est consulté ni utilisé pour omp/podman")
func ac3NeverUsesSystemBinaries() async throws {
    StubURLProtocol.reset()
    let ompData = Data(repeating: 0x41, count: 1024)
    StubURLProtocol.reply(ComponentsFixture.ompPath, .init(body: ompData))

    let paths = try ComponentsFixture.supportRoot("ac3")
    let runner = RunnerDouble(reply: nominalReply)
    let installer = makeInstaller(
        paths: paths,
        manifest: ComponentsFixture.manifest(ompData: ompData),
        runner: runner
    )
    try await installer.install { _ in }

    let forbidden = ["/opt/homebrew", "/.bun/", "/usr/local/bin", "/opt/local/bin"]
    for call in runner.calls {
        let path = call.binary.path
        for marker in forbidden where path.contains(marker) {
            Issue.record("binaire système consulté : \(path)")
        }
        // Tout binaire lancé est un composant de l'app, donc sous la racine.
        #expect(path.hasPrefix(paths.supportRoot.path))
        for argument in call.arguments {
            for marker in forbidden where argument.contains(marker) {
                Issue.record("chemin système dans l'argv : \(argument)")
            }
        }
    }
    // La vérification a bien porté sur le binaire omp de l'app.
    let validated = runner.calls.filter { $0.arguments == ["--version"] }.map(\.binary.path)
    #expect(validated == [installer.installedOmpBinary()!.path])
}
