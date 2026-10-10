// Ce que la coque garde des textes de la Mémoire : les surcharges qui nomment
// un type de la coque (`MemoryRow`, `ForeignOwnership`). Toutes les constantes
// et les fonctions pures vivent dans `ConsoleCore/Memory/MemoryText.swift` —
// la ligne de contexte d'une ligne y est levée par la MÊME formule que l'app
// iOS (une seule écriture, deux coques).

import ConsoleCore

extension MemoryText {
    /// La ligne de contexte d'un souvenir, dans la liste comme dans le détail :
    /// date relative à `nowMs`, puis étiquettes — chaque segment absent de l'entrée
    /// est omis, jamais remplacé. La portée, identique pour toute la liste, n'y
    /// figure pas (elle vit dans les détails techniques).
    static func subtitle(row: MemoryRow, nowMs: Double) -> String {
        subtitle(updatedAt: row.updatedAt, tags: row.tags, nowMs: nowMs)
    }

    /// Le détail sélectionnable de l'état « étranger » (BR-9) : l'adresse observée,
    /// le propriétaire et le geste exact, une ligne chacun.
    static func foreignOwnershipDetail(_ ownership: ForeignOwnership) -> String {
        "\(ownership.address)\nTenu par \(ownership.owner).\nGeste : \(ownership.gesture)"
    }
}
