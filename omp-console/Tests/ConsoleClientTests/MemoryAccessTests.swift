// L'accès de l'app iOS à la mémoire du serveur : posé par le code d'appairage,
// gardé d'un lancement à l'autre, et la portée lue — choisie, sinon la plus récente.

import Foundation
import Testing
@testable import ConsoleClient

@MainActor
@Suite("Accès à la mémoire du serveur")
struct MemoryAccessTests {
    @Test("le code d'appairage pose adresse et jeton, relus au lancement suivant ; une adresse vide les oublie")
    func configureAndReload() async throws {
        let preferences = InMemoryClientPreferences()
        let tokens = InMemoryTokenStore()
        let access = MemoryAccess(preferences: preferences, tokens: tokens)
        #expect(!access.isConfigured)
        await access.configure(address: "https://vps.tailnet.ts.net:8443/", token: "jeton")
        #expect(access.server == MemoryServer(baseURL: URL(string: "https://vps.tailnet.ts.net:8443")!, token: "jeton"))

        let relaunched = MemoryAccess(preferences: preferences, tokens: tokens)
        await relaunched.load()
        #expect(relaunched.server == access.server)

        await relaunched.configure(address: "", token: "")
        #expect(!relaunched.isConfigured)
        #expect(preferences.string(forKey: MemoryAccess.addressKey) == nil)
        #expect(try await tokens.token(for: MemoryAccess.tokenAccount) == nil)
    }

    @Test("sans portée choisie, la plus récente ; une portée choisie est gardée")
    func scope() async throws {
        let transport = ScriptedMemoryTransport()
        transport.reply("/memory/all", json: #"{"results":[{"id":"1","memory":"x","agent_id":"recent"},{"id":"2","memory":"y","agent_id":"ancien"}]}"#)
        transport.reply("/memory/all?agent_id=recent", json: #"{"results":[{"id":"1","memory":"x","agent_id":"recent"}]}"#)
        let preferences = InMemoryClientPreferences()
        let access = MemoryAccess(preferences: preferences, tokens: InMemoryTokenStore(), transport: transport)
        await access.configure(address: "https://vps:8443", token: "jeton")
        let page = try await access.memoryPage(scope: nil, offset: 0, limit: nil)
        #expect(page.scope == "recent")
        #expect(access.scopes == ["recent", "ancien"])

        access.choose(scope: "ancien")
        #expect(try await access.scope(nil) == "ancien")
        #expect(preferences.string(forKey: MemoryAccess.scopeKey) == "ancien")
    }

    @Test("sans mémoire configurée, une lecture échoue sans appel")
    func unconfigured() async {
        let transport = ScriptedMemoryTransport()
        let access = MemoryAccess(preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(), transport: transport)
        await #expect(throws: MemoryReadError.unreachable) { try await access.memoryPage(scope: nil, offset: 0, limit: nil) }
        #expect(transport.requests.isEmpty)
    }
}
