// Le harnais des tests hermétiques : modèle + doublures, prêt à observer.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@MainActor
struct ClientHarness {
    let transport = ScriptedTransport()
    let discovery = ScriptedDiscovery()
    let path = ScriptedPathSource()
    let preferences: InMemoryClientPreferences
    let tokens: InMemoryTokenStore
    let pacer: RecordingPacer
    let model: ConsoleClientModel

    init(
        tokens initialTokens: [String: String] = [:],
        preferences initialPreferences: [String: String] = [:],
        pacerLimit: Int = Int.max,
        deviceName: String = "iPhone",
        localProtocolVersion: Int = 1,
        nowMs: @Sendable @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }
    ) {
        preferences = InMemoryClientPreferences(initialPreferences)
        tokens = InMemoryTokenStore(initialTokens)
        pacer = RecordingPacer(limit: pacerLimit)
        model = ConsoleClientModel(
            transport: transport,
            discovery: discovery,
            preferences: preferences,
            tokens: tokens,
            pacer: pacer,
            pathSource: path,
            deviceName: deviceName,
            localProtocolVersion: localProtocolVersion,
            nowMs: nowMs
        )
    }

    /// Démarre et attend que la restauration du jeton ait eu lieu (l'état quitte
    /// `unpaired`).
    func startWithToken() async {
        model.start()
        _ = await eventually { model.state != .unpaired }
    }

    func stop() {
        model.stop()
    }
}
