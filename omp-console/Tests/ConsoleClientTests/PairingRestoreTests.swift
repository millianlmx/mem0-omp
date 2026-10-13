// L'attente de la relecture du jeton (S-2 de client-ios-possede-par-la-vue) :
// `awaitPairingRestored()` démarre le client s'il ne tourne pas, attend la fin de
// la PREMIÈRE lecture du trousseau et rend le statut d'appairage, jamais
// `.restoring`. Elle n'attend ni la découverte du Mac ni la connexion, et ne lit
// jamais le trousseau en plus de la lecture que `start()` lance.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

/// Le trousseau des tests qui compte ses lectures : `held` retient chaque lecture
/// jusqu'à `open()`, pour observer l'attente pendant que le trousseau est lu.
private actor CountingTokenStore: TokenStore {
    private var tokens: [String: String]
    private var held: Bool
    private var gates: [CheckedContinuation<Void, Never>] = []
    private(set) var reads = 0

    init(_ tokens: [String: String] = [:], held: Bool = false) {
        self.tokens = tokens
        self.held = held
    }

    func save(_ token: String, for deviceId: String) async throws {
        tokens[deviceId] = token
    }

    func token(for deviceId: String) async throws -> String? {
        reads += 1
        if held {
            await withCheckedContinuation { gates.append($0) }
        }
        return tokens[deviceId]
    }

    func remove(deviceId: String) async throws {
        tokens[deviceId] = nil
    }

    /// Libère les lectures retenues et laisse passer les suivantes.
    func open() {
        held = false
        let waiting = gates
        gates = []
        for gate in waiting { gate.resume() }
    }
}

/// Le résultat d'une attente lancée en tâche : `nil` tant qu'elle n'a pas rendu.
@MainActor
private final class PairingOutcome {
    var value: ClientPairingStatus?
}

@MainActor
private func makeModel(
    tokens: CountingTokenStore,
    preferences: [String: String],
    discovery: ScriptedDiscovery = ScriptedDiscovery()
) -> ConsoleClientModel {
    ConsoleClientModel(
        transport: ScriptedTransport(),
        discovery: discovery,
        preferences: InMemoryClientPreferences(preferences),
        tokens: tokens,
        pacer: RecordingPacer(),
        pathSource: ScriptedPathSource(),
        deviceName: "iPhone",
        localProtocolVersion: 1,
        nowMs: { Date().timeIntervalSince1970 * 1000 },
        // Le délai de recherche ne s'écoule pas pendant le test : l'état reste
        // `.searching` tant qu'aucun Mac n'est annoncé.
        searchPacer: LiveClientPacer()
    )
}

/// Attend que le trousseau ait reçu `count` lectures (borné à 3 s).
private func waitForReads(_ store: CountingTokenStore, _ count: Int) async -> Bool {
    let deadline = Date().addingTimeInterval(3)
    while Date() < deadline {
        if await store.reads >= count { return true }
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
    return false
}

@Suite("Attente de la relecture du jeton")
@MainActor
struct PairingRestoreTests {
    @Test("client-ios-possede-par-la-vue/AC-1 : deux attentes et un start() de plus ne lisent le trousseau qu'une fois")
    func concurrentWaitersShareOneRead() async {
        let store = CountingTokenStore(["dev-1": "tok-1"], held: true)
        let model = makeModel(tokens: store, preferences: [ClientPreferenceKey.deviceId: "dev-1"])
        defer { model.stop() }

        model.start()
        let first = PairingOutcome()
        let second = PairingOutcome()
        let firstWait = Task { @MainActor in first.value = await model.awaitPairingRestored() }
        let secondWait = Task { @MainActor in second.value = await model.awaitPairingRestored() }
        #expect(await waitForReads(store, 1))
        model.start()
        #expect(first.value == nil)
        #expect(second.value == nil)

        await store.open()
        await firstWait.value
        await secondWait.value

        #expect(first.value == .paired)
        #expect(second.value == .paired)
        #expect(await store.reads == 1)
        // Le trousseau est lu : une nouvelle attente rend sans relire.
        #expect(await model.awaitPairingRestored() == .paired)
        #expect(await store.reads == 1)
    }

    @Test("client-ios-possede-par-la-vue/AC-4 : sans jeton, l'attente rend .unpaired, jamais .restoring")
    func missingTokenResolvesUnpaired() async {
        // (a) Aucun appareil mémorisé : aucune lecture du trousseau.
        let blank = CountingTokenStore()
        let fresh = makeModel(tokens: blank, preferences: [:])
        defer { fresh.stop() }
        #expect(await fresh.awaitPairingRestored() == .unpaired)
        #expect(await blank.reads == 0)

        // (b) Appareil mémorisé sans jeton, lecture retenue : l'attente ne rend
        // pas tant que la lecture est en cours, puis rend `.unpaired`.
        let held = CountingTokenStore(held: true)
        let model = makeModel(tokens: held, preferences: [ClientPreferenceKey.deviceId: "dev-1"])
        defer { model.stop() }
        let outcome = PairingOutcome()
        let wait = Task { @MainActor in outcome.value = await model.awaitPairingRestored() }
        #expect(await waitForReads(held, 1))
        #expect(outcome.value == nil)
        #expect(model.pairing == .restoring)

        await held.open()
        await wait.value

        #expect(outcome.value == .unpaired)
        #expect(await held.reads == 1)
    }

    @Test("client-ios-possede-par-la-vue/AC-5 : jeton présent sans Mac découvert, l'attente rend .paired sans attendre la découverte")
    func storedTokenResolvesPairedWhileSearching() async {
        let discovery = ScriptedDiscovery()
        let store = CountingTokenStore(["dev-1": "tok-1"])
        let model = makeModel(
            tokens: store,
            preferences: [ClientPreferenceKey.deviceId: "dev-1"],
            discovery: discovery
        )
        defer { model.stop() }

        #expect(await model.awaitPairingRestored() == .paired)
        #expect(model.state == .searching)
        #expect(discovery.started)
        #expect(await store.reads == 1)
    }
}
