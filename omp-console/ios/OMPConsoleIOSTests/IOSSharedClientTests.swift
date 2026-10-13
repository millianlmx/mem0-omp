// La preuve Swift de la racine de composition du client distant (feature
// client-ios-possede-par-la-vue, S-1) : l'instance que l'app passe aux vues est
// celle que les App Intents résolvent. Un gestionnaire AUTONOME est employé,
// jamais `.shared`, que l'app hôte des tests remplit déjà dans `App.init()`.
//
// Un `AppDependency` ne se lit que DANS le déroulé d'exécution d'un intent :
// lu hors de lui (`intent.client` depuis un test), il arrête le processus
// (`fatalError` d'AppIntents, « Dependency values can only be accessed inside of
// the intent perform flow… »). La sonde ci-dessous est donc un intent exécuté
// par `callAsFunction(donate:)`, qui relève dans `perform()` le client résolu.

import AppIntents
import ConsoleClient
import Testing

@testable import OMPConsoleIOS

/// Un intent de test, jamais exposé : il résout le client comme le fera tout
/// intent de l'app, mais dans le gestionnaire du test, et le relève.
private struct SharedClientProbe: AppIntent {
    static let title: LocalizedStringResource = "Sonde du client partagé"
    @MainActor static var resolved: [ConsoleClientModel] = []

    @AppDependency var client: ConsoleClientModel

    init() { _client = AppDependency() }
    init(dependencies: AppDependencyManager) { _client = AppDependency(manager: dependencies) }

    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, Never> {
        Self.resolved.append(client)
        return .result()
    }
}

@Suite("client-ios-possede-par-la-vue — client partagé par l'app")
@MainActor
struct IOSSharedClientTests {
    @Test("client-ios-possede-par-la-vue/AC-1 : les vues et les intents reçoivent la même instance du client")
    func viewsAndIntentsShareTheInstance() async throws {
        SharedClientProbe.resolved = []
        let manager = AppDependencyManager()
        let transport = ScriptedClientTransport { _ in ClientDoubles.response(status: 404, json: "{}") }
        let created = ClientDoubles.model(transport: transport, address: "")

        let forViews = IOSSharedClient.install(created, in: manager)
        let _: Void = try await SharedClientProbe(dependencies: manager)(donate: false)
        let _: Void = try await SharedClientProbe(dependencies: manager)(donate: false)

        #expect(forViews === created)
        #expect(SharedClientProbe.resolved.count == 2)
        #expect(SharedClientProbe.resolved.allSatisfy { $0 === created })
    }
}
