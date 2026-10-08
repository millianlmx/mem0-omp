// Les preuves de PARITÉ DES FAITS du graphe des souvenirs (S-7, AC-8, AC-1/2) :
// la dérivation partagée sur la fixture, la charge utile de la route, et l'égalité
// de `tagFamily` avec `visibility(tag:)`.
//
// Aucune socket, aucune base réelle : la doublure `ScriptedMemoryService` alimente
// la pile HTTP réelle (`RemoteStack`), la fixture vit dans `ConsoleCore`
// (`MemoryGraphParity`).

import ConsoleCore
import Foundation
import Testing

@testable import OMPConsole

@Suite("ios-memoire-graphe — la parité des faits")
@MainActor
struct MemoryGraphRelayTests {

    // MARK: - 1. La dérivation partagée == la fixture gelée

    @Test("ios-memoire-graphe/AC-8 : la dérivation partagée rend exactement les faits gelés de la fixture")
    func derivationMatchesTheFrozenFacts() {
        let nodes = MemoryGraph.nodes(rows: MemoryGraphParity.rows)
        let links = MemoryGraph.links(
            rows: MemoryGraphParity.rows,
            edges: MemoryGraphParity.edges,
            manual: MemoryGraphParity.manual
        )
        #expect(nodes == MemoryGraphParity.facts.nodes)
        #expect(links == MemoryGraphParity.facts.links)

        // Les faits de la fixture : une étiquette partagée porte un nœud, une
        // étiquette portée par un seul n'en porte pas, une arête orpheline est
        // ignorée, un lien manuel chargé est visible.
        #expect(nodes.contains { $0.id == .tag("commun") })
        #expect(nodes.contains { $0.id == .tag("autre-partage") })
        #expect(!nodes.contains { $0.id == .tag("seul-a") })
        #expect(!nodes.contains { $0.id == .tag("seul-b") })
        #expect(!links.contains { $0.a == .memory("absent") || $0.b == .memory("absent") })
        #expect(links.contains { $0.a == .memory("m4") && $0.b == .memory("m5") && $0.kind == .manual })
    }

    // MARK: - 2. La charge utile de la route == la projection filaire des faits

    @Test("ios-memoire-graphe/AC-1 : la route sert la projection filaire des faits, lien manuel distingué")
    func routeServesTheWireProjectionOfTheFacts() async throws {
        let service = ScriptedMemoryService(
            page: .success(MemoryPage(total: MemoryGraphParity.rows.count, rows: MemoryGraphParity.rows)),
            graph: .success(MemoryGraphEdges(total: MemoryGraphParity.edges.count, edges: MemoryGraphParity.edges))
        )
        let stack = try await RemoteStack.make(memory: service)
        defer { stack.stop() }
        // Le lien manuel de la fixture, écrit dans le fichier EXACT que la pile lit.
        let url = stack.supportRoot.appendingPathComponent(MemoryLinkStore.fileName)
        #expect(MemoryLinkStore.save(MemoryGraphParity.manual, to: url))
        let token = try await stack.pair()

        // AUCUN scope demandé : toutes les portées.
        let reply = try await stack.call("GET", "/v1/memory/graph", token: token)
        #expect(reply.status == 200)
        let payload = try reply.json(RemoteMemoryGraphPayload.self)

        let facts = MemoryGraphParity.facts
        // Mêmes ids, mêmes libellés, mêmes portées.
        #expect(payload.nodes.map(\.id) == facts.nodes.map { MemoryGraphWire.id($0.id) })
        #expect(payload.nodes.map(\.label) == facts.nodes.map(\.label))
        #expect(payload.nodes.map(\.scope) == facts.nodes.map { $0.scope ?? "" })
        // `text` et `tags` portés par les SEULS nœuds-souvenirs.
        for (index, node) in facts.nodes.enumerated() {
            let wire = payload.nodes[index]
            let isMemory = node.id.memoryId != nil
            #expect(wire.text == (isMemory ? node.text : nil))
            #expect(wire.tags == (isMemory ? node.tags : nil))
        }
        // Mêmes natures, dans le même ordre ; `score` seulement pour `semantic`.
        #expect(payload.links.map(\.a) == facts.links.map { MemoryGraphWire.id($0.a) })
        #expect(payload.links.map(\.b) == facts.links.map { MemoryGraphWire.id($0.b) })
        #expect(payload.links.map(\.kind) == facts.links.map { MemoryGraphWire.name($0.kind) })
        for (index, link) in facts.links.enumerated() {
            let wire = payload.links[index]
            if case let .semantic(score) = link.kind {
                #expect(wire.score == score)
            } else {
                #expect(wire.score == nil)
            }
        }
        #expect(payload.links.contains { $0.kind == "manual" })
        #expect(payload.total == payload.nodes.count)
        #expect(payload.truncated == false)
        #expect(service.allScopes == [nil])
    }

    // MARK: - 3. tagFamily == visibility(tag:)

    @Test("ios-memoire-graphe/AC-7 : tagFamily rend la MÊME famille que visibility(tag:) sur les mêmes lignes")
    func tagFamilyEqualsVisibility() {
        let facts = MemoryGraphParity.facts
        let family = MemoryGraph.tagFamily(
            nodes: facts.nodes,
            links: facts.links,
            tag: MemoryGraphParity.tag
        )
        let expected = MemoryGraph.visibility(
            rows: MemoryGraphParity.rows,
            links: facts.links,
            project: nil,
            tag: MemoryGraphParity.tag,
            searchIds: nil
        )
        #expect(family.nodes == expected.nodes)
        #expect(family.links == expected.links)

        // Tous les porteurs restent, un seul nœud-étiquette, et le filtre est
        // idempotent.
        #expect(family.nodes.allSatisfy { node in
            node.id.tagName == MemoryGraphParity.tag || node.tags.contains(MemoryGraphParity.tag)
        })
        #expect(family.nodes.filter { $0.id.tagName != nil }.count == 1)
        let again = MemoryGraph.tagFamily(nodes: family.nodes, links: family.links, tag: MemoryGraphParity.tag)
        #expect(again.nodes == family.nodes)
        #expect(again.links == family.links)

        // Une étiquette ABSENTE du graphe rend le graphe inchangé.
        let absent = MemoryGraph.tagFamily(nodes: facts.nodes, links: facts.links, tag: "inconnue")
        #expect(absent.nodes == facts.nodes)
        #expect(absent.links == facts.links)
    }
}
