// Preuves des conducteurs (S-7 de omp-console-redesign) : la règle
// `ensurePilot` sur des hôtes factices et un magasin injecté, puis la recette
// réelle — un `omp --mode rpc` conduit par l'app prend en charge une commande
// déposée par l'app — gardée par `MEM0_CONDUCTOR_RECIPE`.

import Foundation
import Testing
@testable import OMPConsole
import ConsoleCore

private let now: Double = 1_700_000_000_000

/// Un hôte factice : il compte ses démarrages et arrêts, et peut refuser de
/// démarrer.
@MainActor
private final class FakeHost: ConductorHosting {
    var isAlive = false
    var pid: Int32?
    var starts: [URL] = []
    var stops = 0
    var failure: Error?

    func start(repoRoot: URL) async throws {
        starts.append(repoRoot)
        if let failure { throw failure }
        isAlive = true
        pid = 4242
    }

    func stop() async {
        stops += 1
        isAlive = false
    }
}

private func lot(repoRoot: String, heartbeatAt: Double) -> Lot {
    Lot(
        id: "lot-1", repoRoot: repoRoot, status: .running, reviewCap: 3, slotCap: 2, recapAt: nil,
        owner: LotOwner(pid: Int(getpid()), sessionFile: nil, sessionId: nil, heartbeatAt: heartbeatAt),
        createdAt: now, launchedAt: now, features: [], isStale: false
    )
}

@MainActor
@Test("omp-console-redesign/AC-5 : un dépôt sans pilote vivant reçoit un conducteur, jamais deux")
func repoWithoutLivePilotGetsOneConductor() async throws {
    let repo = FileManager.default.temporaryDirectory.path
    var lots: [Lot] = []
    var hosts: [FakeHost] = []
    let pool = ConductorPool(
        stateDir: "/nonexistent",
        clock: StoreClock { now },
        readLots: { lots },
        makeHost: {
            let host = FakeHost()
            hosts.append(host)
            return host
        }
    )

    // Aucun lot, aucun hôte : un conducteur démarre, sur le chemin réel du dépôt.
    try await pool.ensurePilot(repoRoot: repo)
    #expect(hosts.count == 1)
    #expect(hosts[0].starts == [URL(fileURLWithPath: realpathOr(repo), isDirectory: true)])

    // Second geste avant que le lot existe : le conducteur vivant pompe déjà.
    try await pool.ensurePilot(repoRoot: repo)
    #expect(hosts.count == 1)

    // Un lot au pilote vivant (battement frais) : rien à faire.
    lots = [lot(repoRoot: repo, heartbeatAt: now - 1_000)]
    try await pool.ensurePilot(repoRoot: repo)
    #expect(hosts.count == 1)
    #expect(hosts[0].stops == 0)

    // Lot périmé alors que notre hôte vit : il est arrêté, un neuf démarre.
    lots = [lot(repoRoot: repo, heartbeatAt: now - 60_000)]
    try await pool.ensurePilot(repoRoot: repo)
    #expect(hosts[0].stops == 1)
    #expect(hosts.count == 2)
    #expect(hosts[1].starts.count == 1)

    // Un démarrage en échec est relancé à l'appelant, et l'hôte est retiré : le
    // geste suivant en redémarre un.
    let other = FileManager.default.homeDirectoryForCurrentUser.path
    let failing = ConductorPool(
        stateDir: "/nonexistent",
        clock: StoreClock { now },
        readLots: { [] },
        makeHost: {
            let host = FakeHost()
            host.failure = SessionHostError.binaryNotFound(searched: ["/a/omp"], override: nil)
            hosts.append(host)
            return host
        }
    )
    await #expect(throws: SessionHostError.binaryNotFound(searched: ["/a/omp"], override: nil)) {
        try await failing.ensurePilot(repoRoot: other)
    }
    let before = hosts.count
    await #expect(throws: SessionHostError.self) { try await failing.ensurePilot(repoRoot: other) }
    #expect(hosts.count == before + 1, "l'hôte en échec a été retiré : un neuf est essayé")
}

@MainActor
@Test(
    "omp-console-redesign/AC-5 : un conducteur réel prend en charge une commande déposée par l'app",
    .enabled(if: ProcessInfo.processInfo.environment["MEM0_CONDUCTOR_RECIPE"] != nil)
)
func realConductorTakesACommandDepositedByTheApp() async throws {
    guard case .success = OmpBinaryResolver.resolve(environment: ProcessInfo.processInfo.environment) else {
        Issue.record("omp introuvable : la recette du conducteur réel exige omp sur ce poste")
        return
    }
    let base = FileManager.default.temporaryDirectory
        .appendingPathComponent("conductor-recipe-\(UUID().uuidString)").path
    let stateDir = joinPath(base, "state")
    let repo = joinPath(base, "depot")
    try FileManager.default.createDirectory(atPath: repo, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(atPath: stateDir, withIntermediateDirectories: true)
    let git = Process()
    git.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    git.arguments = ["init", "-q", repo]
    try git.run()
    git.waitUntilExit()
    #expect(git.terminationStatus == 0)

    // Le conducteur hérite de l'environnement de l'app : c'est lui qui isole son
    // magasin dans le dossier temporaire.
    let saved = ProcessInfo.processInfo.environment["MEM0_PIPELINE_STATE_DIR"]
    setenv("MEM0_PIPELINE_STATE_DIR", stateDir, 1)
    let pool = ConductorPool(stateDir: stateDir)
    defer {
        if let saved { setenv("MEM0_PIPELINE_STATE_DIR", saved, 1) } else { unsetenv("MEM0_PIPELINE_STATE_DIR") }
        try? FileManager.default.removeItem(atPath: base)
    }
    let model = ActionsModel(writer: PipelineWriter(stateDir: stateDir), pilot: pool)

    // Un titre non normalisable : le pilote REFUSE, sans appel modèle.
    model.launch(title: "!!!", description: "sonde", repoRoot: repo)
    await model.pilotTask?.value
    let settled = await awaitMainTrue(timeout: 20) {
        model.pollAcks()
        if case .refused = model.journal.first?.state { return true }
        if case .failed = model.journal.first?.state { return true }
        return false
    }
    #expect(settled, "aucun accusé en 20 s : le plugin chargé par omp porte-t-il le canal (omp plugin list) ?")
    #expect(model.journal.first?.state == .refused(reason: "contenu de feature vide ou illisible"))
    await pool.stopAll()
}
