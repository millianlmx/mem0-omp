// La liste des attentes (attentes-dispersees-entre-sources, BR-2) : la fonction
// PURE `PendingRequests.list` sur les fixtures de `PendingFixtures`. Aucune vue,
// aucune E/S : l'ardoise est dérivée de l'instantané par `KanbanBoardState.derive`,
// comme sur l'iPhone.

import ConsoleCore
import Foundation
import Testing

private typealias F = PendingFixtures

/// Modifie la feature `slug` du premier lot qui la porte.
private func changeFeature(_ snapshot: inout StoreSnapshot, _ slug: String, _ change: (inout LotFeature) -> Void) {
    for lotIndex in snapshot.lots.lots.indices {
        if let index = snapshot.lots.lots[lotIndex].features.firstIndex(where: { $0.slug == slug }) {
            change(&snapshot.lots.lots[lotIndex].features[index])
            return
        }
    }
    Issue.record("feature \(slug) absente de la fixture")
}

private let askId = "ask:\(F.cardId("f-question")):call-1"
private let specsId = "specs:\(F.cardId("f-specs")):\(F.tSpecs)"
private let reviewId = "review:\(F.cardId("f-review")):\(F.tReview)"
private let auditId = "audit:\(F.auditId):\(F.auditEscalationKey)"
private let conduiteId = "conduite:dlg-1:\(F.tConduite)"
private let sessionId = "session:dlg-2:\(F.tSession)"

@Suite("Liste des attentes (ConsoleCore)")
struct PendingRequestsTests {
    // MARK: - Critères d'acceptation

