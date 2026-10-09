import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsoleIOS
@testable import ConsoleCore

/// Les preuves Swift de la dérivation de l'écran Pipelines (S-3, S-4, BR-4) : la
/// priorité des états, et les identifiants d'accessibilité uniques.
@MainActor
@Suite("ios-pipelines — l'état de l'écran")
struct PipelinesModelTests {
    private let endpoint = ClientEndpoint.manual(host: "127.0.0.1", port: 8787)

    @Test("ios-pipelines/AC-3 : pas connectée et jamais reçue → état déconnecté explicite")
    func disconnectedWithoutSnapshot() {
        #expect(PipelinesModel.screen(connection: .unpaired, board: nil) == .noSnapshot)
        #expect(PipelinesModel.screen(connection: .macAbsent(endpoint: endpoint), board: nil) == .noSnapshot)
        #expect(PipelinesModel.screen(connection: .revoked, board: nil) == .noSnapshot)
    }

    @Test("ios-pipelines/AC-2 : connectée sans instantané → chargement")
    func connectedWithoutSnapshotLoads() {
        #expect(PipelinesModel.screen(connection: .connected(endpoint: endpoint), board: nil) == .loading)
    }

    @Test("ios-pipelines/AC-3 : un instantané connu prime — l'ardoise reste affichée connexion perdue")
    func snapshotWinsOverConnection() {
        let board = KanbanBoard(cards: [], anomalies: [])
        #expect(PipelinesModel.screen(connection: .macAbsent(endpoint: endpoint), board: .board(board)) == .board(.board(board)))
        #expect(PipelinesModel.screen(connection: .connected(endpoint: endpoint), board: .storeEmpty(dir: "")) == .board(.storeEmpty(dir: "")))
    }

    @Test("ios-pipelines/AC-3 : seul un état NON connecté porte un bandeau")
    func onlyDisconnectedHasBanner() {
        #expect(PipelinesModel.connectionBanner(connection: .connected(endpoint: endpoint)) == nil)
        #expect(PipelinesModel.connectionBanner(connection: .macAbsent(endpoint: endpoint))?.tone == .attention)
    }

    @Test("ios-pipelines/AC-3 : le mot de l'état vide déconnecté n'est pas celui du magasin vide")
    func noSnapshotWordIsNotTheStoreWord() {
        #expect(PipelinesText.noSnapshot != KanbanText.noPipeline)
    }

    @Test("ios-pipelines/AC-1 : les identifiants de cartes et de voies sont distincts")
    func accessibilityIdentifiers() {
        #expect(PipelinesAccessibility.card("a") != PipelinesAccessibility.card("b"))
        #expect(PipelinesAccessibility.lane("a") != PipelinesAccessibility.lane("b"))
        #expect(PipelinesAccessibility.screen.hasPrefix("pipelines."))
        #expect(PipelinesSheet.card("x").id != PipelinesSheet.newFeature.id)
    }

    @Test("ios-pipelines/AC-5 : les valeurs de contrat des gestes sont celles du protocole")
    func protocolValues() {
        #expect(PipelinesAnswerKind.selected.rawValue == "selected")
        #expect(PipelinesAnswerKind.custom.rawValue == "custom")
        #expect(PipelinesVerdict.specs.rawValue == "specs")
        #expect(PipelinesVerdict.review.rawValue == "review")
    }

    // MARK: - Erreurs du Mac (ios-erreurs-serveur-lisibles)

    /// Le prédicat « lisible » : ni adresse, ni JSON, ni code HTTP à trois chiffres.
    private func isReadable(_ text: String) -> Bool {
        let forbidden = ["localhost", "://", "{", "\"detail\""]
        guard !forbidden.contains(where: text.contains) else { return false }
        return text.range(of: #"\b\d{3}\b"#, options: .regularExpression) == nil
    }

    /// La réponse du Mac passe par la vraie traduction du client.
    private func macError(status: Int, code: String, message: String) -> ClientError {
        let body = (try? JSONSerialization.data(
            withJSONObject: ["error": ["code": code, "message": message]]
        )) ?? Data()
        return ClientErrorMapping.translate(status: status, protocolVersion: 1, body: body)
    }

    /// Le 503 que rend le Mac quand mem0-http répond 405 : l'adresse et le JSON amont sont
    /// dans le message.
    private func relayed503() -> ClientError {
        let detail = MemoryText.unavailableDetail(
            address: "localhost:8321",
            error: "réponse 405 du service ({\"detail\":\"Method Not Allowed\"})"
        )
        return macError(status: 503, code: "unavailable", message: detail)
    }

    @Test("ios-erreurs-serveur-lisibles/AC-8 : catalogShowsTranslatedFailure — le 503 relayé s'affiche en « service indisponible », sans URL ni JSON")
    func catalogShowsTranslatedFailure() async {
        let error = relayed503()
        let state = await PipelinesModel.catalog { throw error }
        let expected = IOSMacErrorText.message(for: .serviceUnavailable)
        #expect(state == .failed(expected))
        #expect(isReadable(expected))
        #expect(expected.contains("Service indisponible sur le Mac"))
    }

    @Test("ios-erreurs-serveur-lisibles/AC-7 : catalogRetryLoadsModels — après un échec, la même fonction rend les modèles ; une raison du Mac garde la composition du noyau")
    func catalogRetryLoadsModels() async {
        var succeed = false
        let error = relayed503()
        let load: @MainActor () async throws -> RemoteModelsPayload = {
            if !succeed { throw error }
            return RemoteModelsPayload(selectors: ["a/b"], failure: nil)
        }
        #expect(await PipelinesModel.catalog(load) == .failed(IOSMacErrorText.message(for: .serviceUnavailable)))
        // Réessayer relance le même chargement : le Mac répond désormais 200.
        succeed = true
        #expect(await PipelinesModel.catalog(load) == .loaded(["a/b"]))
        let failed = await PipelinesModel.catalog { RemoteModelsPayload(selectors: [], failure: "pas de modèle") }
        #expect(failed == .failed(KanbanText.modelCatalogUnavailable("pas de modèle")))
    }

    @Test("ios-erreurs-serveur-lisibles/AC-5 : catalogUnauthorizedShowsConnectionState — le 401 n'affiche aucun message traduit, mais l'état de connexion")
    func catalogUnauthorizedShowsConnectionState() async {
        let state = await PipelinesModel.catalog { throw ClientError.api(.unauthorized) }
        #expect(state == .failed(ConnectionText.revoked))
    }

    @Test("ios-erreurs-serveur-lisibles/D-3 : catalogBusinessRefusalKeepsMotive — un refus métier garde le motif rédigé par le Mac")
    func catalogBusinessRefusalKeepsMotive() async {
        let state = await PipelinesModel.catalog { throw ClientError.api(.notFound("carte inconnue")) }
        #expect(state == .failed(IOSMacErrorText.message(for: .rejected("carte inconnue"))))
        #expect(IOSMacErrorText.message(for: .rejected("carte inconnue")).contains("carte inconnue"))
        // « route inconnue » seule signifie « app Mac trop ancienne ».
        let outdated = await PipelinesModel.catalog { throw ClientError.api(.notFound(IOSMacFailure.unknownRoute)) }
        #expect(outdated == .failed(IOSMacErrorText.message(for: .macOutdated)))
    }
}
