// La garde de parité de l'Accueil macOS ↔ iOS (S-2, S-5, S-6) : depuis le MÊME
// fixture partagé que l'app iOS (`HomeParity.snapshot` / `HomeParity.contractMarkdown`,
// déclarés dans `ConsoleCore`), la coque macOS dérive les mêmes faits, le même
// bandeau de lancement et le même découpage de contrat que ceux qu'assertent les
// suites iOS. C'est la preuve que « le garde automatisé de parité » (AC-1) porte
// sur des faits partagés, pas sur deux recopies.
//
// Aucune vue n'est rendue : tout passe par les fonctions PURES de `ConsoleCore`
// (`KanbanBoardState.derive`, `HomePresentation`, `HomeText`, `ContractDocument`).

import ConsoleCore
import Foundation
import Testing

/// L'horloge FIXE de la dérivation : celle des horodatages du fixture, pour que
/// le rendu ne dépende jamais de l'heure qu'il est.
private let parityNowMs: Double = 1_700_000_000_000

/// L'état du binaire OMP présenté à l'Accueil, comme la coque macOS le résout.
private let parityOmp = OmpStatus.available(URL(fileURLWithPath: "/usr/bin/omp"))

/// L'ardoise dérivée du fixture partagé, horloge fixe et `stateDir` vide (le cas
/// de l'app iOS, qui ne connaît aucun répertoire d'état local).
private func parityBoard() -> KanbanBoardState {
    KanbanBoardState.derive(
        snapshot: HomeParity.snapshot,
        nowMs: parityNowMs,
        stateDir: "",
        isAlive: .transported(HomeParity.snapshot),
        prFacts: [:]
    )
}