    @Test("attentes-dispersees-entre-sources/AC-1 : six sources, six attentes, chacune avec sa nature, sa question et ses options verbatim")
    func oneRequestPerSource() throws {
        let list = PendingRequests.list(F.sources)
        #expect(list.count == 6)
        #expect(Set(list.map(\.nature)) == [.question, .milestoneSpecs, .milestoneReview, .conduiteDialog, .sessionDialog, .auditEscalation])

        func one(_ nature: PendingNature) throws -> PendingRequest {
            let matches = list.filter { $0.nature == nature }
            #expect(matches.count == 1, "une seule attente de nature \(nature)")
            return try #require(matches.first)
        }

        let ask = try one(.question)
        #expect(ask.id == askId)
        #expect(ask.subject == "f-question")
        #expect(ask.question == F.askQuestion)
        #expect(ask.options == F.askOptions)
        #expect(ask.detail == nil)
        #expect(ask.paused == false)
        #expect(ask.reply == .cardAnswer(cardId: F.cardId("f-question"), toolCallId: "call-1"))

        let specs = try one(.milestoneSpecs)
        #expect(specs.subject == "f-specs")
        #expect(specs.question == HomeText.specsPrompt)
        #expect(specs.options == [])
        #expect(specs.reply == .cardVerdict(cardId: F.cardId("f-specs"), milestone: .specs))

        let review = try one(.milestoneReview)
        #expect(review.subject == "f-review")
        #expect(review.question == HomeText.reviewPrompt)
        #expect(review.options == [])
        #expect(review.reply == .cardVerdict(cardId: F.cardId("f-review"), milestone: .review))

        let conduite = try one(.conduiteDialog)
        #expect(conduite.subject == nil)
        #expect(conduite.question == F.conduiteDialog.title)
        #expect(conduite.detail == nil)
        // Les descriptions sont positionnelles ; une option sans description en a `nil`.
        #expect(conduite.options == [
            PanelAskOption(label: "f-specs", description: "la plus ancienne"),
            PanelAskOption(label: "f-review", description: nil),
        ])
        #expect(conduite.reply == .conduiteDialog(dialogId: "dlg-1", method: .select))

        let session = try one(.sessionDialog)
        #expect(session.question == F.sessionDialog.title)
        #expect(session.detail == F.sessionDialog.message)
        #expect(session.options == [])
        #expect(session.reply == .sessionDialog(dialogId: "dlg-2", method: .confirm))

        let audit = try one(.auditEscalation)
        #expect(audit.subject == "f-audit")
        #expect(audit.question == F.auditQuestion)
        #expect(audit.options.map(\.label) == F.auditOptions)
        #expect(audit.options.allSatisfy { $0.description == nil })
        #expect(audit.reply == .auditEscalation(auditId: F.auditId, slug: "f-audit", key: F.auditEscalationKey, kind: .ask))

        #expect(list.allSatisfy { !$0.paused && $0.reply.isDirectAnswer })
    }

    @Test("attentes-dispersees-entre-sources/AC-2 : une carte en échec et une carte bloquée, relançables, ne donnent aucune attente")
    func failedAndBlockedAreNotPending() throws {
        let sources = F.sources(snapshot: F.failedAndBlocked)
        // La fixture porte bien les deux cartes relançables que l'Accueil montre.
        let board = try #require(sources.board.kanbanBoard)
        #expect(Set(board.cards.map(\.column)) == [.echec, .bloquee])
        #expect(board.cards.allSatisfy(KanbanActionPresentation.relaunchable))

        #expect(PendingRequests.list(sources) == [])
    }

    @Test("attentes-dispersees-entre-sources/AC-3 : sans aucune demande dans aucune source, la liste est vide")
    func nothingPendingGivesEmptyList() throws {
        let calm = F.sources(snapshot: F.nothingPending)
        #expect(calm.board.kanbanBoard?.cards.isEmpty == false)
        #expect(PendingRequests.list(calm) == [])

        let empty = F.sources(snapshot: F.emptyStore)
        #expect(empty.board == .storeEmpty(dir: ""))
        #expect(PendingRequests.list(empty) == [])
    }

    @Test("attentes-dispersees-entre-sources/AC-4 : les mêmes données lues deux fois donnent les mêmes identités")
    func identitiesAreStable() {
        let first = PendingRequests.list(F.sources)
        let second = PendingRequests.list(F.sources)
        #expect(first == second)

        // Deux décodages distincts du même JSON.
        let decodedTwice = [F.decode(F.snapshotJSON), F.decode(F.snapshotJSON)].map { snapshot in
            PendingRequests.list(F.sources(snapshot: snapshot, conduite: [F.conduiteDialog], session: [F.sessionDialog]))
        }
        #expect(decodedTwice[0] == decodedTwice[1])
        #expect(decodedTwice[0].map(\.id) == first.map(\.id))
        #expect(first.map(\.id) == [sessionId, reviewId, auditId, askId, conduiteId, specsId])
    }

    @Test("attentes-dispersees-entre-sources/AC-5 : une question remplacée reçoit une nouvelle identité et l'ancienne disparaît")
    func replacedQuestionGetsNewIdentity() {
        var snapshot = F.snapshot
        // Pipeline : nouvelle question `ask` sur la même carte.
        snapshot.running.entries[0].pendingAsk?.toolCallId = "call-2"
        // Pipeline : nouvelle entrée dans le jalon specs (`sinceAt` réécrit).
        changeFeature(&snapshot, "f-specs") { $0.sinceAt = Double(F.tSpecs + 60_000) }
        // Audit : nouvelle escalade sur la même feature.
        changeFeature(&snapshot, "f-audit") { $0.escalation?.key = "ask:f-audit:call-10" }
        // Conduite et session : chaque dialogue est remplacé par un autre.
        let conduite = RpcDialogRequest(id: "dlg-3", method: .input, title: "Nom de la branche ?", at: Double(F.tConduite + 1_000))
        let session = RpcDialogRequest(id: "dlg-2", method: .confirm, title: "Arrêter la session ?", at: Double(F.tSession + 1_000))

        let before = Set(PendingRequests.list(F.sources).map(\.id))
        let after = Set(PendingRequests.list(F.sources(snapshot: snapshot, conduite: [conduite], session: [session])).map(\.id))

        let replaced: [(old: String, new: String)] = [
            (askId, "ask:\(F.cardId("f-question")):call-2"),
            (specsId, "specs:\(F.cardId("f-specs")):\(F.tSpecs + 60_000)"),
            (auditId, "audit:\(F.auditId):ask:f-audit:call-10"),
            (conduiteId, "conduite:dlg-3:\(F.tConduite + 1_000)"),
            // Même `dlg-N`, autre instant : un redémarrage du service.
            (sessionId, "session:dlg-2:\(F.tSession + 1_000)"),
        ]
        for (old, new) in replaced {
            #expect(before.contains(old))
            #expect(!after.contains(old), "l'ancienne identité \(old) ne doit plus apparaître")
            #expect(after.contains(new), "la nouvelle identité \(new) doit apparaître")
            #expect(old != new)
        }
        // La revue, inchangée, garde son identité.
        #expect(after.contains(reviewId))
        #expect(after.count == 6)
    }

    @Test("attentes-dispersees-entre-sources/AC-6 : aucune identité n'est partagée par deux attentes")
    func identitiesAreUnique() {
        let list = PendingRequests.list(F.sources)
        #expect(Set(list.map(\.id)).count == list.count)

        // Une conduite et une session qui portent le même `dlg-N` au même instant.
        let twin = RpcDialogRequest(id: "dlg-1", method: .select, title: "Même numéro", at: Double(F.tConduite))
        let twins = PendingRequests.list(F.sources(snapshot: F.emptyStore, conduite: [twin], session: [twin]))
        #expect(twins.count == 2)
        #expect(Set(twins.map(\.id)) == ["conduite:dlg-1:\(F.tConduite)", "session:dlg-1:\(F.tConduite)"])
    }

    @Test("attentes-dispersees-entre-sources/AC-8 : de la plus ancienne à la plus récente, toutes sources confondues, quel que soit l'ordre des entrées")
    func orderedByAgeAcrossSources() {
        let earlyConduite = RpcDialogRequest(id: "dlg-7", method: .input, title: "Avant tout", at: Double(F.start))
        let lateSession = RpcDialogRequest(id: "dlg-8", method: .confirm, title: "Après tout", at: Double(F.tSpecs + 1_000))
        let expected = [
            "conduite:dlg-7:\(F.start)",
            sessionId,
            reviewId,
            auditId,
            askId,
            conduiteId,
            specsId,
            "session:dlg-8:\(F.tSpecs + 1_000)",
        ]

        let inOrder = PendingRequests.list(F.sources(
            snapshot: F.snapshot, conduite: [F.conduiteDialog, earlyConduite], session: [F.sessionDialog, lateSession]
        ))
        #expect(inOrder.map(\.id) == expected)
        #expect(inOrder.map(\.at) == inOrder.map(\.at).sorted())

        // Files inversées, features du lot inversées.
        var permuted = F.snapshot
        permuted.lots.lots[0].features.reverse()
        let reversed = PendingRequests.list(F.sources(
            snapshot: permuted, conduite: [earlyConduite, F.conduiteDialog], session: [lateSession, F.sessionDialog]
        ))
        #expect(reversed.map(\.id) == expected)
        #expect(reversed == inOrder)
    }

    @Test("attentes-dispersees-entre-sources/AC-9 : deux attentes de même ancienneté gardent toujours le même ordre relatif")
    func equalAgeTieBreakIsDeterministic() {
        // Le dialogue de conduite arrive au même instant que l'escalade d'audit.
        let sameInstant = RpcDialogRequest(id: "dlg-1", method: .select, title: "Même instant", options: ["a", "b"], at: Double(F.tAudit))
        let other = RpcDialogRequest(id: "dlg-4", method: .input, title: "Plus tard", at: Double(F.tSpecs))
        let tiedConduite = "conduite:dlg-1:\(F.tAudit)"

        var reversedFeatures = F.snapshot
        reversedFeatures.lots.lots[0].features.reverse()
        var results: [[PendingRequest]] = []
        for snapshot in [F.snapshot, reversedFeatures] {
            for conduite in [[sameInstant, other], [other, sameInstant]] {
                for _ in 0..<3 {
                    results.append(PendingRequests.list(F.sources(snapshot: snapshot, conduite: conduite, session: [F.sessionDialog])))
                }
            }
        }
        for list in results {
            let tied = list.filter { $0.at == Double(F.tAudit) }.map(\.id)
            #expect(tied == [auditId, tiedConduite])
            #expect(list == results[0])
        }
    }

    @Test("attentes-dispersees-entre-sources/AC-10 : une question ou un jalon au pilote arrêté figure, en pause, sans réponse directe")
    func pausedCardsAreListedWithoutDirectAnswer() throws {
        let sources = F.sources(snapshot: F.pausedLot)
        // La fixture porte bien deux cartes « En pause ».
        let board = try #require(sources.board.kanbanBoard)
        #expect(board.cards.count == 2)
        #expect(board.cards.allSatisfy(KanbanActionPresentation.resumable))

        let list = PendingRequests.list(sources)
        #expect(list.map(\.nature) == [.question, .milestoneSpecs])
        let questionCard = F.cardId("f-pause-question", repoRoot: "/tmp/attentes/pause")
        let specsCard = F.cardId("f-pause-specs", repoRoot: "/tmp/attentes/pause")
        // La pause ne change pas l'identité : seuls `paused` et le geste changent.
        #expect(list.map(\.id) == ["ask:\(questionCard):call-1", "specs:\(specsCard):\(F.tSpecs)"])
        #expect(list.map(\.reply) == [.resume(cardId: questionCard), .resume(cardId: specsCard)])
        for request in list {
            #expect(request.paused)
            #expect(request.reply.isDirectAnswer == false)
        }
        // La question en vol garde sa question et ses options.
        #expect(list[0].question == F.askQuestion)
        #expect(list[0].options == F.askOptions)
    }

    @Test("attentes-dispersees-entre-sources/AC-12 : l'Accueil de la fixture partagée est inchangé")
    func homeIsUnchanged() throws {
        let board = try #require(HomeParity.board.kanbanBoard)
        let dashboard = HomePresentation.dashboard(board)
        #expect(dashboard.attention.map(\.nature) == [.milestoneSpecs, .milestoneReview, .failed, .blocked, .question])
        #expect(dashboard.running.count == 2)
        #expect(dashboard.paused.count == 1)
        #expect(dashboard.notStarted.count == 1)
        #expect(dashboard.delivered.count == 2)
        #expect(HomePresentation.counts(board) == HomeCounts(attention: 5, running: 2))
    }

    // MARK: - Règles hors critères

    @Test("une feature en arbitrage n'est pas une attente : l'arbitre décide")
    func arbitrationExcludesCard() {
        var snapshot = F.snapshot
        changeFeature(&snapshot, "f-specs") { $0.arbitration = FeatureArbitration(key: "specs:f-specs", startedAt: Double(F.tSpecs)) }
        let ids = PendingRequests.list(F.sources(snapshot: snapshot, conduite: [F.conduiteDialog], session: [F.sessionDialog])).map(\.id)
        #expect(!ids.contains(specsId))
        #expect(ids.count == 5)
    }

    @Test("une question escaladée vers un audit ne compte qu'une fois, comme escalade d'audit")
    func auditEscalationIsListedOnce() {
        var snapshot = F.snapshot
        snapshot.running.entries = []
        snapshot.lots.lots[0].features.removeAll { $0.slug != "f-audit" }
        let list = PendingRequests.list(F.sources(snapshot: snapshot))
        #expect(list.map(\.id) == [auditId])
        #expect(list.map(\.nature) == [.auditEscalation])

        // Sans l'audit, la même feature redevient une question en texte de carte.
        snapshot.audits.records = []
        let orphan = PendingRequests.list(F.sources(snapshot: snapshot))
        #expect(orphan.map(\.nature) == [.question])
        #expect(orphan.first?.question == F.auditQuestion)
        #expect(orphan.first?.options == [])
        #expect(orphan.first?.reply == .cardReply(cardId: F.cardId("f-audit")))
        #expect(orphan.first?.id == "reply:\(F.cardId("f-audit")):\(F.start)")
    }

    @Test("une question en vol d'un run sans feature est une attente, jamais en pause")
    func unpairedRunQuestionIsListed() throws {
        let sources = F.sources(snapshot: F.unpairedRun)
        let card = try #require(sources.board.kanbanBoard?.cards.first { $0.column == .questionEnVol })
        #expect(card.id.hasPrefix("run:"))

        let list = PendingRequests.list(sources)
        #expect(list.count == 1)
        let request = try #require(list.first)
        #expect(request.id == "ask:\(card.id):call-1")
        #expect(request.at == Double(F.tAsk))
        #expect(request.paused == false)
        #expect(request.reply == .cardAnswer(cardId: card.id, toolCallId: "call-1"))
    }

    @Test("une ardoise en chargement ne donne que les dialogues et les escalades d'audit")
    func loadingBoardKeepsOtherFamilies() {
        let sources = PendingSources(
            snapshot: F.snapshot, board: .loading, conduiteDialogs: [F.conduiteDialog], sessionDialogs: [F.sessionDialog]
        )
        #expect(PendingRequests.list(sources).map(\.id) == [sessionId, auditId, conduiteId])
    }

    @Test("un dialogue sans horodatage se range en tête, à l'instant 0")
    func undatedDialogComesFirst() {
        let undated = RpcDialogRequest(id: "dlg-9", method: .editor, title: "Sans horodatage")
        let list = PendingRequests.list(F.sources(snapshot: F.snapshot, conduite: [undated], session: [F.sessionDialog]))
        #expect(list.first?.id == "conduite:dlg-9:0")
        #expect(list.first?.at == 0)
    }
}
