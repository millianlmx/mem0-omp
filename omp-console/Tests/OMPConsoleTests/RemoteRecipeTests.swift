// Les recettes de bout en bout (BR-11) : le VRAI serveur, le VRAI `dns-sd`, le VRAI
// client CLI — contre la coque réelle quand les prérequis sont là.
//
// Un prérequis absent fait SAUTER le test, jamais un ✓ trompeur : la recette qui
// demande `omp` porte le trait `.enabled(if:)` sur `MEM0_REMOTE_RECIPE`.

import ConsoleCore
import Foundation
import Network
import Testing
@testable import OMPConsole

/// La racine du dépôt, déduite du fichier de test.
private var repositoryRoot: URL {
    URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // OMPConsoleTests
        .deletingLastPathComponent()   // Tests
        .deletingLastPathComponent()   // omp-console
        .deletingLastPathComponent()   // racine
}

/// La recette complète (pilote réel) n'est armée que sur demande.
private let recipeEnabled = ProcessInfo.processInfo.environment["MEM0_REMOTE_RECIPE"] != nil

/// Lance un programme et rend `(code, sortie combinée)`.
///
/// L'attente CÈDE l'acteur principal (`Task.sleep`) : le serveur accepte ses
/// connexions sur la file principale, un `usleep` bloquant affamerait le fils qu'on
/// vient de lancer — la sonde CLI ne joindrait jamais l'API.
@MainActor
private func run(_ executable: String, _ arguments: [String], cwd: URL, timeout: Double = 60) async throws -> (Int32, String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.currentDirectoryURL = cwd
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    try process.run()
    let deadline = Date().addingTimeInterval(timeout)
    while process.isRunning, Date() < deadline { try? await Task.sleep(nanoseconds: 50_000_000) }
    if process.isRunning {
        process.terminate()
        let killDeadline = Date().addingTimeInterval(5)
        while process.isRunning, Date() < killDeadline { try? await Task.sleep(nanoseconds: 50_000_000) }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    }
    process.waitUntilExit()
    let code = process.terminationStatus
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    return (code, String(decoding: data, as: UTF8.self))
}

/// Lance un programme et rend la PREMIÈRE ligne qui satisfait le prédicat, puis le
/// tue : `dns-sd` navigue sans fin, on ne l'attend pas.
private func firstMatchingLine(
    _ executable: String,
    _ arguments: [String],
    timeout: Double = 15,
    where predicate: (String) -> Bool
) -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    guard (try? process.run()) != nil else { return nil }
    defer {
        process.terminate()
        pipe.fileHandleForReading.readDataToEndOfFile()
    }
    let deadline = Date().addingTimeInterval(timeout)
    var buffer = Data()
    while Date() < deadline {
        let chunk = pipe.fileHandleForReading.availableData
        if chunk.isEmpty {
            usleep(100_000)
            continue
        }
        buffer.append(chunk)
        let text = String(decoding: buffer, as: UTF8.self)
        for line in text.split(separator: "\n") where predicate(String(line)) {
            return String(line)
        }
    }
    return nil
}

@MainActor
@Test("api-distante-du-console/AC-1 : l'API est annoncée par Bonjour et ne répond qu'à une source locale")
func theAPIIsAnnouncedAndServesOnlyLocalSources() async throws {
    let dnsSd = "/usr/bin/dns-sd"
    try #require(FileManager.default.isExecutableFile(atPath: dnsSd), "dns-sd est le prérequis de cette recette")

    let stack = try await RemoteStack.make()
    defer { stack.stop() }
    let token = try await stack.pair()

    // (1) L'annonce Bonjour : une instance `OMP Console` du type du contrat.
    let browse = firstMatchingLine(dnsSd, ["-B", ConsoleAPI.Service.bonjourType, "local."]) { line in
        line.contains("Add") && line.contains(ConsoleAPI.Service.bonjourName)
    }
    let entry = try #require(browse, "l'API doit être annoncée par Bonjour")
    #expect(entry.contains(ConsoleAPI.Service.bonjourType))

    // (2) La résolution donne un hôte ET un port, et cette adresse répond.
    let resolved = firstMatchingLine(dnsSd, ["-L", ConsoleAPI.Service.bonjourName, ConsoleAPI.Service.bonjourType, "local."]) { line in
        line.contains("can be reached at")
    }
    let resolution = try #require(resolved, "l'instance doit se résoudre en hôte:port")
    #expect(resolution.contains(String(stack.port)))

    let version = try await stack.call("GET", "/v1/version", token: token)
    #expect(version.status == 200)
    #expect(try version.json(RemoteVersionPayload.self).protocolVersion == ConsoleAPI.protocolVersion)

    // (3) Une source NON locale est fermée sans un octet de réponse (S-1).
    // `192.0.2.1` est TEST-NET-1 : non locale par la politique, et sans route, donc
    // aucun paquet ne part. La connexion doit être DÉMARRÉE pour que son
    // `stateUpdateHandler` soit appelé (c'est `start(queue:)` qui fixe la file des
    // rappels) ; l'acceptation la coupe avant toute lecture.
    let foreign = NWConnection(host: "192.0.2.1", port: 9999, using: .tcp)
    let observed = LockedFlag()
    foreign.stateUpdateHandler = { state in
        if case .cancelled = state { observed.set() }
    }
    foreign.start(queue: .main)
    stack.server.acceptConnection(foreign)
    _ = await awaitMainTrue { observed.value }
    #expect(observed.value, "la connexion d'une source non locale est annulée avant toute lecture")
    foreign.cancel()
}

/// Le drapeau lu depuis une closure non isolée.
private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false

    func set() { lock.lock(); flag = true; lock.unlock() }
    var value: Bool { lock.lock(); defer { lock.unlock() }; return flag }
}

