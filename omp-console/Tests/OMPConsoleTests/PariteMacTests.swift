// La parité Mac ↔ iOS des voies, des noms et libellés de modèles et des
// libellés de dépôts (feature parite-mac-des-correctifs-ios, S-10) : depuis les
// ENTRÉES partagées de `ConsoleCore` (`KanbanBoardParity`, `KanbanLabelParity`),
// la coque macOS épingle les sorties E-1…E-9, mot pour mot celles de la suite
// iOS `IOSPariteMacTests`. Un même jeu d'entrée, les mêmes libellés.

import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

@MainActor
@Suite("parite-mac-des-correctifs-ios")
struct PariteMacTests {
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

    // MARK: - Voies Mac (BR-2 : S-1, S-2)

    /// Le tableau Mac posé sur l'ardoise de parité, sans magasin ni `gh`.
    private func kanbanModel() -> KanbanModel {
        let fixture = StoreFixture(stores: [])
        let model = KanbanModel(
            hub: StoreHub(stateDir: fixture.root, nowMs: { fixtureT0 }),
            prStates: PullRequestStateBook(reader: nil),
            recipeBoard: .board(KanbanBoardParity.board)
        )
        model.start()
        return model
    }

    private func cards(_ lane: KanbanLane) -> [KanbanCard] {
        board.lanes.first { $0.lane == lane }?.cards ?? []
    }

    @Test("parite-mac-des-correctifs-ios/AC-1 : sur Mac, une voie sans carte n'est pas rendue")
    func macHidesEmptyLanes() {
        let model = kanbanModel()
        defer { model.stop() }
        // L'ardoise de parité porte bien une voie vide : « Pas commencées ».
        #expect(board.lanes.contains { $0.lane == .pasCommencees && $0.cards.isEmpty })
        let rows = model.laneRows
        #expect(rows.map(\.lane) == [.enCours, .aVous, .livrees, .arretees])
        #expect(!rows.contains { $0.lane == .pasCommencees })
        #expect(rows.allSatisfy { !$0.content.cards.isEmpty }, "aucune voie vide, donc aucun texte de voie vide")
        // Hors de l'ardoise, aucune rangée.
        let loading = KanbanModel(
            hub: StoreHub(stateDir: StoreFixture(stores: []).root, nowMs: { fixtureT0 }),
            prStates: PullRequestStateBook(reader: nil)
        )
        #expect(loading.laneRows.isEmpty)
    }

    @Test("parite-mac-des-correctifs-ios/AC-2 : sur Mac, Livrées et Arrêtées s'ouvrent repliées, en-tête et compteur seuls")
    func macFoldsTerminalLanes() {
        let model = kanbanModel()
        defer { model.stop() }
        #expect(model.unfoldedLanes.isEmpty)
        let rows = model.laneRows
        let livrees = rows.first { $0.lane == .livrees }
        let arretees = rows.first { $0.lane == .arretees }
        #expect(livrees?.foldable == true && livrees?.folded == true)
        #expect(arretees?.foldable == true && arretees?.folded == true)
        #expect(livrees?.visibleCards.isEmpty == true)
        #expect(arretees?.visibleCards.isEmpty == true)
        // Le compteur de l'en-tête reste le total de la voie.
        #expect(livrees?.content.cards.count == 100)
        #expect(arretees?.content.cards.count == 2)
        // Les autres voies restent dépliées, sans bouton.
        for row in rows where row.lane == .enCours || row.lane == .aVous {
            #expect(!row.foldable && !row.folded && row.visibleCards == row.content.cards)
        }
    }

