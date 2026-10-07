// Preuves console du lot BR-5 de la feature model-selector : les deux modèles d'une
// feature demandés à la création (AC-1), modifiables par le canal (AC-5) et
// affichés distinctement (AC-7).
//
// Les vues ne se rendent pas sous les Command Line Tools : ce qui se vérifie ici
// est ce qu'elles LISENT — le JSON EXACT des commandes `launch`/`models`, l'état du
// journal, les helpers PURS des deux lignes de carte et la propagation des modèles
// du magasin à l'ardoise.

import Foundation
import Testing
@testable import OMPConsole
@testable import ConsoleCore

private let modelT0: Double = 1_700_000_000_000
private let modelClock = StoreClock { modelT0 }

@MainActor
private func makeActions(_ fixture: StoreFixture) -> ActionsModel {
    ActionsModel(
        writer: PipelineWriter(stateDir: fixture.root),
        clock: modelClock,
        salt: { "abcd" }
    )
}

private func commandObject(_ fixture: StoreFixture, suffix: String = "") -> [String: JSONValue]? {
    let path = joinPath(joinPath(fixture.root, "commands"), "0001700000000000-abcd\(suffix).json")
    guard let data = FileManager.default.contents(atPath: path),
          case .object(let object) = JSONValue.parse(data) else { return nil }
    return object
}

// MARK: - AC-1 : création — deux modèles choisis, deux clés dans launch

@MainActor
@Test("model-selector/AC-1 : la commande launch porte les deux modèles choisis")
func launchCarriesBothModels() throws {
    let fixture = StoreFixture()
    let model = makeActions(fixture)

    model.launch(
        title: "Ma feature", description: "l'intention", repoRoot: fixture.root,
        modelReqSpecs: "anthropic/claude-opus-4-7", modelImplReview: "cerebras/gemma-4-31b"
    )

    let object = try #require(commandObject(fixture))
    #expect(object["kind"] == .string("launch"))
    #expect(object["modelReqSpecs"] == .string("anthropic/claude-opus-4-7"))
    #expect(object["modelImplReview"] == .string("cerebras/gemma-4-31b"))
    // Les choix sont remis à zéro après le lancement, comme le titre et le besoin.
    #expect(model.launchModelReqSpecs == nil)
    #expect(model.launchModelImplReview == nil)
}

@MainActor
@Test("model-selector/AC-1 : un groupe laissé par défaut n'écrit AUCUNE clé de modèle")
func launchOmitsDefaultGroups() throws {
    let fixture = StoreFixture()
    let model = makeActions(fixture)

    model.launch(
        title: "Ma feature", description: "l'intention", repoRoot: fixture.root,
        modelReqSpecs: "  ", modelImplReview: nil
    )

    let object = try #require(commandObject(fixture))
    #expect(object["modelReqSpecs"] == nil, "une valeur blanche est lue absente")
    #expect(object["modelImplReview"] == nil)
}

@Test("model-selector/AC-1 : le catalogue lit les sélecteurs, dédupliqués et triés, et ignore une entrée sans selector")
func catalogParsesSelectors() {
    let json = """
    {"models":[
      {"provider":"cerebras","selector":"cerebras/gemma-4-31b"},
      {"provider":"anthropic","selector":"anthropic/claude-opus-4-7"},
      {"provider":"x","selector":"  "},
      {"provider":"y"},
      {"provider":"z","selector":"cerebras/gemma-4-31b"}
    ]}
    """
    #expect(ModelCatalog.selectors(fromJSON: Data(json.utf8)) == [
        "anthropic/claude-opus-4-7",
        "cerebras/gemma-4-31b",
    ])
    // Un JSON illisible ou hors forme est un échec, jamais une liste vide.
    #expect(ModelCatalog.selectors(fromJSON: Data("{ pas du json".utf8)) == nil)
    #expect(ModelCatalog.selectors(fromJSON: Data("{}".utf8)) == nil)
    // La liste affichée met le défaut en tête.
    #expect(ModelCatalog.choices(.loaded(["b", "a"])) == [ModelCatalog.defaultChoice, "b", "a"])
    #expect(ModelCatalog.choices(.failed("x")) == [ModelCatalog.defaultChoice])
}

// MARK: - AC-5 : édition — la commande models et le refus du pilote

@MainActor
@Test("model-selector/AC-5 : la commande models a l'objet JSON exact, NSNull pour un groupe par défaut")
func modelsCommandIsExact() throws {
    let fixture = StoreFixture()
    let model = makeActions(fixture)

    model.setModels(
        repoRoot: fixture.root, slug: "alpha",
        modelReqSpecs: "anthropic/claude-opus-4-7", modelImplReview: nil
    )

    let object = try #require(commandObject(fixture))
    #expect(object == [
        "version": .number(1),
        "id": .string("console-1700000000000-abcd"),
        "sentAt": .number(modelT0),
        "repo": .string(realpathOr(fixture.root)),
        "kind": .string("models"),
        "slug": .string("alpha"),
        "modelReqSpecs": .string("anthropic/claude-opus-4-7"),
        "modelImplReview": .null,
    ])
    let entry = try #require(model.journal.first)
    #expect(entry.kindLabel == ActionsText.modelsLabel)
    #expect(entry.targetLabel == "alpha")
    #expect(entry.state == .awaitingAck)
}

