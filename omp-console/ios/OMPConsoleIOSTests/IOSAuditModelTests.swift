// Les preuves Swift de l'écran Audit de l'app iOS (audit-panel-in-omp-console, S-8,
// BR-5) : un VRAI `ConsoleClientModel` sur un transport scripté qui sert la fixture
// partagée `AuditParity` par `GET /v1/store` et enregistre chaque geste. Aucun
// réseau, aucun Mac réel.
//
//   • AC-8 : lancer un audit, cocher 2 propositions et valider le brief appelle
//     `POST /v1/audits` puis `POST /v1/audits/{id}/launch` avec ces 2 slugs ;
//   • AC-6 : répondre appelle `POST /v1/audits/{id}/escalations`, et une escalade
//     absente de l'instantané suivant disparaît de l'écran.

@testable import OMPConsoleIOS
import ConsoleClient
import ConsoleCore
import Foundation
import Testing

/// Le Mac scripté : l'instantané servi (remplaçable entre deux trames) et la
/// réponse des routes d'audit.
private final class AuditMac: @unchecked Sendable {
    private let lock = NSLock()
    private var snapshotJSON: Data
    private var answerStatus = 202

    init(snapshot: Data) {
        snapshotJSON = snapshot
    }

    func serve(_ snapshot: Data) { lock.withLock { snapshotJSON = snapshot } }
    func refuseAnswers() { lock.withLock { answerStatus = 409 } }

