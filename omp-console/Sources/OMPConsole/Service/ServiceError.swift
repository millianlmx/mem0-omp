// Le vocabulaire d'erreur du client de service (S-2, S-10).
//
// Une seule table de traduction vers le texte affiché : les modèles ne composent
// jamais de phrase, ils lisent `userMessage`. Un refus MÉTIER n'est PAS une
// erreur : il est porté par l'accusé d'une commande ; seuls les échecs de
// transport lèvent.

import Foundation

/// Ce qu'un modèle peut afficher d'une erreur, sans connaître son type exact.
protocol UserFacingError: Error {
    var userMessage: String { get }
}

/// Les échecs du client HTTP : codes de S-2 et échecs de connexion.
enum ServiceClientError: UserFacingError, Equatable, Sendable {
    /// 401 : jeton absent ou invalide.
    case unauthorized
    /// 400 `{error:"bad_request",reason}`.
    case badRequest(reason: String)
    /// 404 `{error:"not_found",reason}`.
    case notFound(reason: String)
    /// 409 `{error:"conflict",reason}`.
    case conflict(reason: String)
    /// 503 `{error:"stopping"}` : le service s'arrête.
    case stopping
    /// Réponse illisible ou hors schéma.
    case malformed(reason: String)
    /// Échec de transport autre qu'une connexion refusée.
    case transport(reason: String)
    /// Le service n'est pas joignable (connexion refusée) : « service arrêté ».
    case unavailable

    var userMessage: String {
        switch self {
        case .unauthorized: return "jeton du service refusé : relancez le service."
        case .badRequest(let reason): return reason
        case .notFound(let reason): return reason
        case .conflict(let reason): return reason
        case .stopping: return "le service s'arrête."
        case .malformed(let reason): return "réponse illisible du service : \(reason)"
        case .transport(let reason): return "service injoignable : \(reason)"
        case .unavailable: return "service arrêté"
        }
    }
}

/// Les échecs de la session côté app : aucun n'est un échec HTTP.
enum ServiceSessionError: UserFacingError, Equatable, Sendable {
    case alreadyRunning
    case notRunning
    case emptyPrompt
    case dialogNotPending

    var userMessage: String {
        switch self {
        case .alreadyRunning: return "Une session est déjà ouverte : arrêtez-la avant d'en lancer une autre."
        case .notRunning: return "Aucune session vivante."
        case .emptyPrompt: return "Le prompt est vide."
        case .dialogNotPending: return "Aucun dialogue en attente."
        }
    }
}

/// L'échec de résolution du binaire `omp` (préparation des composants, terminal,
/// `omp models --json`) : inchangé, il ne concerne pas le service.
enum OmpBinaryError: UserFacingError, Equatable, Sendable {
    case binaryNotFound(searched: [String], override: String?)

    var userMessage: String {
        switch self {
        case .binaryNotFound(let searched, let override):
            var message = "Binaire `omp` introuvable (cherché : \(searched.joined(separator: ", ")))."
            if let override { message += " Chemin demandé : \(override)" }
            return message
        }
    }
}
