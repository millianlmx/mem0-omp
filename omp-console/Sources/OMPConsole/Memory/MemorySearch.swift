// La sélection de pertinence d'une recherche (S-1, point 2) : portage LITTÉRAL de
// `selectRelevant` (`omp-mem0-memory/mem0Client.ts:113-140`), avec les constantes de
// `config.ts:53,55` et le sur-échantillonnage de `tools.ts:79`.
//
// Le SEUL critère est le cosinus brut (`score_details.semantic_score`) : ni la date,
// ni la langue, ni la portée n'entrent en compte. Le tri se fait sur ce cosinus,
// JAMAIS sur le `score` renvoyé par le service, que BM25 sature.

import ConsoleCore
import Foundation

enum MemorySearch {
    /// Plancher de pertinence du service (`SEARCH_THRESHOLD`, config.ts:53).
    static let threshold: Double = 0.55
    /// Plafond du pool demandé au service (`SEARCH_POOL_MAX`, config.ts:55).
    static let poolMax = 50
    /// Limite finale, figée par S-1 (le défaut du tool `mem0_search`, tools.ts:76).
    static let defaultLimit = 6

    /// Le pool sur-échantillonné demandé au serveur : `min(limit × 4, 50)`.
    static func pool(requested: Int) -> Int {
        min(requested * 4, poolMax)
    }

    /// La sélection, portée de `selectRelevant` : `kept` = lignes dont le cosinus est
    /// ≥ `floor`, triées par cosinus DÉCROISSANT puis tronquées à `limit` ;
    /// `candidates` = lignes reçues ; `scored` = lignes portant un cosinus — avec
    /// des candidats et `scored == 0`, le service ne renvoie pas `score_details`.
    ///
    /// `Array.prototype.sort` de TypeScript est STABLE : à cosinus égal, l'ordre
    /// reçu est conservé. On le reproduit en départageant par l'indice d'origine.
    static func select(
        rows: [MemoryRow],
        floor: Double,
        limit: Int
    ) -> (kept: [MemoryRow], candidates: Int, scored: Int) {
        var hits: [(row: MemoryRow, score: Double, index: Int)] = []
        var scored = 0
        for (index, row) in rows.enumerated() {
            guard let score = row.semanticScore else { continue }
            scored += 1
            if score >= floor { hits.append((row, score, index)) }
        }
        hits.sort { left, right in
            if left.score != right.score { return left.score > right.score }
            return left.index < right.index
        }
        let kept = hits.prefix(max(0, limit)).map(\.row)
        return (Array(kept), rows.count, scored)
    }
}
