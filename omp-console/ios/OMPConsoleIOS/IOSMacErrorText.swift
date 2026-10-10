// Le traducteur PARTAGÉ des erreurs rendues par le Mac (ios-erreurs-serveur-lisibles) :
// une réponse ou un échec d'appel devient UNE cause distinguable, un remède propre à
// cette cause, et jamais un détail technique (ni URL, ni JSON, ni code HTTP).
//
// Fichier de VOCABULAIRE (`*Text.swift`) : la garde `design-ios/AC-5` autorise les
// littéraux alphabétiques ici. Chaque section (Mémoire, Sessions, Statistiques,
// Pipelines) lit ces messages d'ici ; aucune ne recompose l'erreur d'un autre cru.

import ConsoleClient
import ConsoleCore
import Foundation

/// La cause distinguable d'un échec d'appel au Mac.
enum IOSMacFailure: Equatable {
    /// 404 « route inconnue », 404/405 hors contrat.
    case macOutdated
    /// Transport, aucun endpoint connu.
    case macUnreachable
    /// Délai dépassé d'une lecture Mémoire : le Mac a été joint mais n'a pas répondu à
    /// temps. Seule `ofMemoryRead` le rend ; partout ailleurs, un délai dépassé reste
    /// `.macUnreachable` (memoire-ios-expire-a-10-secondes, B-4).
    case macTimedOut
    /// 503.
    case serviceUnavailable
    /// 403.
    case refused
    /// `outdated_service` (seule la route graphe l'émet).
    case serviceOutdated
    /// Refus métier : le motif du Mac, présentable (`isPresentable`).
    case rejected(String)
    case incompatibleProtocol(local: Int, remote: Int?)
    /// 500, corps illisible, code ou statut inattendu.
    case generic

    /// Le message EXACT des 404 « route inconnue » de la coque Mac.
    static let unknownRoute = "route inconnue"

    /// La cause d'une erreur du client ; `nil` ⇔ `.api(.unauthorized)` : le parcours de
    /// révocation du jeton parle seul.
    static func of(_ error: Error) -> IOSMacFailure? {
        guard let error = error as? ClientError else { return .generic }
        switch error {
        case .notConnected, .transport:
            return .macUnreachable
        case .incompatibleProtocol(let local, let remote):
            return .incompatibleProtocol(local: local, remote: remote)
        case .decoding:
            return .generic
        case .unexpectedStatus(let status):
            return of(status: status)
        case .api(let api):
            switch api {
            case .unauthorized:
                return nil
            case .notFound(let message) where message == unknownRoute:
                return .macOutdated
            case .notFound(let message), .badRequest(let message), .conflict(let message):
                return isPresentable(message) ? .rejected(message) : .generic
            case .unavailable:
                return .serviceUnavailable
            case .outdatedService:
                return .serviceOutdated
            case .server, .decoding:
                return .generic
            case .incompatibleProtocol:
                return .incompatibleProtocol(local: ConsoleAPI.protocolVersion, remote: nil)
            }
        }
    }

    /// La cause d'une erreur d'une lecture Mémoire (page, recherche, graphe) : la section
    /// Mémoire seule distingue le délai dépassé du Mac injoignable, et ses routes n'émettent
    /// aucun 404 métier — tout `not_found` y dit « app Mac trop ancienne ». Le reste est
    /// la cause commune de `of(_:)`.
    static func ofMemoryRead(_ error: Error) -> IOSMacFailure? {
        switch error as? ClientError {
        case .transport(.timedOut):
            return .macTimedOut
        case .api(.notFound):
            return .macOutdated
        default:
            return of(error)
        }
    }

    /// La cause d'un statut HTTP dont seul le code est fiable.
    static func of(status: Int) -> IOSMacFailure {
        switch status {
        case 403: return .refused
        case 404, 405: return .macOutdated
        case 503: return .serviceUnavailable
        default: return .generic
        }
    }

    /// Un motif du Mac ne s'affiche que s'il ne laisse fuir ni URL, ni JSON, ni code HTTP.
    static func isPresentable(_ motive: String) -> Bool {
        guard !motive.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        let forbidden = ["://", "localhost", "{", "\"detail\""]
        guard !forbidden.contains(where: motive.contains) else { return false }
        return motive.range(of: #"\b\d{3}\b"#, options: .regularExpression) == nil
    }
}

enum IOSMacErrorText {
    static func cause(_ failure: IOSMacFailure) -> String {
        switch failure {
        case .macOutdated:
            return "Fonction indisponible : app Mac trop ancienne."
        case .macUnreachable:
            return "Mac injoignable."
        case .macTimedOut:
            return "Délai dépassé : le Mac a mis trop de temps à répondre."
        case .serviceUnavailable:
            return "Service indisponible sur le Mac."
        case .refused:
            return "Action refusée par le Mac."
        case .serviceOutdated:
            return IOSMemoryText.graphServiceOutdated
        case .rejected(let motive):
            return "Le Mac n'a pas pu traiter la demande : \(presentable(motive))."
        case .incompatibleProtocol(let local, let remote):
            return ConnectionText.incompatibleProtocol(local: local, remote: remote) + "."
        case .generic:
            return "Le Mac a rencontré une erreur."
        }
    }

    static func remedy(_ failure: IOSMacFailure) -> String {
        switch failure {
        case .macOutdated:
            return "Mets à jour OMP Console sur le Mac, puis réessaie."
        case .macUnreachable:
            return "Vérifie que le Mac est allumé, sur le même réseau que cet appareil, et qu'OMP Console y est ouvert, puis réessaie."
        case .macTimedOut:
            return "Réessaie dans un instant."
        case .serviceUnavailable:
            return "Ouvre OMP Console sur le Mac et vérifie que ses services sont démarrés (redéploie le service mémoire s'il le faut), puis réessaie."
        case .refused:
            return "Vérifie dans OMP Console sur le Mac que cet appareil est toujours appairé, puis réessaie."
        case .serviceOutdated:
            return ""
        case .rejected:
            return "Vérifie la demande ou actualise l'écran, puis réessaie."
        case .incompatibleProtocol:
            return "Mets à jour l'app de cet appareil et OMP Console sur le Mac pour qu'elles parlent la même version."
        case .generic:
            return "Réessaie dans un instant ; si l'erreur revient, redémarre OMP Console sur le Mac."
        }
    }

    /// Cause + remède, sur deux lignes ; `.serviceOutdated` garde son texte livré, entier.
    static func message(for failure: IOSMacFailure) -> String {
        if failure == .serviceOutdated { return IOSMemoryText.graphServiceOutdated }
        return cause(failure) + "\n" + remedy(failure)
    }

    /// Le message d'une erreur du client ; `nil` pour un 401 (le parcours de jeton révoqué
    /// parle seul).
    static func message(for error: Error) -> String? {
        guard let failure = IOSMacFailure.of(error) else { return nil }
        return message(for: failure)
    }

    /// Le motif sans blancs de bord ni point final.
    private static func presentable(_ motive: String) -> String {
        var text = motive.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix(".") {
            text.removeLast()
            text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return text
    }
}