    func respond(_ request: ClientHTTPRequest) -> ClientHTTPResponse {
        lock.withLock {
            switch (request.method, request.path) {
            case ("GET", "/v1/store"):
                var body = Data(#"{"snapshot":"#.utf8)
                body.append(snapshotJSON)
                body.append(Data("}".utf8))
                return ClientHTTPResponse(status: 200, protocolVersion: ConsoleAPI.protocolVersion, body: body)
            case ("POST", "/v1/audits"):
                return ClientDoubles.response(status: 200, json: #"{"id":"\#(AuditParity.proposedId)"}"#)
            case ("POST", "/v1/audits/" + AuditParity.proposedId + "/launch"):
                return ClientDoubles.response(status: 200, json: #"{"launches":[]}"#)
            case ("POST", "/v1/audits/" + AuditParity.launchedId + "/escalations"):
                if answerStatus == 409 {
                    return ClientDoubles.response(
                        status: 409,
                        json: #"{"error":{"code":"conflict","message":"question déjà répondue ou périmée"}}"#
                    )
                }
                return ClientDoubles.response(status: 202, json: #"{"accepted":true}"#)
            default:
                return ClientDoubles.response(status: 404, json: #"{"error":{"code":"not_found","message":"route"}}"#)
            }
        }
    }
}

@MainActor
@Suite("audit-panel-in-omp-console-ios — l'écran Audit de l'iPhone")
struct IOSAuditModelTests {
    private static let address = "127.0.0.1:8787"

    /// L'instantané de la fixture, tel que la coque l'encode dans la trame `store`.
    private static func parityJSON() throws -> Data {
        try JSONEncoder().encode(AuditParity.snapshot)
    }

    /// Le même instantané, toutes escalades retirées : la réponse a été prise.
    private static func answeredJSON() throws -> Data {
        let object = try JSONSerialization.jsonObject(with: parityJSON())
        return try JSONSerialization.data(withJSONObject: removingEscalations(object))
    }

    private static func removingEscalations(_ value: Any) -> Any {
        if var dictionary = value as? [String: Any] {
            dictionary.removeValue(forKey: "escalation")
            return dictionary.mapValues(removingEscalations)
        }
        if let array = value as? [Any] {
            return array.map(removingEscalations)
        }
        return value
    }

    /// Les requêtes d'audit, dans l'ordre (les relectures annexes du client écartées).
    private static func auditRequests(_ transport: ScriptedClientTransport) -> [ClientHTTPRequest] {
        transport.requests.filter { $0.path.hasPrefix("/v1/audits") }
    }

    private static func json(_ request: ClientHTTPRequest) throws -> [String: Any] {
        let body = try #require(request.body)
        return try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    private func connectedModel() async throws -> (IOSAuditModel, ScriptedClientTransport, AuditMac) {
        let mac = AuditMac(snapshot: try Self.parityJSON())
        let transport = ScriptedClientTransport { mac.respond($0) }
        let client = ClientDoubles.model(transport: transport, address: Self.address)
        _ = try await client.store()
        return (IOSAuditModel(client: client), transport, mac)
    }

    // MARK: - AC-8

    @Test("audit-panel-in-omp-console-ios/AC-8 : lancer, cocher 2 et valider appelle startAudit puis launchAudit avec ces 2 slugs")
    func launchingFromTheIPhonePostsTheSameRequests() async throws {
        let (model, transport, _) = try await connectedModel()

        // Lancer : l'orientation part rognée, l'audit créé est poussé.
        #expect(await model.start(repoKey: "depot", orientation: "  accessibilité VoiceOver \n") == nil)
        #expect(model.opened == AuditParity.proposedId)

        let card = try #require(model.card(AuditParity.proposedId))
        let launchable = card.proposals.filter { !$0.taken }
        let taken = try #require(card.proposals.first { $0.taken })
        #expect(launchable.count == 4)

        // Cocher : trois cochées puis une décochée, et une proposition déjà dans le
        // lot ne se coche pas.
        model.toggle(launchable[0].slug, in: card.id)
        model.toggle(launchable[1].slug, in: card.id)
        model.toggle(launchable[2].slug, in: card.id)
        model.toggle(launchable[2].slug, in: card.id)
        model.toggle(taken.slug, in: card.id)
        #expect(!model.isChecked(taken.slug, in: card.id))
        #expect(model.selectedSlugs(of: card) == [launchable[0].slug, launchable[1].slug])

        // Fermer la relecture n'envoie rien.
        model.presentBrief(card)
        #expect(model.briefAudit == card.id)
        #expect(model.briefText == card.briefDraft)
        model.cancelBrief()
        #expect(model.briefAudit == nil)
        #expect(Self.auditRequests(transport).map(\.path) == ["/v1/audits"])

        // Valider : la sélection et le brief partent ensemble, une seule fois.
        model.presentBrief(card)
        #expect(await model.commitBrief())
        #expect(model.briefAudit == nil)
        #expect(model.selectedSlugs(of: card).isEmpty)

        let requests = Self.auditRequests(transport)
        #expect(requests.map { "\($0.method) \($0.path)" } == [
            "POST /v1/audits",
            "POST /v1/audits/" + AuditParity.proposedId + "/launch",
        ])
        let start = try Self.json(requests[0])
        #expect(start["repoKey"] as? String == "depot")
        #expect(start["orientation"] as? String == "accessibilité VoiceOver")
        let launch = try Self.json(requests[1])
        #expect(launch["selected"] as? [String] == [launchable[0].slug, launchable[1].slug])
        #expect(launch["brief"] as? String == card.briefDraft)
    }

    @Test("audit-panel-in-omp-console-ios/AC-8 : un brief sans sa rubrique est signalé dans la feuille, sans aucun envoi")
    func incompleteBriefSendsNothing() async throws {
        let (model, transport, _) = try await connectedModel()
        let card = try #require(model.card(AuditParity.proposedId))
        model.toggle(try #require(card.proposals.first { !$0.taken }).slug, in: card.id)
        model.presentBrief(card)
        model.briefText = (card.briefDraft ?? "").replacingOccurrences(of: "## Orientation", with: "## Orient")

        #expect(!(await model.commitBrief()))
        #expect(model.briefError == AuditText.briefIncomplete(rubric: "Orientation"))
        #expect(model.briefAudit == card.id)
        #expect(Self.auditRequests(transport).isEmpty)
    }

    @Test("audit-panel-in-omp-console-ios/AC-8 : « Lancer l’audit » exige un dépôt et une orientation rognée de 1 à 2 000 caractères")
    func launchGuardFollowsTheOrientationBounds() {
        #expect(IOSAuditModel.mayStart(gesturesEnabled: true, repoKey: "depot", orientation: " a ", submitting: false))
        #expect(IOSAuditModel.mayStart(gesturesEnabled: true, repoKey: "depot", orientation: String(repeating: "a", count: 2000), submitting: false))
        #expect(!IOSAuditModel.mayStart(gesturesEnabled: true, repoKey: "depot", orientation: String(repeating: "a", count: 2001), submitting: false))
        #expect(!IOSAuditModel.mayStart(gesturesEnabled: true, repoKey: "depot", orientation: " \n ", submitting: false))
        #expect(!IOSAuditModel.mayStart(gesturesEnabled: true, repoKey: nil, orientation: "a", submitting: false))
        #expect(!IOSAuditModel.mayStart(gesturesEnabled: false, repoKey: "depot", orientation: "a", submitting: false))
        #expect(!IOSAuditModel.mayStart(gesturesEnabled: true, repoKey: "depot", orientation: "a", submitting: true))
    }

    // MARK: - AC-6

    @Test("audit-panel-in-omp-console-ios/AC-6 : répondre appelle answerAuditEscalation, et l'escalade absente du nouvel instantané disparaît de l'écran")
    func answeredEscalationLeavesTheScreen() async throws {
        let (model, transport, mac) = try await connectedModel()
        let card = try #require(model.card(AuditParity.launchedId))
        let escalation = try #require(card.escalations.first)
        #expect(escalation.options.count == 2)
        // L'audit B n'a aucune question de A (AC-10, côté iPhone).
        #expect(model.card(AuditParity.proposedId)?.escalations.isEmpty == true)

        model.setDraft("brouillon", for: escalation.key)
        #expect(await model.answer(auditId: card.id, escalation: escalation, text: escalation.options[1]))
        #expect(model.draft(for: escalation.key) == "")
        #expect(model.banner == nil)

        let requests = Self.auditRequests(transport)
        #expect(requests.map { "\($0.method) \($0.path)" } == ["POST /v1/audits/" + AuditParity.launchedId + "/escalations"])
        let body = try Self.json(requests[0])
        #expect(body["slug"] as? String == escalation.slug)
        #expect(body["key"] as? String == escalation.key)
        #expect(body["answer"] as? String == escalation.options[1])
        #expect(body["decision"] == nil)

        // Jusqu'à la trame suivante, la question reste ; elle disparaît dès qu'elle
        // manque à l'instantané (réponse prise ici ou sur le Mac).
        #expect(model.card(AuditParity.launchedId)?.escalations.count == 1)
        mac.serve(try Self.answeredJSON())
        _ = try await model.client.store()
        #expect(model.card(AuditParity.launchedId)?.escalations.isEmpty == true)
        #expect(model.card(AuditParity.launchedId)?.features.contains { $0.waiting == .escalated } == false)
    }

    @Test("audit-panel-in-omp-console-ios/AC-6 : une question déjà répondue sur le Mac rend « Cette question a déjà reçu une réponse. »")
    func alreadyAnsweredEscalationIsSaid() async throws {
        let (model, _, mac) = try await connectedModel()
        mac.refuseAnswers()
        let card = try #require(model.card(AuditParity.launchedId))
        let escalation = try #require(card.escalations.first)

        #expect(!(await model.answer(auditId: card.id, escalation: escalation, text: escalation.options[0])))
        #expect(model.banner == AuditText.alreadyAnswered)
        #expect(model.inFlight == nil)
    }

    // MARK: - États propres à l'iPhone (S-8)

    @Test("audit-panel-in-omp-console-ios/AC-6 : hors connexion, l'instantané reçu reste affiché ; sans lui, l'état de connexion seul")
    func offlineKeepsTheReceivedSnapshot() {
        for status in [IOSConnectionStatus.connecting, .disconnected(.unreachable), .disconnected(.unpaired), .disconnected(.refused)] {
            #expect(IOSAuditModel.surface(connection: status, hasSnapshot: false) == .unavailable(status))
            #expect(IOSAuditModel.surface(connection: status, hasSnapshot: true) == .content)
            #expect(IOSAuditModel.shownFailure(AuditText.answerFailed, connection: status) == nil)
        }
        #expect(IOSAuditModel.surface(connection: .connected, hasSnapshot: false) == .content)
        #expect(IOSAuditModel.shownFailure(AuditText.answerFailed, connection: .connected) == AuditText.answerFailed)
    }

    @Test("audit-panel-in-omp-console-ios/AC-8 : la recette `-audit.recipe` sert AuditParity et ouvre l'audit demandé")
    func recipeServesTheParityFixture() throws {
        #expect(IOSAuditRecipe.resolve(["-audit.recipe", "liste"]) == .liste)
        #expect(IOSAuditRecipe.resolve(["-audit.recipe", "suivi", "-audit.recipe", "propositions"]) == .propositions)
        #expect(IOSAuditRecipe.resolve(["-audit.recipe", "inconnue"]) == nil)
        #expect(IOSAuditRecipe.resolve([]) == nil)

        let mac = AuditMac(snapshot: try Self.parityJSON())
        let client = ClientDoubles.model(transport: ScriptedClientTransport { mac.respond($0) }, address: "")
        let model = IOSAuditModel(client: client, recipe: .propositions)
        #expect(model.surface == .content)
        #expect(model.board == AuditParity.board)
        #expect(model.opened == AuditParity.proposedId)
        let card = try #require(model.card(AuditParity.proposedId))
        #expect(model.selectedSlugs(of: card).count == 2)
        #expect(IOSAuditModel(client: client, recipe: .suivi).opened == AuditParity.launchedId)
        #expect(IOSAuditModel(client: client, recipe: .liste).opened == nil)
    }
}
