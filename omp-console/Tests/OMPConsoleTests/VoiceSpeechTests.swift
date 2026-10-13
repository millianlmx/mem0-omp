// Le noyau vocal partagé (noyau-vocal-partage, BR-1) : les fonctions PURES de
// `ConsoleCore/Voice/` — recherche d'une feature, correspondance d'une réponse,
// liste des attentes à voix haute, issue d'un geste — sur des valeurs littérales.
// Aucune vue, aucune E/S, aucune horloge.

import ConsoleCore
import Foundation
import Testing

private let nbsp = "\u{00A0}"

private func card(_ id: String, _ title: String, _ column: KanbanColumn = .enCours) -> KanbanCard {
    KanbanCard(
        id: id, column: column, repo: "depot", title: title, state: "en cours", phase: nil, models: nil,
        prUrl: nil, startMs: 0, endMs: nil, marks: [], sources: []
    )
}

private func pending(_ at: Double, _ subject: String?, _ nature: PendingNature, _ question: String) -> PendingRequest {
    PendingRequest(
        id: "attente:\(Int(at))", nature: nature, at: at, subject: subject, question: question, detail: nil,
        options: [], paused: false, reply: .cardReply(cardId: "feature:depot:x")
    )
}

private let yesNoLater = [
    PanelAskOption(label: "Oui", description: nil),
    PanelAskOption(label: "Non", description: "Refuser"),
    PanelAskOption(label: "Plus tard", description: nil),
]

/// AC-3 : les six colonnes terminales, puis une entrée d'historique en colonne non
/// terminale (seul son préfixe d'identité l'écarte).
private let closedAuditCards: [KanbanCard] =
    [KanbanColumn.prOuverte, .prCreee, .fusionne, .prFermee, .termineeSansPr, .annuleeRetiree]
        .map { card("feature:depot:audit-ui", "audit UI", $0) }
    + [card("history:0123456789abcdef", "audit UI", .enCours)]

/// AC-5 : (énoncé, index attendu, libellé attendu).
private let rankUtterances: [(String, Int, String)] = [
    ("la deuxième", 1, "Non"),
    ("2", 1, "Non"),
    ("option 2", 1, "Non"),
    ("la dernière", 2, "Plus tard"),
    ("plus tard", 2, "Plus tard"),
]

private let unknownUtterances = ["la cinquième", "peut-être"]

@Suite("VoiceSpeechTests")
struct VoiceSpeechTests {
    // MARK: - Critères d'acceptation

