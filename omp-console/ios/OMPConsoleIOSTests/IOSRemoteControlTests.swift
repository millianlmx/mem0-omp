// Les preuves Swift de la télécommande hors de l'app, vue de l'app iOS : les gestes de
// la notification d'une question, les liens `ompconsole://`, le choix de la Live
// Activity démarrée seule, et la Demande que l'extension de partage pose. La logique
// vit dans ConsoleClient ; ces tests la lisent avec les mots français de l'app.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsoleIOS

@Suite("télécommande iOS — notification, liens, Live Activity, partage")
struct IOSRemoteControlTests {
    @Test("la notification d'une question unique offre « Prendre la recommandation » et « Répondre… » ; la toucher ouvre le fil")
    func answerNotificationOffersItsGestures() {
        let actions = HarnessNotificationRouting.actions(for: .answer, approver: false)
        #expect(actions.map(\.title) == ["Prendre la recommandation", "Répondre…", "Ouvrir"])
        #expect(actions[1].textInput && actions[1].submitTitle == "Répondre" && actions[1].placeholder == "Votre réponse")
        #expect(actions.prefix(2).allSatisfy { $0.authenticationRequired && !$0.foreground }, "répondre exige l'appareil déverrouillé")

        let alert = HarnessPushAlert(kind: .escalation, runId: "r1", rev: 7, question: HarnessPushQuestion(id: 12, recommended: "colonne"))
        let category = HarnessNotificationCategory.answer.rawValue
        #expect(HarnessNotificationRouting.gesture(category: category, action: .takeRecommended, alert: alert, text: nil, approver: false)
            == .answer(runId: "r1", rev: 7, question: 12, answer: "colonne"))
        #expect(HarnessNotificationRouting.gesture(category: category, action: nil, alert: alert, text: nil, approver: false) == .open(.run("r1")))
    }

    @Test("un lien ouvre le fil d'une feature, le tri des décisions ou l'accueil ; un lien inconnu n'ouvre rien")
    func linksOpenThreadsDecisionsAndNow() {
        #expect(HarnessWidgetLink.destination(of: HarnessWidgetLink.url(thread: "r1"))?.command == .run("r1"))
        #expect(HarnessWidgetLink.destination(of: HarnessWidgetLink.decisions)?.command == .inbox(.toDecide))
        #expect(HarnessWidgetLink.destination(of: HarnessWidgetLink.now)?.command == .section(.inbox))
        #expect(HarnessWidgetLink.destination(of: HarnessWidgetLink.url(.workstation))?.command == .section(.workstation))
        #expect(HarnessWidgetLink.destination(of: URL(fileURLWithPath: "/threads/r1")) == nil)
    }

    @Test("sans push-to-start, l'activité qui démarre seule est celle de la feature qui attend l'humain, sinon celle qui travaille ; une seule à la fois")
    func theMostUrgentActivityStartsAlone() {
        func run(_ id: String, _ state: String, step: String = "impl") -> HarnessRun {
            HarnessRun(id: id, repo: "demo", slug: id, title: id, request: id, state: state, step: step)
        }
        let inbox = HarnessInbox(runs: [run("travail", "running"), run("revue", "awaiting_human", step: "review"), run("file", "queued")])
        #expect(HarnessActivityStart.candidate(inbox: inbox, running: [])?.id == "revue")
        #expect(HarnessActivityStart.candidate(inbox: inbox, running: [], declined: ["revue"])?.id == "travail")
        #expect(HarnessActivityStart.candidate(inbox: inbox, running: ["travail"]) == nil)
        #expect(HarnessActivityState(run: run("revue", "awaiting_human", step: "review"), inbox: inbox).awaitsReview, "« Valider » s'offre sur une revue qui attend")
        #expect(!HarnessActivityState(run: run("travail", "running"), inbox: inbox).awaitsReview)
    }

    @Test("une page partagée sans consigne devient « Traiter cette page : <titre> », avec la page en contexte ; une consigne la remplace")
    func aSharedPageBecomesARequest() {
        // L'adresse est normalisée par le client : aucune adresse n'est écrite en dur dans la coque iOS.
        let page = HarnessModel.normalizedAddress("example.com/article") ?? ""
        let draft = HarnessShareDraft(url: page, title: "Un article")
        #expect(draft.request(instruction: "", pageRequest: OSRemoteText.sharePage) == "Traiter cette page : Un article")
        #expect(draft.request(instruction: "résume-le", pageRequest: OSRemoteText.sharePage) == "résume-le")
        #expect(draft.context(instruction: "") == HarnessIntakeContext(url: page, title: "Un article"))
        #expect(draft.url?.hasSuffix("example.com/article") == true)
        #expect(HarnessShareDraft().isEmpty)
    }
}
