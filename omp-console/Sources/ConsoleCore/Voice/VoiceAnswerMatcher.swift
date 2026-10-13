// La correspondance d'une réponse dite avec les options d'une question
// (noyau-vocal-partage, S-3). Fonction PURE : savoir si la question accepte le
// texte libre revient à l'appelant.
//
// VIT DANS `ConsoleCore`.

import Foundation

/// Le résultat : une option (index à partir de 0, libellé tel que dans les
/// options), un texte libre (la phrase dite, sans ses blancs de bord), ou
/// « introuvable » avec la phrase que Siri prononce.
public enum VoiceAnswerMatch: Equatable, Sendable {
    case option(index: Int, label: String)
    case freeText(String)
    case notFound(prompt: String)
}

public enum VoiceAnswerMatcher {
    /// Dans l'ordre, la première étape qui conclut l'emporte : énoncé vide,
    /// libellé entier, rang (chiffres, ordinaux, « la dernière »), puis texte libre
    /// ou rappel des choix possibles.
    public static func match(_ spoken: String, options: [PanelAskOption], acceptsFreeText: Bool) -> VoiceAnswerMatch {
        let query = VoiceSpeech.tokens(spoken)
        guard !query.isEmpty else { return .notFound(prompt: VoiceSpeechText.nothingHeard) }

        let said = query.joined(separator: " ")
        if let index = options.firstIndex(where: { VoiceSpeech.normalized($0.label) == said }) {
            return .option(index: index, label: options[index].label)
        }

        if let rank = rank(query, count: options.count), rank >= 1, rank <= options.count {
            return .option(index: rank - 1, label: options[rank - 1].label)
        }

        if acceptsFreeText {
            return .freeText(spoken.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return .notFound(prompt: VoiceSpeechText.optionNotFound(labels: options.map(\.label)))
    }

    /// Vrai si l'énoncé demande à dicter un texte libre (« autre réponse »). Ne
    /// regarde pas les options : un libellé identique l'emporte chez l'appelant,
    /// qui essaie `match` d'abord.
    public static func isOtherAnswer(_ spoken: String) -> Bool {
        VoiceSpeechText.otherAnswerWords.contains(VoiceSpeech.normalized(spoken))
    }

    /// Le rang dit par `query` une fois retirés les mots de liaison, s'il reste
    /// exactement un mot ; `nil` sinon. Non borné : l'appelant vérifie les bornes.
    private static func rank(_ query: [String], count: Int) -> Int? {
        let words = query.filter { !VoiceSpeechText.rankFillers.contains($0) }
        guard words.count == 1, let word = words.first else { return nil }
        if let number = VoiceSpeech.asciiNumber(word, suffixes: VoiceSpeechText.rankSuffixes) {
            return number
        }
        if let rank = VoiceSpeechText.rankWords[word] {
            return rank
        }
        if VoiceSpeechText.lastWords.contains(word), count >= 1 {
            return count
        }
        return nil
    }
}
