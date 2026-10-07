// La recette OUTILLÉE de la feature ios-memoire (BR-4) : lire la mémoire du projet
// depuis le client iOS, contre une coque réelle (pile locale sur un port éphémère,
// vraies routes, vrai registre, vrai flux).
//
// Elle est GATED par `MEM0_MEMOIRE_RECIPE=1` (patron `iosProjetRecipe`) : sans la
// variable, elle rend la main sans rien éprouver — le rejeu MANUEL de la recette
// pas à pas reste la preuve d'écran, elle est documentée dans
// `omp-console/README.md` § Coque iOS. Son nom de fonction est ce que
// `swift test --filter iosMemoireRecipe` cible ; son titre porte l'id qualifié.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsole

/// Découverte muette : le client se connecte par l'adresse manuelle, jamais par
/// Bonjour (ce que la recette n'éprouve pas).
@MainActor
private final class MemoryRecipeDiscovery: DiscoverySource {
    var onChange: (([DiscoveredMac]) -> Void)?
    var onProtocolVersion: ((Int) -> Void)?
    var onDenied: ((Bool) -> Void)?
    func start(serviceType: String) {}
    func stop() {}
}

@MainActor
private final class MemoryRecipePath: ClientPathSource {
    var onChange: ((Bool) -> Void)?
    func start() {}
    func stop() {}
}

/// Attend une condition sans bloquer plus que nécessaire. 10 s : le premier
/// `.connected` dépend de la montée du flux SSE, la seule partie lente.
@MainActor
private func memoryRecipeEventually(timeout: Double = 10, _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return condition()
}

/// Un client iOS réel appairé à une pile de test : le client de PRODUCTION
/// (URLSession), l'adresse manuelle, et l'appairage par un code frais.
@MainActor
private func memoryRecipeClient(on stack: RemoteStack) async throws -> ConsoleClientModel {
    let client = ConsoleClientModel(
        transport: URLSessionTransport(),
        discovery: MemoryRecipeDiscovery(),
        preferences: InMemoryClientPreferences(),
        tokens: InMemoryTokenStore(),
        pacer: LiveClientPacer(),
        pathSource: MemoryRecipePath()
    )
    // `start()` d'abord : sans lui `running` reste faux et `beginConnection` sort
    // sur son garde — les appels HTTP passeraient, mais le flux SSE ne s'ouvrirait
    // jamais et `state` n'atteindrait pas `.connected`.
    client.start()
    _ = client.setManualAddress("127.0.0.1:\(stack.port)")
    let code = try stack.registry.generateCode()
    try await client.pair(code: code.value, deviceName: "Recette iPhone")
    #expect(await memoryRecipeEventually { if case .connected = client.state { return true }; return false })
    return client
}

@MainActor
@Suite("Recette ios-memoire (coque réelle)")
struct MemoryIOSRecipeTests {
    /// La portée EXPLICITE de la recette : déterministe, elle ne dépend pas du
    /// projet ouvert sur le poste.
    private let scope = "recette-memoire"

    private func recipeRows() -> [MemoryRow] {
        [
            memoryRow(id: "r1", text: "souvenir un", score: 0.40, scope: "recette-memoire", tags: ["commun"]),
            memoryRow(id: "r2", text: "souvenir deux", score: 0.55, scope: "recette-memoire", tags: ["commun"]),
            memoryRow(id: "r3", text: "souvenir trois", score: 0.92, scope: "recette-memoire", tags: []),
            memoryRow(id: "r4", text: "souvenir quatre", score: nil, scope: "recette-memoire", tags: ["seul"]),
        ]
    }

    @Test("ios-memoire/AC-1 : recette réelle — sommaire, recherche, panne relayée et « aucun projet » depuis le client iOS")
    func iosMemoireRecipe() async throws {
        guard ProcessInfo.processInfo.environment["MEM0_MEMOIRE_RECIPE"] == "1" else { return }

        let rows = recipeRows()
        let service = ScriptedMemoryService(
            page: .success(MemoryPage(total: rows.count, rows: rows)),
            search: .success(rows)
        )
        let stack = try await RemoteStack.make(memory: service)
        defer { stack.stop() }
        let client = try await memoryRecipeClient(on: stack)
        defer { client.stop() }

        // (1) Le sommaire : les id, textes et l'ORDRE du service, identiques à ceux
        // que la coque macOS montre sur le MÊME service.
        let page = try await client.memory(scope: scope, limit: nil)
        let model = memoryModel(service: service, scope: scope)
        await model.refresh()
        guard case let .summary(_, total, shellRows) = model.state else {
            Issue.record("la coque macOS doit rendre un sommaire, reçu \(model.state)")
            return
        }
        #expect(page.scope == scope)
        #expect(page.total == total)
        #expect(page.truncated == false)
        #expect(page.rows.map(\.id) == shellRows.map(\.id))
        #expect(page.rows.map(\.id) == ["r1", "r2", "r3", "r4"])
        #expect(page.rows.map(\.text) == shellRows.map(\.text))

        // (2) La recherche : exactement la sélection de l'outil `mem0_search`.
        let search = try await client.memorySearch(query: "souvenir", scope: scope, limit: nil)
        let selected = MemorySearch.select(rows: rows, floor: MemorySearch.threshold, limit: MemorySearch.defaultLimit)
        #expect(search.rows.map(\.id) == selected.kept.map(\.id))
        #expect(search.rows.map(\.id) == ["r3", "r2"])
        #expect(search.candidates == 4)
        #expect(search.scored == 3)

        // (3) La pile mémoire tombe : le client reçoit la panne RELAYÉE, avec
        // l'adresse sondée et le dernier message.
        let down = ScriptedMemoryService(
            page: .failure(.notReachable("connexion refusée")),
            search: .failure(.notReachable("connexion refusée"))
        )
        let downStack = try await RemoteStack.make(memory: down)
        defer { downStack.stop() }
        let downClient = try await memoryRecipeClient(on: downStack)
        defer { downClient.stop() }
        do {
            _ = try await downClient.memory(scope: scope, limit: nil)
            Issue.record("une panne mémoire doit lever, jamais rendre un 200 vide")
        } catch let error as ClientError {
            guard case .api(let api) = error else {
                Issue.record("une panne mémoire doit être une erreur du contrat, reçu \(error)")
                return
            }
            #expect(api == .unavailable(MemoryText.unavailableDetail(
                address: "http://127.0.0.1:8321",
                error: "connexion refusée"
            )))
        }

        // (4) Aucun projet ouvert : la charge le DIT, sans lire la mémoire.
        let defaults = UserDefaults.standard
        let previous = defaults.string(forKey: ProjectRoot.defaultsKey)
        defaults.set("/inexistant-omp-console-\(UUID().uuidString)", forKey: ProjectRoot.defaultsKey)
        defer {
            if let previous {
                defaults.set(previous, forKey: ProjectRoot.defaultsKey)
            } else {
                defaults.removeObject(forKey: ProjectRoot.defaultsKey)
            }
        }
        let readsBefore = service.allScopes.count
        let empty = try await client.memory(scope: nil, limit: nil)
        #expect(empty.scope == nil)
        #expect(empty.total == 0)
        #expect(empty.rows.isEmpty)
        #expect(empty.truncated == false)
        #expect(service.allScopes.count == readsBefore)
    }
}
