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
import UIKit

/// Le Mac scripté : l'instantané servi (remplaçable entre deux trames) et la
/// réponse des routes d'audit.
private final class AuditMac: @unchecked Sendable {
    private let lock = NSLock()
    private var snapshotJSON: Data
    private var answerStatus = 202
    private var startStatus = 200

    init(snapshot: Data) {
        snapshotJSON = snapshot
    }

    func serve(_ snapshot: Data) { lock.withLock { snapshotJSON = snapshot } }
    func refuseAnswers() { lock.withLock { answerStatus = 409 } }
    func refuseStarts() { lock.withLock { startStatus = 503 } }

    func respond(_ request: ClientHTTPRequest) -> ClientHTTPResponse {
        lock.withLock {
            switch (request.method, request.path) {
            case ("GET", "/v1/store"):
                var body = Data(#"{"snapshot":"#.utf8)
                body.append(snapshotJSON)
                body.append(Data("}".utf8))
                return ClientHTTPResponse(status: 200, protocolVersion: ConsoleAPI.protocolVersion, body: body)
            case ("POST", "/v1/audits"):
                if startStatus != 200 {
                    return ClientDoubles.response(
                        status: startStatus,
                        json: #"{"error":{"code":"unavailable","message":"service arrêté"}}"#
                    )
                }
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
        #expect(model.board.audits.map(\.id) == AuditParity.board.audits.map(\.id))
        #expect(model.opened == AuditParity.proposedId)
        let card = try #require(model.card(AuditParity.proposedId))
        #expect(model.selectedSlugs(of: card).count == 2)
        #expect(IOSAuditModel(client: client, recipe: .suivi).opened == AuditParity.launchedId)
        #expect(IOSAuditModel(client: client, recipe: .liste).opened == nil)
    }
}

/// Les preuves Swift de la refonte de l'écran Audit de l'iPhone et de l'iPad
/// (audit-ui-redesign, BR-3) : liste en sections, menus, frise, relecture du
/// brief, relance d'un audit en échec — sur la fixture partagée `AuditParity`.
@MainActor
@Suite("audit-ui-redesign-ios — l'écran Audit refondu de l'iPhone et de l'iPad")
struct IOSAuditRedesignTests {
    /// L'instant de la recette : l'audit en cours d'analyse a été lancé 65 s avant.
    private static let nowMs: Double = 1_700_000_100_000

    private static func recipeModel(_ recipe: IOSAuditRecipe) throws -> IOSAuditModel {
        let mac = AuditMac(snapshot: try JSONEncoder().encode(AuditParity.snapshot))
        let client = ClientDoubles.model(transport: ScriptedClientTransport { mac.respond($0) }, address: "")
        return IOSAuditModel(client: client, recipe: recipe)
    }

    private func connectedModel() async throws -> (IOSAuditModel, ScriptedClientTransport, AuditMac) {
        let mac = AuditMac(snapshot: try JSONEncoder().encode(AuditParity.snapshot))
        let transport = ScriptedClientTransport { mac.respond($0) }
        let client = ClientDoubles.model(transport: transport, address: "127.0.0.1:8787")
        _ = try await client.store()
        return (IOSAuditModel(client: client), transport, mac)
    }

    private static func card(_ id: String) throws -> AuditCard {
        try #require(AuditParity.board(nowMs: nowMs).card(id: id))
    }

    // MARK: - AC-2, AC-3 : la liste

    @Test("audit-ui-redesign-ios/AC-2 : « En cours » porte analysing, proposed, launched ; « Terminés » stopped et failed ; une section vide n'est pas rendue")
    func listSectionsSplitRunningAndFinished() throws {
        let board = try Self.recipeModel(.liste).board
        let sections = AuditPresentation.sections(board)
        #expect(sections.map(\.title) == [AuditText.sectionRunning, AuditText.sectionFinished])
        #expect(Set(sections[0].cards.map(\.id)) == [AuditParity.analysingId, AuditParity.proposedId, AuditParity.launchedId])
        #expect(Set(sections[1].cards.map(\.id)) == [AuditParity.stoppedId, AuditParity.failedId])

        let runningOnly = AuditBoard(audits: board.audits.filter { AuditPresentation.isRunning($0.status) })
        #expect(AuditPresentation.sections(runningOnly).map(\.kind) == [.running])
        #expect(AuditPresentation.sections(AuditBoard(audits: [])).isEmpty)
    }

    @Test("audit-ui-redesign-ios/AC-3 : la légende de la rangée lit « dépôt · étape · âge », le dépôt une seule fois")
    func rowCaptionNamesTheRepositoryOnce() throws {
        let card = try Self.card(AuditParity.launchedId)
        let caption = AuditPresentation.rowCaption(card, briefReviewOpen: false, nowMs: Self.nowMs)
        let age = ConsoleFormat.relative(ms: card.createdAt, nowMs: Self.nowMs)
        #expect(caption == AuditText.rowCaption(repo: card.repoName, step: AuditText.stepTitles[3], age: age))
        #expect(caption.components(separatedBy: card.repoName).count == 2)
        #expect(!card.escalations.isEmpty)
        #expect(AuditText.pendingQuestions(card.escalations.count).contains(String(card.escalations.count)))
        // La relecture du brief de CET audit fait lire « Brief » à la rangée proposed.
        let proposed = try Self.card(AuditParity.proposedId)
        #expect(AuditPresentation.rowCaption(proposed, briefReviewOpen: true, nowMs: Self.nowMs).contains(AuditText.stepTitles[2]))
    }

    // MARK: - AC-5 : menus et « Ouvrir dans Projet »

    @Test("audit-ui-redesign-ios/AC-5 : le menu d'un audit copie le chemin complet, ouvre Projet, arrête en dernier — jamais un audit terminé")
    func auditMenuFollowsConnectionAndStatus() throws {
        let running = try Self.card(AuditParity.launchedId)
        #expect(IOSContextMenu.auditRow(running, gesturesEnabled: true)
            == [.copyPath(running.repoRoot), .openInProject, .stopAudit])
        #expect(IOSContextMenu.auditRow(running, gesturesEnabled: false) == [.copyPath(running.repoRoot)])
        for id in [AuditParity.stoppedId, AuditParity.failedId] {
            let finished = try Self.card(id)
            #expect(IOSContextMenu.auditRow(finished, gesturesEnabled: true) == [.copyPath(finished.repoRoot), .openInProject])
        }
        #expect(IOSContextMenu.label(.copyPath(running.repoRoot)) == AuditText.copyPath)
        #expect(IOSContextMenu.label(.openInProject) == AuditText.openInProject)
        #expect(IOSContextMenu.label(.stopAudit) == AuditText.stopAudit)

        // « Copier le chemin » : le presse-papiers reçoit le chemin COMPLET.
        guard case let .copyPath(path) = IOSContextMenu.auditRow(running, gesturesEnabled: true)[0] else {
            Issue.record("la première entrée n'est pas « Copier le chemin »")
            return
        }
        IOSPasteboard.copy(path)
        #expect(UIPasteboard.general.string == running.repoRoot)
        #expect(path.hasPrefix("/"))

        // « Ouvrir dans Projet », côté écran Projet (conduite reçue du Mac).
        let key = running.repoKey
        #expect(AuditPresentation.projectOpening(auditRepoKey: key, pilotedRepoKey: key, pilotActive: true) == .show)
        #expect(AuditPresentation.projectOpening(auditRepoKey: key, pilotedRepoKey: "autre", pilotActive: true) == .refuse)
        #expect(AuditPresentation.projectOpening(auditRepoKey: key, pilotedRepoKey: nil, pilotActive: false) == .proposeLaunch)
    }

    @Test("audit-ui-redesign-ios/AC-5 : « Arrêter l'audit… » confirmé appelle DELETE /v1/audits/{id}")
    func stopFromTheMenuDeletesTheAudit() async throws {
        let (model, transport, _) = try await connectedModel()
        let card = try #require(model.card(AuditParity.launchedId))
        model.requestStop(card)
        #expect(model.pendingStop == card.id)
        _ = await model.confirmStop()
        let requests = transport.requests.filter { $0.path.hasPrefix("/v1/audits") }
        #expect(requests.map { "\($0.method) \($0.path)" } == ["DELETE /v1/audits/" + AuditParity.launchedId])
    }

    // MARK: - AC-8 : l'en-tête

    @Test("audit-ui-redesign-ios/AC-8 : la légende de l'en-tête lit « dépôt · lancé à HH:MM », sans statut écrit")
    func headerCaptionReadsRepositoryAndTime() throws {
        let card = try Self.card(AuditParity.failedId)
        let caption = AuditPresentation.headerCaption(card)
        #expect(caption == AuditText.headerCaption(repo: card.repoName, time: ConsoleFormat.time(ms: card.createdAt)))
        #expect(caption.range(of: #"\d{1,2}:\d{2}$"#, options: .regularExpression) != nil)
        #expect(!caption.contains(AuditText.status(card.status)))
        #expect(card.orientation.count >= 280)
    }

    // MARK: - AC-10, AC-12 : la frise

    @Test("audit-ui-redesign-ios/AC-10 : la frise du détail montre exactement les états calculés pour chaque audit")
    func stepperFollowsThePureFunction() throws {
        let expected: [String: [PipelineStepState]] = [
            AuditParity.analysingId: [.current, .upcoming, .upcoming, .upcoming],
            AuditParity.proposedId: [.done, .current, .upcoming, .upcoming],
            AuditParity.launchedId: [.done, .done, .done, .current],
            AuditParity.stoppedId: [.done, .upcoming, .upcoming, .upcoming],
            AuditParity.failedId: [.failed, .upcoming, .upcoming, .upcoming],
        ]
        for (id, states) in expected {
            let card = try Self.card(id)
            let steps = IOSAuditDetailView.steps(card, briefAudit: nil)
            #expect(steps == AuditPresentation.steps(AuditPresentation.progressInput(card, briefReviewOpen: false)))
            #expect(steps.map(\.state) == states, "audit \(id)")
            #expect(steps.map(\.title) == AuditText.stepTitles)
        }
        // Un symbole par état, tous distincts.
        let symbols = [PipelineStepState.done, .current, .failed, .upcoming].map(IOSAuditStepper.symbolName)
        #expect(Set(symbols).count == 4)
    }

    @Test("audit-ui-redesign-ios/AC-12 : cocher compte « N cochées » ; « Relire le brief → » met Brief en cours, refermer ramène à Propositions")
    func briefReviewDrivesTheStepper() throws {
        let model = try Self.recipeModel(.propositions)
        let card = try #require(model.card(AuditParity.proposedId))
        #expect(AuditText.checkedCount(model.selectedSlugs(of: card).count) == "2 cochées")
        let third = try #require(card.proposals.first { !$0.taken && !model.isChecked($0.slug, in: card.id) })
        model.toggle(third.slug, in: card.id)
        #expect(AuditText.checkedCount(model.selectedSlugs(of: card).count) == "3 cochées")
        model.toggle(third.slug, in: card.id)
        #expect(model.selectedSlugs(of: card).count == 2)
        // « déjà prise » ne se coche pas, « après X » vient des dépendances.
        let taken = try #require(card.proposals.first { $0.taken })
        model.toggle(taken.slug, in: card.id)
        #expect(!model.isChecked(taken.slug, in: card.id))

        #expect(IOSAuditDetailView.steps(card, briefAudit: model.briefAudit).map(\.state) == [.done, .current, .upcoming, .upcoming])
        model.presentBrief(card)
        #expect(model.briefAudit == card.id)
        #expect(IOSAuditDetailView.steps(card, briefAudit: model.briefAudit).map(\.state) == [.done, .done, .current, .upcoming])
        model.cancelBrief()
        #expect(IOSAuditDetailView.steps(card, briefAudit: model.briefAudit).map(\.state) == [.done, .current, .upcoming, .upcoming])
    }

    // MARK: - AC-11, AC-13 : corps des étapes

    @Test("audit-ui-redesign-ios/AC-11 : la carte d'analyse montre la durée écoulée ; « Analyse en cours » n'y figure qu'une fois")
    func analysisCardSaysAnalysingOnce() throws {
        let model = try Self.recipeModel(.analyse)
        let id = try #require(model.opened)
        #expect(id == AuditParity.analysingId)
        let card = try #require(model.card(id))
        let now = Date.now.timeIntervalSince1970 * 1000
        let elapsed = now - card.createdAt
        #expect(elapsed >= 65_000 && elapsed < 75_000)
        #expect(AuditPresentation.elapsed(ms: 65_000) == "1:05")
        #expect(AuditPresentation.elapsed(ms: 68_000) != AuditPresentation.elapsed(ms: 65_000))

        let phrase = "Analyse en cours"
        let shown = [
            AuditText.analysisCardTitle,
            AuditText.analysisElapsed(AuditPresentation.elapsed(ms: elapsed)),
            AuditText.analysisNext,
            AuditText.stopAudit,
            AuditPresentation.headerCaption(card),
            AuditText.stepsAccessibility(IOSAuditDetailView.steps(card, briefAudit: nil)),
        ] + AuditText.stepTitles
        #expect(shown.filter { $0.contains(phrase) }.count == 1)
        #expect(AuditText.analysisElapsed(AuditPresentation.elapsed(ms: elapsed)).contains(phrase))
    }

    @Test("audit-ui-redesign-ios/AC-13 : les questions précèdent l'avancement, les non lancées et les décisions repliées")
    func followUpPutsQuestionsFirst() throws {
        let card = try Self.card(AuditParity.launchedId)
        let blocks = AuditPresentation.followUpBlocks(card)
        #expect(blocks.first == .escalations)
        #expect(blocks.contains(.progress))
        #expect(card.features.contains { $0.prUrl != nil })
        for row in card.features {
            #expect(AuditPresentation.featureSteps(row).count == 5)
        }
        if !card.decisions.isEmpty {
            #expect(blocks.last == .decisions)
            #expect(AuditText.decisionsGroupTitle(card.decisions.count).contains("(\(card.decisions.count))"))
        }
        let stopped = try Self.card(AuditParity.stoppedId)
        #expect(AuditPresentation.followUpBlocks(stopped) == [.stoppedBeforeLaunch])
    }

    // MARK: - AC-14 : échec et relance

    @Test("audit-ui-redesign-ios/AC-14 : « Relancer avec la même orientation » poste le même dépôt et la même orientation, puis ouvre l'audit créé")
    func relaunchPostsTheSameOrientation() async throws {
        let (model, transport, _) = try await connectedModel()
        let failed = try #require(model.card(AuditParity.failedId))
        #expect(AuditPresentation.failureSentence(failed.failure) == "L'analyse a été interrompue.")
        #expect(AuditPresentation.diagnostic(failed).contains(failed.repoRoot))

        #expect(await model.relaunch(failed))
        #expect(model.opened == AuditParity.proposedId)
        let requests = transport.requests.filter { $0.path.hasPrefix("/v1/audits") }
        #expect(requests.map { "\($0.method) \($0.path)" } == ["POST /v1/audits"])
        let data = try #require(requests[0].body)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(body["repoKey"] as? String == failed.repoKey)
        #expect(body["orientation"] as? String == failed.orientation.trimmingCharacters(in: .whitespacesAndNewlines))
        // L'audit échoué reste listé sous « Terminés ».
        let finished = try #require(AuditPresentation.sections(model.board).first { $0.kind == .finished })
        #expect(finished.cards.contains { $0.id == AuditParity.failedId })
    }

    @Test("audit-ui-redesign-ios/AC-14 : une relance refusée s'affiche en bandeau, sans ouvrir d'audit")
    func refusedRelaunchShowsTheBanner() async throws {
        let (model, _, mac) = try await connectedModel()
        mac.refuseStarts()
        let failed = try #require(model.card(AuditParity.failedId))
        #expect(!(await model.relaunch(failed)))
        #expect(model.banner == AuditText.startFailed)
        #expect(model.opened == nil)
        #expect(model.inFlight == nil)
    }

    // MARK: - AC-15 : identifiants conservés

    @Test("audit-ui-redesign-ios/AC-15 : les identifiants d'accessibilité conservés gardent leur valeur")
    func accessibilityIdentifiersAreKept() {
        let kept: [String: String] = [
            IOSAuditAccessibility.screen: "ios.audit",
            IOSAuditAccessibility.empty: "ios.audit.empty",
            IOSAuditAccessibility.banner: "ios.audit.banner",
            IOSAuditAccessibility.start: "ios.audit.start",
            IOSAuditAccessibility.detail: "ios.audit.detail",
            IOSAuditAccessibility.header: "ios.audit.header",
            IOSAuditAccessibility.reviewBrief: "ios.audit.brief",
            IOSAuditAccessibility.stop: "ios.audit.stop",
            IOSAuditAccessibility.row("a"): "ios.audit.row.a",
            IOSAuditAccessibility.proposal("s"): "ios.audit.proposal.s",
            IOSAuditAccessibility.feature("s"): "ios.audit.feature.s",
            IOSAuditAccessibility.openPR("s"): "ios.audit.feature.s.pr",
            IOSAuditAccessibility.escalation("k"): "ios.audit.escalation.k",
            IOSAuditAccessibility.decision(0): "ios.audit.decision.0",
            IOSAuditAccessibility.checkedCount: "ios.audit.checkedCount",
            IOSAuditAccessibility.orientationToggle: "ios.audit.orientation.toggle",
            IOSAuditAccessibility.menu: "ios.audit.menu",
            IOSAuditAccessibility.stepper: "ios.audit.stepper",
            IOSAuditAccessibility.analysis: "ios.audit.analysis",
            IOSAuditAccessibility.notLaunched: "ios.audit.notLaunched",
            IOSAuditAccessibility.decisions: "ios.audit.decisions",
            IOSAuditAccessibility.stoppedEmpty: "ios.audit.stoppedEmpty",
            IOSAuditAccessibility.failure: "ios.audit.failure",
            IOSAuditAccessibility.relaunch: "ios.audit.relaunch",
            IOSAuditAccessibility.diagnostic: "ios.audit.diagnostic",
        ]
        for (value, expected) in kept {
            #expect(value == expected)
        }
        #expect(IOSAuditRecipe.resolve(["-audit.recipe", "analyse"]) == .analyse)
        #expect(IOSAuditRecipe.resolve(["-audit.recipe", "echec"]) == .echec)
        #expect(IOSAuditRecipe.echec.openedAudit == AuditParity.failedId)
    }
}
