// Les deux machines de la coque (S-6 de orchestrator-living-in-a-vps) : le bloc de
// connexion au VPS, la vue unifiée des dépôts, la bascule Mac → VPS de bout en bout,
// l'ardoise unifiée (badges, identifiants de carte) et le relais des gestes vers le VPS.
//
// Le « VPS » est une VRAIE pile distante (`RemoteStack`) qui s'annonce `vps` ; le Mac
// est une autre pile, dont les gestes de bascule relaient à un service local scripté.
// Aucun id d'AC dans ces titres : l'AC-11 est porté par le test de ConsoleCore.

import Combine
import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsole

// MARK: - Doublures

private let vpsMachine = ConsoleMachine(kind: ConsoleMachine.vpsKind, name: "VPS de test")

/// Un client du slot `.vps`, jeton en mémoire, transport réel.
@MainActor
private func vpsClient() -> ConsoleClientModel {
    ConsoleClientModel(
        transport: ConsoleClient.URLSessionTransport(),
        discovery: ContractDiscovery(),
        preferences: InMemoryClientPreferences(),
        tokens: InMemoryTokenStore(),
        pacer: LiveClientPacer(),
        pathSource: ContractPath(),
        deviceName: "Tests",
        slot: .vps
    )
}

/// Pose l'adresse du VPS et son code d'appairage dans le bloc de connexion.
@MainActor
private func fill(_ connection: VpsConnectionModel, stack: RemoteStack, code: String? = nil) throws {
    connection.addressText = "127.0.0.1:\(stack.port)"
    connection.codeText = PairingPresentation.grouped(try code ?? stack.registry.generateCode().value)
}

@MainActor
private func isConnected(_ connection: VpsConnectionModel) -> Bool {
    if case .connected = connection.state { return true }
    return false
}

/// Un dépôt git réel dont l'`origin` est `origin`, publié comme lot du magasin.
@MainActor
private func publishOriginRepo(_ store: StoreFixture, name: String, origin: String, lotByte: Int) throws -> String {
    let repoRoot = store.root + "/" + name
    try FileManager.default.createDirectory(atPath: repoRoot, withIntermediateDirectories: true)
    for arguments in [["init", "-q"], ["remote", "add", "origin", origin]] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", repoRoot] + arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
    }
    store.publish(.lots, "\(fixtureId(lotByte)).json", object: lotObject(id: fixtureId(lotByte), repoRoot: repoRoot))
    return realpathOr(repoRoot)
}

/// Le relais factice des gestes vers le VPS.
@MainActor
private final class RecordingRelay: RemoteGestureRelay {
    var gestures: [(RemoteCardGesture, String)] = []
    var launches: [(root: String, title: String)] = []
    var failure: String?

    func send(_ gesture: RemoteCardGesture, cardId: String) async -> String? {
        gestures.append((gesture, cardId))
        return failure
    }

    func launch(repoRoot: String, title: String, description: String, modelReqSpecs: String?, modelImplReview: String?) async -> String? {
        launches.append((repoRoot, title))
        return failure
    }
}

// MARK: - Bloc de connexion

@MainActor
@Test("bloc VPS : adresse et code appairent le VPS, « Oublier ce VPS » revient à non appairé, un mauvais code dit sa cause")
func vpsConnectionBlockPairsAndForgets() async throws {
    let stack = try await RemoteStack.make(machine: vpsMachine)
    defer { stack.stop() }
    let client = vpsClient()
    client.start()
    let connection = VpsConnectionModel(client: client)
    #expect(connection.state == .notPaired)
    #expect(!connection.canPair)

    // Mauvais code : la cause est dite, rien n'est appairé.
    try fill(connection, stack: stack, code: "ABCDEFGH")
    #expect(connection.canPair)
    await connection.pair()
    #expect(connection.error == ReposViewText.codeRefused)
    #expect(connection.state == .notPaired)

    // Adresse invalide : refusée avant toute requête.
    connection.addressText = "ftp://vps"
    await connection.pair()
    #expect(connection.error == ReposViewText.addressInvalid)

    try fill(connection, stack: stack)
    await connection.pair()
    #expect(connection.error == nil)
    #expect(await awaitMainTrue(timeout: 10) { isConnected(connection) })
    #expect(connection.state == .connected(address: "127.0.0.1:\(stack.port)"))
    #expect(stack.registry.devices.count == 1)

    await connection.forget()
    #expect(connection.state == .notPaired)
    #expect(connection.addressText.isEmpty)
    #expect(stack.registry.devices.isEmpty)
}

