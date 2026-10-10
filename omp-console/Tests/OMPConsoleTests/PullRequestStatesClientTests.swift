// L'état des PR de bout en bout (S-6, BR-3) : la pile RÉELLE du Mac (registre au
// lecteur scripté) face au VRAI client (`ConsoleClientModel` + transport HTTP).
// Le client demande la relecture à l'ouverture du flux, reçoit la trame
// `pull-request-states` et dérive la même ardoise que le Mac ; le geste
// « Rafraîchir » fait passer une carte « PR ouverte » à « PR fusionnée ».

import ConsoleClient
import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

@MainActor
private final class SilentDiscovery: DiscoverySource {
    var onChange: (([DiscoveredMac]) -> Void)?
    var onProtocolVersion: ((Int) -> Void)?
    var onDenied: ((Bool) -> Void)?
    func start(serviceType: String) {}
    func stop() {}
}

@MainActor
private final class SilentPath: ClientPathSource {
    var onChange: ((Bool) -> Void)?
    func start() {}
    func stop() {}
}

private let deliveredPR = "https://github.com/proprietaire/depot/pull/11"
private let deliveredRepo = "/tmp/pr-states/client"
private let dayMs: Double = 86_400_000

/// Publie une feature de lot livrée avec sa PR, finie il y a 30 jours.
@MainActor
private func publishDelivered(_ stack: RemoteStack) {
    let repoKey = KanbanRepoKey.key(forRoot: deliveredRepo)
    let lot = lotObject(id: repoKey, repoRoot: deliveredRepo, features: [
        lotFeatureObject(slug: "livree", state: "done", phase: "release", prUrl: deliveredPR, endedAt: stack.clock.nowMs - 30 * dayMs),
    ])
    let data = (try? JSONSerialization.data(withJSONObject: lot, options: [.sortedKeys])) ?? Data()
    let directory = PipelineStore.directory(.lots, stateDir: stack.stateDir)
    try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
    try? data.write(to: URL(fileURLWithPath: (directory as NSString).appendingPathComponent("\(repoKey).json")))
}

/// La pastille de la carte livrée sur une ardoise, ou nil si elle n'y est pas.
private func label(_ state: KanbanBoardState) -> String? {
    state.kanbanBoard?.cards
        .first { $0.prUrl == deliveredPR && KanbanLane.of($0) == .livrees }
        .map { ConsoleStatus.of(card: $0).text }
}

@MainActor
@Test("pipelines-livrees-statut-pr-faux-et-doub/AC-5 : de bout en bout, le client iOS voit « PR ouverte » puis, après Rafraîchir, « PR fusionnée » — le même libellé que le Mac")
func clientFollowsMacPullRequestStates() async throws {
    let reader = ScriptedPullRequestStateReader()
    reader.script(deliveredPR, .open)
    let stack = try await RemoteStack.make(prStates: PullRequestStateBook(reader: reader))
    defer { stack.stop() }
    publishDelivered(stack)
    stack.kanban.start()
    defer { stack.kanban.stop() }
    #expect(await awaitMainTrue(timeout: 5) { label(stack.kanban.state) == "PR ouverte" })

    let client = ConsoleClientModel(
        transport: ConsoleClient.URLSessionTransport(),
        discovery: SilentDiscovery(),
        preferences: InMemoryClientPreferences(),
        tokens: InMemoryTokenStore(),
        pacer: LiveClientPacer(),
        pathSource: SilentPath(),
        nowMs: { [clock = stack.clock] in clock.nowMs }
    )
    client.start()
    defer { client.stop() }
    _ = client.setManualAddress("127.0.0.1:\(stack.port)")
    try await client.pair(code: try stack.registry.generateCode().value, deviceName: "Tests")

    // Lancement : l'ouverture du flux demande une relecture (2e lecture) et la
    // trame porte le fait du Mac.
    #expect(await awaitMainTrue(timeout: 10) {
        reader.readCount(deliveredPR) >= 2 && !stack.kanban.prRefreshing
    }, "relecture demandée à l'ouverture du flux, terminée")
    #expect(await awaitMainTrue(timeout: 10) {
        label(client.board) == "PR ouverte" && client.pullRequestStates?.refreshing == false
    })

    // La PR est fusionnée sur GitHub hier ; l'utilisateur touche « Rafraîchir ».
    let mergedAt = stack.clock.nowMs - dayMs
    reader.script(deliveredPR, .merged, closedAtMs: mergedAt)
    let accepted = try await client.refreshPullRequestStates()
    #expect(accepted.accepted)
    #expect(await awaitMainTrue(timeout: 10) { label(client.board) == "PR fusionnée" })
    #expect(label(stack.kanban.state) == "PR fusionnée", "le Mac et l'iPhone portent le même libellé")
    #expect(client.pullRequestFacts[deliveredPR] == PullRequestFact(url: deliveredPR, state: .merged, closedAtMs: mergedAt))
}
