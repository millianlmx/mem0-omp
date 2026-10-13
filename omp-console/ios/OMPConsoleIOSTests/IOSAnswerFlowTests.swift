// Les preuves Swift du flux de réponse à une carte (feature
// reponse-ios-sans-identifiant-de-question, S-3, S-4, S-5) : un VRAI
// `ConsoleClientModel` sur un transport scripté qui enregistre chaque POST
// `/v1/cards/<id>/answer` et répond selon l'identifiant de question du corps,
// comme le Mac (S-1) : la question en vol accepte, toute autre refuse en 409.
// La relecture de l'ardoise est la fermeture `reread`, qui rend la carte relue.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsoleIOS

@MainActor
@Suite("reponse-ios-sans-identifiant-de-question — flux de réponse iOS")
struct IOSAnswerFlowTests {
    private static let cardId = "feature:abc:slug"

    private static let q1 = IOSAnswerQuestion(
        toolCallId: "call-1",
        question: "Quel format ?",
        options: [PanelAskOption(label: "A", description: nil), PanelAskOption(label: "B", description: nil)]
    )
    private static let q2 = IOSAnswerQuestion(
        toolCallId: "call-2",
        question: "Quelle base ?",
        options: [PanelAskOption(label: "B", description: nil), PanelAskOption(label: "C", description: nil)]
    )

    // --- fixtures --------------------------------------------------------------

    /// Une carte dont la question en vol est `question`, ou une carte au travail
    /// sans question quand `question` est nil.
    private static func card(asking question: IOSAnswerQuestion?) -> KanbanCard {
        let ask = question.map {
            PanelPendingAsk(toolCallId: $0.toolCallId, id: "ask-" + $0.toolCallId, question: $0.question, options: $0.options)
        }
        let run = KanbanCardRun(id: "r1", label: "depot/slug", inbox: "/box", pendingAsk: ask)
        return KanbanCard(
            id: cardId,
            column: ask == nil ? .enCours : .questionEnVol,
            repo: "depot",
            title: "slug",
            state: "attend",
            phase: nil,
            models: nil,
            prUrl: nil,
            startMs: 0,
            endMs: nil,
            marks: [],
            sources: [],
            action: KanbanCardAction(
                repoRoot: "/depot",
                repoKey: "abc",
                slug: "slug",
                waitKind: ask == nil ? nil : .answer,
                featureState: ask == nil ? .running : .waiting,
                run: run
            )
        )
    }

