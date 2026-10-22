// Les preuves de PARITÉ DES FAITS du graphe des souvenirs (S-7, AC-8, AC-7) : la
// dérivation partagée sur la fixture, et l'égalité de `tagFamily` avec
// `visibility(tag:)`. La fixture vit dans `ConsoleCore` (`MemoryGraphParity`) ; le
// lecteur de l'app iOS en tire la même projection (`MemoryReaderTests`).

import ConsoleCore
import Foundation
import Testing

@Suite("ios-memoire-graphe — la parité des faits")
struct MemoryGraphParityTests {
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