@MainActor
@Test("bloc VPS : une adresse qui est celle du Mac est dite « mauvaise machine » et ne sert aucun geste")
func vpsConnectionBlockFlagsTheWrongMachine() async throws {
    let stack = try await RemoteStack.make(machine: ConsoleMachine(kind: ConsoleMachine.macKind, name: "Un Mac"))
    defer { stack.stop() }
    let client = vpsClient()
    client.start()
    let connection = VpsConnectionModel(client: client)
    try fill(connection, stack: stack)
    await connection.pair()
    #expect(await awaitMainTrue(timeout: 10) {
        if case .wrongMachine = connection.state { return true }
        return false
    })
    #expect(connection.state == .wrongMachine(expected: .vps, actual: .mac))
    #expect(VpsConnectionBlock.statusText(connection.state) == ReposText.wrongMachine(expected: .vps, actual: .mac))
    #expect(VpsConnectionBlock.offersPairing(connection.state))
}

// MARK: - Vue unifiée et bascule de bout en bout

@MainActor
@Test("section Dépôts : une vue des deux machines, la bascule Mac → VPS part du Mac et arrive au VPS, un VPS muet rend ses lignes injoignables")
func unifiedReposHandOverFromMacToVps() async throws {
    let macStore = StoreFixture()
    let vpsStore = StoreFixture()
    let macRoot = try publishOriginRepo(macStore, name: "depot-a", origin: "https://github.com/o/a.git", lotByte: 0xC1)
    _ = try publishOriginRepo(vpsStore, name: "depot-b", origin: "git@github.com:o/b.git", lotByte: 0xC2)
    let macService = ScriptedServiceTransport()
    macService.stubJSON("POST", "/handover", [
        "id": "h1", "identity": "github.com/o/a",
        "features": [["slug": "alpha", "description": "À faire"]],
    ])
    macService.stubJSON("POST", "/handover/h1/commit", ["removed": ["alpha"]])
    let vpsService = ScriptedServiceTransport()
    vpsService.stubJSON("POST", "/v1/repos/adopt", [
        "repoKey": "k", "repoRoot": "/srv/a", "cloned": true, "launched": ["alpha"], "refused": [],
    ])
    let env = ["PATH": "/usr/bin:/bin"]
    let macStack = try await RemoteStack.make(stateDir: macStore.root, environment: env, makeServiceClient: { scriptedClient(macService) })
    let vpsStack = try await RemoteStack.make(stateDir: vpsStore.root, machine: vpsMachine, environment: env, makeServiceClient: { scriptedClient(vpsService) })
    defer { macStack.stop(); vpsStack.stop() }

    let hub = MachineHub(
        local: LocalMacSource(actions: macStack.remoteActions, hub: macStack.storeHub, kanban: macStack.kanban),
        vps: vpsClient(),
        kanban: macStack.kanban,
        actions: macStack.actions,
        preferences: InMemoryClientPreferences()
    )
    hub.start()
    // Sans VPS configuré : rien ne change — pas d'ardoise unifiée, pas de sélecteur.
    #expect(hub.unifiedBoard == nil)
    #expect(!hub.vpsConfigured)
    #expect(hub.activeMachine == .mac)
    hub.select(.vps)
    #expect(hub.activeMachine == .mac)
    await hub.repos.refresh()
    #expect(hub.repos.lines.map(\.name) == ["a"])
    #expect(hub.repos.lines.first?.offers.first?.disabledReason == ReposText.notPaired(.vps))

    // Le VPS est appairé par le bloc de connexion.
    try fill(hub.connection, stack: vpsStack)
    await hub.connection.pair()
    #expect(await awaitMainTrue(timeout: 10) { isConnected(hub.connection) })
    #expect(hub.vpsConfigured)
    #expect(hub.activeMachine == .vps)
    await hub.repos.refresh()

    // Un relevé déjà en vol (déclenché par la connexion) absorbe l'appel : on attend ses lignes.
    #expect(await awaitMainTrue(timeout: 10) { hub.repos.lines.count == 2 })
    // Une vue : les deux dépôts, chacun marqué de sa machine.
    let lines = hub.repos.lines
    #expect(lines.map(\.name) == ["a", "b"])
    let a = try #require(lines.first { $0.name == "a" })
    let b = try #require(lines.first { $0.name == "b" })
    #expect(a.mac?.repoRoot == macRoot && a.vps == nil && a.conductor == .mac)
    #expect(b.vps != nil && b.mac == nil && b.conductor == .vps)
    #expect(a.status == .drivable && b.status == .drivable)
    let offer = try #require(a.offers.first)
    #expect(offer.to == .vps && offer.isEnabled)
    #expect(hub.repos.confirmation(for: a, offer: offer).hasPrefix("Confier a au VPS"))

    // Confier a au VPS : handover sur le Mac, adopt sur le VPS, commit sur le Mac.
    await hub.repos.handOver(a, offer: offer)
    #expect(hub.repos.message == .success(ReposText.success(name: "a", to: .vps, launched: 1)))
    let macCalls = macService.requests
    #expect(macCalls.map(\.method) == ["POST", "POST"])
    #expect(macCalls[0].path == "/v1/repos/\(macRoot)/handover")
    #expect(macCalls[0].body?["to"] as? String == "vps")
    #expect(macCalls[1].path == "/v1/repos/\(macRoot)/handover/h1/commit")
    #expect(macCalls[1].body?["slugs"] as? [String] == ["alpha"])
    let vpsCalls = vpsService.requests
    #expect(vpsCalls.count == 1)
    #expect(vpsCalls[0].path == "/v1/repos/adopt")
    #expect(vpsCalls[0].body?["identity"] as? String == "github.com/o/a")
    #expect((vpsCalls[0].body?["features"] as? [[String: Any]])?.first?["slug"] as? String == "alpha")

    // Le VPS cesse de répondre : ses lignes viennent du dernier relevé, marquées injoignables.
    vpsStack.stop()
    #expect(await awaitMainTrue(timeout: 15) { hub.availability == .unreachable })
    #expect(await awaitMainTrue(timeout: 10) { hub.repos.lines.first { $0.name == "b" }?.status == .unreachable(.vps) })
    let stale = try #require(hub.repos.lines.first { $0.name == "b" })
    #expect(stale.status == .unreachable(.vps))
    #expect(stale.staleMachines == [.vps])
    let live = try #require(hub.repos.lines.first { $0.name == "a" })
    #expect(live.status == .drivable)
    // Le bandeau « VPS injoignable » sur l'ardoise unifiée.
    #expect(hub.unifiedBoard?.unreachable == [.vps])
    #expect(hub.unifiedBoard?.showsBadges == true)
    #expect(ReposText.machineBanner(.vps) == "VPS injoignable")
}

