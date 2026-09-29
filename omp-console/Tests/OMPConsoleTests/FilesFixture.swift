// Harnais de fixtures de la visionneuse : un dépôt git RÉEL, jetable, sur disque.
//
// Aucun mock du système de fichiers : les critères d'acceptation portent sur des
// commandes git réelles (arbres, diffs, worktrees, index) — un double ne les
// prouverait pas. Tout vit sous `NSTemporaryDirectory()`, et la configuration git
// de la machine est neutralisée (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`) pour
// que le dépôt de fixture ne dépende ni des réglages du poste, ni de ceux de la CI.
//
// Le chemin est CANONISÉ à la création : `NSTemporaryDirectory()` rend `/var/...`
// alors que git rend `/private/var/...` sur macOS (mesuré) — le dépôt de fixture
// parle donc d'emblée la langue de git.

import CryptoKit
import Foundation
import Testing

@testable import OMPConsole

final class FilesFixture {
    /// Le dépôt principal (racine canonique).
    let root: String
    /// Tous les répertoires créés, retirés au `deinit`.
    private var created: [String] = []
    private let fileManager = FileManager.default

    init() throws {
        root = canonicalPath(
            (NSTemporaryDirectory() as NSString).appendingPathComponent("omp-console-files-\(UUID().uuidString)")
        )
        try fileManager.createDirectory(atPath: root, withIntermediateDirectories: true)
        created.append(root)

        try git(["init", "-q", "-b", "main", "."])
        try write("tracked.txt", "a\n")
        try write("folder/inner.txt", "f\n")
        try write(".gitignore", "ignored/\n*.log\n.omp/pipeline/\n")
        try git(["add", "."])
        try git(["commit", "-qm", "init"])
    }

    deinit {
        for path in created {
            try? fileManager.removeItem(atPath: path)
        }
    }

    // MARK: - Geste git

    /// Le code de sortie et les deux sorties d'une commande git dans la fixture.
    func gitResult(
        _ arguments: [String],
        in directory: String? = nil
    ) throws -> (code: Int32, stdout: String, stderr: String) {
        let directory = directory ?? root
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = [
            "-C", directory,
            "-c", "core.pager=cat",
            "-c", "commit.gpgsign=false",
            "-c", "user.email=fixture@example.com",
            "-c", "user.name=Fixture",
        ] + arguments
        var environment = [
            "PATH": "/usr/bin:/bin",
            "LANG": "C",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_TERMINAL_PROMPT": "0",
        ]
        if let home = ProcessInfo.processInfo.environment["HOME"] { environment["HOME"] = home }
        process.environment = environment

        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        process.standardInput = FileHandle.nullDevice
        try process.run()

        // Les deux tubes sont lus EN PARALLÈLE : une sortie de diff peut dépasser un
        // tampon de tube, et lire l'un après l'autre bloquerait alors pour toujours.
        let buffers = FixtureBuffers()
        let group = DispatchGroup()
        for (handle, isError) in [(out.fileHandleForReading, false), (err.fileHandleForReading, true)] {
            group.enter()
            Thread.detachNewThread {
                buffers.set(handle.readDataToEndOfFile(), stderr: isError)
                group.leave()
            }
        }
        group.wait()
        process.waitUntilExit()

        let output = buffers.output
        return (process.terminationStatus, output.stdout, output.stderr)
    }

    /// Exécute git et rend sa sortie standard ; l'échec n'est jamais silencieux —
    /// c'est le harnais qui est cassé, pas le test.
    @discardableResult
    func git(_ arguments: [String], in directory: String? = nil) throws -> String {
        let result = try gitResult(arguments, in: directory)
        guard result.code == 0 else {
            throw FilesFixtureFailure.git(
                command: "git \(arguments.joined(separator: " "))",
                code: result.code,
                stderr: result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            )
        }
        return result.stdout
    }

    // MARK: - Disque

