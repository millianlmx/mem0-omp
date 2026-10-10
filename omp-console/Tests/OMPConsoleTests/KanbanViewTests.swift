// Preuves de la SURFACE de la section Kanban (BR-4) : les treize colonnes et leurs
// identifiants (AC-1), la déclaration de section de la vue et le badge d'état
// d'une carte.
//
// Les vues SwiftUI ne se rendent pas sous les Command Line Tools : ce qui se
// vérifie ici est ce qu'elles LISENT (les colonnes du modèle, les messages), le
// rendu graphique lui-même relevant de la recette manuelle de BR-6.

import Testing
@testable import OMPConsole
@testable import ConsoleCore

// `@MainActor` : `KanbanView` est une vue SwiftUI, donc isolée au fil principal
// (Swift 6) — lire sa `section` statique depuis un test non isolé avertirait.
@MainActor
@Test("kanban-des-pipelines/AC-1 : les treize colonnes sont ordonnées et identifiées")
func columnsAreOrdered() {
    // L'ordre des colonnes ordonne les cartes DANS une voie : le changer
    // changerait l'ordre lu à l'écran et par le clavier.
    #expect(KanbanColumn.allCases.map(\.rawValue) == [
        "en-attente",
        "en-cours",
        "question-en-vol",
        "pr-ouverte",
        "pr-creee",
        "fusionne",
        "pr-fermee",
        "echec",
        "jalon-specs",
        "jalon-review",
        "bloquee",
        "terminee-sans-pr",
        "annulee-retiree",
    ])
}

@MainActor
@Test("kanban-des-pipelines/AC-8 : la vue Kanban déclare la section Kanban")
func kanbanViewDeclaresItsSection() {
    #expect(KanbanView.section == .kanban)
}

@Test("kanban-des-pipelines/AC-11 : les marques d'une carte s'affichent dans l'ordre illisible, mort, doublon")
func marksTextIsOrdered() {
    let card = KanbanCard(
        id: "run:x", column: .echec, repo: "depot", title: "depot/x", state: "tourne",
        phase: .impl, models: nil, prUrl: nil, startMs: 0, endMs: nil,
        marks: [.illisible, .mort, .doublon], sources: []
    )
    #expect(card.marksText == "illisible, mort, doublon")
    #expect(card.phaseText == "/impl")
    // Une carte saine n'affiche aucune ligne de marques.
    var healthy = card
    healthy.marks = []
    #expect(healthy.marksText == nil)
}

@Test("jargon-technique-expose-mac-et-ios/AC-5 : la carte iOS dit ses marques par une phrase lisible, jamais par la marque brute")
func marksSentenceIsReadable() {
    #expect(KanbanText.marksSentence([.mort]) == "Elle s’est arrêtée de façon inattendue.")
    #expect(KanbanText.markSentence(.illisible) == "Une partie de ses données est illisible.")
    #expect(KanbanText.markSentence(.doublon) == "Deux sources la décrivent.")
    // Une carte saine n'affiche aucune ligne.
    #expect(KanbanText.marksSentence([]) == nil)
    // Plusieurs marques : les phrases dans l'ordre des marques, jointes par une espace.
    let all = KanbanText.marksSentence(KanbanMark.allCases)
    #expect(all == "Une partie de ses données est illisible. Elle s’est arrêtée de façon inattendue. Deux sources la décrivent.")
    // Jamais la forme brute : ni « Marques », ni la liste `marksText`, ni les
    // marques `mort` et `doublon` comme mots (« illisible » reste un adjectif
    // français dans sa phrase, pas une marque).
    #expect(all?.contains("Marques") == false)
    let card = KanbanCard(
        id: "run:x", column: .echec, repo: "depot", title: "depot/x", state: "tourne",
        phase: .impl, models: nil, prUrl: nil, startMs: 0, endMs: nil,
        marks: KanbanMark.allCases, sources: []
    )
    #expect(all?.contains(card.marksText ?? "") == false)
    for raw in [KanbanMark.mort.rawValue, KanbanMark.doublon.rawValue] {
        #expect(all?.range(of: "\\b\(raw)\\b", options: .regularExpression) == nil)
    }
    for mark in KanbanMark.allCases {
        let sentence = KanbanText.markSentence(mark)
        #expect(sentence != mark.rawValue)
        #expect(sentence.first?.isUppercase == true)
        #expect(sentence.hasSuffix("."))
    }
}