// MARK: - Ardoise unifiée et gestes de carte

@MainActor
@Test("ardoise unifiée : les cartes du VPS portent `vps:<id>` et leur identifiant dans le geste ; sans VPS, l'ardoise du Mac est inchangée")
func unifiedBoardStampsVpsCards() throws {
    let kanban = KanbanModel(prStates: PullRequestStateBook(reader: nil))
    #expect(kanban.board == kanban.state)
    let board = KanbanBoardState.derive(
        snapshot: HomeParity.snapshot, nowMs: 1_700_000_000_000, stateDir: "",
        isAlive: .transported(HomeParity.snapshot), prFacts: [:]
    )
    let cards = try #require(board.kanbanBoard?.cards)
    #expect(!cards.isEmpty)
    let merged = UnifiedBoard.merge(mac: .state(board), vps: .state(board))
    var unified = merged
    unified.state = MachineHub.stamped(merged.state)
    let all = try #require(unified.state.kanbanBoard?.cards)
    #expect(all.count == cards.count * 2)
    for card in all {
        let isVps = MachineCardID.machine(of: card.id) == .vps
        #expect(card.action?.cardId == (isVps && card.action != nil ? card.id : nil))
    }
    kanban.setUnified(unified)
    #expect(kanban.board == unified.state)
    #expect(kanban.unified?.showsBadges == true)
    kanban.setUnified(nil)
    #expect(kanban.board == kanban.state)
}