@MainActor
@Test(
    "api-distante-du-console/AC-21 : le client CLI sans appairage est refusé par l'API",
    .enabled(if: FileManager.default.isExecutableFile(atPath: "/usr/local/bin/bun") || bunIsOnPath)
)
func theCLIWithoutPairingIsRefused() async throws {
    let stack = try await RemoteStack.make()
    defer { stack.stop() }

    let bun = try #require(resolveBun(), "bun est le seul prérequis de cette recette")
    let cli = repositoryRoot.appendingPathComponent("scripts/omp-console-api.ts")
    try #require(FileManager.default.fileExists(atPath: cli.path), "le client CLI doit vivre dans le dépôt")

    let (code, output) = try await run(bun, [cli.path, "status", "--url", stack.base], cwd: repositoryRoot)
    #expect(code == 1, "un refus est un code 1, jamais un succès trompeur")
    #expect(output.contains("refusé : unauthorized"), "le refus est rapporté tel quel : \(output)")
    #expect(!output.contains("protocolVersion"), "aucune donnée n'est servie")
}

@MainActor
@Test(
    "api-distante-du-console/AC-20 : le client CLI s'appaire, lit un run vivant, le fait avancer et consomme le flux",
    .enabled(if: recipeEnabled)
)
func theCLIDrivesALiveRunEndToEnd() async throws {
    let bun = try #require(resolveBun(), "bun est requis pour la recette")
    // Le conducteur est le SERVICE : l'app ne lance plus `omp` (elle POSTE
    // `POST /v1/repos/{repo}/pilot`). La recette exige donc un service LOCAL EN
    // MARCHE, à la place du binaire `omp` d'avant le cutover — un service absent se
    // voit dans le refus de l'étape 3, jamais dans un succès trompeur.

    // Un magasin jetable avec un lot publié, comme la coque en lit un.
    let store = StoreFixture()
    let repoRoot = store.root + "/depot"
    let worktree = repoRoot + "/alpha"
    try FileManager.default.createDirectory(atPath: repoRoot + "/.git", withIntermediateDirectories: true)
    try FileManager.default.createDirectory(atPath: worktree, withIntermediateDirectories: true)
    let runId = fixtureId(0xB1)
    store.publish(.lots, "\(fixtureId(0xB2)).json", object: lotObject(
        repoRoot: repoRoot,
        features: [lotFeatureObject(slug: "alpha", state: "running", worktree: worktree)]
    ))
    store.publish(.running, "\(runId).json", object: runningObject(
        id: runId,
        cwd: worktree,
        phaseStartedAt: fixtureT0 - 5_000,
        updatedAt: fixtureT0 - 1_000,
        ownerPid: Double(getpid()),
        sessionFile: store.root + "/session.jsonl"
    ))

    let pilot = RecipePilot()
    let actions = ActionsModel(
        writer: PipelineWriter(
            stateDir: store.root,
            pilot: { repo in try await pilot.ensurePilot(repoRoot: repo) }
        ),
        clock: .live
    )
    let stack = try await RemoteStack.make(stateDir: store.root, actionsModel: actions)
    defer { stack.stop() }
    stack.kanban.start()
    _ = await awaitMainTrue { stack.kanban.state.kanbanBoard != nil }

    let cli = repositoryRoot.appendingPathComponent("scripts/omp-console-api.ts").path
    let url = stack.base

    // 1. `pair` avec le code affiché par la coque.
    let code = try stack.registry.generateCode().value
    let pair = try await run(bun, [cli, "pair", "--code", code, "--name", "recette", "--url", url], cwd: repositoryRoot)
    #expect(pair.0 == 0, "l'appairage doit réussir : \(pair.1)")

    // 2. `snapshot` : le run vivant est lu.
    let snapshot = try await run(bun, [cli, "snapshot", "--url", url], cwd: repositoryRoot)
    #expect(snapshot.0 == 0, "la lecture du magasin doit réussir : \(snapshot.1)")

    // 3. Un geste qui fait avancer le run.
    let cardId = "feature:\(ProjectPaths.key(forRoot: repoRoot)):alpha"
    let resume = try await run(bun, [cli, "resume", cardId, "--url", url], cwd: repositoryRoot)
    #expect(resume.0 == 0, "reprendre doit être accepté : \(resume.1)")
    #expect(await awaitMainTrue { !pilot.roots.isEmpty }, "le conducteur réel doit être armé")

    // 4. Le flux temps réel est consommé.
    let watch = try await run(bun, [cli, "watch", "--seconds", "3", "--url", url], cwd: repositoryRoot, timeout: 30)
    #expect(watch.0 == 0, "le flux doit se consommer : \(watch.1)")

    // Le jeton n'est jamais réaffiché.
    #expect(!snapshot.1.contains("token"))
}

/// Le dépôt piloté par le SERVICE RÉEL : l'app POSTE `POST /v1/repos/{repo}/pilot`
/// au service local (`ServiceLocator`), qui possède le conducteur — l'app ne lance
/// plus `omp`. Le double NOTE le dépôt confié, ce qui garde l'assertion « le
/// conducteur a réellement été armé » observable depuis la recette.
private final class RecipePilot: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String] = []

    var roots: [String] { lock.withLock { stored } }

    func ensurePilot(repoRoot: String) async throws {
        lock.withLock { stored.append(repoRoot) }
        let client = try ServiceClient(endpoint: try ServiceLocator.locate())
        try await client.pilot(repo: repoRoot)
    }
}

private let bunIsOnPath = resolveBun() != nil

private func resolveBun() -> String? {
    let candidates = ["/opt/homebrew/bin/bun", "/usr/local/bin/bun", "\(NSHomeDirectory())/.bun/bin/bun"]
    return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
}