private func laneCard(_ column: KanbanColumn, id: String = "feature:k:export", marks: [KanbanMark] = []) -> KanbanCard {
    let action = KanbanCardAction(
        repoRoot: "/tmp/depot", slug: "export", waitKind: nil, featureState: .running, run: nil
    )
    return KanbanCard(
        id: id, column: column, repo: "depot", title: "export", state: "tourne",
        phase: .impl, models: nil, prUrl: nil, startMs: 0, endMs: nil,
        marks: marks, sources: [], action: action
    )
}

@Test("pipelines/voies : chaque colonne de l'ardoise tombe dans la voie de son cours, une feature en pause reste en cours")
func everyColumnHasItsLane() {
    let expected: [KanbanColumn: KanbanLane] = [
        .enAttente: .pasCommencees, .enCours: .enCours,
        .questionEnVol: .aVous, .jalonSpecs: .aVous, .jalonReview: .aVous,
        .prOuverte: .livrees, .prCreee: .livrees, .fusionne: .livrees, .prFermee: .livrees,
        .termineeSansPr: .livrees,
        .echec: .arretees, .bloquee: .arretees, .annuleeRetiree: .arretees,
    ]
    for column in KanbanColumn.allCases {
        var card = laneCard(column)
        card.action = nil
        #expect(KanbanLane.of(card) == expected[column], "colonne \(column.rawValue)")
    }
    // Le pilote est mort, la feature vit : « En pause », donc en cours — pas en échec.
    let paused = laneCard(.echec, marks: [.mort])
    #expect(KanbanLane.of(paused) == .enCours)
    #expect(KanbanCardPresentation.badge(paused)?.tone == .paused)
}

@Test("pipelines/voies : les voies permanentes restent même vides, « Arrêtées » seulement si elle a des cartes")
func lanesKeepPermanentOnes() {
    let empty = KanbanBoard(cards: [], anomalies: [])
    #expect(empty.lanes.map(\.lane) == [.pasCommencees, .enCours, .aVous, .livrees])
    var failed = laneCard(.echec, id: "f")
    failed.action = nil
    let review = laneCard(.jalonReview, id: "r")
    let question = laneCard(.questionEnVol, id: "q")
    let board = KanbanBoard(cards: [review, failed, question], anomalies: [])
    #expect(board.lanes.map(\.lane) == [.pasCommencees, .enCours, .aVous, .livrees, .arretees])
    // Dans une voie : l'ordre des colonnes (question avant revue), pas celui de l'ardoise.
    #expect(board.lanes.first { $0.lane == .aVous }?.cards.map(\.id) == ["q", "r"])
}

@Test("pipelines/cartes : le badge ne répète jamais la voie")
func cardBadgeNeverRepeatsTheLane() {
    var running = laneCard(.enCours)
    #expect(KanbanCardPresentation.badge(running) == nil)
    running.column = .enAttente
    running.action = nil
    #expect(KanbanCardPresentation.badge(running) == nil)
    // « À vous » dans « À vous » : la nature de l'attente le remplace.
    #expect(KanbanCardPresentation.badge(laneCard(.questionEnVol))?.text != KanbanLane.aVous.title)
    #expect(KanbanCardPresentation.badge(laneCard(.jalonSpecs)) == ConsoleStatus.of(card: laneCard(.jalonSpecs)))
    // La durée ne s'affiche que pour ce qui tourne ou attend.
    #expect(KanbanCardPresentation.showsDuration(laneCard(.enCours)))
    #expect(!KanbanCardPresentation.showsDuration(laneCard(.prOuverte)))
}
