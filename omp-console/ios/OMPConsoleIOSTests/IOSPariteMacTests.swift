// La parité Mac ↔ iOS des voies, des noms et libellés de modèles et des
// libellés de dépôts (feature parite-mac-des-correctifs-ios, S-10) : les MÊMES
// attentes E-1…E-9 que la suite macOS `PariteMacTests`, depuis les mêmes
// entrées partagées de `ConsoleCore`.

import ConsoleCore
import Testing

@MainActor
@Suite("parite-mac-des-correctifs-ios")
struct IOSPariteMacTests {
    private func card(models: ModelSlots?) -> KanbanCard {
        KanbanCard(
            id: "feature:parite:alpha", column: .enCours, repo: "mem0-omp", title: "alpha", state: "en cours",
            phase: .impl, models: models, prUrl: nil, startMs: 0, endMs: nil, marks: [], sources: []
        )
    }

    private var board: KanbanBoard { KanbanBoardParity.board }

    @Test("parite-mac-des-correctifs-ios/AC-11 : E-1, en disposition condensée, les voies vides sont écartées et Livrées, Arrêtées repliées")
    func condensedHidesEmptyAndFoldsTerminalLanes() {
        let rows = KanbanLaneRows.rows(board.lanes, layout: .condensed, unfolded: [])
        #expect(rows.map(\.lane) == [.enCours, .aVous, .livrees, .arretees])
        #expect(rows.map(\.content.cards.count) == [3, 2, 100, 2])
        #expect(rows.map(\.folded) == [false, false, true, true])
        #expect(rows.map(\.foldable) == [false, false, true, true])
        for row in rows where row.foldable {
            #expect(row.visibleCards.isEmpty, "une voie repliée ne rend aucune carte")
        }
        #expect(KanbanLaneRows.foldable == [.livrees, .arretees])
    }

    @Test("parite-mac-des-correctifs-ios/AC-11 : E-2, une voie dépliée rend toutes ses cartes, l'autre reste repliée")
    func condensedUnfoldsOnlyTheChosenLane() {
        let rows = KanbanLaneRows.rows(board.lanes, layout: .condensed, unfolded: [.livrees])
        #expect(rows.map(\.folded) == [false, false, false, true])
        let livrees = rows.first { $0.lane == .livrees }
        #expect(livrees?.visibleCards.count == 100)
        #expect(rows.first { $0.lane == .arretees }?.visibleCards.isEmpty == true)
    }

    @Test("parite-mac-des-correctifs-ios/AC-11 et AC-4 : E-3, en disposition complète (iPad), toutes les voies restent, dépliées")
    func fullKeepsEveryLaneUnfolded() {
        for unfolded: Set<KanbanLane> in [[], [.livrees], Set(KanbanLane.allCases)] {
            let rows = KanbanLaneRows.rows(board.lanes, layout: .full, unfolded: unfolded)
            #expect(rows.map(\.content) == board.lanes)
            #expect(rows.count == 5)
            #expect(rows.first?.lane == .pasCommencees)
            #expect(rows.first?.content.cards.isEmpty == true, "« Pas commencées » vide reste rendue")
            #expect(rows.allSatisfy { !$0.foldable && !$0.folded && $0.visibleCards == $0.content.cards })
        }
    }

    @Test("parite-mac-des-correctifs-ios/AC-11 : E-4, les dépôts sont nommés par leur dossier, les homonymes par « nom (parent) »")
    func repoLabelsAreFolderNames() {
        let labels = KanbanLaunchRepos.choices(KanbanLabelParity.repoRoots).map(\.label)
        #expect(labels == ["mem0-omp (Projets)", "mem0-omp (Archives)", "site-vitrine"])
    }