@Suite("Parité de l'Accueil (fixture partagée)")
struct HomeParityTests {
    @Test("ios-accueil/AC-1, accueil-en-cours-melange-pause-et-compte/AC-3 : les cinq faits d'attention du fixture partagé")
    func attentionFacts() throws {
        let board = parityBoard()
        #expect(HomePresentation.attentionCount(omp: parityOmp, board: board) == 5)

        guard case .dashboard(let dashboard) = HomePresentation.state(omp: parityOmp, board: board) else {
            Issue.record("le fixture partagé doit donner un tableau de bord")
            return
        }
        let attention = dashboard.attention
        // L'ordre est celui de l'ardoise (features de lot avant les runs).
        #expect(attention.map(\.nature) == [.milestoneSpecs, .milestoneReview, .failed, .blocked, .question])
        #expect(
            attention.map { HomeText.natureText($0.nature) }
                == ["Specs à valider", "Revue à accepter", "En échec", "Bloquée", "Question"]
        )
        // La question en vol porte SA question et ses deux options ; les deux
        // jalons portent l'invite partagée de leur nature.
        let question = try #require(attention.first { $0.nature == .question })
        let specs = try #require(attention.first { $0.nature == .milestoneSpecs })
        let review = try #require(attention.first { $0.nature == .milestoneReview })
        #expect(question.prompt == "On livre avec le drapeau activé ?")
        #expect(question.card.action?.run?.pendingAsk?.options.map(\.label) == ["Avec le drapeau", "Sans le drapeau"])
        #expect(specs.prompt == HomeText.specsPrompt)
        #expect(review.prompt == HomeText.reviewPrompt)
        // AC-3 : l'échec et le blocage disent leur étape, offrent la relance, et
        // ne paraissent dans aucune autre section.
        let failed = try #require(attention.first { $0.nature == .failed })
        let blocked = try #require(attention.first { $0.nature == .blocked })
        #expect(failed.card.title == "cache-sessions")
        #expect(failed.prompt == "L'étape « Implémentation » s'est arrêtée en échec.")
        #expect(blocked.card.title == "export-csv")
        #expect(blocked.prompt == "La pipeline est bloquée à l'étape « Spécification ».")
        #expect(HomePresentation.cardAction(failed) == .relaunch)
        #expect(HomePresentation.cardAction(blocked) == .relaunch)
        let others = Set((dashboard.running + dashboard.paused + dashboard.notStarted + dashboard.delivered).map(\.id))
        #expect(!others.contains(failed.id) && !others.contains(blocked.id))
    }

    @Test("ios-accueil/AC-1 : showsRepo vrai et deux livraisons récentes")
    func deliveredAndRepo() {
        guard case .dashboard(let dashboard) = HomePresentation.state(omp: parityOmp, board: parityBoard()) else {
            Issue.record("le fixture partagé doit donner un tableau de bord")
            return
        }
        // Au moins deux dépôts à l'écran : le dépôt se lit sous chaque carte.
        #expect(HomePresentation.showsRepo(dashboard) == true)
        // Une feature de projet livrée (`prUrl`) et une feature de lot `done`
        // (`prUrl`) ; l'entrée d'historique terminée est en `.termineeSansPr`,
        // donc jamais comptée (comportement inchangé de `HomePresentation`).
        #expect(dashboard.delivered.count == 2)
        #expect(Set(dashboard.delivered.compactMap(\.prUrl)) == Set([
            "https://example.com/pr/42",
            "https://example.com/pr/43",
        ]))
    }

    @Test("accueil-en-cours-melange-pause-et-compte/AC-1 : deux « En cours » vivants, la pause sous « À reprendre », la feature jamais lancée sous « Pas commencées »")
    func runningPausedAndNotStarted() {
        guard case .dashboard(let dashboard) = HomePresentation.state(omp: parityOmp, board: parityBoard()) else {
            Issue.record("le fixture partagé doit donner un tableau de bord")
            return
        }
        #expect(dashboard.running.map(\.id) == ["run:aaaaaaaaaaaaaaa2", "run:aaaaaaaaaaaaaaa3"])
        #expect(!dashboard.running.contains { KanbanActionPresentation.resumable($0) })
        #expect(!dashboard.running.contains { $0.column == .enAttente })
        // La pause : le lot `beta` au pilote mort, feature `reprise`.
        #expect(dashboard.paused.map(\.title) == ["reprise"])
        #expect(dashboard.paused.first?.repo == "beta")
        #expect(dashboard.paused.allSatisfy { KanbanActionPresentation.resumable($0) })
        #expect(dashboard.paused.map { ConsoleStatus.of(card: $0).text } == ["En pause"])
        #expect(dashboard.notStarted.map(\.title) == ["theme-sombre"])
        // Aucune carte dans deux sections.
        let all = (dashboard.attention.map(\.card) + dashboard.running + dashboard.paused
            + dashboard.notStarted + dashboard.delivered).map(\.id)
        #expect(Set(all).count == all.count)
        #expect(HomePresentation.counts(HomeParityTests.unwrap(parityBoard())) == HomeCounts(attention: 5, running: 2))
    }

    @Test("accueil-en-cours-melange-pause-et-compte/S-8 : HomeParity.board est l'ardoise de parité ; menuBarBoard et pausedOnlyBoard donnent (1, 2) et (0, 0)")
    func menuBarBoards() {
        #expect(HomeParity.board == parityBoard())
        #expect(HomePresentation.counts(Self.unwrap(HomeParity.menuBarBoard)) == HomeCounts(attention: 1, running: 2))
        #expect(HomePresentation.counts(Self.unwrap(HomeParity.pausedOnlyBoard)) == .zero)
        let paused = HomePresentation.dashboard(Self.unwrap(HomeParity.pausedOnlyBoard))
        #expect(paused.paused.count == 1 && paused.notStarted.count == 1)
    }

    private static func unwrap(_ state: KanbanBoardState) -> KanbanBoard {
        guard case .board(let board) = state else {
            Issue.record("la fixture doit donner une ardoise")
            return KanbanBoard(cards: [], anomalies: [])
        }
        return board
    }

    @Test("ios-accueil/AC-13 : le bandeau de lancement rend la phrase partagée, et le masquage le retire")
    func launchBanner() {
        let older = ActionJournalEntry(
            id: "j-reponse",
            kindLabel: "réponse",
            targetLabel: "autre",
            state: .delivered,
            at: parityNowMs
        )
        let first = ActionJournalEntry(
            id: "j-lancement-1",
            kindLabel: ActionsText.launchLabel,
            targetLabel: "ma-feature",
            state: .taken,
            at: parityNowMs
        )
        // La PLUS RÉCENTE est en tête du journal : c'est elle qui est retenue.
        let latest = ActionJournalEntry(
            id: "j-lancement-2",
            kindLabel: ActionsText.launchLabel,
            targetLabel: "recente",
            state: .awaitingAck,
            at: parityNowMs
        )
        let journal = [latest, first, older]

        #expect(HomePresentation.launchBannerEntry(journal: journal, dismissedID: nil)?.id == "j-lancement-2")
        // Journal vide ou sans entrée de lancement : aucun bandeau.
        #expect(HomePresentation.launchBannerEntry(journal: [], dismissedID: nil) == nil)
        #expect(HomePresentation.launchBannerEntry(journal: [older], dismissedID: nil) == nil)
        // Masquer la plus récente la retire ; masquer une autre la laisse.
        #expect(HomePresentation.launchBannerEntry(journal: journal, dismissedID: "j-lancement-2") == nil)
        #expect(HomePresentation.launchBannerEntry(journal: journal, dismissedID: "j-lancement-1")?.id == "j-lancement-2")

        // La phrase rendue pour l'entrée retenue, des deux états testables.
        #expect(
            HomeText.launchBanner(title: "ma-feature", state: .taken)
                == "Pipeline « ma-feature » lancée : la collecte des besoins démarre."
        )
        #expect(
            HomeText.launchBanner(title: "ma-feature", state: .refused(reason: nil))
                == "Lancement de « ma-feature » refusé."
        )
    }

    @Test("ios-accueil/AC-8 : le découpage du contrat partagé rend les sections requises verbatim")
    func contractSections() {
        #expect(ContractDocument.titles(for: .specs) == ["Spécifications", "Lots"])
        #expect(ContractDocument.titles(for: .besoins) == ["Besoins", "Critères d'acceptation"])

        let lots = ContractDocument.section(in: HomeParity.contractMarkdown, title: "Lots")
        #expect(lots.title == "Lots")
        // Texte VERBATIM : de la ligne du titre incluse à la fin du fichier.
        #expect(lots.text == "## Lots\n\n- BR-1 : déplacer le noyau de l'Accueil dans ConsoleCore.")

        // Le découpage complet d'un moment rend les DEUX sections requises, dans
        // l'ordre de `titles(for:)`. Le texte d'une section va de la ligne du titre
        // à la ligne qui PRÉCÈDE le titre suivant : il inclut donc la ligne vide
        // qui sépare les deux sections (sauf pour la dernière, qui va jusqu'à la
        // fin du fichier).
        #expect(
            ContractDocument.content(markdown: HomeParity.contractMarkdown, moment: .specs)
                == .sections([
                    ContractSection(
                        title: "Spécifications",
                        text: "## Spécifications\n\n- Une seule dérivation partagée, `HomePresentation`.\n\n"
                    ),
                    ContractSection(
                        title: "Lots",
                        text: "## Lots\n\n- BR-1 : déplacer le noyau de l'Accueil dans ConsoleCore."
                    ),
                ])
        )
    }
}
