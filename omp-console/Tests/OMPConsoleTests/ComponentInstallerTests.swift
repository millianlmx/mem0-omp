// L'installateur de composants (S-1, BR-1) : la chaîne complète en doublure
// (`URLProtocol` sert des octets dont le SHA-256 est calculé par le test, un
// `CommandRunner` double rend les `--version`), les erreurs typées, l'idempotence,
// la purge des autres versions et la garde d'architecture. Aucune socket, aucun
// binaire réel : c'est la preuve d'AC-2 (récupération + erreur explicite) et d'AC-3
// (aucun chemin système pour omp/podman).

import CryptoKit
import Foundation
import Testing

@testable import OMPConsole

// MARK: - Fixtures

private enum ComponentsFixture {
    static let ompPath = "/releases/omp-darwin-arm64"
    static let podmanPath = "/releases/podman-installer-macos-arm64.pkg"

    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func manifest(ompData: Data, podmanData: Data, ompSHA: String? = nil, podmanSHA: String? = nil) -> ComponentManifest {
        ComponentManifest(
            ompVersion: "18.6.0",
            omp: RemoteFile(
                url: URL(string: "https://example.test\(ompPath)")!,
                sha256: ompSHA ?? sha256(ompData),
                bytes: Int64(ompData.count)
            ),
            podmanVersion: "6.1.3",
            podmanInstaller: RemoteFile(
                url: URL(string: "https://example.test\(podmanPath)")!,
                sha256: podmanSHA ?? sha256(podmanData),
                bytes: Int64(podmanData.count)
            ),
            machineImage: "docker://quay.io/podman/machine-os:6.1",
            qdrantImage: "docker.io/qdrant/qdrant:v1.19.0",
            stackImageRepository: "omp-console-mem0-http"
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

/// Le comportement nominal du double : `pkgutil` matérialise la charge utile du
/// pkg, omp et podman rendent leur version attendue.
private func nominalReply(_ binary: URL, _ arguments: [String]) throws -> ProcessRun {
    switch binary.lastPathComponent {
    case "pkgutil":
        let directory = URL(fileURLWithPath: arguments[2])
        let payload = directory.appendingPathComponent("podman.pkg/Payload/podman/bin/podman")
        try FileManager.default.createDirectory(at: payload.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("podman".utf8).write(to: payload)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: payload.path)
        return ProcessRun(code: 0, stdout: "", stderr: "", timedOut: false)
    case "omp":
        return ProcessRun(code: 0, stdout: "omp/18.6.0\n", stderr: "", timedOut: false)
    default:
        return ProcessRun(code: 0, stdout: "podman version 6.1.3\n", stderr: "", timedOut: false)
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
func ac2FullChainInstallsBothComponents() async throws {
    StubURLProtocol.reset()
    let ompData = Data(repeating: 0x41, count: 4096)
    let podmanData = Data(repeating: 0x42, count: 8192)
    StubURLProtocol.reply(ComponentsFixture.ompPath, .init(body: ompData))
    StubURLProtocol.reply(ComponentsFixture.podmanPath, .init(body: podmanData))

    let paths = try ComponentsFixture.supportRoot("full")
    let runner = RunnerDouble(reply: nominalReply)
    let installer = makeInstaller(
        paths: paths,
        manifest: ComponentsFixture.manifest(ompData: ompData, podmanData: podmanData),
        runner: runner
    )

    var steps: [ComponentInstallStep] = []
    try await installer.install { steps.append($0) }

    let omp = try #require(installer.installedOmpBinary())
    let podman = try #require(installer.installedPodmanBinary())
    #expect(omp.path == paths.ompDir("18.6.0").appendingPathComponent("omp").path)
    #expect(podman.path == paths.podmanDir("6.1.3").appendingPathComponent("bin/podman").path)

    // Progression : un pas à zéro AVANT le réseau, puis les écritures, puis l'étape
    // d'installation — et la même chose pour podman.
    #expect(steps.first == .omp(downloaded: 0, total: Int64(ompData.count)))
    #expect(steps.contains(.ompInstall))
    #expect(steps.contains(.podmanInstall))
    #expect(steps.contains { if case let .omp(downloaded, _) = $0 { return downloaded == Int64(ompData.count) }; return false })
    #expect(steps.contains { if case let .podman(downloaded, _) = $0 { return downloaded == Int64(podmanData.count) }; return false })

    // Les deux `--version` ont été joués sur les binaires installés.
    for (binary, arguments) in runner.calls where arguments == ["--version"] {
        #expect(binary.path.hasPrefix(paths.supportRoot.path))
    }
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
        manifest: ComponentsFixture.manifest(ompData: Data("a".utf8), podmanData: Data("b".utf8)),
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

    // Filet : aucune écriture de composant, et aucune requête vers podman.
    #expect(installer.installedOmpBinary() == nil)
    #expect(installer.installedPodmanBinary() == nil)
    #expect(!FileManager.default.fileExists(atPath: paths.podmanDir("6.1.3").path))
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
            podmanData: Data("b".utf8),
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
    let podmanData = Data(repeating: 0x42, count: 4096)
    StubURLProtocol.reply(ComponentsFixture.ompPath, .init(body: ompData))
    StubURLProtocol.reply(ComponentsFixture.podmanPath, .init(body: podmanData))

    let paths = try ComponentsFixture.supportRoot("idempotent")
    let runner = RunnerDouble(reply: nominalReply)
    let manifest = ComponentsFixture.manifest(ompData: ompData, podmanData: podmanData)
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
    #expect(installer.installedPodmanBinary() != nil)
}

@MainActor
@Test("all-in-one-app/AC-2 : les autres versions sous components/ sont purgées, stackRoot est intact")
func ac2PurgesOtherVersions() async throws {
    StubURLProtocol.reset()
    let ompData = Data(repeating: 0x41, count: 2048)
    let podmanData = Data(repeating: 0x42, count: 4096)
    StubURLProtocol.reply(ComponentsFixture.ompPath, .init(body: ompData))
    StubURLProtocol.reply(ComponentsFixture.podmanPath, .init(body: podmanData))

    let paths = try ComponentsFixture.supportRoot("purge")
    let fileManager = FileManager.default
    // Une version antérieure de chaque composant, et une donnée de pile à préserver.
    let staleOmp = paths.ompDir("17.0.0").appendingPathComponent("omp")
    try fileManager.createDirectory(at: staleOmp.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("vieux".utf8).write(to: staleOmp)
    let stalePodman = paths.podmanDir("5.0.0").appendingPathComponent("bin/podman")
    try fileManager.createDirectory(at: stalePodman.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("vieux".utf8).write(to: stalePodman)
    let stackMarker = paths.stackRoot.appendingPathComponent("keep.txt")
    try fileManager.createDirectory(at: paths.stackRoot, withIntermediateDirectories: true)
    try Data("pile".utf8).write(to: stackMarker)

    let runner = RunnerDouble(reply: nominalReply)
    let installer = makeInstaller(
        paths: paths,
        manifest: ComponentsFixture.manifest(ompData: ompData, podmanData: podmanData),
        runner: runner
    )
    try await installer.install { _ in }

    #expect(!fileManager.fileExists(atPath: paths.ompDir("17.0.0").path))
    #expect(!fileManager.fileExists(atPath: paths.podmanDir("5.0.0").path))
    #expect(fileManager.fileExists(atPath: paths.ompDir("18.6.0").path))
    #expect(fileManager.fileExists(atPath: paths.podmanDir("6.1.3").path))
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
        manifest: ComponentsFixture.manifest(ompData: Data("a".utf8), podmanData: Data("b".utf8)),
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
    let podmanData = Data(repeating: 0x42, count: 2048)
    StubURLProtocol.reply(ComponentsFixture.ompPath, .init(body: ompData))
    StubURLProtocol.reply(ComponentsFixture.podmanPath, .init(body: podmanData))

    let paths = try ComponentsFixture.supportRoot("ac3")
    let runner = RunnerDouble(reply: nominalReply)
    let installer = makeInstaller(
        paths: paths,
        manifest: ComponentsFixture.manifest(ompData: ompData, podmanData: podmanData),
        runner: runner
    )
    try await installer.install { _ in }

    let forbidden = ["/opt/homebrew", "/.bun/", "/usr/local/bin", "/opt/local/bin"]
    for call in runner.calls {
        let path = call.binary.path
        for marker in forbidden where path.contains(marker) {
            Issue.record("binaire système consulté : \(path)")
        }
        if path.hasSuffix("/pkgutil") {
            #expect(path == ComponentInstaller.pkgutil.path)
        } else {
            // Tout autre binaire est un composant de l'app, donc sous la racine.
            #expect(path.hasPrefix(paths.supportRoot.path))
        }
        for argument in call.arguments {
            for marker in forbidden where argument.contains(marker) {
                Issue.record("chemin système dans l'argv : \(argument)")
            }
        }
    }
    // Les deux vérifications ont bien porté sur les binaires de l'app.
    let validated = runner.calls.filter { $0.arguments == ["--version"] }.map(\.binary.path)
    #expect(validated.contains(installer.installedOmpBinary()!.path))
    #expect(validated.contains(installer.installedPodmanBinary()!.path))
}

// MARK: - Recherche bornée de la charge utile

@MainActor
@Test("all-in-one-app/AC-2 : la charge utile est trouvée sous podman.pkg/Payload d'abord, puis par recherche bornée")
func ac2PayloadSearchPrefersCanonicalPath() throws {
    let paths = try ComponentsFixture.supportRoot("payload")
    let installer = makeInstaller(
        paths: paths,
        manifest: ComponentsFixture.manifest(ompData: Data("a".utf8), podmanData: Data("b".utf8)),
        runner: RunnerDouble(reply: nominalReply)
    )

    let root = try ComponentsFixture.supportRoot("payload-root")
    let canonical = root.supportRoot.appendingPathComponent("podman.pkg/Payload/podman")
    let canonicalBinary = canonical.appendingPathComponent("bin/podman")
    try FileManager.default.createDirectory(at: canonicalBinary.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("podman".utf8).write(to: canonicalBinary)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: canonicalBinary.path)
    #expect(installer.findPodmanPayload(root: root.supportRoot)?.path == canonical.path)

    // Nom de sous-paquet différent : la recherche bornée le retrouve.
    let other = try ComponentsFixture.supportRoot("payload-other")
    let nested = other.supportRoot.appendingPathComponent("Some.pkg/Payload/usr/local/podman")
    let nestedBinary = nested.appendingPathComponent("bin/podman")
    try FileManager.default.createDirectory(at: nestedBinary.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("podman".utf8).write(to: nestedBinary)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: nestedBinary.path)
    let found = try #require(installer.findPodmanPayload(root: other.supportRoot))
    #expect(found.path.hasSuffix("Some.pkg/Payload/usr/local/podman"))
    #expect(FileManager.default.isExecutableFile(atPath: found.appendingPathComponent("bin/podman").path))
}
