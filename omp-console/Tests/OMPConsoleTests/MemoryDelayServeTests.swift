// Le banc de recette de la feature memoire-ios-expire-a-10-secondes (S-9) : une
// coque RÉELLE construite depuis le worktree (vraies routes, vrai registre, vrai
// flux) servie sur un port éphémère, branchée sur la VRAIE mémoire mem0-http du
// poste. Les simulateurs privés s'y appairent sans aucun geste sur l'app Mac de
// l'utilisateur.
//
// GATED par `MEM0_MEMOIRE_DELAI_SERVE=1` : sans la variable, il rend la main sans
// rien faire (patron `iosMemoireRecipe`). Lancement, depuis `omp-console/` :
//
//   MEM0_MEMOIRE_DELAI_SERVE=1 MEM0_MEMOIRE_DELAI_ROOT=/Users/millian/Experiments/mem0-omp \
//     [MEM0_MEMOIRE_DELAI_MINUTES=20] [MEM0_MEMOIRE_DELAI_LATENCE=0] \
//     swift test --filter memoryDelayServe
//
// Sorties (une ligne chacune, sur stdout) : `SCOPE <portée>`, puis, sans latence,
// `PAGES <n> LIGNES <n> DOUBLONS <d> TOTAL <total>` et
// `GRAPHE SOUVENIRS <n> AUTRES-PORTEES <k> TRONQUE <bool>` ; enfin `PORT <port>`
// et `CODE <code>` toutes les 90 s jusqu'à l'échéance de MINUTES.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsole

/// Un service mémoire qui RETARDE ses deux lectures lourdes (`all`, `graph`) de
/// `latency` secondes avant de déléguer : il simule un Mac chargé, pour capturer
/// l'attente puis l'expiration côté iOS. Toutes les autres méthodes délèguent
/// sans délai.
struct DelayedMemoryService: MemoryServing {
    let base: any MemoryServing
    let latency: TimeInterval

    private func pause() async throws {
        guard latency > 0 else { return }
        try await Task.sleep(for: .seconds(latency))
    }

    func health() async -> MemoryHealth {
        await base.health()
    }

    func all(scope: String?) async throws -> MemoryPage {
        try await pause()
        return try await base.all(scope: scope)
    }

    func search(query: String, scope: String?, pool: Int) async throws -> [MemoryRow] {
        try await base.search(query: query, scope: scope, pool: pool)
    }

    func graph() async throws -> MemoryGraphEdges {
        try await pause()
        return try await base.graph()
    }

    func add(text: String, scope: String, tags: [String]) async throws {
        try await base.add(text: text, scope: scope, tags: tags)
    }

    func update(id: String, text: String, tags: [String]) async throws {
        try await base.update(id: id, text: text, tags: tags)
    }

    func delete(id: String) async throws {
        try await base.delete(id: id)
    }
}

/// Une ligne du banc, vidée tout de suite : stdout est tamponné quand `swift test`
/// le redirige, et l'opérateur lit `PORT`/`CODE` pendant que le banc sert.
private func benchLine(_ line: String) {
    print(line)
    fflush(stdout)
}

/// Une durée lue dans l'environnement : absente ou vide ⇒ `fallback` ; illisible
/// ou négative ⇒ `nil` (le banc refuse de deviner).
private func benchSeconds(_ raw: String?, fallback: Double) -> Double? {
    guard let raw, !raw.trimmingCharacters(in: .whitespaces).isEmpty else { return fallback }
    guard let value = Double(raw.trimmingCharacters(in: .whitespaces)), value >= 0 else { return nil }
    return value
}

/// Découverte muette : le client du banc se connecte par l'adresse manuelle.
@MainActor
private final class BenchDiscovery: DiscoverySource {
    var onChange: (([DiscoveredMac]) -> Void)?
    var onProtocolVersion: ((Int) -> Void)?
    var onDenied: ((Bool) -> Void)?
    func start(serviceType: String) {}
    func stop() {}
}

@MainActor
private final class BenchPath: ClientPathSource {
    var onChange: ((Bool) -> Void)?
    func start() {}
    func stop() {}
}

/// Le client de PRODUCTION (URLSession) appairé à la pile du banc par un code
/// frais : ses lectures passent par les mêmes délais et bornes que l'app iOS.
@MainActor
private func benchClient(on stack: RemoteStack) async throws -> ConsoleClientModel {
    let client = ConsoleClientModel(
        transport: ConsoleClient.URLSessionTransport(),
        discovery: BenchDiscovery(),
        preferences: InMemoryClientPreferences(),
        tokens: InMemoryTokenStore(),
        pacer: LiveClientPacer(),
        pathSource: BenchPath()
    )
    client.start()
    _ = client.setManualAddress("127.0.0.1:\(stack.port)")
    try await client.pair(code: try stack.registry.generateCode().value, deviceName: "Banc mémoire")
    return client
}

