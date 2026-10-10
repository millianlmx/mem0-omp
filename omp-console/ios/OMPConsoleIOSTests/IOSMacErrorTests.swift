// Les preuves Swift du traducteur PARTAGÉ des erreurs du Mac (ios-erreurs-serveur-lisibles,
// S-1, S-2) : une réponse du Mac devient une cause, un remède, jamais un détail technique.
//
// Aucune socket : la doublure du Mac est `ClientErrorMapping.translate(status:…)`, l'API
// publique par où passe toute réponse du Mac.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsoleIOS

/// La doublure du Mac : ce que le client lève pour une réponse d'erreur.
private enum MacDouble {
    static func error(status: Int, body: Data) -> ClientError {
        ClientErrorMapping.translate(status: status, protocolVersion: 1, body: body)
    }

    /// Une enveloppe d'erreur du contrat, construite par `JSONSerialization`.
    static func envelope(_ code: String, _ message: String? = nil) -> Data {
        var inner: [String: Any] = ["code": code]
        if let message { inner["message"] = message }
        return (try? JSONSerialization.data(withJSONObject: ["error": inner])) ?? Data()
    }

    static func error(status: Int, code: String, message: String? = nil) -> ClientError {
        error(status: status, body: envelope(code, message))
    }

    /// Le 503 que rend le Mac quand mem0-http répond 405 : l'adresse et le JSON amont
    /// sont dans le message.
    static var relayed503: ClientError {
        let detail = MemoryText.unavailableDetail(
            address: "localhost:8321",
            error: "réponse 405 du service ({\"detail\":\"Method Not Allowed\"})"
        )
        return error(status: 503, code: "unavailable", message: detail)
    }
}

