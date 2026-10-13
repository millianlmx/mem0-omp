// La recherche d'une feature par son titre prononcé (noyau-vocal-partage, S-2),
// parmi les cartes de l'ardoise — les mêmes sur Mac et sur iPhone. Fonction PURE.
//
// VIT DANS `ConsoleCore`.

import Foundation

/// Le résultat d'une recherche : une feature unique, une demande de précision ou
/// « introuvable ». Les deux derniers portent la phrase que Siri prononce.
public enum VoiceFeatureMatch: Equatable, Sendable {
    case found(KanbanCard)
    case ambiguous(candidates: [KanbanCard], prompt: String)
    case notFound(prompt: String)
}

public enum VoiceFeatureSearch {
    /// Les features non terminées dont le titre contient les mots de `spoken`, mot
    /// pour mot et d'un seul tenant. Dès deux correspondances, une précision est
    /// demandée, même si l'un des titres est identique à l'énoncé.
    public static func find(_ spoken: String, in cards: [KanbanCard]) -> VoiceFeatureMatch {
        find(spoken, among: cards.filter(isEligible))
    }

    /// La même recherche parmi `cards` tels quels, sans filtre de colonne : la
    /// liste reçue fait foi (les features éligibles à un geste, par exemple).
    public static func find(_ spoken: String, among cards: [KanbanCard]) -> VoiceFeatureMatch {
        let query = VoiceSpeech.tokens(spoken)
        guard !query.isEmpty else { return .notFound(prompt: VoiceSpeechText.featureNotFound) }

        let matches = cards
            .filter { contains(VoiceSpeech.tokens($0.title), query) }
            .map { (key: VoiceSpeech.normalized($0.title), card: $0) }
            .sorted { a, b in
                if a.key != b.key { return a.key.utf8.lexicographicallyPrecedes(b.key.utf8) }
                return a.card.id.utf8.lexicographicallyPrecedes(b.card.id.utf8)
            }
            .map(\.card)

        guard let first = matches.first else { return .notFound(prompt: VoiceSpeechText.featureNotFound) }
        guard matches.count > 1 else { return .found(first) }
        let prompt = VoiceSpeechText.featureAmbiguous(
            titles: matches.prefix(3).map(\.title),
            more: max(matches.count - 3, 0)
        )
        return .ambiguous(candidates: matches, prompt: prompt)
    }

    /// Une carte de feature ou de projet dont la colonne n'est ni livrée ni
    /// archivée. Les cartes `run:` et `history:` ne le sont jamais.
    static func isEligible(_ card: KanbanCard) -> Bool {
        guard card.id.hasPrefix("feature:") || card.id.hasPrefix("project:") else { return false }
        switch card.column {
        case .enAttente, .enCours, .questionEnVol, .echec, .jalonSpecs, .jalonReview, .bloquee:
            return true
        case .prOuverte, .prCreee, .fusionne, .prFermee, .termineeSansPr, .annuleeRetiree:
            return false
        }
    }

    /// Vrai si `query` est une sous-suite contiguë de `words`.
    private static func contains(_ words: [String], _ query: [String]) -> Bool {
        guard query.count <= words.count else { return false }
        return (0...(words.count - query.count)).contains { start in
            words[start..<(start + query.count)].elementsEqual(query)
        }
    }
}
