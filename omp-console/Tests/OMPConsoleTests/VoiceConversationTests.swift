// Le parcours vocal des demandes en attente (siri-mac-questions-en-attente, BR-1) :
// la forme vocale d'une demande (table S-1) et le moteur PUR `VoiceConversation`
// (S-3) sur des `PendingRequest` littérales, avec des ports scriptés. Les preuves
// tracées par critère, sur la pile réelle du Mac, vivent dans MacVoiceIntentTests.

import ConsoleCore
import Foundation
import Testing

private let nbsp = "\u{00A0}"

private func options(_ labels: [String]) -> [PanelAskOption] {
    labels.map { PanelAskOption(label: $0, description: nil) }
}

private func request(
    _ id: String,
    at: Double,
    nature: PendingNature = .question,
    subject: String? = nil,
    question: String = "Que faire\u{00A0}?",
    options labels: [String] = [],
    paused: Bool = false,
    reply: PendingReply
) -> PendingRequest {
    PendingRequest(
        id: id, nature: nature, at: at, subject: subject, question: question, detail: nil,
        options: options(labels), paused: paused, reply: reply
    )
}

/// Un envoi observé : la demande visée et la réponse reçue.
private struct Sent: Equatable {
    let id: String
    let answer: VoiceAnswer
}

/// Les ports scriptés : la liste lue, les énoncés rendus dans l'ordre (« annuler »
/// ou file vide lève), les prompts dits, les envois et leurs issues.
@MainActor
private final class Harness {
    var list: [PendingRequest]
    var utterances: [String]
    var issues: [VoiceIssue] = []
    var prompts: [String] = []
    var sent: [Sent] = []
    /// Appelé pendant le n-ième `ask` (à partir de 1), avant que l'énoncé soit rendu.
    var duringAsk: (Int) -> Void = { _ in }

    init(_ list: [PendingRequest], utterances: [String]) {
        self.list = list
        self.utterances = utterances
    }

    func run(announcing: Bool = true) async -> String {
        await VoiceConversation(
            read: { .ready(self.list) },
            ask: { prompt in
                self.prompts.append(prompt)
                self.duringAsk(self.prompts.count)
                guard !self.utterances.isEmpty else { throw CancellationError() }
                let said = self.utterances.removeFirst()
                if said == "annuler" { throw CancellationError() }
                return said
            },
            send: { request, answer in
                self.sent.append(Sent(id: request.id, answer: answer))
                let issue = self.issues.isEmpty
                    ? VoiceIssue.sent(request.voiceGesture!, target: request.subject ?? "")
                    : self.issues.removeFirst()
                if case .sent = issue {
                    self.list.removeAll { $0.voiceKey == request.voiceKey }
                }
                return issue
            }
        ).run(announcing: announcing)
    }
}

