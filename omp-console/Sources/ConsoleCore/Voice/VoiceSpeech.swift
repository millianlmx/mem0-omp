// La normalisation d'un énoncé (noyau-vocal-partage, S-1) : ce que Siri a compris,
// réduit à des mots comparables. Fonction PURE : pliage sans locale, aucune
// correction phonétique, aucune tolérance aux fautes ; œ/oe et æ/ae ne sont pas
// rapprochés.
//
// VIT DANS `ConsoleCore`.

import Foundation

enum VoiceSpeech {
    /// Les mots de `text` : casse et accents pliés sans locale, puis découpés sur
    /// tout caractère qui n'est ni lettre ni chiffre (tirets, apostrophes,
    /// ponctuation, tiret bas, blancs). Aucun segment vide.
    static func tokens(_ text: String) -> [String] {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
            .split(whereSeparator: { !($0.isLetter || $0.isNumber) })
            .map(String.init)
    }

    /// Les mots de `text` joints par une espace.
    static func normalized(_ text: String) -> String {
        tokens(text).joined(separator: " ")
    }

    /// `text` dont toute suite de blancs, sauts de ligne compris, est réduite à une
    /// espace, sans blanc de bord.
    static func collapsingBlanks(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// Le nombre écrit par `word` en 1 à 3 chiffres ASCII, suivis de l'un des
    /// `suffixes` ou de rien ; `nil` sinon. Jamais `isNumber` seul : « ² » est un
    /// chiffre Unicode mais pas un nombre.
    static func asciiNumber(_ word: String, suffixes: Set<String>) -> Int? {
        let digits = word.prefix(while: { $0.isASCII && $0.isNumber })
        guard (1...3).contains(digits.count) else { return nil }
        let rest = word.dropFirst(digits.count)
        guard rest.isEmpty || suffixes.contains(String(rest)) else { return nil }
        return Int(digits)
    }
}
