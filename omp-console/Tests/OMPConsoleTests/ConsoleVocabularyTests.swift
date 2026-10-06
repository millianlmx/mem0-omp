// Preuves du vocabulaire commun (S-11 de omp-console-redesign) : l'état d'une
// carte ou d'un run est un mot doublé d'un ton. Aucune chaîne de Foundation n'est
// figée (Doc-10) : les formateurs sont vérifiés par leurs bornes. L'avancement
// d'une carte (S-14) est une fonction pure de sa colonne, de son maillon et de
// son geste « Reprendre ».

import Foundation
import Testing
@testable import OMPConsole
import ConsoleCore

private func vocabularyCard(
    _ column: KanbanColumn,
    phase: PipelinePhase? = .impl,
    action: KanbanCardAction? = nil,
    marks: [KanbanMark] = []
) -> KanbanCard {
    KanbanCard(
        id: column.rawValue, column: column, repo: "depot", title: "titre", state: "x",
        phase: phase, models: nil, prUrl: nil, startMs: 0, endMs: nil, marks: marks, sources: [],
        action: action
    )
}

private func vocabularyRun(_ state: RunChoiceState, stale: Bool = false) -> RunChoice {
    RunChoice(
        id: "/s.jsonl", sessionFile: "/s.jsonl", label: "depot/f",
        repo: "depot", featureTitle: "f", startedAtMs: 0, phase: .impl,
        state: state, isStale: stale,
        target: ViewerTarget(sessionFile: "/s.jsonl", title: "t")
    )
}

@Test("omp-console-redesign/S-11 : l'état affiché d'une carte et d'un run est un mot doublé d'un ton")
func statusIsAWordDoubledByATone() {
    let expected: [KanbanColumn: ConsoleStatus] = [
        .enAttente: ConsoleStatus(text: "Pas commencée", tone: .neutral),
        .enCours: ConsoleStatus(text: "En cours", tone: .info),
        .questionEnVol: ConsoleStatus(text: "À vous", tone: .attention),
        .prOuverte: ConsoleStatus(text: "PR ouverte", tone: .success),
        .fusionne: ConsoleStatus(text: "Fusionnée", tone: .success),
        .echec: ConsoleStatus(text: "Échec", tone: .danger),
        .jalonSpecs: ConsoleStatus(text: "Specs à valider", tone: .attention),
        .jalonReview: ConsoleStatus(text: "Revue à accepter", tone: .attention),
        .bloquee: ConsoleStatus(text: "Bloquée", tone: .danger),
        .termineeSansPr: ConsoleStatus(text: "Terminée", tone: .neutral),
        .annuleeRetiree: ConsoleStatus(text: "Annulée", tone: .neutral),
    ]
    #expect(expected.count == KanbanColumn.allCases.count)
    for column in KanbanColumn.allCases {
        #expect(ConsoleStatus.of(card: vocabularyCard(column)) == expected[column], "colonne \(column.rawValue)")
    }

    // Le pilote est mort, la feature vit : « En pause », quelle que soit la colonne.
    func dead(_ state: LotFeatureState) -> KanbanCard {
        vocabularyCard(.echec, action: KanbanCardAction(
            repoRoot: "/r", slug: "f", waitKind: nil, featureState: state, run: nil
        ), marks: [.mort])
    }
    #expect(ConsoleStatus.of(card: dead(.running)) == ConsoleStatus(text: "En pause", tone: .paused))
    #expect(ConsoleStatus.of(card: dead(.done)) == ConsoleStatus(text: "Échec", tone: .danger))

    #expect(ConsoleStatus.of(run: vocabularyRun(.live(.running))) == ConsoleStatus(text: "En cours", tone: .info))
    #expect(ConsoleStatus.of(run: vocabularyRun(.live(.waiting))) == ConsoleStatus(text: "À vous", tone: .attention))
    #expect(ConsoleStatus.of(run: vocabularyRun(.live(.running), stale: true)) == ConsoleStatus(text: "Interrompu", tone: .neutral))
    #expect(ConsoleStatus.of(run: vocabularyRun(.ended(.done))) == ConsoleStatus(text: "Terminé", tone: .success))
    #expect(ConsoleStatus.of(run: vocabularyRun(.ended(.failed))) == ConsoleStatus(text: "Échec", tone: .danger))

    // Une durée négative est bornée à zéro (aucune chaîne Foundation figée).
    #expect(ConsoleFormat.duration(ms: -5_000) == ConsoleFormat.duration(ms: 0))
    #expect(ConsoleFormat.duration(ms: .nan) == ConsoleFormat.duration(ms: 0))
}

