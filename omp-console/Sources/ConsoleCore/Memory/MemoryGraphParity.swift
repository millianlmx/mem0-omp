// LA FIXTURE DE RÉFÉRENCE partagée du graphe des souvenirs (S-7) : un jeu de
// lignes, des arêtes de service et un lien manuel, et l'ensemble ATTENDU
// {nœuds, liens} que `MemoryGraph` en dérive.
//
// Son CONTENU est figé par ses EFFETS attendus, pas par ses octets. Depuis
// `MemoryGraphParity.rows` / `.edges` / `.manual`, `MemoryGraph.nodes` puis
// `MemoryGraph.links` produisent exactement `MemoryGraphParity.facts` :
//   • une étiquette portée par ≥ 2 souvenirs B (« commun » : m1, m2, m3, m7) et
//     une autre (« autre-partage » : m8, m9) ⇒ deux nœuds-étiquettes ;
//   • une étiquette portée par un SEUL souvenir (« seul-a », « seul-b ») ⇒ aucun
//     nœud, aucun lien ;
//   • une étiquette blanche («  ») et un doublon d'étiquette ⇒ dédoublonnés ;
//   • un souvenir sans étiquette (m4) et un souvenir au texte blanc (m6) ;
//   • une arête du service dont une extrémité n'est PAS chargée (m1 ↔ absent) ⇒
//     ignorée ;
//   • un lien manuel entre DEUX souvenirs chargés (m4 ↔ m5) ⇒ visible.
//
// Les deux coques (macOS et iOS) nomment cette fixture : c'est la garde de parité
// des faits (AC-8).
//
// VIT DANS `ConsoleCore`.

import Foundation

public enum MemoryGraphParity {
    /// Les lignes de référence : neuf souvenirs, trois portées nommées et une
    /// ligne SANS portée (« Sans projet »), dans l'ordre du service.
    public static let rows: [MemoryRow] = [
        MemoryRow(id: "m1", text: "titre un", tags: ["commun", "seul-a"], agentId: "alpha"),
        MemoryRow(id: "m2", text: "titre deux", tags: ["commun"], agentId: "alpha"),
        MemoryRow(id: "m3", text: "titre trois", tags: ["commun", "vide", " "], agentId: "beta"),
        MemoryRow(id: "m4", text: "titre quatre", tags: [], agentId: "beta"),
        MemoryRow(id: "m5", text: "titre cinq", tags: ["seul-b"], agentId: "gamma"),
        MemoryRow(id: "m6", text: "", tags: [], agentId: "gamma"),
        MemoryRow(id: "m7", text: "titre sept", tags: ["commun"], agentId: nil),
        MemoryRow(id: "m8", text: "titre huit", tags: ["autre-partage"], agentId: "delta"),
        MemoryRow(id: "m9", text: "titre neuf", tags: ["autre-partage"], agentId: "delta"),
    ]

    /// Les arêtes de proximité du service : trois valides, une dont une extrémité
    /// n'est PAS chargée.
    public static let edges: [MemoryGraphEdge] = [
        MemoryGraphEdge(source: "m1", target: "m2", score: 0.81),
        MemoryGraphEdge(source: "m2", target: "m3", score: 0.75),
        MemoryGraphEdge(source: "m3", target: "m4", score: 0.90),
        MemoryGraphEdge(source: "absent", target: "m1", score: 0.99),
    ]

    /// Le lien manuel de référence, entre deux souvenirs CHARGÉS.
    public static let manual: Set<MemoryLink> = [MemoryLink(a: "m4", b: "m5")]

    /// L'étiquette partagée du geste de filtre : elle porte un nœud-étiquette, donc
    /// `tagFamily` et `visibility(tag:)` s'y appliquent.
    public static let tag = "commun"

    /// L'ensemble ATTENDU {nœuds, liens} de
    /// `MemoryGraph.nodes(rows:)` + `MemoryGraph.links(rows:edges:manual:)`.
    ///
    /// Écrit en CLAIR (littéraux) — le test de S-7 verrouille la valeur : toute
    /// dérive de la dérivation partagée le fait rougir.
    public static let facts: (nodes: [MemoryGraphNode], links: [MemoryGraphLink]) = (
        nodes: [
            MemoryGraphNode(id: .memory("m1"), label: "titre un", scope: "alpha", text: "titre un", tags: ["commun", "seul-a"]),
            MemoryGraphNode(id: .memory("m2"), label: "titre deux", scope: "alpha", text: "titre deux", tags: ["commun"]),
            MemoryGraphNode(id: .memory("m3"), label: "titre trois", scope: "beta", text: "titre trois", tags: ["commun", "vide"]),
            MemoryGraphNode(id: .memory("m4"), label: "titre quatre", scope: "beta", text: "titre quatre", tags: []),
            MemoryGraphNode(id: .memory("m5"), label: "titre cinq", scope: "gamma", text: "titre cinq", tags: ["seul-b"]),
            MemoryGraphNode(id: .memory("m6"), label: "", scope: "gamma", text: "", tags: []),
            MemoryGraphNode(id: .memory("m7"), label: "titre sept", scope: nil, text: "titre sept", tags: ["commun"]),
            MemoryGraphNode(id: .memory("m8"), label: "titre huit", scope: "delta", text: "titre huit", tags: ["autre-partage"]),
            MemoryGraphNode(id: .memory("m9"), label: "titre neuf", scope: "delta", text: "titre neuf", tags: ["autre-partage"]),
            MemoryGraphNode(id: .tag("autre-partage"), label: "#autre-partage", scope: nil),
            MemoryGraphNode(id: .tag("commun"), label: "#commun", scope: nil),
        ],
        links: [
            MemoryGraphLink(a: .memory("m1"), b: .tag("commun"), kind: .tag),
            MemoryGraphLink(a: .memory("m2"), b: .tag("commun"), kind: .tag),
            MemoryGraphLink(a: .memory("m3"), b: .tag("commun"), kind: .tag),
            MemoryGraphLink(a: .memory("m7"), b: .tag("commun"), kind: .tag),
            MemoryGraphLink(a: .memory("m8"), b: .tag("autre-partage"), kind: .tag),
            MemoryGraphLink(a: .memory("m9"), b: .tag("autre-partage"), kind: .tag),
            MemoryGraphLink(a: .memory("m1"), b: .memory("m2"), kind: .semantic(score: 0.81)),
            MemoryGraphLink(a: .memory("m2"), b: .memory("m3"), kind: .semantic(score: 0.75)),
            MemoryGraphLink(a: .memory("m3"), b: .memory("m4"), kind: .semantic(score: 0.90)),
            MemoryGraphLink(a: .memory("m4"), b: .memory("m5"), kind: .manual),
        ]
    )
}
