// Le format du code d'appairage, partagé par le Mac (qui le vérifie) et l'app
// iOS/iPadOS (qui le saisit). Le Mac l'AFFICHE groupé « XXXX-XXXX » : le tiret,
// les espaces et la casse ne sont que de la présentation, jamais du code. Les
// lettres absentes de l'alphabet qu'on confond avec un chiffre sont lues comme
// ce chiffre : I, L → 1 ; O → 0 (Crockford). U reste invalide.

import Foundation

public enum PairingCodeFormat {
    /// Les séparateurs ignorés : blancs, sauts de ligne et tirets (trait d'union
    /// ASCII, ceux que la correction typographique substitue, et le signe moins).
    private static let separators: CharacterSet = {
        var set = CharacterSet.whitespacesAndNewlines
        set.insert(charactersIn: "\u{002D}\u{2010}\u{2011}\u{2012}\u{2013}\u{2014}\u{2212}")
        return set
    }()

    /// Les sosies de chiffres, lus au décodage comme le chiffre qu'ils imitent.
    public static let lookalikes: [Character: Character] = ["I": "1", "L": "1", "O": "0"]

    /// Le code présenté sans séparateurs, en majuscules, sosies remplacés :
    /// « abcd-efgh » ⇒ « ABCDEFGH » ; « oIl0-1LOi » ⇒ « 01101101 ».
    public static func normalize(_ raw: String) -> String {
        let upper = String(String.UnicodeScalarView(raw.unicodeScalars.filter { !separators.contains($0) })).uppercased()
        return String(upper.map { lookalikes[$0] ?? $0 })
    }

    /// Un code normalisé est-il bien formé : exactement 8 symboles de l'alphabet ?
    public static func isWellFormed(_ normalized: String) -> Bool {
        let alphabet = Set(ConsoleAPI.Service.pairingCodeAlphabet)
        return normalized.count == ConsoleAPI.Service.pairingCodeLength
            && normalized.allSatisfy { alphabet.contains($0) }
    }

    /// La saisie bornée : tout jusqu'au 8e caractère significatif inclus, rien
    /// après. « ABCD-EFGHX » ⇒ « ABCD-EFGH » ; « ABCDEFGHIJ » ⇒ « ABCDEFGH ».
    public static func limitInput(_ raw: String) -> String {
        var significant = 0
        var kept = String.UnicodeScalarView()
        for scalar in raw.unicodeScalars {
            if significant == ConsoleAPI.Service.pairingCodeLength { break }
            kept.append(scalar)
            if !separators.contains(scalar) { significant += 1 }
        }
        return String(kept)
    }
}