@Test("audit HIG : au-delà d'une minute, une durée est arrondie à la minute — les secondes ne défilent plus")
func durationDropsSecondsAboveAMinute() {
    // Au-delà d'une minute, les secondes ne comptent plus (Foundation arrondit à
    // la minute la plus proche) ; en deçà, elles restent.
    #expect(ConsoleFormat.duration(ms: 3_610_000) == ConsoleFormat.duration(ms: 3_600_000))
    #expect(ConsoleFormat.duration(ms: 125_000) == ConsoleFormat.duration(ms: 120_000))
    #expect(ConsoleFormat.duration(ms: 59_000) != ConsoleFormat.duration(ms: 58_000))
}

@Test("audit HIG : un compte prend un vrai pluriel, 0 et 1 au singulier")
func countUsesFrenchPlural() {
    #expect(ConsoleFormat.count(0, "souvenir", "souvenirs") == "0 souvenir")
    #expect(ConsoleFormat.count(1, "souvenir", "souvenirs") == "1 souvenir")
    #expect(ConsoleFormat.count(2, "souvenir", "souvenirs") == "2 souvenirs")
}

@Test("audit HIG : un chemin s'affiche relatif à sa racine, sinon sous « ~ »")
func pathIsShortenedForDisplay() {
    let home = NSHomeDirectory()
    #expect(ConsoleFormat.path("/r/depot/src/a.swift", relativeTo: "/r/depot") == "src/a.swift")
    #expect(ConsoleFormat.path("/r/depot", relativeTo: "/r/depot") == "depot")
    #expect(ConsoleFormat.path("/r/depotbis/a", relativeTo: "/r/depot") == "/r/depotbis/a")
    #expect(ConsoleFormat.path(home + "/Experiments/x") == "~/Experiments/x")
    #expect(ConsoleFormat.path("/tmp/x") == "/tmp/x")
}

@Test("omp-console-redesign/S-14 : l'avancement d'une carte suit son étape et son issue")
func progressFollowsTheStepAndTheOutcome() {
    func states(_ card: KanbanCard) -> [PipelineStepState] {
        PipelineProgress.steps(for: card).map(\.state)
    }
    #expect(states(vocabularyCard(.enCours, phase: .impl)) == [.done, .done, .current, .upcoming, .upcoming])
    #expect(states(vocabularyCard(.jalonSpecs, phase: .specs)) == [.done, .current, .upcoming, .upcoming, .upcoming])
    #expect(states(vocabularyCard(.jalonReview, phase: .review)) == [.done, .done, .done, .current, .upcoming])
    #expect(states(vocabularyCard(.prOuverte, phase: .release)) == [.done, .done, .done, .done, .current])
    #expect(states(vocabularyCard(.fusionne, phase: .release)) == [.done, .done, .done, .done, .done])
    #expect(states(vocabularyCard(.echec, phase: .impl)) == [.done, .done, .failed, .upcoming, .upcoming])
    // Le pilote est mort, la feature vit : l'étape reste en cours, « Reprendre » la relance.
    let resumable = vocabularyCard(.echec, phase: .impl, action: KanbanCardAction(
        repoRoot: "/r", slug: "f", waitKind: nil, featureState: .running, run: nil
    ), marks: [.mort])
    #expect(states(resumable) == [.done, .done, .current, .upcoming, .upcoming])
    #expect(states(vocabularyCard(.enAttente, phase: nil)) == [.upcoming, .upcoming, .upcoming, .upcoming, .upcoming])
    #expect(states(vocabularyCard(.termineeSansPr, phase: .release)) == [.done, .done, .done, .done, .upcoming])
    #expect(states(vocabularyCard(.annuleeRetiree, phase: .specs)) == [.done, .upcoming, .upcoming, .upcoming, .upcoming])
}
