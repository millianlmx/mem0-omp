// La lecture des réponses de la mémoire (mem0-rs), partagée par la coque macOS
// (`HTTPMemoryService`) et l'app iOS (`MemoryReader`) : décodage TOLÉRANT des
// lignes, des pages et des arêtes, et sélection de pertinence d'une recherche,
// portées du plugin mémoire (`omp-mem0-memory/mem0Client.ts`).

import Foundation

/// La réponse de `GET /memory/graph`, décodée TOLÉRAMMENT : une arête dont les
/// extrémités ne sont pas deux chaînes et le score un nombre fini est ignorée — une
/// réponse partiellement illisible ne fait pas tomber le graphe entier.
public struct MemoryGraphEdges: Equatable, Sendable {
    public var total: Int
    public var edges: [MemoryGraphEdge]

    public init(total: Int, edges: [MemoryGraphEdge]) {
        self.total = total
        self.edges = edges
    }

    public static func decode(_ json: Any) -> MemoryGraphEdges {
        let object = json as? [String: Any]
        let raw = object?["edges"] as? [Any] ?? []
        var edges: [MemoryGraphEdge] = []
        for entry in raw {
            guard let edge = entry as? [String: Any],
                  let source = edge["source"] as? String,
                  let target = edge["target"] as? String,
                  let score = edge["score"] as? NSNumber,
                  !MemoryJSON.isBoolean(score) else { continue }
            let value = score.doubleValue
            guard value.isFinite else { continue }
            edges.append(MemoryGraphEdge(source: source, target: target, score: value))
        }
        let total = object?["total"] as? Int ?? edges.count
        return MemoryGraphEdges(total: total, edges: edges)
    }
}

/// Le sommaire d'une portée (S-3) : le compte `total` du service et ses lignes,
/// dans l'ordre rendu.
public struct MemoryPage: Equatable, Sendable {
    public var total: Int
    public var rows: [MemoryRow]

    public init(total: Int, rows: [MemoryRow]) {
        self.total = total
        self.rows = rows
    }

    /// Un tableau nu est accepté autant qu'un objet `{"total": n, "results": […]}` ;
    /// `total` absent (ou non entier) vaut le nombre de lignes reçues.
    public static func decode(_ json: Any) -> MemoryPage {
        let rows = MemoryJSON.rows(json).map(MemoryJSON.row)
        let total = (json as? [String: Any])?["total"] as? Int ?? rows.count
        return MemoryPage(total: total, rows: rows)
    }
}

/// Les gardes de décodage des lignes réseau, portées de `mem0Client.ts:82-111`.
/// Les lignes ne sont validées nulle part ailleurs : chaque garde est locale, et
/// une ligne mal formée rend un champ `nil` — jamais un `force`-unwrap, jamais une
/// exception qui ferait tomber la liste entière.
public enum MemoryJSON {
    /// `rows(result)` (mem0Client.ts:71-73) : tableau nu ou `{"results": […]}`.
    public static func rows(_ json: Any) -> [Any] {
        if let array = json as? [Any] { return array }
        if let object = json as? [String: Any], let results = object["results"] as? [Any] { return results }
        return []
    }

    /// `memoryLine(m)` : `m.memory`, sinon `m.text`, sinon la sérialisation JSON.
    public static func line(_ json: Any) -> String {
        guard let object = json as? [String: Any] else { return scalar(json) }
        if let memory = object["memory"], !(memory is NSNull) { return scalar(memory) }
        if let text = object["text"], !(text is NSNull) { return scalar(text) }
        return scalar(json)
    }

    /// `memoryId(m)` : `String(m.id)` pour une chaîne ou un nombre, `"?"` sinon.
    public static func identifier(_ json: Any) -> String {
        guard let object = json as? [String: Any], let raw = object["id"] else { return "?" }
        if let string = raw as? String { return string }
        // `typeof id === "number"` : un booléen n'est PAS un nombre ici (mesuré :
        // JSONSerialization rend `true` en NSNumber).
        if let number = raw as? NSNumber, !isBoolean(number) { return number.stringValue }
        return "?"
    }