    @Test("parite-mac-des-correctifs-ios/AC-11 : E-5, les options de modèle sont nommées et deux options ne se lisent jamais pareil")
    func choiceLabelsDisambiguateSharedNames() {
        let labels = ModelCatalog.choiceLabels(KanbanLabelParity.modelSelectors, names: KanbanLabelParity.modelNames)
        #expect(labels == [
            "anthropic/claude-opus-4-7": "Claude Opus 4.7 (anthropic)",
            "anthropic/claude-opus-5-5": "Claude Opus 5.5",
            "github-copilot/claude-opus-4.7": "Claude Opus 4.7 (github-copilot)",
            "github-copilot/gpt-4o": "GPT-4o (gpt-4o)",
            "github-copilot/gpt-4o-2024-05-13": "GPT-4o (gpt-4o-2024-05-13)",
            "lm-studio/qwen3-coder-30b": "lm-studio/qwen3-coder-30b",
        ])
        #expect(Set(labels.values).count == labels.count)
        let doubled = ModelCatalog.choiceLabels(KanbanLabelParity.modelSelectors + KanbanLabelParity.modelSelectors, names: KanbanLabelParity.modelNames)
        #expect(doubled == labels, "un sélecteur répété n'ajoute aucune option")
        let bare = ModelCatalog.choiceLabels(KanbanLabelParity.modelSelectors, names: nil)
        #expect(bare.allSatisfy { $0.key == $0.value }, "sans catalogue de noms, chaque option garde son sélecteur")
    }

    @Test("parite-mac-des-correctifs-ios/AC-11 : E-6, les lignes de modèle d'une carte portent le libellé de groupe et le nom lisible")
    func modelLinesUseGroupLabelsAndNames() {
        let names = KanbanLabelParity.modelNames
        #expect(KanbanCardPresentation.modelLines(card(models: KanbanLabelParity.models), names: names) == KanbanModelLines(
            reqSpecs: "Modèle /req et /specs : Claude Opus 5.5",
            implReview: "Modèle /impl et /review : lm-studio/qwen3-coder-30b"
        ))
        #expect(KanbanCardPresentation.modelLines(card(models: KanbanLabelParity.models), names: nil)?.reqSpecs
            == "Modèle /req et /specs : anthropic/claude-opus-5-5")
        let noReview = ModelSlots(reqSpecs: "anthropic/claude-opus-5-5", implReview: nil)
        #expect(KanbanCardPresentation.modelLines(card(models: noReview), names: names)?.implReview
            == "Modèle /impl et /review : défaut OMP")
        #expect(KanbanCardPresentation.modelLines(card(models: nil), names: names) == nil)
    }

    @Test("parite-mac-des-correctifs-ios/AC-11 : E-7, un nom blanc retombe sur le sélecteur")
    func blankNameFallsBackToSelector() {
        #expect(ModelCatalog.displayName("lm-studio/blanc", names: KanbanLabelParity.modelNames) == "lm-studio/blanc")
        #expect(ModelCatalog.displayName("anthropic/claude-opus-5-5", names: KanbanLabelParity.modelNames) == "Claude Opus 5.5")
        #expect(ModelCatalog.displayName("anthropic/claude-opus-5-5", names: nil) == "anthropic/claude-opus-5-5")
    }

    @Test("parite-mac-des-correctifs-ios/AC-11 : E-8, le modèle d'une session se nomme par fournisseur et id, jamais par un id nu deviné")
    func sessionModelNameNeedsTheProvider() {
        let names = KanbanLabelParity.modelNames
        #expect(ModelCatalog.sessionModelName(model: "claude-opus-5-5", provider: "anthropic", names: names) == "Claude Opus 5.5")
        #expect(ModelCatalog.sessionModelName(model: "claude-opus-5-5", provider: nil, names: names) == "claude-opus-5-5")
        #expect(ModelCatalog.sessionModelName(model: "claude-opus-5-5", provider: "  ", names: names) == "claude-opus-5-5")
        #expect(ModelCatalog.sessionModelName(model: "anthropic/claude-opus-5-5", provider: nil, names: names) == "Claude Opus 5.5")
        #expect(ModelCatalog.sessionModelName(model: "claude-opus-5-5", provider: "anthropic", names: nil) == "claude-opus-5-5")
    }

    @Test("parite-mac-des-correctifs-ios/AC-11 : E-9, la ligne des deux modèles du plan porte les libellés de groupe")
    func modelsLineUsesGroupLabels() {
        #expect(KanbanText.modelsLine(KanbanLabelParity.models)
            == "Modèle /req et /specs : anthropic/claude-opus-5-5 · Modèle /impl et /review : lm-studio/qwen3-coder-30b")
        #expect(KanbanText.modelReqSpecs == "Modèle /req et /specs")
        #expect(KanbanText.modelImplReview == "Modèle /impl et /review")
    }
}
