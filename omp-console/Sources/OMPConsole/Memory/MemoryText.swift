// Ce que la coque garde des textes de la Mémoire : la ligne de contexte d'un
// souvenir, seule fonction qui nomme un type de la coque (`MemoryRow`). Toutes
// les constantes et les fonctions pures vivent dans
// `ConsoleCore/Memory/MemoryText.swift`.

import ConsoleCore

extension MemoryText {
    /// La ligne de contexte d'un souvenir, dans la liste comme dans le détail :
    /// date relative à `nowMs`, puis étiquettes — chaque segment absent de l'entrée
    /// est omis, jamais remplacé. La portée, identique pour toute la liste, n'y
    /// figure pas (elle vit dans les détails techniques).
    static func subtitle(row: MemoryRow, nowMs: Double) -> String {
        var segments: [String] = []
        if let ms = updatedAtMs(row.updatedAt) {
            segments.append(ConsoleFormat.relative(ms: ms, nowMs: nowMs))
        }
        if !row.tags.isEmpty {
            segments.append(tagList(row.tags))
        }
        return segments.joined(separator: separator)
    }
}