@Suite("Parcours vocal (ConsoleCore)")
@MainActor
struct VoiceConversationTests {
    @Test("Forme vocale : une ligne par geste, méthode de dialogue et sorte d'escalade")
    func voiceFormTable() {
        let two = options(["Le garder", "Le vider"])
        let yesNo = options(["Oui", "Non"])
        let rows: [(PendingReply, [String], VoiceAnswerForm, VoiceGesture?, String)] = [
            (.cardAnswer(cardId: "c1", toolCallId: "t1"), ["Le garder", "Le vider"], .choice(options: two, acceptsFreeText: true), .answerOption, "card:c1"),
            (.cardAnswer(cardId: "c1", toolCallId: "t1"), [], .dictation, .answerOption, "card:c1"),
            (.cardReply(cardId: "c1"), [], .dictation, .answerText, "card:c1"),
            (.cardVerdict(cardId: "c1", milestone: .specs), [], .inApp, nil, "card:c1"),
            (.cardVerdict(cardId: "c1", milestone: .review), [], .inApp, nil, "card:c1"),
            (.resume(cardId: "c1"), ["Le garder", "Le vider"], .inApp, nil, "card:c1"),
            (.conduiteDialog(dialogId: "d1", method: .select), ["Le garder", "Le vider"], .choice(options: two, acceptsFreeText: false), .answerProjectDialog, "conduite:d1"),
            (.conduiteDialog(dialogId: "d1", method: .input), [], .dictation, .answerProjectDialog, "conduite:d1"),
            (.conduiteDialog(dialogId: "d1", method: .confirm), [], .choice(options: yesNo, acceptsFreeText: false), .answerProjectDialog, "conduite:d1"),
            (.conduiteDialog(dialogId: "d1", method: .editor), [], .inApp, nil, "conduite:d1"),
            (.sessionDialog(dialogId: "d2", method: .select), ["Le garder", "Le vider"], .choice(options: two, acceptsFreeText: false), .answerHostedDialog, "session:d2"),
            (.sessionDialog(dialogId: "d2", method: .input), [], .dictation, .answerHostedDialog, "session:d2"),
            (.sessionDialog(dialogId: "d2", method: .confirm), [], .choice(options: yesNo, acceptsFreeText: false), .answerHostedDialog, "session:d2"),
            (.sessionDialog(dialogId: "d2", method: .editor), [], .inApp, nil, "session:d2"),
            (.auditEscalation(auditId: "a1", slug: "f-x", key: "ask:f-x:c9", kind: .ask), ["Le garder", "Le vider"], .choice(options: two, acceptsFreeText: true), .answerAuditEscalation, "audit:a1:f-x"),
            (.auditEscalation(auditId: "a1", slug: "f-x", key: "ask:f-x:c9", kind: .ask), [], .dictation, .answerAuditEscalation, "audit:a1:f-x"),
            (.auditEscalation(auditId: "a1", slug: "f-x", key: "question:f-x", kind: .question), ["Le garder", "Le vider"], .choice(options: two, acceptsFreeText: true), .answerAuditEscalation, "audit:a1:f-x"),
            (.auditEscalation(auditId: "a1", slug: "f-x", key: "question:f-x", kind: .question), [], .dictation, .answerAuditEscalation, "audit:a1:f-x"),
            (.auditEscalation(auditId: "a1", slug: "f-x", key: "specs:f-x", kind: .specs), [], .inApp, nil, "audit:a1:f-x"),
            (.auditEscalation(auditId: "a1", slug: "f-x", key: "review:f-x", kind: .review), [], .inApp, nil, "audit:a1:f-x"),
        ]
        for (reply, labels, form, gesture, key) in rows {
            let r = request("r", at: 1, options: labels, paused: reply == .resume(cardId: "c1"), reply: reply)
            #expect(r.voiceForm == form, "\(reply)")
            #expect(r.voiceGesture == gesture, "\(reply)")
            #expect(r.voiceKey == key, "\(reply)")
            #expect((r.voiceGesture == nil) == (r.voiceForm == .inApp), "\(reply)")
        }
    }

    @Test("Clé vocale : une question remplacée garde la clé de sa demande")
    func voiceKeyIgnoresQuestion() {
        let before = request("ask:1", at: 1, question: "Avant\u{00A0}?", reply: .cardAnswer(cardId: "c1", toolCallId: "t1"))
        let after = request("ask:2", at: 2, question: "Après\u{00A0}?", reply: .cardAnswer(cardId: "c1", toolCallId: "t2"))
        #expect(before.voiceKey == after.voiceKey)
        let first = request("e1", at: 1, nature: .auditEscalation, reply: .auditEscalation(auditId: "a1", slug: "f-x", key: "ask:f-x:c1", kind: .ask))
        let second = request("e2", at: 1, nature: .auditEscalation, reply: .auditEscalation(auditId: "a1", slug: "f-x", key: "ask:f-x:c2", kind: .ask))
        #expect(first.voiceKey == second.voiceKey)
    }