    @discardableResult
    func write(_ relative: String, _ contents: String, in base: String? = nil) throws -> String {
        let path = joinPath(base ?? root, relative)
        try fileManager.createDirectory(
            atPath: (path as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true
        )
        try Data(contents.utf8).write(to: URL(fileURLWithPath: path))
        return path
    }

    func remove(_ relative: String, in base: String? = nil) throws {
        try fileManager.removeItem(atPath: joinPath(base ?? root, relative))
    }

    func read(_ relative: String, in base: String? = nil) -> String? {
        fileManager.contents(atPath: joinPath(base ?? root, relative))
            .map { String(decoding: $0, as: UTF8.self) }
    }

    // MARK: - Gestes du scénario

    /// Un worktree de feature, créé par `git worktree add` (c'est le geste de la
    /// pipeline). Le répertoire est créé à côté du principal.
    @discardableResult
    func makeWorktree(slug: String) throws -> String {
        let parent = (root as NSString).deletingLastPathComponent
        let path = canonicalPath(joinPath(parent, "omp-console-files-\(slug)-\(UUID().uuidString)"))
        created.append(path)
        try git(["worktree", "add", "-q", "-b", "feat/\(slug)", path])
        return path
    }

    func head(of revision: String = "HEAD", in directory: String? = nil) throws -> String {
        try git(["rev-parse", revision], in: directory).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Le contenu du fichier d'index du principal : deux relevés égaux disent que
    /// l'index n'a pas été touché.
    func indexDigest(in repository: String? = nil) throws -> String {
        let repository = repository ?? root
        let path = try git(["rev-parse", "--git-path", "index"], in: repository)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let absolute = path.hasPrefix("/") ? path : joinPath(repository, path)
        return sha256Hex((try? Data(contentsOf: URL(fileURLWithPath: absolute))) ?? Data())
    }

    /// `git status --porcelain` : la forme la plus compacte de l'état d'un dépôt, et
    /// celle qu'utilisent AC-13 et AC-14.
    func status(in directory: String? = nil) throws -> String {
        try git(["status", "--porcelain"], in: directory)
    }

    /// L'empreinte de TOUS les fichiers de la cible : `chemin relatif → sha256`.
    func fileDigests(in directory: String? = nil) -> [String: String] {
        let base = directory ?? root
        var digests: [String: String] = [:]
        guard let enumerator = fileManager.enumerator(atPath: base) else { return digests }
        for case let relative as String in enumerator {
            let absolute = joinPath(base, relative)
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: absolute, isDirectory: &isDirectory), !isDirectory.boolValue else {
                continue
            }
            digests[relative] = sha256Hex((try? Data(contentsOf: URL(fileURLWithPath: absolute))) ?? Data())
        }
        return digests
    }
}

/// Les deux sorties d'une commande de fixture, écrites par deux fils et lues par le
/// fil appelant : tout l'état mutable est derrière un verrou.
private final class FixtureBuffers: @unchecked Sendable {
    private let lock = NSLock()
    private var outData = Data()
    private var errData = Data()

    func set(_ data: Data, stderr: Bool) {
        lock.lock()
        if stderr { errData = data } else { outData = data }
        lock.unlock()
    }

    var output: (stdout: String, stderr: String) {
        lock.lock()
        defer { lock.unlock() }
        return (String(decoding: outData, as: UTF8.self), String(decoding: errData, as: UTF8.self))
    }
}

enum FilesFixtureFailure: Error, CustomStringConvertible {
    case git(command: String, code: Int32, stderr: String)

