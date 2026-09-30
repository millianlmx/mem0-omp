// Tous les textes de la section « Mémoire », en UN endroit.
//
// Un message à un seul endroit, c'est ce qui permet à un test de le figer sans
// rendre une vue, et à la vue de ne jamais composer une phrase : chaque état de la
// section a son texte, et il n'existe qu'ici.

import Foundation

enum MemoryText {
    // En-tête
    static let searchPlaceholder = "Rechercher dans la mémoire du projet"
    static let searchButton = "Rechercher"
    static let summaryButton = "Sommaire"
    static let refresh = "Rafraîchir"

    // États
    static let noProjectTitle = "Aucun projet ouvert"
    static let noProjectDescription = "Choisis-le dans la fenêtre « Session OMP » (⌘N)."
    static let unavailableTitle = "Service mem0-http indisponible"
    static let loading = "Chargement de la mémoire du projet…"
    static let noMatch = "La mémoire du projet ne contient aucun souvenir correspondant."
    static let noSemanticScore = "Le service n'annonce pas de score sémantique (score_details absent) — recherche impossible."
    static let nothingSelected = "Choisis un souvenir dans la liste pour lire son texte complet."
    static let emptyRow = "Souvenir vide."

    // Erreurs (S-6.4)
    static let tokenRefused = "jeton refusé (401)"
    static let unreadableResponse = "réponse illisible"

    /// L'état du service dans l'en-tête (S-6.2) : le texte porte LITTÉRALEMENT
    /// « disponible » ou « indisponible », suivi de l'adresse du service.
    static func serviceAvailable(_ address: String) -> String {
        "disponible — \(address)"
    }

    static func serviceUnavailable(_ address: String) -> String {
        "indisponible — \(address)"
    }

    static func summaryCount(_ n: Int) -> String {
        "\(n) souvenir(s)"
    }

    static func emptySummary(_ scope: String) -> String {
        "Aucun souvenir dans la mémoire du projet « \(scope) »."
    }

    static func belowThreshold(_ floor: Double) -> String {
        "Aucun souvenir ne dépasse le seuil de pertinence (\(decimal(floor))) pour cette recherche."
    }

    /// Le rappel de la requête au-dessus d'une liste de résultats de recherche.
    static func searchResults(_ query: String) -> String {
        "Résultats pour « \(query) »"
    }

    static func unexpectedStatus(code: Int, detail: String) -> String {
        "réponse \(code) du service (\(detail))"
    }

    // MARK: - Aperçu d'une ligne

    /// Longueur d'une ligne de sommaire (`INDEX_LINE_CHARS`, summary.ts:7) : la
    /// PREMIÈRE ligne, détourée, tronquée à 99 caractères suivis de `…` — la règle
    /// exacte de `buildIndex` (summary.ts:60-63).
    static let previewChars = 100

    static func preview(_ text: String) -> String {
        let first = text.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? ""
        let line = first.trimmingCharacters(in: .whitespaces)
        guard line.count > previewChars else { return line }
        return String(line.prefix(previewChars - 1)) + "…"
    }

    /// « 0,55 » : un seuil se lit en français, jamais « 0.55 ».
    static func decimal(_ value: Double) -> String {
        String(format: "%.2f", value).replacingOccurrences(of: ".", with: ",")
    }
}