    /// `walkRequest` replie TOUS les blancs de la question, insécable comprise
    /// (`VoiceSpeech.collapsingBlanks`) : « cache\u{00A0}? » est dit « cache ? ».
    @Test("Premier prompt : en-tête, demande « à traiter dans l’app », puis la question et ses choix")
    func firstPromptExample() async {
        let editor = request("session:dlg-e", at: 1, nature: .sessionDialog, question: "Corriger le plan",
                             reply: .sessionDialog(dialogId: "dlg-e", method: .editor))
        let ask = request("ask:1", at: 2, subject: "f-question", question: "Que faire du cache\u{00A0}?",
                          options: ["Le garder", "Le vider"], reply: .cardAnswer(cardId: "c1", toolCallId: "t1"))
        let h = Harness([editor, ask], utterances: ["annuler"])
        _ = await h.run()
        #expect(h.prompts.first == "2 demandes en attente. La première\(nbsp): session OMP, dialogue de session\(nbsp): Corriger le plan. À traiter dans l’app. La suivante\(nbsp): f-question, question\(nbsp): Que faire du cache ? Choix possibles\(nbsp): Le garder et Le vider. Vous pouvez aussi dire «\(nbsp)autre réponse\(nbsp)».")
    }

    @Test("Liste vide ou illisible : la phrase seule, aucune question, aucun envoi")
    func emptyOrUnreadable() async {
        let empty = Harness([], utterances: [])
        #expect(await empty.run() == VoiceSpeechText.noPending)
        #expect(empty.prompts.isEmpty && empty.sent.isEmpty)

        let unreadable = await VoiceConversation(
            read: { .unavailable(phrase: VoiceSpeechText.stateUnreadable) },
            ask: { _ in Issue.record("ask"); return "" },
            send: { _, _ in Issue.record("send"); return .misconfigured }
        ).run(announcing: true)
        #expect(unreadable == VoiceSpeechText.stateUnreadable)
    }

    @Test("Borne : trois énoncés non reconnus terminent la session sans envoi")
    func maxAsksBound() async {
        let dialog = request("conduite:d1", at: 1, nature: .conduiteDialog, question: "Quel mode\u{00A0}?",
                             options: ["Rapide", "Prudent"], reply: .conduiteDialog(dialogId: "d1", method: .select))
        let h = Harness([dialog], utterances: ["zzz", "yyy", "xxx", "Rapide"])
        let phrase = await h.run()
        #expect(phrase == VoiceSpeechText.walkNotUnderstood)
        #expect(h.prompts.count == VoiceConversation.maxAsks)
        #expect(h.sent.isEmpty)
        #expect(h.prompts.dropFirst().allSatisfy { $0 == VoiceSpeechText.optionNotFound(labels: ["Rapide", "Prudent"]) })
    }

    @Test("« Autre réponse » refusée sans texte libre : seules les options sont relues")
    func otherAnswerRefusedWithoutFreeText() async {
        let dialog = request("conduite:d1", at: 1, nature: .conduiteDialog, question: "Quel mode\u{00A0}?",
                             options: ["Rapide", "Prudent"], reply: .conduiteDialog(dialogId: "d1", method: .select))
        let h = Harness([dialog], utterances: ["autre réponse", "Prudent"])
        let phrase = await h.run(announcing: false)
        #expect(h.prompts.count == 2)
        #expect(h.prompts[1] == VoiceSpeechText.optionNotFound(labels: ["Rapide", "Prudent"]))
        #expect(h.sent == [Sent(id: "conduite:d1", answer: .option(index: 1, label: "Prudent"))])
        #expect(phrase.hasSuffix(VoiceSpeechText.walkNoneLeft))
    }