/// Le prédicat « lisible » : ni adresse, ni JSON, ni code HTTP à trois chiffres.
private func isReadable(_ text: String) -> Bool {
    let forbidden = ["localhost", "://", "{", "\"detail\""]
    guard !forbidden.contains(where: text.contains) else { return false }
    return text.range(of: #"\b\d{3}\b"#, options: .regularExpression) == nil
}

@Suite("ios-erreurs-serveur-lisibles — le traducteur partagé")
struct IOSMacErrorTests {
    @Test("ios-erreurs-serveur-lisibles/AC-1 : macOutdatedOn404And405 — 404 « route inconnue » et 405 donnent « app Mac trop ancienne »")
    func macOutdatedOn404And405() {
        let notFound = MacDouble.error(status: 404, code: "not_found", message: "route inconnue")
        let notAllowed = MacDouble.error(status: 405, body: Data(#"{"detail":"Method Not Allowed"}"#.utf8))
        for error in [notFound, notAllowed] {
            #expect(IOSMacFailure.of(error) == .macOutdated)
            let text = IOSMacErrorText.message(for: error)
            #expect(text?.contains("app Mac trop ancienne") == true)
            #expect(isReadable(text ?? "{"))
        }
    }

    @Test("ios-erreurs-serveur-lisibles/AC-2 : refusedConnectionIsMacUnreachable — le refus de connexion donne « Mac injoignable », sans adresse")
    func refusedConnectionIsMacUnreachable() {
        let refused = ClientError.transport(.unreachable("Could not connect to the server. (127.0.0.1:8787)"))
        #expect(IOSMacFailure.of(refused) == .macUnreachable)
        #expect(IOSMacFailure.of(ClientError.transport(.closed("coupé"))) == .macUnreachable)
        #expect(IOSMacFailure.of(ClientError.notConnected) == .macUnreachable)
        let text = IOSMacErrorText.message(for: refused) ?? ""
        #expect(text.contains("Mac injoignable"))
        #expect(!text.contains("127.0.0.1"))
        #expect(!text.contains("8787"))
        #expect(isReadable(text))
        #expect(text != IOSMacErrorText.message(for: .serviceUnavailable))
    }

    @Test("ios-erreurs-serveur-lisibles/AC-3 : unavailableHidesRelayDetail — le 503 relayé donne « service indisponible », sans URL ni JSON ni code")
    func unavailableHidesRelayDetail() {
        let error = MacDouble.relayed503
        #expect(IOSMacFailure.of(error) == .serviceUnavailable)
        let text = IOSMacErrorText.message(for: error) ?? ""
        #expect(text.contains("Service indisponible sur le Mac"))
        #expect(isReadable(text))
        #expect(!text.contains("8321"))
        #expect(!text.contains("Method Not Allowed"))
    }

    @Test("ios-erreurs-serveur-lisibles/AC-4 : forbiddenIsRefused — le 403 donne « action refusée », distincte du 401 et du 404/405")
    func forbiddenIsRefused() {
        let forbidden = [
            MacDouble.error(status: 403, code: "forbidden", message: "x"),
            MacDouble.error(status: 403, body: Data("<html></html>".utf8)),
        ]
        for error in forbidden {
            #expect(IOSMacFailure.of(error) == .refused)
            #expect(IOSMacErrorText.message(for: error)?.contains("Action refusée par le Mac") == true)
        }
        #expect(IOSMacFailure.of(MacDouble.error(status: 401, code: "unauthorized")) == nil)
        #expect(IOSMacFailure.of(status: 403) != IOSMacFailure.of(status: 404))
        #expect(IOSMacFailure.of(status: 403) != IOSMacFailure.of(status: 405))
    }

    @Test("ios-erreurs-serveur-lisibles/AC-5 : unauthorizedHasNoMessage — le 401 n'a aucun message : le parcours de jeton révoqué parle seul")
    func unauthorizedHasNoMessage() {
        let unauthorized = ClientError.api(.unauthorized)
        #expect(IOSMacFailure.of(unauthorized) == nil)
        #expect(IOSMacErrorText.message(for: unauthorized) == nil)
        #expect(IOSMacFailure.of(MacDouble.error(status: 401, code: "unauthorized")) == nil)
        // Un 401 sans enveloppe lisible n'est pas une révocation : cause générique.
        #expect(IOSMacFailure.of(MacDouble.error(status: 401, body: Data("oops".utf8))) == .generic)
    }

    @Test("ios-erreurs-serveur-lisibles/AC-6 : serverAndUnreadableAreGeneric — 500, corps illisible, code ou statut inattendu donnent le message générique")
    func serverAndUnreadableAreGeneric() {
        let errors: [Error] = [
            MacDouble.error(status: 500, code: "server", message: "erreur inattendue"),
            MacDouble.error(status: 500, body: Data("oops".utf8)),
            MacDouble.error(status: 418, code: "teapot"),
            ClientError.decoding("charge utile illisible (X)"),
            ClientError.api(.decoding("charge utile non encodable")),
            NSError(domain: "x", code: 1),
        ]
        for error in errors {
            #expect(IOSMacFailure.of(error) == .generic)
            let text = IOSMacErrorText.message(for: error) ?? ""
            #expect(text == IOSMacErrorText.cause(.generic) + "\n" + IOSMacErrorText.remedy(.generic))
            #expect(text.hasPrefix("Le Mac a rencontré une erreur."))
            #expect(isReadable(text))
        }
    }

    @Test("ios-erreurs-serveur-lisibles/AC-7 : everyCauseHasItsOwnRemedy — chaque cause a son remède, deux à deux différents, et son message porte cause et remède")
    func everyCauseHasItsOwnRemedy() {
        let causes: [IOSMacFailure] = [.macOutdated, .macUnreachable, .macTimedOut, .serviceUnavailable, .refused, .generic]
        for failure in causes {
            let message = IOSMacErrorText.message(for: failure)
            #expect(message.contains(IOSMacErrorText.cause(failure)))
            #expect(message.contains(IOSMacErrorText.remedy(failure)))
            #expect(isReadable(message))
        }
        let remedies = Set(causes.map(IOSMacErrorText.remedy))
        #expect(remedies.count == causes.count)
        // La cause du service trop ancien garde son texte livré, entier.
        #expect(IOSMacErrorText.message(for: .serviceOutdated) == IOSMemoryText.graphServiceOutdated)
    }

    @Test("ios-erreurs-serveur-lisibles/D-3 : businessRefusalKeepsTheMacMotive — un refus métier garde le motif du Mac, sauf s'il fuit un détail technique")
    func businessRefusalKeepsTheMacMotive() {
        let refusal = ClientError.api(.notFound("carte inconnue"))
        #expect(IOSMacFailure.of(refusal) == .rejected("carte inconnue"))
        #expect(IOSMacErrorText.message(for: refusal)
            == "Le Mac n'a pas pu traiter la demande : carte inconnue.\nVérifie la demande ou actualise l'écran, puis réessaie.")
        // Point final : pas de double point.
        #expect(IOSMacErrorText.cause(.rejected("carte inconnue.")) == "Le Mac n'a pas pu traiter la demande : carte inconnue.")
        // La comparaison de « route inconnue » est EXACTE.
        #expect(IOSMacFailure.of(ClientError.api(.notFound(" route inconnue "))) == .rejected(" route inconnue "))
        #expect(IOSMacFailure.of(ClientError.api(.notFound("route inconnue"))) == .macOutdated)
        // Motif vide, JSON, URL, adresse ou code HTTP : le message générique le remplace.
        for motive in ["", "  ", "{\"x\":1}", "voir localhost", "ouvrir x://y", "erreur 418"] {
            #expect(IOSMacFailure.of(ClientError.api(.badRequest(motive))) == .generic, "motif « \(motive) »")
            #expect(IOSMacFailure.of(ClientError.api(.conflict(motive))) == .generic)
        }
    }

    @Test("ios-erreurs-serveur-lisibles/AC-7 : incompatibleProtocolNamesBothVersions — le verrou de version garde ses deux numéros")
    func incompatibleProtocolNamesBothVersions() {
        let locked = ClientError.incompatibleProtocol(local: 1, remote: 2)
        #expect(IOSMacFailure.of(locked) == .incompatibleProtocol(local: 1, remote: 2))
        #expect(IOSMacErrorText.message(for: locked)?.contains("app 1, Mac 2") == true)
        #expect(IOSMacFailure.of(ClientError.api(.incompatibleProtocol("x")))
            == .incompatibleProtocol(local: ConsoleAPI.protocolVersion, remote: nil))
    }
}