@MainActor
@Test("gestes de carte : une carte du VPS part au VPS avec l'identifiant de la carte, une carte du Mac ne traverse jamais le relais")
func vpsCardGesturesGoToTheVps() async throws {
    let relay = RecordingRelay()
    let actions = ActionsModel()
    actions.relay = relay
    let vpsAction = KanbanCardAction(
        repoRoot: "/srv/depot", slug: "alpha", waitKind: .specs, featureState: .waiting, run: nil
    )
    var stamped = vpsAction
    stamped.cardId = "vps:feature:k:alpha"

    actions.validate(stamped)
    actions.accept(stamped)
    actions.stopLot(stamped)
    actions.resume(stamped)
    actions.replyText = "ma réponse"
    actions.submitReply(stamped)
    await actions.commandTask?.value
    #expect(relay.gestures.map(\.1) == Array(repeating: "vps:feature:k:alpha", count: 5))
    #expect(relay.gestures.map(\.0) == [.verdict("specs"), .verdict("review"), .stop, .resume, .reply("ma réponse")])
    #expect(actions.replyText.isEmpty)
    #expect(actions.journal.allSatisfy { $0.state == .taken || $0.state == .awaitingAck })

    // Une carte du Mac : le relais n'est jamais appelé.
    relay.gestures = []
    actions.validate(vpsAction)
    #expect(relay.gestures.isEmpty)

    // Le motif du VPS arrive au journal, tel quel.
    relay.failure = "carte inconnue"
    actions.validate(stamped)
    await actions.commandTask?.value
    #expect(actions.journal.first?.state == .failed(reason: "carte inconnue"))
}

@MainActor
@Test("nouvelle feature : un dépôt conduit par le VPS lance sur le VPS avec sa racine, un dépôt du Mac lance en local")
func newFeatureLaunchesOnTheConductingMachine() async throws {
    let relay = RecordingRelay()
    let actions = ActionsModel()
    actions.relay = relay
    actions.launchTitle = "Titre"
    actions.launchDescription = "Besoin"
    let console = ConsoleModel()
    NewFeatureSheet.submit(actions: actions, console: console, repoRoot: MachineCardID.namespaced("/srv/depot", on: .vps))
    await actions.commandTask?.value
    #expect(relay.launches.map(\.root) == ["/srv/depot"])
    #expect(relay.launches.map(\.title) == ["Titre"])
    #expect(actions.journal.first?.state == .taken)
    #expect(!actions.launchFormShown)
}

@MainActor
@Test("relais du hub : un geste vers le VPS atteint la route du VPS avec l'identifiant brut de la carte et rend son motif")
func hubRelaysGesturesToTheVpsRoutes() async throws {
    let vpsStack = try await RemoteStack.make(machine: vpsMachine)
    defer { vpsStack.stop() }
    let hub = MachineHub(
        local: LocalMacSource(actions: vpsStack.remoteActions, hub: vpsStack.storeHub, kanban: vpsStack.kanban),
        vps: vpsClient(),
        kanban: KanbanModel(prStates: PullRequestStateBook(reader: nil)),
        actions: ActionsModel(),
        preferences: InMemoryClientPreferences()
    )
    hub.start()
    try fill(hub.connection, stack: vpsStack)
    await hub.connection.pair()
    #expect(await awaitMainTrue(timeout: 10) { isConnected(hub.connection) })
    // La carte n'existe pas sur le VPS : sa route répond 404 « carte inconnue ».
    let reason = await hub.send(.stop, cardId: "vps:feature:k:alpha")
    #expect(reason == "carte inconnue")
    let launched = await hub.launch(repoRoot: "/inconnu", title: "t", description: "d", modelReqSpecs: nil, modelImplReview: nil)
    #expect(launched == "racine de dépôt git invalide")
}