    @Test("parite-mac-des-correctifs-ios/AC-3 : Livrées dépliée sur Mac est de nouveau repliée au retour dans Pipelines")
    func macRefoldsOnEachVisit() {
        let model = kanbanModel()
        defer { model.stop() }
        model.toggleLane(.livrees)
        #expect(model.unfoldedLanes == [.livrees])
        let unfolded = model.laneRows.first { $0.lane == .livrees }
        #expect(unfolded?.folded == false)
        #expect(unfolded?.visibleCards.count == 100)
        // Un second clic replie.
        model.toggleLane(.livrees)
        #expect(model.laneRows.first { $0.lane == .livrees }?.folded == true)
        // Départ de la section (`onDisappear` de KanbanView) puis retour.
        model.toggleLane(.livrees)
        model.resetLaneFolding()
        #expect(model.unfoldedLanes.isEmpty)
        #expect(model.laneRows.first { $0.lane == .livrees }?.folded == true)
        #expect(model.laneRows.first { $0.lane == .arretees }?.folded == true)
    }

    @Test("parite-mac-des-correctifs-ios/AC-3 : la sélection n'est jamais cachée")
    func macSelectionIsNeverHidden() throws {
        let model = kanbanModel()
        defer { model.stop() }
        let delivered = try #require(cards(.livrees).last)
        let lastWaiting = try #require(cards(.aVous).last)
        let firstRunning = try #require(cards(.enCours).first)

        // Sélectionner (ou ouvrir depuis une notification) une carte livrée déplie Livrées.
        model.openDetail(delivered.id)
        #expect(model.unfoldedLanes.contains(.livrees))
        #expect(model.laneRows.first { $0.lane == .livrees }?.visibleCards.contains(delivered) == true)
        model.detailShown = false

        // Le clavier ne parcourt que les cartes visibles : Livrées repliée, rien
        // après la dernière carte d'« À vous ».
        model.resetLaneFolding()
        model.select(lastWaiting.id)
        model.move(by: .next)
        #expect(model.selectedCardID == lastWaiting.id)
        model.move(by: .nextColumn)
        #expect(model.selectedCardID == lastWaiting.id)
        #expect(!cards(.livrees).contains { $0.id == model.selectedCardID })
        #expect(model.unfoldedLanes.isEmpty, "le clavier ne déplie rien")

        // Une sélection posée sur une carte repliée compte comme une absence de sélection.
        model.select(delivered.id)
        model.toggleLane(.livrees)
        #expect(model.laneRows.first { $0.lane == .livrees }?.folded == true)
        model.move(by: .next)
        #expect(model.selectedCardID == firstRunning.id)
    }

    // MARK: - Noms de modèle Mac (BR-3 : S-4, S-5, S-6)

    private var paritySelectors: [String] { KanbanLabelParity.modelSelectors }

    /// Le catalogue de parité, servi sans lancer `omp`.
    private func listing() -> ModelCatalogListing {
        ModelCatalogListing(selectors: paritySelectors, names: KanbanLabelParity.modelNames)
    }

    /// Un modèle d'action dont le catalogue répond `results` dans l'ordre des
    /// chargements (le dernier se répète).
    private func actions(_ results: [Result<ModelCatalogListing, ModelCatalogError>]) -> ActionsModel {
        let queue = LoaderQueue(results)
        return ActionsModel(modelCatalogLoader: { queue.next() })
    }

    private func load(_ actions: ActionsModel) async {
        actions.loadModelCatalog()
        await actions.modelCatalogTask?.value
    }

    @Test("parite-mac-des-correctifs-ios/AC-5 : sur Mac, la fiche et la carte nomment le modèle par son nom lisible, sans l'identifiant")
    func macNamesTheCardModel() async throws {
        let actions = actions([.success(listing())])
        #expect(actions.modelNames.isEmpty, "rien n'est nommé avant le chargement")
        await load(actions)
        #expect(actions.modelCatalog == .loaded(paritySelectors))
        #expect(actions.modelNames == KanbanLabelParity.modelNames)

        // Carte du tableau : les deux lignes C-3.
        let lines = try #require(KanbanCardPresentation.modelLines(card(models: KanbanLabelParity.models), names: actions.modelNames))
        #expect(lines.reqSpecs == "Modèle /req et /specs : Claude Opus 5.5")
        #expect(!lines.reqSpecs.contains("anthropic/claude-opus-5-5"))
        // Fiche : la valeur de la grille Informations.
        #expect(ModelCatalog.displayName("anthropic/claude-opus-5-5", names: actions.modelNames) == "Claude Opus 5.5")
    }

