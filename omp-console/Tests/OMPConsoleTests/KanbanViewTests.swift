// Preuves de la SURFACE de la section Kanban (BR-4) : les onze colonnes nommées et
// ordonnées (AC-1), les messages d'état exacts (AC-14), et la déclaration de
// section de la vue.
//
// Les vues SwiftUI ne se rendent pas sous les Command Line Tools : ce qui se
// vérifie ici est ce qu'elles LISENT (les colonnes du modèle, les messages), le
// rendu graphique lui-même relevant de la recette manuelle de BR-6.

import Testing
@testable import OMPConsole

// `@MainActor` : `KanbanView` est une vue SwiftUI, donc isolée au fil principal
// (Swift 6) — lire sa `section` statique depuis un test non isolé avertirait.
@MainActor
@Test("kanban-des-pipelines/AC-1 : les onze colonnes sont nommées d'après leur état et ordonnées")
func columnsAreNamedAndOrdered() {
    #expect(KanbanColumn.allCases.map(\.title) == [
        "En attente",
        "En cours",
        "Question en vol",
        "PR ouverte",
        "Fusionné",
        "Échec",
        "Jalon specs",
        "Jalon review",
        "Bloquée",
        "Terminée sans PR",
        "Annulée / retirée",
    ])
    // Le `rawValue` EST l'identifiant d'accessibilité `kanban.column.<rawValue>` :
    // une colonne renommée changerait l'identifiant lu par la sonde AX.
    #expect(KanbanColumn.allCases.map(\.rawValue) == [
        "en-attente",
        "en-cours",
        "question-en-vol",
        "pr-ouverte",
        "fusionne",
        "echec",
        "jalon-specs",
        "jalon-review",
        "bloquee",
        "terminee-sans-pr",
        "annulee-retiree",
    ])
}

@MainActor
@Test("kanban-des-pipelines/AC-14 : les messages d'état de la vue sont exacts et portent le chemin")
func stateMessagesAreExact() {
    #expect(KanbanBoardState.loadingText == "Chargement du magasin d'état…")
    #expect(KanbanBoardState.absentText(dir: "/tmp/etat") == "Magasin d'état absent : /tmp/etat")
    #expect(KanbanBoardState.emptyText(dir: "/tmp/etat") == "Magasin d'état vide : /tmp/etat")
    #expect(KanbanBoardState.emptySelectionText == "Aucune carte sélectionnée")
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
        phase: .impl, model: nil, prUrl: nil, startMs: 0, endMs: nil,
        marks: [.illisible, .mort, .doublon], sources: []
    )
    #expect(card.marksText == "illisible, mort, doublon")
    #expect(card.phaseText == "/impl")
    #expect(card.modelText == "modèle : absent")
    #expect(card.prText == "PR : absente")
    // Une carte saine n'affiche aucune ligne de marques.
    var healthy = card
    healthy.marks = []
    #expect(healthy.marksText == nil)
}

@Test("kanban-des-pipelines/AC-7 : le panneau de détail décrit la carte ligne par ligne")
func detailLinesMatchTheContract() {
    let card = KanbanCard(
        id: "feature:abc:s", column: .jalonSpecs, repo: "depot", title: "s ← amont",
        state: "attend validation", phase: .specs, model: "opus", prUrl: nil,
        startMs: 1_000, endMs: nil,
        marks: [.mort],
        sources: [
            KanbanSource(kind: .lot, ref: "lots/abc.json · feature « s »"),
            KanbanSource(kind: .run, ref: "running/deadbeef00000000.json"),
        ]
    )
    #expect(KanbanDetail.lines(for: card, nowMs: 4_000) == [
        "depot · s ← amont",
        "État : attend validation",
        "Maillon : /specs",
        "Modèle : opus",
        "PR : absente",
        "Durée : 0:03",
        "Marques : mort",
        "Sources :",
        "  · lots/abc.json · feature « s »",
        "  · running/deadbeef00000000.json",
    ])
    // Le panneau dit l'ABSENCE quand la carte n'a ni modèle ni URL.
    var bare = card
    bare.model = nil
    bare.prUrl = nil
    #expect(KanbanDetail.lines(for: bare, nowMs: 4_000)[3] == "Modèle : absent")
    #expect(KanbanDetail.lines(for: bare, nowMs: 4_000)[4] == "PR : absente")
}