@MainActor
@Test("model-selector/AC-5 : un refus du pilote est journalisé au motif exact")
func modelsRefusalIsJournalled() throws {
    let fixture = StoreFixture()
    let model = makeActions(fixture)
    let writer = PipelineWriter(stateDir: fixture.root)
    let motif = "lotFeatureMissingRefusal"

    model.setModels(repoRoot: fixture.root, slug: "alpha", modelReqSpecs: "A", modelImplReview: "B")
    let id = try #require(model.journal.first?.id)
    try FileManager.default.createDirectory(atPath: writer.commandAckDir, withIntermediateDirectories: true)
    try Data("{\"version\":1,\"id\":\"\(id)\",\"repo\":\"/x\",\"kind\":\"models\",\"state\":\"refused\",\"reason\":\"\(motif)\",\"at\":1}"
        .utf8).write(to: URL(fileURLWithPath: writer.ackPath(id: id)))
    model.pollAcks()

    #expect(model.journal.first?.state == .refused(reason: motif))
    #expect(ActionsText.journalLine(for: try #require(model.journal.first))
        == "\(ActionsText.modelsLabel) · alpha · refusée : \(motif)")
}

@MainActor
@Test("model-selector/AC-5 : l'édition se pré-positionne sur les valeurs courantes résolues")
func editPrefillsCurrentSlotValues() {
    let fixture = StoreFixture()
    let model = makeActions(fixture)
    model.beginModelsEdit(ModelSlots(reqSpecs: "A", implReview: nil))
    #expect(model.editModelReqSpecs == "A")
    #expect(model.editModelImplReview == nil)
    // Une feature sans modèle : les deux sélecteurs retombent sur le défaut.
    model.beginModelsEdit(nil)
    #expect(model.editModelReqSpecs == nil)
    #expect(model.editModelImplReview == nil)
}

// MARK: - AC-7 : affichage — lignes pures et propagation à l'ardoise

@Test("model-selector/AC-7 : les deux lignes d'une carte portent valeur ou « défaut OMP », ou aucune")
func modelLinesAreExact() throws {
    let card = KanbanCard(
        id: "feature:k:alpha", column: .enCours, repo: "depot", title: "alpha", state: "en cours",
        phase: .impl, models: ModelSlots(reqSpecs: "anthropic/claude-opus-4-7", implReview: nil),
        prUrl: nil, startMs: 0, endMs: nil, marks: [], sources: []
    )
    #expect(KanbanCardPresentation.reqSpecsLine(card) == "req+specs anthropic/claude-opus-4-7")
    #expect(KanbanCardPresentation.implReviewLine(card) == "impl+review défaut OMP")
    let slots = try #require(card.models)
    #expect(KanbanCardPresentation.modelsText(slots)
        == "req+specs anthropic/claude-opus-4-7 · impl+review défaut OMP")

    var bare = card
    bare.models = nil
    #expect(KanbanCardPresentation.reqSpecsLine(bare) == nil, "sans modèle, aucune ligne")
    #expect(KanbanCardPresentation.implReviewLine(bare) == nil)
}

@Test("model-selector/AC-7 : une feature ancienne à modèle unique remplit les DEUX groupes")
func legacyModelFillsBothGroups() {
    #expect(ModelSlots.resolve(legacy: "M", reqSpecs: nil, implReview: nil)
        == ModelSlots(reqSpecs: "M", implReview: "M"))
    // La clé neuve prime sur l'ancien modèle pour SON groupe ; l'autre replie.
    #expect(ModelSlots.resolve(legacy: "M", reqSpecs: "A", implReview: nil)
        == ModelSlots(reqSpecs: "A", implReview: "M"))
    // Aucune clé non blanche : aucun modèle.
    #expect(ModelSlots.resolve(legacy: nil, reqSpecs: "  ", implReview: nil) == nil)
}

@Test("model-selector/AC-7 : l'ardoise porte les modèles résolus, le projet primant sur le lot")
func boardPropagatesModelSlots() throws {
    let fixture = StoreFixture()
    let repoRoot = "/tmp/model-selector/depot"
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)
    fixture.publish(
        .lots, "\(repoKey).json",
        object: lotObject(id: repoKey, repoRoot: repoRoot, features: [
            lotFeatureObject(
                slug: "alpha", worktree: "/tmp/model-selector/arbre",
                modelReqSpecs: "anthropic/claude-opus-4-7", modelImplReview: "cerebras/gemma-4-31b"
            ),
            lotFeatureObject(slug: "heritee", model: "M"),
            lotFeatureObject(slug: "sans-modele"),
        ])
    )

    let board = kanbanBoard(fixture)
    func card(_ slug: String) throws -> KanbanCard {
        try #require(board.cards.first { $0.id == "feature:\(repoKey):\(slug)" })
    }
    #expect(try card("alpha").models
        == ModelSlots(reqSpecs: "anthropic/claude-opus-4-7", implReview: "cerebras/gemma-4-31b"))
    #expect(try card("heritee").models == ModelSlots(reqSpecs: "M", implReview: "M"))
    #expect(try card("sans-modele").models == nil)

    // Le plan du projet fait autorité : ses deux clés remplacent celles du lot.
    fixture.publish(
        .projects, "\(repoKey).json",
        object: projectObject(
            repoKey: repoKey, repoRoot: repoRoot,
            segments: [["name": "S", "features": [
                projectFeatureObject(slug: "alpha", modelReqSpecs: "P1", modelImplReview: "P2"),
            ]]],
            current: 0
        )
    )
    let merged = try #require(
        kanbanBoard(fixture).cards.first { $0.id == "feature:\(repoKey):alpha" }
    )
    #expect(merged.models == ModelSlots(reqSpecs: "P1", implReview: "P2"))
}