    @Test("noyau-vocal-partage/AC-1 : deux titres proches demandent une précision, même si l'un est identique à l'énoncé")
    func ambiguousEvenWhenOneTitleIsExact() {
        let exact = card("feature:depot:audit-ui", "audit UI")
        let longer = card("feature:depot:audit-ui-redesign", "audit UI redesign")
        let result = VoiceFeatureSearch.find("audit UI", in: [longer, exact])
        #expect(result == .ambiguous(
            candidates: [exact, longer],
            prompt: "Plusieurs features correspondent\(nbsp): audit UI et audit UI redesign. Laquelle\(nbsp)?"
        ))
    }

    @Test("noyau-vocal-partage/AC-2 : casse, accent et tiret différents retrouvent la feature")
    func foldsCaseAccentsAndDashes() {
        let feature = card("project:depot:noyau-vocal-partage", "Noyau vocal partagé", .jalonSpecs)
        #expect(VoiceFeatureSearch.find("noyau vocal partage", in: [feature]) == .found(feature))
        #expect(VoiceFeatureSearch.find("Noyau-Vocal-Partagé", in: [feature]) == .found(feature))
    }

    @Test("noyau-vocal-partage/AC-3 : une feature livrée ou archivée est introuvable", arguments: closedAuditCards)
    func closedFeatureIsNotFound(closed: KanbanCard) {
        #expect(VoiceFeatureSearch.find("audit UI", in: [closed]) == .notFound(prompt: VoiceSpeechText.featureNotFound))
    }

    @Test("noyau-vocal-partage/AC-4 : cinq correspondances, trois titres cités puis « et 2 autres »")
    func ambiguityCitesThreeTitles() throws {
        let cards = (1...5).reversed().map { card("feature:depot:audit-\($0)", "audit \($0)") }
        let result = VoiceFeatureSearch.find("audit", in: cards)
        guard case let .ambiguous(candidates, prompt) = result else {
            Issue.record("précision attendue, obtenu \(result)")
            return
        }
        #expect(candidates.map(\.title) == ["audit 1", "audit 2", "audit 3", "audit 4", "audit 5"])
        #expect(prompt == "Plusieurs features correspondent\(nbsp): audit 1, audit 2, audit 3 et 2 autres. Laquelle\(nbsp)?")
    }

    @Test("noyau-vocal-partage/AC-5 : rang, chiffre, « option 2 », « la dernière » et libellé en minuscules", arguments: rankUtterances)
    func matchesRankAndLabel(utterance: (String, Int, String)) {
        let (spoken, index, label) = utterance
        #expect(
            VoiceAnswerMatcher.match(spoken, options: yesNoLater, acceptsFreeText: false)
                == .option(index: index, label: label)
        )
    }

    @Test("noyau-vocal-partage/AC-6 : option introuvable sans texte libre, la phrase rappelle les choix", arguments: unknownUtterances)
    func unknownOptionRecallsChoices(spoken: String) throws {
        let result = VoiceAnswerMatcher.match(spoken, options: yesNoLater, acceptsFreeText: false)
        #expect(result == .notFound(prompt: "Je n’ai pas reconnu cette option. Choix possibles\(nbsp): Oui, Non et Plus tard."))
        guard case let .notFound(prompt) = result else { return }
        #expect(prompt.hasPrefix("Je n’ai pas reconnu cette option. Choix possibles\(nbsp):"))
    }

    @Test("noyau-vocal-partage/AC-7 : sans option correspondante, une question à texte libre reçoit la phrase dite")
    func unmatchedAnswerBecomesFreeText() {
        #expect(
            VoiceAnswerMatcher.match("  Garde la version courte ", options: yesNoLater, acceptsFreeText: true)
                == .freeText("Garde la version courte")
        )
    }

    @Test("noyau-vocal-partage/AC-8 : une liste vide a sa phrase dédiée")
    func emptyListHasDedicatedPhrase() {
        #expect(VoicePendingSummary.phrase(for: []) == "Aucune demande ne vous attend.")
        #expect(VoicePendingSummary.phrase(for: []) == VoiceSpeechText.noPending)
    }

    @Test("noyau-vocal-partage/AC-9 : cinq attentes, total, trois plus récentes de la plus récente à la plus ancienne, « et 2 autres »")
    func fiveRequestsDetailThreeMostRecent() {
        let list = [
            pending(2000, "vieille-feature", .milestoneReview, "Revue prête"),
            pending(5000, "audit-ui", .question, "Garder le bouton ?"),
            pending(1000, nil, .sessionDialog, "Plus ancienne"),
            pending(3000, "noyau-vocal-partage", .milestoneSpecs, "Specs prêtes"),
            pending(4000, nil, .conduiteDialog, "Choisir la base"),
        ]
        let expected = "5 demandes vous attendent\(nbsp): "
            + "audit-ui, question «\(nbsp)Garder le bouton ?\(nbsp)»\(nbsp); "
            + "conduite de projet, dialogue de conduite «\(nbsp)Choisir la base\(nbsp)»\(nbsp); "
            + "noyau-vocal-partage, spécifications à valider «\(nbsp)Specs prêtes\(nbsp)»\(nbsp); et 2 autres."
        #expect(VoicePendingSummary.phrase(for: list) == expected)
    }

    @Test("noyau-vocal-partage/AC-10 : deux attentes, toutes deux détaillées, sans « autres »")
    func twoRequestsWithoutMore() {
        let phrase = VoicePendingSummary.phrase(for: [
            pending(1000, nil, .auditEscalation, "Valider le constat"),
            pending(2000, "login-oauth", .question, "Quel fournisseur"),
        ])
        #expect(phrase == "2 demandes vous attendent\(nbsp): login-oauth, question «\(nbsp)Quel fournisseur\(nbsp)»\(nbsp); "
            + "audit, escalade d’audit «\(nbsp)Valider le constat\(nbsp)».")
        #expect(!phrase.contains("autre"))
    }

    @Test("noyau-vocal-partage/AC-11 : un succès nomme le geste et sa cible")
    func successNamesGestureAndTarget() {
        let phrase = VoiceIssue(.sent, gesture: .validateSpecs, target: "audit UI").phrase
        #expect(phrase == "Les specs de la feature audit UI sont validées.")
    }

    @Test("noyau-vocal-partage/AC-12 : sept issues d'échec, sept phrases françaises non vides et distinctes")
    func failureIssuesAreDistinct() {
        let issues: [VoiceIssue] = [
            VoiceIssue(.cancelled(dialog: VoiceGestureText.cancelled), gesture: .stopFeature, target: "x"),
            VoiceIssue(.misconfigured(dialog: VoiceGestureText.misconfigured), gesture: .stopFeature, target: "x"),
            .staleQuestion,
            .invalidOption,
            .notPaired,
            .macUnreachable,
            .incompatibleVersion(local: 2, remote: 1),
        ]
        let phrases = issues.map(\.phrase)
        for phrase in phrases {
            #expect(!phrase.isEmpty)
            #expect(phrase == phrase.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        #expect(Set(phrases).count == 7)
        #expect(phrases[0] == VoiceGestureText.cancelled)
        #expect(phrases[1] == VoiceGestureText.misconfigured)
    }

    // MARK: - Cas limites

    @Test("Un énoncé vide ne trouve aucune feature et n'est pas une réponse, même en texte libre")
    func emptyUtterance() {
        let cards = [card("feature:depot:audit-ui", "audit UI")]
        #expect(VoiceFeatureSearch.find(" — ’ ", in: cards) == .notFound(prompt: VoiceSpeechText.featureNotFound))
        #expect(VoiceFeatureSearch.find("audit", in: []) == .notFound(prompt: VoiceSpeechText.featureNotFound))
        #expect(VoiceAnswerMatcher.match("  ", options: yesNoLater, acceptsFreeText: true) == .notFound(prompt: VoiceSpeechText.nothingHeard))
    }

    @Test("Les mots de l'énoncé doivent se suivre dans le titre, mot pour mot")
    func contiguousWholeWords() {
        let suivi = card("feature:depot:suivi", "suivi")
        let redesign = card("feature:depot:audit-ui-redesign", "audit UI redesign")
        #expect(VoiceFeatureSearch.find("ui", in: [suivi]) == .notFound(prompt: VoiceSpeechText.featureNotFound))
        #expect(VoiceFeatureSearch.find("audit redesign", in: [redesign]) == .notFound(prompt: VoiceSpeechText.featureNotFound))
        #expect(VoiceFeatureSearch.find("ui redesign", in: [redesign, suivi]) == .found(redesign))
    }

    @Test("Une option nommée « 2 » l'emporte sur le rang 2")
    func labelBeatsRank() {
        let options = [PanelAskOption(label: "Oui", description: nil), PanelAskOption(label: "Non", description: nil), PanelAskOption(label: "2", description: nil)]
        #expect(VoiceAnswerMatcher.match("2", options: options, acceptsFreeText: false) == .option(index: 2, label: "2"))
        #expect(VoiceAnswerMatcher.match("la deuxième", options: options, acceptsFreeText: false) == .option(index: 1, label: "Non"))
    }

    @Test("Ordinaux en chiffres, rang hors bornes et question sans option")
    func rankEdges() {
        #expect(VoiceAnswerMatcher.match("la 1re", options: yesNoLater, acceptsFreeText: false) == .option(index: 0, label: "Oui"))
        #expect(VoiceAnswerMatcher.match("3ème", options: yesNoLater, acceptsFreeText: false) == .option(index: 2, label: "Plus tard"))
        #expect(VoiceAnswerMatcher.match("0", options: yesNoLater, acceptsFreeText: true) == .freeText("0"))
        #expect(VoiceAnswerMatcher.match("²", options: yesNoLater, acceptsFreeText: true) == .freeText("²"))
        #expect(VoiceAnswerMatcher.match("la dernière", options: [], acceptsFreeText: false) == .notFound(prompt: "Je n’ai pas reconnu cette option."))
        #expect(VoiceAnswerMatcher.match("deux", options: [], acceptsFreeText: true) == .freeText("deux"))
    }

    @Test("Refus du Mac sans motif, avec motif, avec motif déjà ponctué")
    func macRefusal() {
        #expect(VoiceIssue.macRefused(motive: "  ").phrase == "Le Mac a refusé la demande.")
        #expect(VoiceIssue.macRefused(motive: " feature inconnue ").phrase == "Le Mac a refusé la demande\(nbsp): feature inconnue.")
        #expect(VoiceIssue.macRefused(motive: "feature inconnue…").phrase == "Le Mac a refusé la demande\(nbsp): feature inconnue…")
        #expect(VoiceIssue.macRefused(motive: "déjà arrêtée !").phrase == "Le Mac a refusé la demande\(nbsp): déjà arrêtée !")
    }

    @Test("Version incompatible : trois formes, aucun numéro prononcé")
    func incompatibleVersionForms() {
        let unknown = VoiceIssue.incompatibleVersion(local: 2, remote: nil).phrase
        #expect(unknown == "OMP Console n’a pas la même version sur cet appareil et sur le Mac. Mettez à jour l’app la plus ancienne.")
        #expect(VoiceIssue.incompatibleVersion(local: 2, remote: 2).phrase == unknown)
        #expect(VoiceIssue.incompatibleVersion(local: 1, remote: 2).phrase == "L’app de cet appareil est plus ancienne que celle du Mac. Mettez-la à jour.")
        #expect(VoiceIssue.incompatibleVersion(local: 3, remote: 2).phrase == "OMP Console sur le Mac est plus ancien que l’app de cet appareil. Mettez-le à jour.")
    }

    @Test("Chaque geste a son succès, et une cible vide dit seulement « C’est fait. »")
    func everyGestureSuccess() {
        let phrases = VoiceGesture.allCases.map { VoiceIssue(.sent, gesture: $0, target: " audit UI ").phrase }
        #expect(Set(phrases).count == VoiceGesture.allCases.count)
        #expect(phrases.allSatisfy { $0.contains("audit UI") })
        #expect(VoiceIssue(.sent, gesture: .stopFeature, target: "  ").phrase == "C’est fait.")
    }

    @Test("Un seul reste se dit « et 1 autre »")
    func singleRemainder() {
        let four = (1...4).map { pending(Double($0) * 1000, "f\($0)", .question, "") }
        #expect(VoicePendingSummary.phrase(for: four) == "4 demandes vous attendent\(nbsp): f4, question\(nbsp); f3, question\(nbsp); f2, question\(nbsp); et 1 autre.")
        let cards = (1...4).map { card("feature:depot:audit-\($0)", "audit \($0)") }
        #expect(VoiceFeatureSearch.find("audit", in: cards)
            == .ambiguous(candidates: cards, prompt: "Plusieurs features correspondent\(nbsp): audit 1, audit 2, audit 3 et 1 autre. Laquelle\(nbsp)?"))
        let one = [pending(1000, "  ", .auditEscalation, "  Une\n  question  ")]
        #expect(VoicePendingSummary.phrase(for: one) == "1 demande vous attend\(nbsp): audit, escalade d’audit «\(nbsp)Une question\(nbsp)».")
    }
}