    /// Le Mac scripté : `inFlight` est l'identifiant de la question en vol (nil :
    /// aucune) ; un POST answer qui porte un autre identifiant est refusé en 409,
    /// avec le message de S-1. `badRequest` force un 400 sur tout POST answer.
    private static func mac(inFlight: String?, badRequest: Bool = false) -> ScriptedClientTransport {
        let changed = #"{"error":{"code":"conflict","message":"la question a changé depuis la demande"}}"#
        let noAsk = #"{"error":{"code":"conflict","message":"aucune question en vol"}}"#
        return ScriptedClientTransport { request in
            guard request.method == "POST", request.path.hasSuffix("/answer") else {
                return ClientDoubles.response(status: 404, json: #"{"error":{"code":"not_found","message":"route"}}"#)
            }
            if badRequest {
                return ClientDoubles.response(status: 400, json: #"{"error":{"code":"bad_request","message":"texte vide"}}"#)
            }
            guard let inFlight else { return ClientDoubles.response(status: 409, json: noAsk) }
            let sent = request.body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            guard sent?["toolCallId"] as? String == inFlight else {
                return ClientDoubles.response(status: 409, json: changed)
            }
            return ClientDoubles.response(status: 202, json: #"{"accepted":true}"#)
        }
    }

    /// La fermeture `send` d'une feuille : `client.answer` avec les kinds de la
    /// feuille (Accueil : `IOSHomeText`, Pipelines : `PipelinesAnswerKind`).
    private static func sender(
        _ client: ConsoleClientModel,
        selected: String,
        custom: String
    ) -> @MainActor (String, IOSAnswerChoice) async throws -> Void {
        { toolCallId, choice in
            switch choice {
            case .option(let label):
                _ = try await client.answer(cardId: cardId, kind: selected, label: label, text: nil, toolCallId: toolCallId)
            case .custom(let text):
                _ = try await client.answer(cardId: cardId, kind: custom, label: nil, text: text, toolCallId: toolCallId)
            }
        }
    }

    private static let homeKinds = (selected: IOSHomeText.kindSelected, custom: IOSHomeText.kindCustom)
    private static let pipelinesKinds = (
        selected: PipelinesAnswerKind.selected.rawValue,
        custom: PipelinesAnswerKind.custom.rawValue
    )

    /// Les corps décodés des POST answer enregistrés, dans l'ordre.
    private static func answerBodies(_ transport: ScriptedClientTransport) -> [[String: Any]] {
        transport.requests
            .filter { $0.method == "POST" && $0.path.hasSuffix("/answer") }
            .map { request in
                request.body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            }
    }

    private static func changedQuestion(_ outcome: IOSAnswerOutcome) -> IOSAnswerQuestion? {
        if case .questionChanged(let question) = outcome { return question }
        return nil
    }

    private static func isDelivered(_ outcome: IOSAnswerOutcome) -> Bool {
        if case .delivered = outcome { return true }
        return false
    }

    private static func isGone(_ outcome: IOSAnswerOutcome) -> Bool {
        if case .questionGone = outcome { return true }
        return false
    }

    private static func failure(_ outcome: IOSAnswerOutcome) -> (any Error)? {
        if case .failed(let error) = outcome { return error }
        return nil
    }

    // --- AC-5 ------------------------------------------------------------------

    @Test("reponse-ios-sans-identifiant-de-question/AC-5 : la réponse choisie et la réponse libre portent l'identifiant de la question affichée")
    func answerSendsShownQuestionId() async throws {
        for (sheet, kinds) in [("accueil", Self.homeKinds), ("pipelines", Self.pipelinesKinds)] {
            let transport = Self.mac(inFlight: "call-1")
            let client = ClientDoubles.model(transport: transport, address: "127.0.0.1:8787")
            let draft = IOSAnswerDraft(question: IOSAnswerQuestion(card: Self.card(asking: Self.q1)))
            let shown = try #require(draft.question, "la feuille \(sheet) affiche Q1")
            #expect(shown == Self.q1)

            for choice in [IOSAnswerChoice.option("A"), .custom("mon texte")] {
                let outcome = await IOSAnswerFlow.submit(
                    question: shown,
                    choice: choice,
                    send: Self.sender(client, selected: kinds.selected, custom: kinds.custom),
                    reread: { Issue.record("aucune relecture sur un envoi accepté"); return nil }
                )
                #expect(Self.isDelivered(outcome), "\(sheet) : \(choice) livrée")
            }

            let bodies = Self.answerBodies(transport)
            #expect(bodies.count == 2, "\(sheet) : une requête par envoi")
            #expect(bodies.map { $0["toolCallId"] as? String } == ["call-1", "call-1"], "\(sheet) : l'identifiant de Q1")
            #expect(bodies.map { $0["kind"] as? String } == [kinds.selected, kinds.custom])
            #expect(bodies.first?["label"] as? String == "A")
            #expect(bodies.last?["text"] as? String == "mon texte")
        }
    }

    // --- AC-6, AC-7, AC-8 ------------------------------------------------------

    /// Le scénario commun d'AC-6 et AC-7 : draft sur Q1 (option A, « mon texte »),
    /// Q2 en vol côté Mac, envoi refusé, relecture qui montre Q2.
    private func changedQuestionKeepsText(selected: String, custom: String) async throws
        -> (IOSAnswerDraft, ScriptedClientTransport, ConsoleClientModel)
    {
        let transport = Self.mac(inFlight: "call-2")
        let client = ClientDoubles.model(transport: transport, address: "127.0.0.1:8787")
        var draft = IOSAnswerDraft(question: IOSAnswerQuestion(card: Self.card(asking: Self.q1)))
        draft.text = "mon texte"
        draft.selectedOption = "A"
        let question = try #require(draft.question)
        let choice = try #require(draft.choice)
        #expect(choice == .option("A"))

        let outcome = await IOSAnswerFlow.submit(
            question: question,
            choice: choice,
            send: Self.sender(client, selected: selected, custom: custom),
            reread: { Self.card(asking: Self.q2) }
        )
        let next = try #require(Self.changedQuestion(outcome), "issue « question changée »")
        #expect(next == Self.q2)
        draft.adopt(next)

        #expect(draft.question == Self.q2)
        #expect(draft.text == "mon texte")
        #expect(draft.notice == IOSHomeText.answerQuestionChanged)
        #expect(draft.selectedOption == nil, "A n'existe pas dans Q2")
        let bodies = Self.answerBodies(transport)
        #expect(bodies.count == 1, "une seule requête, aucune vers Q2")
        #expect(bodies.first?["toolCallId"] as? String == "call-1")
        #expect(bodies.first?["kind"] as? String == selected)
        return (draft, transport, client)
    }

    @Test("reponse-ios-sans-identifiant-de-question/AC-6 : la feuille Répondre de l'Accueil reste sur la nouvelle question, texte conservé")
    func changedQuestionKeepsTextOnHome() async throws {
        _ = try await changedQuestionKeepsText(selected: Self.homeKinds.selected, custom: Self.homeKinds.custom)
        #expect(IOSHomeText.answerQuestionChanged
            == "La question a changé sur le Mac. Lisez la nouvelle question avant d’envoyer, votre texte est conservé.")
    }

    @Test("reponse-ios-sans-identifiant-de-question/AC-7 : la fiche Pipelines reste sur la nouvelle question, texte conservé")
    func changedQuestionKeepsTextOnPipelines() async throws {
        _ = try await changedQuestionKeepsText(selected: Self.pipelinesKinds.selected, custom: Self.pipelinesKinds.custom)
    }

    @Test("reponse-ios-sans-identifiant-de-question/AC-8 : le renvoi après refus part vers la nouvelle question et est livré")
    func resendAfterChangeTargetsNewQuestion() async throws {
        for kinds in [Self.homeKinds, Self.pipelinesKinds] {
            let (draft, transport, client) = try await changedQuestionKeepsText(selected: kinds.selected, custom: kinds.custom)
            let question = try #require(draft.question)
            let choice = try #require(draft.choice)
            #expect(choice == .custom("mon texte"))

            let outcome = await IOSAnswerFlow.submit(
                question: question,
                choice: choice,
                send: Self.sender(client, selected: kinds.selected, custom: kinds.custom),
                reread: { Issue.record("aucune relecture sur un envoi accepté"); return nil }
            )
            #expect(Self.isDelivered(outcome))
            let bodies = Self.answerBodies(transport)
            #expect(bodies.map { $0["toolCallId"] as? String } == ["call-1", "call-2"])
            #expect(bodies.last?["text"] as? String == "mon texte")
        }
    }

    // --- AC-9 ------------------------------------------------------------------

    @Test("reponse-ios-sans-identifiant-de-question/AC-9 : la question résolue sans remplaçante ferme la feuille avec un message")
    func goneQuestionClosesWithMessage() async throws {
        let rereads: [KanbanCard?] = [Self.card(asking: nil), nil]
        for relue in rereads {
            let transport = Self.mac(inFlight: nil)
            let client = ClientDoubles.model(transport: transport, address: "127.0.0.1:8787")
            let outcome = await IOSAnswerFlow.submit(
                question: Self.q1,
                choice: .custom("mon texte"),
                send: Self.sender(client, selected: Self.homeKinds.selected, custom: Self.homeKinds.custom),
                reread: { relue }
            )
            #expect(Self.isGone(outcome), "carte relue \(relue == nil ? "absente" : "sans question")")
            #expect(Self.answerBodies(transport).map { $0["toolCallId"] as? String } == ["call-1"])
        }
        #expect(IOSHomeText.answerQuestionGone == "Cette question n’attend plus de réponse.")
        #expect(IOSHomeText.answerNotSentTitle == "Réponse non envoyée")
    }

    // --- cas limites de S-4 et S-5 -----------------------------------------------

    @Test("reponse-ios-sans-identifiant-de-question : une relecture en échec garde la feuille sur Q1 (S-4)")
    func failedRereadKeepsQuestion() async throws {
        let transport = Self.mac(inFlight: "call-2")
        let client = ClientDoubles.model(transport: transport, address: "127.0.0.1:8787")
        let rereadError = ClientError.transport(.unreachable("relecture"))
        let outcome = await IOSAnswerFlow.submit(
            question: Self.q1,
            choice: .option("A"),
            send: Self.sender(client, selected: Self.homeKinds.selected, custom: Self.homeKinds.custom),
            reread: { throw rereadError }
        )
        let error = try #require(Self.failure(outcome))
        #expect(error as? ClientError == rereadError, "l'erreur rendue est celle de la relecture")
    }

    @Test("reponse-ios-sans-identifiant-de-question : un 400 échoue sans relecture (S-4)")
    func badRequestFailsWithoutReread() async throws {
        let transport = Self.mac(inFlight: "call-1", badRequest: true)
        let client = ClientDoubles.model(transport: transport, address: "127.0.0.1:8787")
        var rereads = 0
        let outcome = await IOSAnswerFlow.submit(
            question: Self.q1,
            choice: .custom("mon texte"),
            send: Self.sender(client, selected: Self.homeKinds.selected, custom: Self.homeKinds.custom),
            reread: { rereads += 1; return Self.card(asking: Self.q2) }
        )
        let error = try #require(Self.failure(outcome))
        #expect(error as? ClientError == .api(.badRequest("texte vide")))
        #expect(rereads == 0)
        #expect(transport.requests.map { "\($0.method) \($0.path)" }.allSatisfy { !$0.hasPrefix("GET") })
    }

    @Test("reponse-ios-sans-identifiant-de-question : un 409 dont la relecture montre encore Q1 est un échec (S-4)")
    func conflictOnSameQuestionFails() async throws {
        let transport = Self.mac(inFlight: "call-2")
        let client = ClientDoubles.model(transport: transport, address: "127.0.0.1:8787")
        let outcome = await IOSAnswerFlow.submit(
            question: Self.q1,
            choice: .option("A"),
            send: Self.sender(client, selected: Self.homeKinds.selected, custom: Self.homeKinds.custom),
            reread: { Self.card(asking: Self.q1) }
        )
        let error = try #require(Self.failure(outcome))
        #expect(error as? ClientError == .api(.conflict("la question a changé depuis la demande")))
    }

    @Test("reponse-ios-sans-identifiant-de-question : l'option choisie présente dans Q2 est conservée, le texte jamais vidé (S-4)")
    func adoptKeepsOptionPresentInNewQuestion() {
        var draft = IOSAnswerDraft(question: Self.q1)
        draft.selectedOption = "B"
        draft.text = "  "
        #expect(draft.choice == .option("B"))
        draft.adopt(Self.q2)
        #expect(draft.selectedOption == "B")
        #expect(draft.text == "  ")
        draft.selectedOption = nil
        #expect(draft.choice == nil, "un texte blanc n'est pas envoyable")
        draft.text = " mon texte "
        #expect(draft.choice == .custom(" mon texte "), "le texte part tel que saisi")
    }

    @Test("reponse-ios-sans-identifiant-de-question : seule une question à options est une question de la route answer (S-4, S-5)")
    func textQuestionIsNotAnAnswerQuestion() {
        #expect(IOSAnswerQuestion(card: nil) == nil)
        #expect(IOSAnswerQuestion(card: Self.card(asking: nil)) == nil)
        var textCard = Self.card(asking: nil)
        textCard.column = .questionEnVol
        textCard.action = KanbanCardAction(
            repoRoot: "/depot", repoKey: "abc", slug: "slug", waitKind: .answer, featureState: .waiting, run: nil
        )
        #expect(IOSAnswerQuestion(card: textCard) == nil, "question en texte")
        if case .questionGone = IOSAnswerFlow.outcome(after: ClientError.api(.conflict("x")), sent: "call-1", card: textCard) {
        } else {
            Issue.record("une question en texte compte comme « question partie »")
        }
        #expect(IOSAnswerFlow.isStale(ClientError.api(.notFound("carte inconnue"))))
        #expect(!IOSAnswerFlow.isStale(ClientError.api(.badRequest("x"))))
        #expect(!IOSAnswerFlow.isStale(ClientError.transport(.unreachable("x"))))
        #expect(!IOSAnswerFlow.isStale(ClientError.incompatibleProtocol(local: 1, remote: 2)))
    }
}
