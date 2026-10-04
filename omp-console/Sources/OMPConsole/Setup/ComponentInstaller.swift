// L'installation des composants embarqués (S-1, BR-1) : omp et podman sont
// téléchargés depuis les URL épinglées du manifeste, leur empreinte SHA-256 est
// vérifiée EN FLUX (jamais 208 Mo en mémoire), puis ils sont déplacés sous la
// racine privée de l'app.
//
// Ce que ce fichier ne fait JAMAIS (S-1, AC-3) : consulter `PATH`, `~/.bun/bin`,
// `/opt/homebrew/bin` ou `/usr/local/bin` pour trouver un omp/podman système. La
// seule incursion hors de la racine est `/usr/bin/pkgutil`, outil d'extraction du
// pkg (jamais un binaire omp/podman).
//
// Le seul réglage de plateforme — la détection arm64 — est isolé dans
// `isSupportedArchitecture` : la signature d'`init` est figée par le contrat, donc
// les tests basculent ce drapeau via `@testable import` pour prouver
// `unsupportedMac` sans dépendre de l'architecture de la machine de test.

import CryptoKit
import Darwin
import Foundation

/// La progression observable d'une installation (S-1, BR-5 l'affiche).
enum ComponentInstallStep: Equatable, Sendable {
    case omp(downloaded: Int64, total: Int64)
    case ompInstall
    case podman(downloaded: Int64, total: Int64)
    case podmanInstall
}

/// Les échecs typés de l'installation (S-1). Les textes destinés à l'utilisateur
/// vivent dans `SetupText` (BR-5) : ici, seul le détail brut est porté, borné.
enum ComponentInstallError: Error, Equatable, Sendable {
    case unsupportedMac
    case network(component: String, detail: String)
    case checksum(component: String)
    case install(component: String, detail: String)
}

/// L'installation idempotente des composants omp et podman (S-1, BR-1).
@MainActor
final class ComponentInstaller {
    /// Les noms de composant portés par les erreurs (figés par le contrat).
    static let ompComponent = "OMP"
    static let podmanComponent = "Podman"

    /// `pkgutil` est l'outil système d'extraction du pkg podman ; il n'est jamais
    /// un binaire omp/podman, donc il échappe légitimement à l'interdiction des
    /// chemins système de S-1. Sur macOS il vit sous `/usr/sbin` (mesuré : pas de
    /// `/usr/bin/pkgutil`), pas dans le `PATH`.
    static let pkgutil = URL(fileURLWithPath: "/usr/sbin/pkgutil")

    /// La sortie brute des vérifications est bornée à 300 caractères (S-1).
    static let detailLimit = 300

    private let paths: AppPaths
    private let manifest: ComponentManifest
    private let session: URLSession
    private let run: CommandRunner

    /// Détection réelle, exposée INTERNE pour que les tests forcent `false`.
    var isSupportedArchitecture: Bool

    init(
        paths: AppPaths,
        manifest: ComponentManifest = .current,
        session: URLSession = .shared,
        run: CommandRunner = .live
    ) {
        self.paths = paths
        self.manifest = manifest
        self.session = session
        self.run = run
        self.isSupportedArchitecture = ComponentInstaller.detectArm64()
    }

    // MARK: - Chemins des composants installés

    /// Le binaire omp du manifeste, `nil` s'il est absent ou non exécutable — un
    /// fichier non exécutable ne compte jamais comme installé (invariant S-1).
    func installedOmpBinary() -> URL? {
        executable(paths.ompDir(manifest.ompVersion).appendingPathComponent("omp"))
    }

    /// Le binaire podman du manifeste (`bin/podman`), même invariant.
    func installedPodmanBinary() -> URL? {
        executable(paths.podmanDir(manifest.podmanVersion).appendingPathComponent("bin/podman"))
    }

    // MARK: - Installation

    /// Garantit la présence des deux composants à la version du manifeste.
    ///
    /// Idempotent : un composant déjà installé n'est ni retéléchargé ni revérifié.
    /// Après une installation complète, les autres versions sous `components/omp/`
    /// et `components/podman/` sont supprimées ; `stackRoot` n'est jamais touché.
    func install(progress: @escaping @MainActor (ComponentInstallStep) -> Void) async throws {
        guard isSupportedArchitecture else { throw ComponentInstallError.unsupportedMac }

        if installedOmpBinary() == nil {
            try await installOmp(progress: progress)
        }
        if installedPodmanBinary() == nil {
            try await installPodman(progress: progress)
        }
        try purgeOtherVersions()
    }

    // MARK: - omp