    @Test("parite-mac-des-correctifs-ios/AC-6 : sur Mac, un catalogue en échec ou sans nom laisse l'identifiant en repli sur la fiche et la carte")
    func macFallsBackToSelectorWithoutNames() async throws {
        let actions = actions([.success(listing()), .failure(ModelCatalogError(reason: "omp introuvable"))])
        await load(actions)
        #expect(!actions.modelNames.isEmpty)
        // Un rechargement en échec retire les noms : aucun nom périmé ne survit.
        await load(actions)
        #expect(actions.modelCatalog == .failed("omp introuvable"))
        #expect(actions.modelNames == [:])

        let lines = try #require(KanbanCardPresentation.modelLines(card(models: KanbanLabelParity.models), names: actions.modelNames))
        #expect(lines == KanbanModelLines(
            reqSpecs: "Modèle /req et /specs : anthropic/claude-opus-5-5",
            implReview: "Modèle /impl et /review : lm-studio/qwen3-coder-30b"
        ))
        #expect(ModelCatalog.displayName("anthropic/claude-opus-5-5", names: actions.modelNames) == "anthropic/claude-opus-5-5")
    }

    @Test("parite-mac-des-correctifs-ios/AC-6 (feuille) : sans nom, chaque option du sélecteur Mac porte son identifiant ; en échec, la valeur courante reste")
    func macPickerFallsBackToSelectors() {
        let loaded = ModelSlotsPicker.options(.loaded(paritySelectors), including: nil, names: [:])
        #expect(loaded.map(\.label) == paritySelectors)
        #expect(loaded.map(\.selector) == paritySelectors)

        let failed = ModelSlotsPicker.options(.failed("omp introuvable"), including: "anthropic/claude-opus-5-5", names: [:])
        #expect(failed == [ModelSlotOption(selector: "anthropic/claude-opus-5-5", label: "anthropic/claude-opus-5-5")])
        #expect(ModelSlotsPicker.options(.loading, including: nil, names: KanbanLabelParity.modelNames).isEmpty)
    }

    @Test("parite-mac-des-correctifs-ios/AC-11 : S-5, les options du sélecteur Mac portent les libellés E-5, le défaut une seule fois")
    func macPickerUsesSharedChoiceLabels() {
        let names = KanbanLabelParity.modelNames
        let options = ModelSlotsPicker.options(.loaded(paritySelectors), including: nil, names: names)
        let labels = ModelCatalog.choiceLabels(paritySelectors, names: names)
        #expect(options.map(\.selector) == paritySelectors, "la valeur transmise reste le sélecteur exact")
        #expect(options.map(\.label) == paritySelectors.map { labels[$0] ?? "" })
        #expect(options.map(\.label) == [
            "Claude Opus 4.7 (anthropic)",
            "Claude Opus 5.5",
            "Claude Opus 4.7 (github-copilot)",
            "GPT-4o (gpt-4o)",
            "GPT-4o (gpt-4o-2024-05-13)",
            "lm-studio/qwen3-coder-30b",
        ])
        #expect(Set(options.map(\.label)).count == options.count, "deux options ne se lisent jamais pareil")
        // « défaut OMP (aucun modèle) » est l'option `nil` du Picker, jamais une option balisée.
        #expect(!options.contains { $0.label == ModelCatalog.defaultChoice || $0.selector == ModelCatalog.defaultChoice })
        // Une valeur courante hors catalogue s'ajoute en fin, nommée si le nom est connu.
        let extra = ModelSlotsPicker.options(.loaded(["lm-studio/qwen3-coder-30b"]), including: "anthropic/claude-opus-5-5", names: names)
        #expect(extra == [
            ModelSlotOption(selector: "lm-studio/qwen3-coder-30b", label: "lm-studio/qwen3-coder-30b"),
            ModelSlotOption(selector: "anthropic/claude-opus-5-5", label: "Claude Opus 5.5"),
        ])
    }

    // MARK: Statistiques (S-6)

    private static func line(_ object: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    private static func assistant(id: String, stamp: String, provider: String?, model: String) -> String {
        var message: [String: Any] = [
            "role": "assistant",
            "content": [["type": "text", "text": "réponse"]],
            "model": model,
            "usage": ["input": 10, "output": 2, "totalTokens": 12, "cacheRead": 0, "cacheWrite": 0],
        ]
        if let provider { message["provider"] = provider }
        return line(["type": "message", "id": id, "timestamp": stamp, "parentId": NSNull(), "message": message])
    }

    /// Une session réelle écrite sur disque, relue par `SessionReader` puis
    /// réduite par `sessionMetrics` : la ligne de Statistiques de son run.
    private func statsRow(_ assistants: [(provider: String?, model: String)], names: [String: String]?) throws -> StatsRow {
        let fixture = try ViewerSessionFixture()
        defer { fixture.remove() }
        let stamp = "2026-10-10T08:00:00.000Z"
        var lines = [
            Self.line(["type": "session", "id": "s", "timestamp": stamp, "version": 3, "cwd": "/tmp/projet"]),
            Self.line(["type": "message", "id": "u1", "timestamp": stamp, "parentId": NSNull(),
                       "message": ["role": "user", "content": [["type": "text", "text": "go"]]]]),
        ]
        for (index, turn) in assistants.enumerated() {
            lines.append(Self.assistant(id: "a\(index)", stamp: "2026-10-10T08:00:0\(index + 1).000Z", provider: turn.provider, model: turn.model))
        }
        try fixture.write(lines)
        let reader = SessionReader(path: fixture.path)
        reader.read()
        let metrics = sessionMetrics(reader.conversation)
        let project = ProjectStats(
            repoKey: "k", label: "mem0-omp",
            features: [FeatureStats(id: "alpha", slug: "alpha", runs: [
                RunStats(id: "run", sessionFile: "run.jsonl", phase: .impl, isLive: false, metrics: .measured(metrics)),
            ])],
            hiddenPlanFeatures: 0
        )
        return try #require(StatsPresentation.rows(project, nowMs: 0, names: names).first)
    }

    @Test("parite-mac-des-correctifs-ios/AC-7 : Statistiques Mac nomme le modèle d'une session par fournisseur et id")
    func macStatsNameTheSessionModel() throws {
        let names = KanbanLabelParity.modelNames
        #expect(try statsRow([(provider: "anthropic", model: "claude-opus-5-5")], names: names).model == "Claude Opus 5.5")
        // Le fournisseur est celui de la MÊME réponse que le modèle retenu (la dernière).
        #expect(try statsRow([
            (provider: "anthropic", model: "claude-opus-5-5"),
            (provider: "github-copilot", model: "gpt-4o"),
        ], names: names).model == "GPT-4o")
        // Un id nu sans fournisseur n'est jamais deviné, même si une réponse
        // précédente en portait un.
        #expect(try statsRow([
            (provider: "anthropic", model: "claude-opus-4-7"),
            (provider: nil, model: "claude-opus-5-5"),
        ], names: names).model == "claude-opus-5-5")
    }

    @Test("parite-mac-des-correctifs-ios/AC-6 (Statistiques) : sans catalogue, la colonne Modèle garde l'id de la session")
    func macStatsFallBackToTheBareId() throws {
        #expect(try statsRow([(provider: "anthropic", model: "claude-opus-5-5")], names: nil).model == "claude-opus-5-5")
        #expect(try statsRow([(provider: "anthropic", model: "claude-opus-5-5")], names: [:]).model == "claude-opus-5-5")
        #expect(try statsRow([(provider: "lm-studio", model: "qwen3-coder-30b")], names: KanbanLabelParity.modelNames).model
            == "qwen3-coder-30b")
    }

    // MARK: - Feuille Nouvelle feature Mac (BR-4 : S-8, S-9)

    @Test("parite-mac-des-correctifs-ios/AC-9 : la feuille Nouvelle feature Mac nomme chaque dépôt par son dossier, jamais par un chemin")
    func macSheetNamesReposByFolder() throws {
        let roots = KanbanLabelParity.repoRoots
        #expect(KanbanLaunchRepos.choices(roots).map(\.label) == ["mem0-omp (Projets)", "mem0-omp (Archives)", "site-vitrine"])
        // Le sélecteur reçoit les dépôts triés de `LaunchRepo.options`.
        let choices = KanbanLaunchRepos.choices(roots.sorted())
        #expect(choices.map(\.label) == ["mem0-omp (Archives)", "mem0-omp (Projets)", "site-vitrine"])
        for label in choices.map(\.label) {
            #expect(!label.contains("/") && !label.contains("~") && !label.contains("…"), "« \(label) » montre un chemin")
        }
        // La valeur lancée reste la racine complète.
        #expect(choices.map(\.root) == roots.sorted())

        // Un dossier choisi à la main, homonyme du projet ouvert : les deux se départagent par leur parent.
        let chosen = LaunchRepo.options(cards: [], projectRoot: roots[0], chosen: roots[1])
        #expect(KanbanLaunchRepos.choices(chosen).map(\.label) == ["mem0-omp (Archives)", "mem0-omp (Projets)"])
        // Le dépôt sélectionné par défaut (le projet ouvert) se lit par son libellé.
        let selected = try #require(KanbanLaunchRepos.defaultSelection(options: chosen, selectedRepoRoot: nil, projectRoot: roots[0]))
        #expect(KanbanLaunchRepos.choices(chosen).first { $0.root == selected }?.label == "mem0-omp (Projets)")
    }

    @Test("parite-mac-des-correctifs-ios/AC-10 : « Lancer » ferme la feuille Mac et mène à Pipelines depuis toute section, jamais à l'Accueil")
    func macLaunchLandsOnPipelines() async throws {
        for section in ConsoleSection.allCases where section != .kanban {
            let fixture = StoreFixture()
            let actions = ActionsModel(
                writer: PipelineWriter(
                    stateDir: fixture.root,
                    post: { repo, body in
                        ServiceCommandAck(
                            id: body["id"] as? String ?? "x", repo: repo, kind: "launch",
                            state: .taken, reason: nil, at: fixtureT0)
                    },
                    pilot: { _ in }
                ),
                clock: StoreClock { fixtureT0 }
            )
            let console = ConsoleModel()
            console.select(section)
            actions.launchFormShown = true
            actions.launchTitle = "Ma feature"
            actions.launchDescription = "l'intention"
            actions.launchRepoError = NewFeatureText.notGitRoot

            NewFeatureSheet.submit(actions: actions, console: console, repoRoot: fixture.root)

            #expect(actions.launchFormShown == false, "la feuille se ferme")
            #expect(actions.launchRepoError == nil)
            #expect(console.selection == .kanban, "depuis \(section), l'arrivée est Pipelines")
            #expect(actions.journal.first?.targetLabel == "Ma feature", "la commande est partie")
            await actions.commandTask?.value
        }

        // Depuis Pipelines même, on y reste ; et l'arrivée n'est jamais l'Accueil.
        let console = ConsoleModel()
        console.select(.kanban)
        console.showLaunchedFeature()
        #expect(console.selection == .kanban)
        #expect(console.selection != .home)
    }
}

/// Les réponses successives d'un chargeur de catalogue de test.
private final class LoaderQueue: @unchecked Sendable {
    private let lock = NSLock()
    private var results: [Result<ModelCatalogListing, ModelCatalogError>]

    init(_ results: [Result<ModelCatalogListing, ModelCatalogError>]) {
        self.results = results
    }

    func next() -> Result<ModelCatalogListing, ModelCatalogError> {
        lock.lock(); defer { lock.unlock() }
        return results.count > 1 ? results.removeFirst() : results[0]
    }
}
