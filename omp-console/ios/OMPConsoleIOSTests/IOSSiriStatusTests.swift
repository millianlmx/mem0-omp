// La preuve Swift de l'intent témoin et de la racine de composition du serveur de
// pipelines (feature client-ios-possede-par-la-vue) : l'instance que l'app passe aux
// vues est celle que les App Intents résolvent, et l'intent énonce l'une des trois
// phrases, sans Mac et sans écriture.
//
// Un `AppDependency` ne se lit que DANS le déroulé d'exécution d'un intent : les
// intents sont exécutés par `callAsFunction(donate:)` contre un gestionnaire
// AUTONOME, jamais `.shared`.

import AppIntents
import ConsoleClient
import Foundation
import Testing

@testable import OMPConsoleIOS

/// Un serveur qui ne répond rien : chaque appel échoue en transport.
private struct SilentHarnessTransport: HarnessTransport {
    func send(_ call: HarnessCall, server: HarnessServer) async throws -> HarnessReply {
        throw URLError(.cannotConnectToHost)
    }

    func events(_ call: HarnessCall, server: HarnessServer) async throws -> AsyncThrowingStream<Data, Error> {
        throw URLError(.cannotConnectToHost)
    }
}

/// Un intent de test, jamais exposé : il résout le serveur comme tout intent de
/// l'app, mais dans le gestionnaire du test, et le relève.
private struct SharedServerProbe: AppIntent {
    static let title: LocalizedStringResource = "Sonde du serveur partagé"
    @MainActor static var resolved: [HarnessModel] = []

    @AppDependency var server: HarnessModel

    init() { _server = AppDependency() }
    init(dependencies: AppDependencyManager) { _server = AppDependency(manager: dependencies) }

    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, Never> {
        Self.resolved.append(server)
        return .result()
    }
}

@MainActor
private func silentServer() -> HarnessModel {
    HarnessModel(transport: SilentHarnessTransport(), preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore())
}

@Suite("client-ios-possede-par-la-vue — l'intent témoin")
@MainActor
struct IOSSiriStatusTests {
    @Test("les vues et les intents reçoivent la même instance du serveur")
    func viewsAndIntentsShareTheInstance() async throws {
        SharedServerProbe.resolved = []
        let manager = AppDependencyManager()
        let created = silentServer()
        let forViews = IOSSharedServer.install(created, in: manager)
        let _: Void = try await SharedServerProbe(dependencies: manager)(donate: false)
        let _: Void = try await SharedServerProbe(dependencies: manager)(donate: false)
        #expect(forViews === created)
        #expect(SharedServerProbe.resolved.count == 2)
        #expect(SharedServerProbe.resolved.allSatisfy { $0 === created })
    }

    @Test("la table : aucun serveur, serveur injoignable, ou ce qui attend l'humain")
    func resolvesTheThreeStates() {
        #expect(IOSSiriStatus.resolve(isConfigured: false, inbox: nil, failed: false) == .unconfigured)
        #expect(IOSSiriStatus.resolve(isConfigured: true, inbox: nil, failed: false) == .unreachable)
        #expect(IOSSiriStatus.resolve(isConfigured: true, inbox: HarnessInbox(), failed: true) == .unreachable)
        #expect(IOSSiriStatus.resolve(isConfigured: true, inbox: HarnessInbox(), failed: false) == .connected(pending: 0))
    }

    @Test("trois phrases distinctes, sans Mac")
    func phrasesAreDistinctWithoutMac() {
        let phrases = [IOSSiriStatus.unconfigured, .unreachable, .connected(pending: 0), .connected(pending: 3)].map(\.phrase)
        #expect(Set(phrases).count == phrases.count)
        #expect(phrases.allSatisfy { !$0.contains("Mac") })
        #expect(IOSSiriText.connected(pending: 3) == "Relié au serveur, 3 en attente")
    }

    @Test("sans serveur relié, l'intent le dit sans rien appeler")
    func unconfiguredIntentSaysSo() async throws {
        let manager = AppDependencyManager()
        _ = IOSSharedServer.install(silentServer(), in: manager)
        let answer = await IOSSiriStatus.answer(for: silentServer())
        #expect(answer == IOSSiriText.unconfigured)
        let _: Void = try await IOSConnectionStatusIntent(dependencies: manager)(donate: false)
    }
}