    private func installOmp(progress: @escaping @MainActor (ComponentInstallStep) -> Void) async throws {
        let remote = manifest.omp
        let component = ComponentInstaller.ompComponent

        // Un premier pas À ZÉRO est toujours émis avant le réseau (S-1) : la
        // longueur du manifeste est connue, donc `total` l'est aussi.
        progress(.omp(downloaded: 0, total: remote.bytes))
        let staged = try await download(remote, component: component) { written, total in
            progress(.omp(downloaded: written, total: total))
        }
        defer { try? FileManager.default.removeItem(at: staged.deletingLastPathComponent()) }
        progress(.omp(downloaded: remote.bytes, total: remote.bytes))

        try verifyChecksum(staged, remote: remote, component: component)
        progress(.ompInstall)

        let destination = paths.ompDir(manifest.ompVersion).appendingPathComponent("omp")
        try placeFile(staged, at: destination, component: component)

        let binary = try requireBinary(installedOmpBinary(), component: component)
        try await verifyVersion(
            binary,
            arguments: ["--version"],
            expecting: "omp/\(manifest.ompVersion)",
            component: component
        )
    }

    // MARK: - podman

    private func installPodman(progress: @escaping @MainActor (ComponentInstallStep) -> Void) async throws {
        let remote = manifest.podmanInstaller
        let component = ComponentInstaller.podmanComponent

        progress(.podman(downloaded: 0, total: remote.bytes))
        let staged = try await download(remote, component: component) { written, total in
            progress(.podman(downloaded: written, total: total))
        }
        defer { try? FileManager.default.removeItem(at: staged.deletingLastPathComponent()) }
        progress(.podman(downloaded: remote.bytes, total: remote.bytes))

        try verifyChecksum(staged, remote: remote, component: component)
        progress(.podmanInstall)

        let payload = try await expandPodman(staged)
        defer { try? FileManager.default.removeItem(at: payload.deletingLastPathComponent()) }
        try placePodmanPayload(payload)

        let binary = try requireBinary(installedPodmanBinary(), component: component)
        try await verifyVersion(
            binary,
            arguments: ["--version"],
            expecting: "podman version \(manifest.podmanVersion)",
            component: component
        )
    }

    /// `pkgutil --expand-full` puis recherche BORNÉE de la charge utile (S-1).
    private func expandPodman(_ pkg: URL) async throws -> URL {
        let component = ComponentInstaller.podmanComponent
        // `pkgutil --expand-full` CRÉE le dossier de destination : il doit ne pas
        // exister (sinon « Could not unarchive … File exists »). On ne le crée donc
        // pas, contrairement au dossier de téléchargement.
        let extractDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("omp-console-podman-expand-\(UUID().uuidString)", isDirectory: true)
        let result: ProcessRun
        do {
            result = try await run(
                ComponentInstaller.pkgutil,
                ["--expand-full", pkg.path, extractDir.path],
                ProcessInfo.processInfo.environment,
                600
            )
        } catch {
            // `pkgutil` absent (lancement impossible) : c'est un échec d'installation.
            throw ComponentInstallError.install(component: component, detail: bounded("\(error)"))
        }
        guard result.code == 0 else {
            try? FileManager.default.removeItem(at: extractDir)
            throw ComponentInstallError.install(
                component: component,
                detail: bounded(result.stdout + result.stderr)
            )
        }
        guard let payload = findPodmanPayload(root: extractDir) else {
            try? FileManager.default.removeItem(at: extractDir)
            throw ComponentInstallError.install(
                component: component,
                detail: "charge utile podman introuvable sous \(extractDir.path)"
            )
        }
        return payload
    }

    // MARK: - Placement atomique

