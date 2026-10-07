// Ce que la coque garde des textes de la Mémoire : la seule surcharge qui nomme
// un type de la coque (`MemoryRow`). Toutes les constantes et les fonctions
// pures vivent dans `ConsoleCore/Memory/MemoryText.swift` — cette extension ne
// fait que lever la ligne de contexte d'une ligne, par la MÊME formule que l'app
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
}
