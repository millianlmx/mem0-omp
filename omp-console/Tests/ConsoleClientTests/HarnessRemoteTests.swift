// La TÉLÉCOMMANDE côté client (contrat §6.1 et §6.2) : la notification `omp.answer` —
// sa charge (`omp.question`), ses actions, le routage vers la réponse à l'escalade et
// son exécution à la révision de la notification — et le jeton push-to-start des Live
// Activities (`POST /v1/push/activities/start`), sur la doublure de transport.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private func route(
    _ category: HarnessNotificationCategory, _ action: HarnessNotificationAction?, _ alert: HarnessPushAlert?, text: String? = nil
) -> HarnessNotificationGesture {
    HarnessNotificationRouting.gesture(category: category.rawValue, action: action, alert: alert, text: text, approver: false)
}

@Suite("Télécommande — client")
@MainActor
struct HarnessRemoteTests {
    @Test("la charge `omp.question` d'une alerte `omp.answer` se lit : identifiant, recommandation, options ; sans elle, l'alerte est celle d'avant")
    func payload() throws {
        let apns = try #require(
            try JSONSerialization.jsonObject(with: Data(#"""
            {"aps":{"alert":{"title":"Où stocker la date ?","body":"Recommandé : colonne"},"thread-id":"r1","category":"omp.answer"},
             "omp":{"kind":"escalation","runId":"r1","rev":7,"question":{"id":12,"recommended":"colonne","options":["colonne","table"]}}}
            """#.utf8)) as? [AnyHashable: Any]
        )
        let alert = try #require(HarnessPushAlert(userInfo: apns))
        #expect(alert == HarnessPushAlert(
            kind: .escalation, runId: "r1", rev: 7, question: HarnessPushQuestion(id: 12, recommended: "colonne", options: ["colonne", "table"])
        ))
        #expect(HarnessPushAlert(userInfo: alert.userInfo) == alert, "une notification locale porte la même charge")

        let plain = HarnessPushAlert(userInfo: ["omp": ["kind": "escalation", "runId": "r1", "rev": 7]])
        #expect(plain == HarnessPushAlert(kind: .escalation, runId: "r1", rev: 7))
        #expect(plain?.question == nil)
        // Une question sans identifiant ni recommandation n'en est pas une : rien à répondre d'ici.
        let broken = HarnessPushAlert(userInfo: ["omp": ["kind": "escalation", "runId": "r1", "question": ["options": ["a"]]]])
        #expect(broken?.question == nil)
    }

    @Test("la catégorie `omp.answer` offre « prendre la recommandation » et « répondre » (saisie), appareil déverrouillé, sans ouvrir l'app ; aucun libellé n'est vide")
    func actions() {
        let specs = HarnessNotificationRouting.actions(for: .answer, approver: false)
        #expect(specs.map(\.action) == [.takeRecommended, .answer, .open])
        #expect(specs[0].authenticationRequired && !specs[0].foreground && !specs[0].textInput && !specs[0].destructive)
        #expect(specs[1].authenticationRequired && !specs[1].foreground && specs[1].textInput)
        #expect(specs[1].placeholder == PipelineServerText.answerPlaceholder)
        #expect(specs[1].title == PipelineServerText.answer)
        #expect(specs[2].foreground && !specs[2].authenticationRequired)
        #expect(HarnessNotificationAction.allCases.allSatisfy { !$0.title.isEmpty })
        #expect(HarnessNotificationCategory.answer.rawValue == "omp.answer")
        #expect(HarnessNotificationAction.takeRecommended.rawValue == "omp.action.takeRecommended")
        #expect(HarnessNotificationAction.answer.rawValue == "omp.action.answer")
        // Le refus de specs garde son invite ; une action sans champ n'en a pas.
        let validate = HarnessNotificationRouting.actions(for: .validate, approver: false)
        #expect(validate[1].placeholder == NotificationText.refusePlaceholder && validate[0].placeholder == nil)
    }

    @Test("une action `omp.answer` devient la réponse à l'escalade, à la révision de la notification ; hors de sa catégorie, sans question ou sans texte, elle ouvre « À trancher »")
    func routing() {
        let question = HarnessPushQuestion(id: 12, recommended: "colonne", options: ["colonne", "table"])
        let alert = HarnessPushAlert(kind: .escalation, runId: "r1", rev: 7, question: question)
        let open = HarnessNotificationGesture.open(.inbox(.toDecide))

        #expect(route(.answer, .takeRecommended, alert) == .answer(runId: "r1", rev: 7, question: 12, answer: "colonne"))
        #expect(route(.answer, .answer, alert, text: "  une table à part  ") == .answer(runId: "r1", rev: 7, question: 12, answer: "une table à part"))
        #expect(route(.answer, .answer, alert, text: " \n") == open, "une réponse vide ouvre l'app")
        #expect(route(.answer, .answer, alert) == open)
        #expect(route(.answer, nil, alert) == open, "un toucher ouvre la question")
        #expect(route(.answer, .open, alert) == open)

        // Une charge incomplète ou forgée n'agit pas.
        #expect(route(.answer, .takeRecommended, HarnessPushAlert(kind: .escalation, runId: "r1", rev: 7)) == open)
        #expect(route(.answer, .takeRecommended, HarnessPushAlert(kind: .escalation, rev: 7, question: question)) == open)
        #expect(route(.answer, .takeRecommended, HarnessPushAlert(kind: .escalation, runId: "r1", question: HarnessPushQuestion(id: 12, recommended: ""))) == open)
        #expect(route(.open, .takeRecommended, alert) == open, "hors de la catégorie `omp.answer`")
        #expect(route(.validate, .answer, alert, text: "oui") == open)
        #expect(route(.answer, .takeRecommended, HarnessPushAlert(kind: .specs, runId: "r1", rev: 7, question: question)) == .open(.inbox(.specs)))
        // Les autres catégories ne répondent pas à une question.
        #expect(route(.answer, .validate, alert) == open)
    }

    @Test("la réponse part vers les escalades de la feature avec l'If-Match de la notification, et seulement la question visée")
    func execute() async throws {
        let transport = osTransport(routes: ["POST /v1/runs/r1/escalations": osJSON(#"{"run":"# + osRunJSON("r1") + "}")])
        let model = await osConnected(transport)

        #expect(await model.execute(.answer(runId: "r1", rev: 7, question: 12, answer: "colonne")))
        let call = try #require(transport.last("POST", "/v1/runs/r1/escalations"))
        #expect(call.headers["If-Match"] == "\"7\"", "la révision de la notification, pas celle de la boîte")
        let answers = try #require(transport.body("POST", "/v1/runs/r1/escalations")?["answers"] as? [[String: Any]])
        #expect(answers.count == 1)
        #expect(answers[0]["id"] as? Int == 12 && answers[0]["answer"] as? String == "colonne")
        #expect(answers[0]["always"] == nil && answers[0]["reason"] == nil)

        // Sans révision dans la notification : celle que l'app connaît.
        #expect(await model.execute(.answer(runId: "r1", rev: nil, question: 12, answer: "table")))
        #expect(transport.last("POST", "/v1/runs/r1/escalations")?.headers["If-Match"] == "\"4\"")
    }

    @Test("une feature qui a bougé depuis la notification refuse la réponse (412) : rien n'est tranché, l'échec le dit")
    func staleAnswer() async {
        let transport = osTransport(routes: ["POST /v1/runs/r1/escalations": osJSON(#"{"error":"périmé"}"#, status: 412)])
        let model = await osConnected(transport)
        #expect(await model.execute(.answer(runId: "r1", rev: 3, question: 12, answer: "colonne")) == false)
        #expect(model.failure == .stale)
    }

    @Test("le jeton push-to-start s'enregistre au serveur relié avec sa passerelle, le suit sur un autre serveur, et quitte le serveur oublié")
    func activityStart() async throws {
        let transport = osTransport { call in
            switch (call.method, call.path) {
            case ("POST", "/v1/push/activities/start"): osJSON(#"{"registered":true,"pushes":true}"#, status: 201)
            case ("DELETE", _) where call.path.hasPrefix("/v1/push/activities/start/"): osJSON(#"{"removed":true}"#)
            default: nil
            }
        }
        let model = HarnessModel(
            transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(),
            retryDelay: .seconds(3600), refreshDelay: .milliseconds(1), reporter: .off
        )
        // Pas encore de serveur : le jeton est retenu, rien ne part.
        #expect(await model.registerActivityStart(token: "ab12", environment: .sandbox) == false)
        #expect(transport.calls.isEmpty)

        _ = await model.configure(address: "vps.example", token: "t")
        let body = try #require(transport.body("POST", "/v1/push/activities/start"))
        #expect(body["token"] as? String == "ab12")
        #expect(body["environment"] as? String == "development")
        #expect(Set(body.keys) == ["token", "environment"])

        #expect(await model.registerActivityStart(token: "cd34", environment: .production))
        #expect(transport.body("POST", "/v1/push/activities/start")?["environment"] as? String == "production")
        #expect(transport.last("DELETE", "/v1/push/activities/start/ab12") != nil, "un jeton renouvelé remplace l'ancien")

        _ = await model.configure(address: "autre.example", token: "t")
        let moves = transport.calls.filter { $0.path.hasPrefix("/v1/push/activities/start") }.suffix(2)
        #expect(moves.map(\.method) == ["DELETE", "POST"], "l'ancien serveur oublie le jeton, le nouveau l'apprend")
        #expect(moves.first?.path == "/v1/push/activities/start/cd34")

        await model.unregisterActivityStart()
        #expect(transport.calls.last?.method == "DELETE" && transport.calls.last?.path == "/v1/push/activities/start/cd34")
        let before = transport.calls.filter { $0.path.hasPrefix("/v1/push/activities/start") }.count
        await model.forget()
        #expect(transport.calls.filter { $0.path.hasPrefix("/v1/push/activities/start") }.count == before, "un jeton retiré ne repart plus")
        #expect(HarnessPushEnvironment.sandbox.apnsName == "development" && HarnessPushEnvironment.production.apnsName == "production")
    }

    @Test("un serveur sans push-to-start (404) : l'enregistrement rend faux, sans échec affiché")
    func activityStartOnOlderServer() async {
        let model = await osConnected(osTransport(routes: [:]))
        #expect(await model.registerActivityStart(token: "ab12", environment: .production) == false)
        #expect(model.failure == nil)

        // Un serveur sans APNs prend le jeton mais ne poussera rien : l'app le sait.
        let mute = await osConnected(osTransport(routes: ["POST /v1/push/activities/start": osJSON(#"{"registered":true,"pushes":false}"#)]))
        #expect(await mute.registerActivityStart(token: "ab12", environment: .production) == false)
    }
}