    /// Place un fichier à sa destination finale (création des dossiers, chmod 0755).
    private func placeFile(_ source: URL, at destination: URL, component: String) throws {
        let fileManager = FileManager.default
        let parent = destination.deletingLastPathComponent()
        do {
            try fileManager.createDirectory(at: parent, withIntermediateDirectories: true)
            try? fileManager.removeItem(at: destination)
            try fileManager.moveItem(at: source, to: destination)
            try? fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: destination.path)
        } catch {
            throw ComponentInstallError.install(component: component, detail: bounded("\(error)"))
        }
    }

    /// Monte `bin`, `lib`, `share` dans un dossier temporaire FRÈRE de la
    /// destination, puis renomme le dossier — l'installation n'est jamais visible
    /// à moitié faite.
    private func placePodmanPayload(_ payload: URL) throws {
        let component = ComponentInstaller.podmanComponent
        let fileManager = FileManager.default
        let destination = paths.podmanDir(manifest.podmanVersion)
        let parent = destination.deletingLastPathComponent()
        let staging = parent.appendingPathComponent(".podman-\(UUID().uuidString)", isDirectory: true)
        do {
            try fileManager.createDirectory(at: staging, withIntermediateDirectories: true)
            for item in ["bin", "lib", "share"] {
                let source = payload.appendingPathComponent(item)
                guard fileManager.fileExists(atPath: source.path) else { continue }
                try fileManager.moveItem(at: source, to: staging.appendingPathComponent(item))
            }
            if fileManager.fileExists(atPath: destination.path) {
                try fileManager.removeItem(at: destination)
            }
            try fileManager.moveItem(at: staging, to: destination)
            try? fileManager.setAttributes(
                [.posixPermissions: 0o755],
                ofItemAtPath: destination.appendingPathComponent("bin/podman").path
            )
        } catch {
            try? fileManager.removeItem(at: staging)
            throw ComponentInstallError.install(component: component, detail: bounded("\(error)"))
        }
    }

    // MARK: - Recherche de la charge utile

    /// `<extraction>/podman.pkg/Payload/podman` d'abord, puis un dossier nommé
    /// `podman` contenant `bin/podman`, en profondeur bornée (S-1).
    func findPodmanPayload(root: URL) -> URL? {
        let direct = root.appendingPathComponent("podman.pkg/Payload/podman", isDirectory: true)
        if isPodmanPayload(direct) { return direct }
        return searchPodman(in: root, depth: 0, maxDepth: 5)
    }

    private func searchPodman(in directory: URL, depth: Int, maxDepth: Int) -> URL? {
        guard depth <= maxDepth else { return nil }
        let fileManager = FileManager.default
        let entries = (try? fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isDirectoryKey]
        )) ?? []
        for entry in entries where entry.lastPathComponent == "podman" {
            if isPodmanPayload(entry) { return entry }
        }
        for entry in entries {
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: entry.path, isDirectory: &isDirectory),
                  isDirectory.boolValue else { continue }
            if let found = searchPodman(in: entry, depth: depth + 1, maxDepth: maxDepth) {
                return found
            }
        }
        return nil
    }

    private func isPodmanPayload(_ url: URL) -> Bool {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory),
              isDirectory.boolValue else { return false }
        return FileManager.default.isExecutableFile(atPath: url.appendingPathComponent("bin/podman").path)
    }

    // MARK: - Vérifications

    /// Empreinte SHA-256 lue en FLUX : le fichier est haché bloc par bloc, jamais
    /// chargé entier en mémoire (208 Mo pour omp).
    private func verifyChecksum(_ file: URL, remote: RemoteFile, component: String) throws {
        let actual: String
        do {
            actual = try ComponentInstaller.sha256(of: file)
        } catch {
            throw ComponentInstallError.install(component: component, detail: bounded("\(error)"))
        }
        guard actual.caseInsensitiveCompare(remote.sha256) == .orderedSame else {
            // Le fichier est JETÉ : il reste dans le dossier temporaire, que
            // l'appelant supprime en sortant, et n'atteint jamais la destination.
            try? FileManager.default.removeItem(at: file)
            throw ComponentInstallError.checksum(component: component)
        }
    }

    private func verifyVersion(
        _ binary: URL,
        arguments: [String],
        expecting needle: String,
        component: String
    ) async throws {
        let result: ProcessRun
        do {
            result = try await run(binary, arguments, ProcessInfo.processInfo.environment, 60)
        } catch {
            throw ComponentInstallError.install(component: component, detail: bounded("\(error)"))
        }
        let output = result.stdout + result.stderr
        guard result.code == 0, output.contains(needle) else {
            throw ComponentInstallError.install(
                component: component,
                detail: bounded(output.isEmpty ? "sortie vide (code \(result.code))" : output)
            )
        }
    }

    private func requireBinary(_ binary: URL?, component: String) throws -> URL {
        guard let binary else {
            throw ComponentInstallError.install(component: component, detail: "binaire introuvable après installation")
        }
        return binary
    }

    // MARK: - Purge des autres versions

    /// Supprime les versions autres que celle du manifeste, jamais `stackRoot`.
    private func purgeOtherVersions() throws {
        purge(versionRoot: paths.componentsRoot.appendingPathComponent("omp", isDirectory: true), keeping: manifest.ompVersion)
        purge(versionRoot: paths.componentsRoot.appendingPathComponent("podman", isDirectory: true), keeping: manifest.podmanVersion)
    }

    private func purge(versionRoot: URL, keeping version: String) {
        let fileManager = FileManager.default
        let entries = (try? fileManager.contentsOfDirectory(at: versionRoot, includingPropertiesForKeys: nil)) ?? []
        for entry in entries where entry.lastPathComponent != version {
            try? fileManager.removeItem(at: entry)
        }
    }

    // MARK: - Téléchargement

    /// Télécharge dans un dossier temporaire et rend le fichier obtenu. Le
    /// déplacement final est fait par l'appelant APRÈS vérification du SHA.
    private func download(
        _ remote: RemoteFile,
        component: String,
        onProgress: @escaping @MainActor (Int64, Int64) -> Void
    ) async throws -> URL {
        let directory = try makeStagingDirectory(named: "download")
        let destination = directory.appendingPathComponent(
            remote.url.lastPathComponent.isEmpty ? "download" : remote.url.lastPathComponent
        )

        let delegate = DownloadDelegate(component: component, destination: destination, onProgress: onProgress)
        // Une session DÉDIÉE porte le delegate du téléchargement : muter la session
        // injectée (parfois `.shared`) serait incorrect. Sa configuration est
        // recopiée telle quelle, donc les `URLProtocol` des tests suivent.
        let downloadSession = URLSession(
            configuration: session.configuration,
            delegate: delegate,
            delegateQueue: nil
        )
        defer { downloadSession.finishTasksAndInvalidate() }

        do {
            return try await withCheckedThrowingContinuation { continuation in
                delegate.start(continuation: continuation)
                let task = downloadSession.downloadTask(with: URLRequest(url: remote.url))
                delegate.attach(task: task)
                task.resume()
            }
        } catch let error as ComponentInstallError {
            throw error
        } catch let failure as DownloadFailure {
            switch failure {
            case let .status(code):
                throw ComponentInstallError.network(component: component, detail: "HTTP \(code)")
            case let .move(detail):
                throw ComponentInstallError.install(component: component, detail: bounded(detail))
            }
        } catch {
            throw ComponentInstallError.network(component: component, detail: bounded("\(error)"))
        }
    }

    // MARK: - Outils

    private func makeStagingDirectory(named name: String) throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("omp-console-\(name)-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func executable(_ url: URL) -> URL? {
        FileManager.default.isExecutableFile(atPath: url.path) ? url : nil
    }

    private func bounded(_ text: String) -> String {
        String(text.prefix(ComponentInstaller.detailLimit))
    }

    /// Détection arm64 par `uname` : renvoie faux ailleurs (x86_64, Rosetta).
    static func detectArm64() -> Bool {
        var info = utsname()
        guard uname(&info) == 0 else { return false }
        let machine = withUnsafeBytes(of: &info.machine) { raw -> String in
            let bytes = raw.prefix { $0 != 0 }
            return String(decoding: bytes, as: UTF8.self)
        }
        return machine == "arm64"
    }

    /// Hache un fichier en flux, sans jamais le charger entièrement en mémoire.
    static func sha256(of file: URL) throws -> String {
        guard let stream = InputStream(url: file) else {
            throw CocoaError(.fileReadUnknown)
        }
        stream.open()
        defer { stream.close() }
        var hasher = SHA256()
        var buffer = [UInt8](repeating: 0, count: 1 << 20)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read < 0 { throw stream.streamError ?? CocoaError(.fileReadUnknown) }
            if read == 0 { break }
            hasher.update(data: Data(bytes: buffer, count: read))
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - Delegate de téléchargement

/// L'échec interne du transport, traduit en `ComponentInstallError` par `download`.
private enum DownloadFailure: Error {
    case status(Int)
    case move(String)
}

/// Un `URLSessionDownloadDelegate` qui relaie la progression vers le fil principal
/// et DÉPLACE le fichier pendant `didFinishDownloadingTo` — le dossier temporaire
/// d'Apple est supprimé dès le retour de la méthode (Documentation du contrat).
private final class DownloadDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let component: String
    private let destination: URL
    private let onProgress: @MainActor (Int64, Int64) -> Void
    private let lock = NSLock()
    private var continuation: CheckedContinuation<URL, any Error>?
    private var settled = false

    init(component: String, destination: URL, onProgress: @escaping @MainActor (Int64, Int64) -> Void) {
        self.component = component
        self.destination = destination
        self.onProgress = onProgress
    }

    func start(continuation: CheckedContinuation<URL, any Error>) {
        lock.lock()
        self.continuation = continuation
        lock.unlock()
    }

    func attach(task: URLSessionDownloadTask) {}

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        let total = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : 0
        let written = totalBytesWritten
        let progress = onProgress
        Task { @MainActor in progress(written, total) }
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            settle(.failure(DownloadFailure.status(status)))
            return
        }
        let fileManager = FileManager.default
        do {
            try fileManager.createDirectory(
                at: destination.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try? fileManager.removeItem(at: destination)
            try fileManager.moveItem(at: location, to: destination)
            settle(.success(destination))
        } catch {
            settle(.failure(DownloadFailure.move("\(error)")))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        if let error { settle(.failure(error)) }
    }

    private func settle(_ result: Result<URL, any Error>) {
        lock.lock()
        if settled || continuation == nil {
            lock.unlock()
            return
        }
        settled = true
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        switch result {
        case let .success(url): continuation?.resume(returning: url)
        case let .failure(error): continuation?.resume(throwing: error)
        }
    }
}
