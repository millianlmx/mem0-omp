// Les preuves de la conversation Siri « demandes en attente » de l'iPhone
// (siri-iphone-questions-en-attente, S-8) : un vrai `ConsoleClientModel` sur un
// Mac scripté (`ScriptedClientTransport`) qui sert `/v1/store`, `/v1/conduite` et
// `/v1/session` et accepte chaque réponse, face à une conversation scriptée qui
// enregistre chaque dialogue `ask`/`confirm` et rejoue des réponses. Les attendus
// sont construits par les fonctions publiques du noyau vocal (`VoiceSpeechText`,
// `VoicePendingSummary`, `VoiceIssue`, `VoiceAnswerMatcher`), jamais par un
// littéral recopié. AC-8 est la recette manuelle sur iPhone réel du README.
//
// Le Mac scripté, la conversation scriptée et leurs outils vivent dans
// `IOSSiriMacDoubles.swift`.

import AppIntents
import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsoleIOS

// MARK: - Outils

private let labelsABC = ["A", "B", "C"]

/// Les réponses dites qui désignent une option de A, B, C (AC-4).
private let designations = ["la deuxième", "2", "la dernière", "b"]

/// La liste que le Mac sert dans `state`, lue par un client à part : la source
/// des attendus (`VoicePendingSummary.item`, `subject`).
@MainActor
private func listed(_ state: MacState) async throws -> [PendingRequest] {
    try await connect(state).client.pendingRequests()
}

/// Les phrases non vides séparées d'une espace : ce que Siri dit d'une traite.
private func joined(_ phrases: [String]) -> String {
    phrases.filter { !$0.isEmpty }.joined(separator: " ")
}

/// La route de réponse d'un dialogue de la conduite (`conduite`) ou de la
/// session hébergée (`session`).
private func dialogPath(_ source: String, _ id: String) -> String {
    "/v1/\(source)/dialogs/\(encoded(id))"
}

/// La question en vol de `f-question` sur A, B, C (identifiant `call-1`).
private let questionABC = MacState().asking(
    "f-question", run: "aaaaaaaaaaaaaaa1", at: PendingJSON.at(4),
    toolCallId: "call-1", question: "Quelle option ?", labels: labelsABC
)

// MARK: - Les preuves