@MainActor
@Suite("Banc memoire-ios-expire-a-10-secondes (coque réelle, mémoire réelle)")
struct MemoryDelayServeTests {
    /// Le NOM de la fonction est ce que `swift test --filter memoryDelayServe` cible.
    @Test("memoire-ios-expire-a-10-secondes/AC-2 : memoryDelayServe — banc de recette sur la mémoire réelle, servi aux simulateurs privés")
    func memoryDelayServe() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["MEM0_MEMOIRE_DELAI_SERVE"] == "1" else { return }

        let root = try #require(
            environment["MEM0_MEMOIRE_DELAI_ROOT"].flatMap { $0.isEmpty ? nil : $0 },
            "MEM0_MEMOIRE_DELAI_ROOT est requis : la racine du dépôt dont la mémoire est servie"
        )
        let minutes = try #require(
            benchSeconds(environment["MEM0_MEMOIRE_DELAI_MINUTES"], fallback: 20),
            "MEM0_MEMOIRE_DELAI_MINUTES doit être un nombre positif ou nul"
        )
        let latency = try #require(
            benchSeconds(environment["MEM0_MEMOIRE_DELAI_LATENCE"], fallback: 0),
            "MEM0_MEMOIRE_DELAI_LATENCE doit être un nombre de secondes positif ou nul"
        )

        // (1) Le projet ouvert de la coque = la racine demandée ; la préférence de
        // l'utilisateur est rendue telle quelle en sortie.
        let defaults = UserDefaults.standard
        let previousRoot = defaults.object(forKey: ProjectRoot.defaultsKey)
        defaults.set(root, forKey: ProjectRoot.defaultsKey)
        defer {
            if let previousRoot {
                defaults.set(previousRoot, forKey: ProjectRoot.defaultsKey)
            } else {
                defaults.removeObject(forKey: ProjectRoot.defaultsKey)
            }
        }
        let scope = try #require(
            await MemoryScope.currentProject(environment: [:]),
            "aucune portée résolue pour \(root) : la coque servirait une Mémoire vide"
        )
        benchLine("SCOPE \(scope)")

        // (2) La pile complète, ses routes Mémoire branchées sur la vraie mémoire,
        // retardée de `latency` secondes avant chaque lecture lourde.
        let memoryConfig = MemoryServiceConfig.fromEnvironment(environment)
        let stack = try await RemoteStack.make(
            liveMemory: DelayedMemoryService(base: HTTPMemoryService(config: memoryConfig), latency: latency),
            memoryConfig: memoryConfig
        )
        defer { stack.stop() }

        // (3) Contrôles par le client de production, sautés sous latence (le banc
        // sert alors à capturer l'attente et l'expiration, pas à mesurer).
        if latency == 0 {
            let client = try await benchClient(on: stack)
            defer { client.stop() }

            var ids: [String] = []
            var pages = 0
            var offset = 0
            var total = 0
            while true {
                let page = try await client.memoryPage(scope: nil, offset: offset, limit: nil)
                pages += 1
                total = page.total
                ids.append(contentsOf: page.rows.map(\.id))
                guard let next = page.nextOffset else { break }
                #expect(next > offset, "nextOffset doit avancer")
                guard next > offset else { break }
                offset = next
            }
            let duplicates = ids.count - Set(ids).count
            benchLine("PAGES \(pages) LIGNES \(ids.count) DOUBLONS \(duplicates) TOTAL \(total)")
            #expect(ids.count == total)
            #expect(duplicates == 0)

            let graph = try await client.memoryGraph(scope: nil)
            let memoryNodes = graph.nodes.filter { $0.id.hasPrefix("memory:") }
            let otherScopes = memoryNodes.filter { $0.scope != scope }.count
            benchLine("GRAPHE SOUVENIRS \(memoryNodes.count) AUTRES-PORTEES \(otherScopes) TRONQUE \(graph.truncated)")
            #expect(memoryNodes.count == total)
            #expect(otherScopes == 0)
            #expect(graph.truncated == false)
        }

        // (4) Servir jusqu'à l'échéance, un code d'appairage frais toutes les 90 s.
        guard minutes > 0 else { return }
        benchLine("PORT \(stack.port)")
        let deadline = Date().addingTimeInterval(minutes * 60)
        while true {
            let remaining = deadline.timeIntervalSinceNow
            guard remaining > 0 else { break }
            benchLine("CODE \(try stack.registry.generateCode().value)")
            try await Task.sleep(for: .seconds(min(90, remaining)))
        }
    }
}
