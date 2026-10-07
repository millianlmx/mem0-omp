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
        isAlive: .transported(HomeParity.snapshot)
    )
}

@Suite("Parité de l'Accueil (fixture partagée)")
struct HomeParityTests {
    @Test("ios-accueil/AC-1 : les trois faits d'attention du fixture partagé")
    func attentionFacts() throws {
        let board = parityBoard()
        #expect(HomePresentation.attentionCount(omp: parityOmp, board: board) == 3)

        guard case .dashboard(let dashboard) = HomePresentation.state(omp: parityOmp, board: board) else {
            Issue.record("le fixture partagé doit donner un tableau de bord")
            return
        }
        let attention = dashboard.attention
        #expect(attention.count == 3)
        // L'ordre est celui de l'ardoise (features de lot avant les runs) : les
        // trois NATURES y sont, chacune avec le libellé partagé de son mot.
        #expect(Set(attention.map(\.nature)) == Set([.question, .milestoneSpecs, .milestoneReview]))
        #expect(
            Set(attention.map { HomeText.natureText($0.nature) })
                == Set(["Question", "Specs à valider", "Revue à accepter"])
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

    @Test("ios-accueil/AC-2 : deux lignes « En cours », dont le lot au pilote mort offre « Reprendre »")
    func runningAndResume() {
        guard case .dashboard(let dashboard) = HomePresentation.state(omp: parityOmp, board: parityBoard()) else {
            Issue.record("le fixture partagé doit donner un tableau de bord")
            return
        }
        #expect(dashboard.running.count == 2)
        // Un seul lot est `resumable` : celui dont le pilote est mort (lot
        // `beta`, feature `reprise` rangée en `.echec`).
        let resumable = dashboard.running.filter { KanbanActionPresentation.resumable($0) }
        #expect(resumable.count == 1)
        #expect(resumable.first?.repo == "beta")
        #expect(resumable.first?.title == "reprise")
        // L'autre ligne est le run VIVANT, et n'offre jamais « Reprendre ».
        #expect(dashboard.running.filter { !KanbanActionPresentation.resumable($0) }.map(\.id) == ["run:aaaaaaaaaaaaaaa2"])
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