    @Test("« Autre réponse » admise : le texte dicté part tel quel, blancs compris")
    func otherAnswerDictation() async {
        let ask = request("ask:1", at: 1, subject: "f-cache", options: ["Le garder", "Le vider"],
                          reply: .cardAnswer(cardId: "c1", toolCallId: "t1"))
        let h = Harness([ask], utterances: ["Une autre réponse", "  vider puis recharger "])
        _ = await h.run(announcing: false)
        #expect(h.prompts.count == 2)
        #expect(h.prompts[1] == VoiceSpeechText.walkDictate)
        #expect(h.sent == [Sent(id: "ask:1", answer: .text("  vider puis recharger "))])
        #expect(VoiceAnswerMatcher.isOtherAnswer("Une autre réponse"))
        #expect(!VoiceAnswerMatcher.isOtherAnswer("Le vider"))
    }

    @Test("Un libellé « Autre » l’emporte sur la demande de texte libre")
    func otherLabelWins() async {
        let ask = request("ask:1", at: 1, subject: "f-cache", options: ["Autre", "Garder"],
                          reply: .cardAnswer(cardId: "c1", toolCallId: "t1"))
        let h = Harness([ask], utterances: ["autre"])
        _ = await h.run(announcing: false)
        #expect(h.prompts.count == 1)
        #expect(h.sent == [Sent(id: "ask:1", answer: .option(index: 0, label: "Autre"))])
    }

    @Test("Question remplacée avant l’envoi : rien n’est envoyé, la nouvelle question est relue")
    func staleBeforeSend() async {
        let old = request("ask:1", at: 1, subject: "f-cache", question: "Avant\u{00A0}?", options: ["Oui", "Non"],
                          reply: .cardAnswer(cardId: "c1", toolCallId: "t1"))
        let new = request("ask:2", at: 1, subject: "f-cache", question: "Après\u{00A0}?", options: ["Oui", "Non"],
                          reply: .cardAnswer(cardId: "c1", toolCallId: "t2"))
        let h = Harness([old], utterances: ["Oui", "Non"])
        h.duringAsk = { n in if n == 1 { h.list = [new] } }
        _ = await h.run(announcing: false)
        #expect(h.prompts.count == 2)
        #expect(h.prompts[1] == VoiceIssue.staleQuestion.phrase + " " + VoiceSpeechText.walkRequest(new) + " "
            + VoiceSpeechText.walkChoices(labels: ["Oui", "Non"], acceptsFreeText: true))
        #expect(h.sent == [Sent(id: "ask:2", answer: .option(index: 1, label: "Non"))])
    }

    @Test("Refus du Mac : le motif est dit, la demande n’est plus reproposée, la suivante est lue")
    func refusalMovesOn() async {
        let first = request("ask:1", at: 1, subject: "f-un", options: ["Oui", "Non"], reply: .cardAnswer(cardId: "c1", toolCallId: "t1"))
        let second = request("reply:2", at: 2, subject: "f-deux", reply: .cardReply(cardId: "c2"))
        let h = Harness([first, second], utterances: ["Oui", "annuler"])
        h.issues = [.macRefused(motive: "écriture impossible")]
        let phrase = await h.run(announcing: false)
        #expect(h.prompts[1] == VoiceIssue.macRefused(motive: "écriture impossible").phrase + " "
            + VoiceSpeechText.walkNext + VoiceSpeechText.walkRequest(second) + " " + VoiceSpeechText.walkDictate)
        #expect(phrase == VoiceSpeechText.walkStopped)
        #expect(h.list.count == 2)
    }

    @Test("Mauvaise configuration : la session s’arrête sur sa phrase")
    func misconfiguredEndsSession() async {
        let first = request("ask:1", at: 1, subject: "f-un", options: ["Oui", "Non"], reply: .cardAnswer(cardId: "c1", toolCallId: "t1"))
        let second = request("reply:2", at: 2, subject: "f-deux", reply: .cardReply(cardId: "c2"))
        let h = Harness([first, second], utterances: ["Oui", "texte"])
        h.issues = [.misconfigured]
        let phrase = await h.run()
        #expect(phrase == VoiceIssue.misconfigured.phrase)
        #expect(h.prompts.count == 1)
        #expect(h.sent.count == 1)
    }
}