    var description: String {
        switch self {
        case let .git(command, code, stderr):
            "\(command) a échoué (code \(code)) : \(stderr)"
        }
    }
}

/// Le sha256 d'un contenu, en hexadécimal minuscule (empreintes de fichiers).
func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

/// Le binaire git du poste, utilisé par les tests comme par le produit : le
/// toolchain des Command Line Tools en fournit toujours un à cet emplacement.
func filesGit() -> GitCLI {
    GitCLI(binary: URL(fileURLWithPath: "/usr/bin/git"))
}

/// Un magasin d'état réduit à UN lot : la racine du dépôt principal et les features
/// connues, avec leur branche, leur worktree et leur sha de base. C'est de là que
/// S-1 tire la base d'un worktree.
func filesStore(
    _ fixture: StoreFixture,
    principal: String,
    features: [(slug: String, branch: String, worktree: String, base: String?)]
) -> StoreReader {
    var objects: [[String: Any]] = []
    for feature in features {
        var object = lotFeatureObject(slug: feature.slug)
        object["branch"] = feature.branch
        object["worktree"] = feature.worktree
        object["base"] = feature.base ?? NSNull()
        objects.append(object)
    }
    var lot = lotObject(id: "0f0f0f0f0f0f0f0f", features: objects)
    lot["repoRoot"] = principal
    fixture.publish(.lots, "0f0f0f0f0f0f0f0f.json", object: lot)
    return StoreReader(stateDir: fixture.root, clock: fixtureClock)
}

/// Un modèle de la visionneuse branché sur une fixture et sur des `UserDefaults`
/// JETABLES : le projet est CHOISI dans la préférence de test, jamais deviné depuis
/// le cwd de la suite (qui est celui du dépôt).
@MainActor
func filesModel(for projectRoot: String, store: StoreReader, git: GitCLI? = nil) -> FilesModel {
    let suite = UserDefaults(suiteName: "omp-console-files-\(UUID().uuidString)") ?? .standard
    suite.set(projectRoot, forKey: ProjectRoot.defaultsKey)
    return FilesModel(
        projectRoot: URL(fileURLWithPath: projectRoot),
        git: git ?? filesGit(),
        store: store,
        defaults: suite,
        fileManager: .default,
        environment: ["PATH": "/usr/bin:/bin"]
    )
}

/// Échéance des tests du MODÈLE : sa condition est `@MainActor` comme lui, donc
/// l'attente ne peut pas la lire depuis un fil étranger.
@MainActor
@discardableResult
func waitUntilFiles(timeout: Duration = .seconds(5), _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return condition()
}

/// Ouvre une entrée de l'arbre et attend la publication de SON document : la lecture
/// est une `Task`, donc on lui laisse d'abord la main — sinon l'attente verrait le
/// document du fichier PRÉCÉDENT et passerait trop tôt.
@MainActor
@discardableResult
func openEntry(_ entry: FilesEntry, in model: FilesModel, timeout: Duration = .seconds(5)) async -> Bool {
    model.select(file: entry)
    await Task.yield()
    return await waitUntilFiles(timeout: timeout) {
        !model.isLoading && model.highlight == entry.path && model.content != nil
    }
}

/// Le scénario complet de la visionneuse, monté une fois : un worktree de feature
/// (fichier suivi modifié sans commit, fichier non suivi, contrat), un fichier
/// modifié par un COMMIT de la branche, et le principal avec son `PROJECT.md`.
@MainActor
final class FilesScene {
    let fixture: FilesFixture
    let storeFixture: StoreFixture
    let worktree: String
    /// Le commit initial, enregistré comme base de la feature.
    let base: String
    let git: GitCLI
    let model: FilesModel

    /// `projectRootIsPrimary` monte le projet sur le DÉPÔT PRINCIPAL : c'est le seul
    /// moyen de prouver qu'une cible qui disparaît sort du catalogue sans emporter le
    /// projet avec elle.
    init(
        contract: String? = "# contrat de la fixture\n",
        projectDocument: String? = "# projet de la fixture\n",
        projectRootIsPrimary: Bool = false
    ) throws {
        let fixture = try FilesFixture()
        let base = try fixture.head()
        let worktree = try fixture.makeWorktree(slug: "scene")
        // Un commit de la BRANCHE : c'est l'écart que la base doit couvrir (AC-4).
        try fixture.write("folder/inner.txt", "f2\n", in: worktree)
        try fixture.git(["add", "."], in: worktree)
        try fixture.git(["commit", "-qm", "la branche modifie inner"], in: worktree)
        // Modifications NON commitées : dans la cible, et dans le principal (AC-6).
        try fixture.write("tracked.txt", "b\n", in: worktree)
        try fixture.write("folder/new.txt", "x\ny\n", in: worktree)
        try fixture.write("tracked.txt", "a\nz\n")
        if let contract {
            try fixture.write(FilesModel.contractRelativePath, contract, in: worktree)
        }
        if let projectDocument {
            try fixture.write(FilesModel.projectDocumentRelativePath, projectDocument)
        }

        let storeFixture = StoreFixture()
        let reader = filesStore(
            storeFixture,
            principal: fixture.root,
            features: [("scene", "feat/scene", worktree, base)]
        )
        self.fixture = fixture
        self.base = base
        self.worktree = worktree
        self.storeFixture = storeFixture
        self.git = filesGit()
        self.model = filesModel(for: projectRootIsPrimary ? fixture.root : worktree, store: reader)
    }

    /// Charge l'arbre et la cible active : le geste de l'ouverture de la section.
    func open() async {
        await model.refresh()
        _ = await waitUntilFiles { model.tree != nil }
    }

    /// Ouvre un fichier de l'arbre et attend la publication de son document : le
    /// diff précède toujours le contenu dans `loadDocument`.
    func openFile(_ path: String) async {
        guard let entry = model.tree?.entries.first(where: { $0.path == path }) else {
            Issue.record("« \(path) » n'est pas dans l'arbre de la cible")
            return
        }
        await openEntry(entry, in: model)
    }
}