@Suite("IOSSiriPendingTests")
@MainActor
struct IOSSiriPendingTests {
    @Test("siri-iphone-questions-en-attente/AC-1 : 3 demandes d'âges différents → « 3 demandes en attente » puis la plus ancienne")
    func announcesCountThenOldest() async throws {
        let state = MacState()
            .asking("f-question", run: "aaaaaaaaaaaaaaa1", at: PendingJSON.at(4), toolCallId: "call-1", question: "On garde le cache ?", labels: ["Le garder", "Le vider"])
            .milestone("f-specs", "specs", at: PendingJSON.at(6))
            .sessionDialog("dlg-2", method: "input", title: "Quel nom pour la session ?", at: PendingJSON.at(1))
        let list = try await listed(state)
        try #require(list.count == 3)
        #expect(list.map(\.at) == list.map(\.at).sorted(), "la liste est rangée de la plus ancienne à la plus récente")
        let oldest = try #require(list.min { $0.at < $1.at })
        #expect(oldest.nature == .sessionDialog)

        let (client, _) = connect(state)
        let conversation = ScriptedConversation()
        await #expect(throws: Abandoned.self) {
            _ = try await IOSSiriPending.walk(client: client, conversation: conversation)
        }
        let first = try #require(conversation.dialogs.first)
        #expect(first.hasPrefix(VoiceSpeechText.walkCount(3)))
        #expect(first == joined([
            VoiceSpeechText.walkCount(3),
            VoiceSpeechText.walkFirst(VoicePendingSummary.item(oldest)),
            VoiceSpeechText.dictate,
        ]))
    }

    @Test("siri-iphone-questions-en-attente/AC-2 : chaque phrase d'App Shortcut porte le nom de l'app, et « Demandes en attente » a ses 4 phrases françaises")
    func shortcutPhrasesCarryTheAppName() throws {
        let url = try #require(Bundle.main.url(forResource: "extract", withExtension: "actionsdata", subdirectory: "Metadata.appintents"))
        let json = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let shortcuts = try #require(json["autoShortcuts"] as? [[String: Any]])
        #expect(!shortcuts.isEmpty)

        func keys(_ shortcut: [String: Any]) -> [String] {
            (shortcut["phraseTemplates"] as? [[String: Any]] ?? []).compactMap { $0["key"] as? String }
        }
        for shortcut in shortcuts {
            for key in keys(shortcut) {
                #expect(key.contains("${applicationName}"), "« \(key) » ne nomme pas l'app")
            }
        }
        let pending = try #require(shortcuts.first { ($0["shortTitle"] as? [String: Any])?["key"] as? String == "Demandes en attente" })
        #expect(pending["actionIdentifier"] as? String == String(describing: IOSPendingRequestsIntent.self))
        #expect(keys(pending) == [
            "Demandes en attente dans ${applicationName}",
            "Questions en attente dans ${applicationName}",
            "Répondre aux questions de ${applicationName}",
            "Ce qui attend dans ${applicationName}",
        ])
    }

    @Test("siri-iphone-questions-en-attente/AC-3 : une demande de chaque nature est comptée, présentée et répondue")
    func everyNatureIsCountedAndPresented() async throws {
        let state = MacState()
            .sessionDialog("dlg-2", method: "confirm", title: "Arrêter la session ?", at: PendingJSON.at(1))
            .milestone("f-review", "review", at: PendingJSON.at(2))
            .escalation("f-audit", question: "Faut-il journaliser les erreurs ?", labels: ["Oui", "Non"], at: PendingJSON.at(3))
            .asking("f-question", run: "aaaaaaaaaaaaaaa1", at: PendingJSON.at(4), toolCallId: "call-1", question: "On garde le cache ?", labels: ["Le garder", "Le vider"])
            .conduiteDialog("dlg-1", method: "select", title: "Quelle feature d'abord ?", options: ["f-specs", "f-review"], at: PendingJSON.at(5))
            .milestone("f-specs", "specs", at: PendingJSON.at(6))
            .textQuestion("f-texte", prompt: "Que faire du cache ?", at: PendingJSON.at(7))
        let list = try await listed(state)
        #expect(list.map(\.nature) == [
            .sessionDialog, .milestoneReview, .auditEscalation, .question, .conduiteDialog, .milestoneSpecs, .question,
        ])
        #expect(list.map(\.reply).contains(.cardAnswer(cardId: PendingJSON.cardId("f-question"), toolCallId: "call-1")))
        #expect(list.map(\.reply).contains(.cardReply(cardId: PendingJSON.cardId("f-texte"))))

        let (client, transport) = connect(state)
        // Session « oui », escalade « oui », question en vol, conduite, texte libre ;
        // deux jalons confirmés et six « Passer à la suivante ? » acceptés.
        let conversation = ScriptedConversation(
            answers: ["oui", "oui", "le garder", "la première", "Il faut garder le cache."],
            confirmations: Array(repeating: true, count: 8)
        )
        let result = try await IOSSiriPending.walk(client: client, conversation: conversation)

        #expect(conversation.dialogs.first?.hasPrefix(VoiceSpeechText.walkCount(7)) == true)
        let said = joined(conversation.dialogs + [result])
        for request in list {
            #expect(said.contains(VoicePendingSummary.item(request)), "« \(VoicePendingSummary.item(request)) » jamais présentée")
        }
        #expect(result.hasSuffix(VoiceSpeechText.noPending))
        #expect(posts(transport.requests).map(\.path) == [
            dialogPath("session", "dlg-2"),
            cardPath("f-review", "verdict"),
            "/v1/audits/\(encoded(PendingJSON.auditId))/escalations",
            cardPath("f-question", "answer"),
            dialogPath("conduite", "dlg-1"),
            cardPath("f-specs", "verdict"),
            cardPath("f-texte", "reply"),
        ])
    }

    @Test("siri-iphone-questions-en-attente/AC-4 : « la deuxième », « 2 », « la dernière », « b » livrent l'option que retient le noyau", arguments: designations)
    func spokenDesignationPicksTheMatcherOption(_ spoken: String) async throws {
        let options = labelsABC.map { PanelAskOption(label: $0, description: nil) }
        guard case let .option(_, label) = VoiceAnswerMatcher.match(spoken, options: options, acceptsFreeText: false) else {
            Issue.record("« \(spoken) » ne désigne aucune option pour le noyau")
            return
        }
        let (client, transport) = connect(questionABC)
        _ = try await IOSSiriPending.walk(client: client, conversation: ScriptedConversation(answers: [spoken]))
        let sent = posts(transport.requests)
        #expect(sent.count == 1)
        #expect(sent.first.map(body)?["label"] as? String == label)
    }

    @Test("siri-iphone-questions-en-attente/AC-4 : une réponse qui ne désigne aucune option fait redemander sans rien envoyer")
    func unknownDesignationAsksAgain() async throws {
        let options = labelsABC.map { PanelAskOption(label: $0, description: nil) }
        guard case let .notFound(prompt) = VoiceAnswerMatcher.match("la quatrième", options: options, acceptsFreeText: false) else {
            Issue.record("« la quatrième » ne doit désigner aucune option")
            return
        }
        let (client, transport) = connect(questionABC)
        let conversation = ScriptedConversation(answers: ["la quatrième"])
        await #expect(throws: Abandoned.self) {
            _ = try await IOSSiriPending.walk(client: client, conversation: conversation)
        }
        #expect(conversation.asks.count == 2, "la question est redemandée")
        #expect(conversation.asks.last?.hasPrefix(prompt) == true)
        #expect(posts(transport.requests).isEmpty)
    }

    @Test("siri-iphone-questions-en-attente/AC-5 : « autre réponse » puis un texte dicté envoie ce texte en réponse libre")
    func otherAnswerSendsTheDictatedText() async throws {
        let dictated = "On verra plus tard"
        guard case let .freeText(text) = VoiceAnswerMatcher.match(dictated, options: [], acceptsFreeText: true) else {
            Issue.record("le noyau doit accepter ce texte libre")
            return
        }
        let (client, transport) = connect(questionABC)
        let conversation = ScriptedConversation(answers: [VoiceSpeechText.otherAnswer, dictated])
        _ = try await IOSSiriPending.walk(client: client, conversation: conversation)

        #expect(conversation.asks.first?.contains(VoiceSpeechText.otherAnswerOffer) == true, "« autre réponse » est proposée")
        #expect(conversation.asks.dropFirst().first == VoiceSpeechText.dictate)
        let sent = posts(transport.requests)
        #expect(sent.count == 1)
        let payload = sent.first.map(body) ?? [:]
        #expect(payload["kind"] as? String == IOSHomeText.kindCustom)
        #expect(payload["text"] as? String == text)
        #expect(payload["toolCallId"] as? String == "call-1")
    }

    @Test("siri-iphone-questions-en-attente/AC-5 : une demande sans texte libre ne propose pas « autre réponse », qui fait redemander sans rien envoyer")
    func noFreeTextNoOtherAnswer() async throws {
        let labels = ["f-specs", "f-review"]
        let state = MacState().conduiteDialog("dlg-1", method: "select", title: "Quelle feature d'abord ?", options: labels, at: PendingJSON.at(1))
        let options = labels.map { PanelAskOption(label: $0, description: nil) }
        guard case let .notFound(prompt) = VoiceAnswerMatcher.match(VoiceSpeechText.otherAnswer, options: options, acceptsFreeText: false) else {
            Issue.record("« autre réponse » ne doit désigner aucune option")
            return
        }
        let (client, transport) = connect(state)
        let conversation = ScriptedConversation(answers: [VoiceSpeechText.otherAnswer])
        await #expect(throws: Abandoned.self) {
            _ = try await IOSSiriPending.walk(client: client, conversation: conversation)
        }
        #expect(conversation.asks.count == 2)
        #expect(conversation.asks.allSatisfy { !$0.contains(VoiceSpeechText.otherAnswerOffer) })
        #expect(conversation.asks.last?.hasPrefix(prompt) == true)
        #expect(posts(transport.requests).isEmpty)
    }

    @Test("siri-iphone-questions-en-attente/AC-6 : la première répondue, Siri propose la suivante ; « oui » la présente, « non » termine sans autre envoi")
    func offersTheNextOne() async throws {
        let state = MacState()
            .asking("f-question", run: "aaaaaaaaaaaaaaa1", at: PendingJSON.at(1), toolCallId: "call-1", question: "Quelle option ?", labels: labelsABC)
            .conduiteDialog("dlg-1", method: "select", title: "Quelle feature d'abord ?", options: ["f-specs", "f-review"], at: PendingJSON.at(2))
        let second = try #require(try await listed(state).last)

        // « non » : une seule réponse envoyée, la conversation s'arrête.
        let (stopClient, stopTransport) = connect(state)
        let stopped = ScriptedConversation(answers: ["a"], confirmations: [false])
        let result = try await IOSSiriPending.walk(client: stopClient, conversation: stopped)
        #expect(stopped.confirms.count == 1)
        #expect(stopped.confirms.first?.hasSuffix(VoiceSpeechText.nextPrompt) == true)
        #expect(result == VoiceSpeechText.walkStopped)
        #expect(posts(stopTransport.requests).count == 1)

        // « oui » : la seconde est présentée par « La suivante : … ».
        let (client, transport) = connect(state)
        let accepted = ScriptedConversation(answers: ["a", "la première"], confirmations: [true])
        _ = try await IOSSiriPending.walk(client: client, conversation: accepted)
        #expect(accepted.asks.count == 2)
        #expect(accepted.asks.last?.hasPrefix(VoiceSpeechText.walkNext(VoicePendingSummary.item(second))) == true)
        #expect(posts(transport.requests).map(\.path) == [cardPath("f-question", "answer"), dialogPath("conduite", "dlg-1")])
    }

    @Test("siri-iphone-questions-en-attente/AC-7 : une réponse à la question X part en UNE requête vers la route de réponse, porteuse de X et du libellé choisi")
    func answerCarriesTheQuestionId() async throws {
        let state = MacState().asking(
            "f-question", run: "aaaaaaaaaaaaaaa1", at: PendingJSON.at(1), toolCallId: "call-x", question: "Quelle option ?", labels: labelsABC
        )
        let (client, transport) = connect(state)
        _ = try await IOSSiriPending.walk(client: client, conversation: ScriptedConversation(answers: ["la deuxième"]))
        let sent = posts(transport.requests)
        try #require(sent.count == 1)
        #expect(sent[0].path == cardPath("f-question", "answer"))
        let payload = body(sent[0])
        #expect(payload["toolCallId"] as? String == "call-x")
        #expect(payload["kind"] as? String == IOSHomeText.kindSelected)
        #expect(payload["label"] as? String == "B")
    }

    @Test("siri-iphone-questions-en-attente/AC-9 : un jalon specs est relu et rien ne part sans « oui » ; une question à options part sans confirmation")
    func confirmationFollowsThePolicy() async throws {
        let state = MacState().milestone("f-specs", "specs", at: PendingJSON.at(1))
        let request = try #require(try await listed(state).first)
        let subject = try #require(request.subject)
        let confirmation = try #require(VoiceGestureText.confirmation(for: .validateSpecs, target: subject))
        let expectedDialog = joined([
            VoiceSpeechText.walkCount(1),
            VoiceSpeechText.walkFirst(VoicePendingSummary.item(request)),
            confirmation,
        ])

        // Refus : rien n'est envoyé.
        let (refusedClient, refusedTransport) = connect(state)
        let refused = ScriptedConversation(confirmations: [false])
        _ = try await IOSSiriPending.walk(client: refusedClient, conversation: refused)
        #expect(refused.asks.isEmpty)
        #expect(refused.confirms == [expectedDialog])
        #expect(posts(refusedTransport.requests).isEmpty)

        // Acceptation : un seul verdict « specs ».
        let (client, transport) = connect(state)
        let accepted = ScriptedConversation(confirmations: [true])
        _ = try await IOSSiriPending.walk(client: client, conversation: accepted)
        #expect(accepted.confirms == [expectedDialog])
        let sent = posts(transport.requests)
        #expect(sent.map(\.path) == [cardPath("f-specs", "verdict")])
        #expect(sent.first.map(body)?["verdict"] as? String == IOSHomeText.verdictSpecs)

        // Une question à options : aucune confirmation avant l'envoi.
        let (askClient, askTransport) = connect(questionABC)
        let asked = ScriptedConversation(answers: ["a"])
        _ = try await IOSSiriPending.walk(client: askClient, conversation: asked)
        #expect(asked.confirms.isEmpty)
        #expect(posts(askTransport.requests).count == 1)
    }

    @Test("siri-iphone-questions-en-attente/AC-10 : la politique littérale de l'intent est celle que la table exige pour chacun de ses gestes")
    func intentPolicyMatchesTheTable() {
        #expect(VoiceGesturePolicy.admits(IOSPendingRequestsIntent.authenticationPolicy, for: VoicePendingWalk.gestures, on: .ios))
        #expect(!VoiceGesturePolicy.admits(.requiresAuthentication, for: VoicePendingWalk.gestures, on: .ios))
        #expect(!VoiceGesturePolicy.admits(.alwaysAllowed, for: VoicePendingWalk.gestures, on: .ios))
    }

    @Test("siri-iphone-questions-en-attente/AC-11 : un dialogue « editor » est compté, signalé « à traiter dans l'app », sans réponse demandée ni envoi")
    func editorDialogIsAppOnly() async throws {
        let state = MacState()
            .conduiteDialog("dlg-1", method: "editor", title: "Corrigez le plan", at: PendingJSON.at(1))
            .asking("f-question", run: "aaaaaaaaaaaaaaa1", at: PendingJSON.at(4), toolCallId: "call-1", question: "Quelle option ?", labels: labelsABC)
        let editor = try #require(try await listed(state).first)
        #expect(editor.reply == .conduiteDialog(dialogId: "dlg-1", method: .editor))

        let (client, transport) = connect(state)
        let conversation = ScriptedConversation(confirmations: [false])
        let result = try await IOSSiriPending.walk(client: client, conversation: conversation)
        #expect(conversation.asks.isEmpty, "aucune réponse demandée")
        #expect(conversation.confirms == [joined([
            VoiceSpeechText.walkCount(2),
            VoiceSpeechText.walkFirst(VoicePendingSummary.item(editor)),
            VoiceSpeechText.appOnly,
            VoiceSpeechText.nextPrompt,
        ])])
        #expect(result == VoiceSpeechText.walkStopped)
        #expect(posts(transport.requests).isEmpty)
    }

    @Test("siri-iphone-questions-en-attente/AC-12 : X remplacée par Y pendant la dictée → rien sur X, « la question a changé », Y relue et redemandée")
    func replacedQuestionIsReadAgain() async throws {
        let stateX = questionABC
        let stateY = MacState().asking(
            "f-question", run: "aaaaaaaaaaaaaaa1", at: PendingJSON.at(5), toolCallId: "call-2", question: "Et maintenant ?", labels: labelsABC
        )
        let questionY = try #require(try await listed(stateY).first)

        let (client, transport) = connect(stateX, stateY)
        let conversation = ScriptedConversation(answers: ["a", "b"])
        _ = try await IOSSiriPending.walk(client: client, conversation: conversation)

        let sent = posts(transport.requests)
        #expect(sent.allSatisfy { body($0)["toolCallId"] as? String != "call-1" }, "rien n'est envoyé sur X")
        #expect(conversation.asks.count == 2)
        let again = conversation.asks.last ?? ""
        #expect(again.contains(VoiceIssue.staleQuestion.phrase))
        #expect(again.contains(VoiceSpeechText.walkReplaced(VoicePendingSummary.item(questionY))))
        #expect(sent.count == 1)
        #expect(sent.first.map(body)?["toolCallId"] as? String == "call-2")
        #expect(sent.first.map(body)?["label"] as? String == "B")
    }

    @Test("siri-iphone-questions-en-attente/AC-13 : une demande répondue ailleurs → rien n'est envoyé, « la question a changé », puis la suivante ou plus rien")
    func answeredElsewhereMovesOn() async throws {
        // Seule demande : la conversation finit sur « Aucune demande ne vous attend. »
        let (client, transport) = connect(questionABC, MacState())
        let alone = ScriptedConversation(answers: ["a"])
        let result = try await IOSSiriPending.walk(client: client, conversation: alone)
        #expect(result == joined([VoiceIssue.staleQuestion.phrase, VoiceSpeechText.noPending]))
        #expect(posts(transport.requests).isEmpty)

        // Une autre demande reste : Siri propose de passer à la suivante.
        let other = MacState().sessionDialog("dlg-2", method: "input", title: "Quel nom ?", at: PendingJSON.at(6))
        var both = questionABC
        both.session = other.session
        let (nextClient, nextTransport) = connect(both, other)
        let followed = ScriptedConversation(answers: ["a"], confirmations: [false])
        _ = try await IOSSiriPending.walk(client: nextClient, conversation: followed)
        #expect(followed.confirms == [joined([VoiceIssue.staleQuestion.phrase, VoiceSpeechText.nextPrompt])])
        #expect(posts(nextTransport.requests).isEmpty)
    }

    @Test("siri-iphone-questions-en-attente/AC-14 : non appairé, Mac injoignable, version incompatible, iPhone verrouillé → 4 phrases distinctes du noyau, rien d'envoyé, app fermée")
    func connectionCausesHaveDistinctPhrases() async throws {
        let local = ConsoleAPI.protocolVersion
        let mac = PendingMac([questionABC])

        // iPhone verrouillé : le client n'est pas touché.
        let lockedTransport = ScriptedClientTransport { mac.respond($0) }
        let locked = try await IOSSiriPending.answer(
            client: ClientDoubles.model(transport: lockedTransport, address: macAddress),
            conversation: ScriptedConversation(),
            isProtectedDataAvailable: { false }
        )
        #expect(lockedTransport.requests.isEmpty)

        // Non appairé : aucun jeton.
        let unpairedTransport = ScriptedClientTransport { mac.respond($0) }
        let unpaired = try await IOSSiriPending.answer(
            client: ClientDoubles.model(transport: unpairedTransport, address: macAddress),
            conversation: ScriptedConversation(),
            isProtectedDataAvailable: { true }
        )

        // Mac injoignable : le flux échoue, l'échéance tombe aussitôt.
        let silentTransport = ScriptedClientTransport { mac.respond($0) }
        let silentClient = ClientDoubles.pairedModel(
            tokens: CountingTokenStore(["dev-1": "tok-1"]), transport: silentTransport,
            address: macAddress, readinessPacer: ReturningPacer()
        )
        let unreachable = try await IOSSiriPending.answer(
            client: silentClient, conversation: ScriptedConversation(), isProtectedDataAvailable: { true }
        )
        silentClient.stop()

        // Version incompatible : le Mac salue en version suivante.
        let newerTransport = HelloStreamTransport(version: local + 1) { mac.respond($0) }
        let newerClient = ClientDoubles.pairedModel(
            tokens: CountingTokenStore(["dev-1": "tok-1"]), transport: newerTransport, address: macAddress
        )
        let incompatible = try await IOSSiriPending.answer(
            client: newerClient, conversation: ScriptedConversation(), isProtectedDataAvailable: { true }
        )
        newerClient.stop()

        #expect(locked == VoiceIssue.deviceLocked.phrase)
        #expect(unpaired == VoiceIssue.notPaired.phrase)
        #expect(unreachable == VoiceIssue.macUnreachable.phrase)
        #expect(incompatible == VoiceIssue.incompatibleVersion(local: local, remote: local + 1).phrase)
        #expect(Set([locked, unpaired, unreachable, incompatible]).count == 4)
        let all = lockedTransport.requests + unpairedTransport.requests + silentTransport.requests + newerTransport.requests
        #expect(posts(all).isEmpty, "aucune réponse envoyée")
        #expect(IOSPendingRequestsIntent.supportedModes == .background, "l'app ne s'ouvre pas")
    }

    @Test("siri-iphone-questions-en-attente/AC-15 : rien en attente → « Aucune demande ne vous attend. », sans aucune question")
    func nothingPendingSaysSo() async throws {
        let (client, transport) = connect(MacState())
        let conversation = ScriptedConversation()
        let result = try await IOSSiriPending.walk(client: client, conversation: conversation)
        #expect(result == VoiceSpeechText.noPending)
        #expect(conversation.dialogs.isEmpty)
        #expect(posts(transport.requests).isEmpty)

        // Même issue par l'intent complet : client appairé, Mac prêt (hello de la
        // version de l'app), puis la conversation.
        let mac = PendingMac([MacState()])
        let readyTransport = HelloStreamTransport(version: ConsoleAPI.protocolVersion) { mac.respond($0) }
        let readyClient = ClientDoubles.pairedModel(
            tokens: CountingTokenStore(["dev-1": "tok-1"]), transport: readyTransport, address: macAddress
        )
        let ready = ScriptedConversation()
        let answered = try await IOSSiriPending.answer(client: readyClient, conversation: ready, isProtectedDataAvailable: { true })
        readyClient.stop()
        #expect(answered == VoiceSpeechText.noPending)
        #expect(ready.dialogs.isEmpty)
        #expect(readyTransport.requests.contains { $0.method == "GET" && $0.path == "/v1/store" }, "la liste est lue sur le Mac prêt")
    }

    @Test("siri-iphone-pilotage-pipelines/AC-6 : une demande au pilote arrêté reste « à traiter dans l'app » : aucune reprise proposée ni envoyée")
    func pausedRequestStaysAppOnly() async throws {
        let pausedRoot = "/tmp/siri/autre"
        let state = MacState()
            .lot(on: pausedRoot, features: [PendingJSON.feature(
                "specs-arretees", state: "waiting", phase: "specs", waitKind: "specs", sinceAt: PendingJSON.at(1)
            )], pilotDead: true)
            .asking("f-question", run: "aaaaaaaaaaaaaaa1", at: PendingJSON.at(4), toolCallId: "call-1", question: "Quelle option ?", labels: labelsABC)

        // Préalable : après la dérivation du client, l'app offre « Reprendre » sur
        // cette carte (pilote mort).
        let reader = connect(state).client
        _ = try await reader.store()
        let cards = PipelinesModel.boardState(of: reader, nowMs: Date().timeIntervalSince1970 * 1000)?.kanbanBoard?.cards ?? []
        let pausedCard = try #require(cards.first { $0.id == PendingJSON.cardId("specs-arretees", root: pausedRoot) })
        try #require(KanbanActionPresentation.resumable(pausedCard))
        let paused = try #require(try await listed(state).first)
        try #require(paused.paused)

        let (client, transport) = connect(state)
        let conversation = ScriptedConversation(confirmations: [false])
        let result = try await IOSSiriPending.walk(client: client, conversation: conversation)
        #expect(conversation.asks.isEmpty, "aucune reprise ni réponse demandée")
        #expect(conversation.confirms == [joined([
            VoiceSpeechText.walkCount(2),
            VoiceSpeechText.walkFirst(VoicePendingSummary.item(paused)),
            VoiceSpeechText.appOnly,
            VoiceSpeechText.nextPrompt,
        ])])
        #expect(result == VoiceSpeechText.walkStopped)
        #expect(posts(transport.requests).isEmpty)
        #expect(!transport.requests.contains { $0.method == "POST" && $0.path.hasSuffix("/resume") })
    }
}
