// Le traducteur des pannes de lecture de la mémoire du serveur : une panne devient
// UNE cause distinguable, un remède propre à cette cause, et jamais un détail
// technique (ni URL, ni JSON, ni code HTTP).
//
// Fichier de VOCABULAIRE (`*Text.swift`) : la garde `design-ios/AC-5` autorise les
// littéraux alphabétiques ici. Le sommaire, la recherche et le graphe lisent ces
// messages d'ici ; aucun ne recompose l'erreur d'un autre cru.

import ConsoleClient

/// La cause distinguable d'une lecture de la mémoire échouée.
enum IOSMemoryFailure: Equatable {
    /// Aucune réponse : serveur éteint, hors réseau, appareil hors du tailnet.
    case unreachable
    /// Joint, mais sans réponse à temps.
    case timedOut
    /// 503 : la mémoire n'est pas prête.
    case serviceUnavailable
    /// 401, 403 : le jeton de la mémoire n'est plus le bon.
    case refused
    /// Le graphe : un serveur mémoire trop ancien pour cette route.
    case serviceOutdated
    /// Corps illisible, statut inattendu.
    case generic

    /// La cause d'une erreur de lecture.
    static func of(_ error: Error) -> IOSMemoryFailure {
        switch error as? MemoryReadError {
        case .unreachable: .unreachable
        case .timedOut: .timedOut
        case .unavailable: .serviceUnavailable
        case .unauthorized: .refused
        case .outdated: .serviceOutdated
        case .failed, nil: .generic
        }
    }
}

enum IOSMemoryErrorText {
    static func cause(_ failure: IOSMemoryFailure) -> String {
        switch failure {
        case .unreachable:
            "Mémoire du serveur injoignable."
        case .timedOut:
            "Délai dépassé : la mémoire a mis trop de temps à répondre."
        case .serviceUnavailable:
            "Mémoire indisponible sur le serveur."
        case .refused:
            "Le serveur a refusé le jeton de la mémoire."
        case .serviceOutdated:
            IOSMemoryText.graphServiceOutdated
        case .generic:
            "La mémoire du serveur a rencontré une erreur."
        }
    }

    static func remedy(_ failure: IOSMemoryFailure) -> String {
        switch failure {
        case .unreachable:
            "Vérifiez que cet appareil est sur votre tailnet et que le serveur est démarré, puis réessayez."
        case .timedOut:
            "Réessayez dans un instant."
        case .generic:
            "Réessayez dans un instant. Si l’erreur persiste, consultez les journaux du serveur."
        case .serviceUnavailable:
            "Vérifiez que le serveur est démarré, puis réessayez."
        case .refused:
            "Collez de nouveau le code d’appairage affiché par le serveur dans la feuille Serveur."
        case .serviceOutdated:
            ""
        }
    }

    /// Cause + remède, sur deux lignes ; `.serviceOutdated` garde son texte, entier.
    static func message(for failure: IOSMemoryFailure) -> String {
        if failure == .serviceOutdated { return IOSMemoryText.graphServiceOutdated }
        return cause(failure) + "\n" + remedy(failure)
    }
}