    /// `semanticScore(row)` : `score_details.semantic_score`, seulement s'il est
    /// fini — champ absent, non numérique, NaN ou infini rendent `nil`.
    public static func score(_ json: Any) -> Double? {
        guard let object = json as? [String: Any],
              let details = object["score_details"] as? [String: Any],
              let raw = details["semantic_score"] as? NSNumber,
              !isBoolean(raw)
        else { return nil }
        let value = raw.doubleValue
        return value.isFinite ? value : nil
    }

    public static func updatedAt(_ json: Any) -> String? {
        guard let object = json as? [String: Any], let raw = object["updated_at"], !(raw is NSNull) else {
            return nil
        }
        return scalar(raw)
    }

    /// `metadata.tags` tel que le serveur le stocke (`"a,b"`, http_server.py) :
    /// découpé aux virgules, détouré, sans segment vide. Absent ou non textuel ⇒
    /// aucune étiquette.
    public static func tags(_ json: Any) -> [String] {
        guard let object = json as? [String: Any],
              let metadata = object["metadata"] as? [String: Any],
              let raw = metadata["tags"] as? String
        else { return [] }
        return raw.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    /// `agent_id` de la ligne (S-2) : la portée du souvenir, absente ⇒ `nil` (la
    /// ligne reste un nœud, regroupé sous « Sans projet »).
    public static func agentId(_ json: Any) -> String? {
        guard let object = json as? [String: Any], let raw = object["agent_id"], !(raw is NSNull) else {
            return nil
        }
        return raw as? String
    }

    public static func row(_ json: Any) -> MemoryRow {
        MemoryRow(
            id: identifier(json),
            text: line(json),
            updatedAt: updatedAt(json),
            semanticScore: score(json),
            tags: tags(json),
            agentId: agentId(json)
        )
    }

    public static func isBoolean(_ number: NSNumber) -> Bool {
        #if canImport(Darwin)
        CFGetTypeID(number) == CFBooleanGetTypeID()
        #else
        String(cString: number.objCType) == "c"
        #endif
    }

    /// La forme TEXTE d'une valeur JSON : une chaîne telle quelle, tout le reste
    /// sérialisé en JSON (le `String(...)`/`JSON.stringify` du plugin).
    public static func scalar(_ value: Any) -> String {
        if let string = value as? String { return string }
        if let fragment = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
           let text = String(data: fragment, encoding: .utf8) {
            return text
        }
        return "\(value)"
    }
}

// La sélection de pertinence d'une recherche (S-1, point 2) : portage LITTÉRAL de
// `selectRelevant` (`omp-mem0-memory/mem0Client.ts:113-140`), avec les constantes de
// `config.ts:53,55` et le sur-échantillonnage de `tools.ts:79`.
//
// Le SEUL critère est le cosinus brut (`score_details.semantic_score`) : ni la date,
// ni la langue, ni la portée n'entrent en compte. Le tri se fait sur ce cosinus,
// JAMAIS sur le `score` renvoyé par le service, que BM25 sature.
public enum MemorySearch {
    /// Plancher de pertinence du service (`SEARCH_THRESHOLD`, config.ts:53).
    public static let threshold: Double = 0.55
    /// Plafond du pool demandé au service (`SEARCH_POOL_MAX`, config.ts:55).
    public static let poolMax = 50
    /// Limite finale, figée par S-1 (le défaut du tool `mem0_search`, tools.ts:76).
    public static let defaultLimit = 6

    /// Le pool sur-échantillonné demandé au serveur : `min(limit × 4, 50)`.
    public static func pool(requested: Int) -> Int {
        min(requested * 4, poolMax)
    }

    /// La sélection, portée de `selectRelevant` : `kept` = lignes dont le cosinus est
    /// ≥ `floor`, triées par cosinus DÉCROISSANT puis tronquées à `limit` ;
    /// `candidates` = lignes reçues ; `scored` = lignes portant un cosinus — avec
    /// des candidats et `scored == 0`, le service ne renvoie pas `score_details`.
    ///
    /// `Array.prototype.sort` de TypeScript est STABLE : à cosinus égal, l'ordre
    /// reçu est conservé. On le reproduit en départageant par l'indice d'origine.
    public static func select(
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
