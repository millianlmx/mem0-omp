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

/// Le capteur du corps posté au service : les commandes ne s'écrivent plus en
/// fichier, elles partent par HTTP (S-9).
private final class ModelPostRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var bodies: [[String: Any]] = []
    var ack = ServiceCommandAck(id: "x", repo: "", kind: nil, state: .taken, reason: nil, at: 0)
    var failure: Error?

    func post(_ body: [String: Any]) throws -> ServiceCommandAck {
        lock.lock(); defer { lock.unlock() }
        bodies.append(body)
        if let failure { throw failure }
        return ack
    }
}

@MainActor
private func makeActions(_ fixture: StoreFixture, recorder: ModelPostRecorder = ModelPostRecorder()) -> ActionsModel {
    ActionsModel(
        writer: PipelineWriter(stateDir: fixture.root, post: { _, body in try recorder.post(body) }),
        clock: modelClock,
        salt: { "abcd" }
    )
}

/// L'objet `[String: Any]` du premier corps posté, converti en `[String: JSONValue]`.
private func postedObject(_ recorder: ModelPostRecorder, index: Int = 0) -> [String: JSONValue]? {
    guard recorder.bodies.indices.contains(index) else { return nil }
    return recorder.bodies[index].compactMapValues { JSONValue(raw: $0) }
}

// MARK: - AC-1 : création — deux modèles choisis, deux clés dans launch

@MainActor
@Test("model-selector/AC-1 : la commande launch porte les deux modèles choisis")
func launchCarriesBothModels() async throws {
    let fixture = StoreFixture()
    let recorder = ModelPostRecorder()
    let model = makeActions(fixture, recorder: recorder)

    model.launch(
        title: "Ma feature", description: "l'intention", repoRoot: fixture.root,
        modelReqSpecs: "anthropic/claude-opus-4-7", modelImplReview: "cerebras/gemma-4-31b"
    )
    await model.commandTask?.value

    let object = try #require(postedObject(recorder))
    #expect(object["kind"] == .string("launch"))
    #expect(object["modelReqSpecs"] == .string("anthropic/claude-opus-4-7"))
    #expect(object["modelImplReview"] == .string("cerebras/gemma-4-31b"))
    // Les choix sont remis à zéro après le lancement, comme le titre et le besoin.
    #expect(model.launchModelReqSpecs == nil)
    #expect(model.launchModelImplReview == nil)
}

@MainActor
@Test("model-selector/AC-1 : un groupe laissé par défaut n'écrit AUCUNE clé de modèle")
func launchOmitsDefaultGroups() async throws {
    let fixture = StoreFixture()
    let recorder = ModelPostRecorder()
    let model = makeActions(fixture, recorder: recorder)

    model.launch(
        title: "Ma feature", description: "l'intention", repoRoot: fixture.root,
        modelReqSpecs: "  ", modelImplReview: nil
    )
    await model.commandTask?.value

    let object = try #require(postedObject(recorder))
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

@Test("ios-fiche-carte-pipelines/AC-6 : le catalogue garde le premier nom lisible non blanc de chaque sélecteur")
func catalogKeepsFirstReadableName() {
    let json = """
    {"models":[
      {"selector":"anthropic/claude-opus-5-5","name":"Claude Opus 5.5"},
      {"selector":"lm-studio/blank","name":"  "},
      {"selector":"lm-studio/sans-nom"},
      {"selector":"anthropic/claude-opus-5-5","name":"Autre nom"},
      {"selector":"  ","name":"Sans sélecteur"},
      {"name":"Sans clé"}
    ]}
    """
    #expect(ModelCatalog.names(fromJSON: Data(json.utf8)) == [
        "anthropic/claude-opus-5-5": "Claude Opus 5.5",
    ])
    #expect(ModelCatalog.names(fromJSON: Data(#"{"models":[]}"#.utf8)) == [:])
    #expect(ModelCatalog.names(fromJSON: Data("{ pas du json".utf8)) == nil)
    #expect(ModelCatalog.names(fromJSON: Data("{}".utf8)) == nil)
}

// MARK: - AC-5 : édition — la commande models et le refus du pilote

@MainActor
@Test("model-selector/AC-5 : la commande models a l'objet JSON exact, NSNull pour un groupe par défaut")
func modelsCommandIsExact() async throws {
    let fixture = StoreFixture()
    let recorder = ModelPostRecorder()
    let model = makeActions(fixture, recorder: recorder)

    model.setModels(
        repoRoot: fixture.root, slug: "alpha",
        modelReqSpecs: "anthropic/claude-opus-4-7", modelImplReview: nil
    )
    let entry = try #require(model.journal.first)
    #expect(entry.kindLabel == ActionsText.modelsLabel)
    #expect(entry.targetLabel == "alpha")
    #expect(entry.state == .awaitingAck)

    await model.commandTask?.value
    let object = try #require(postedObject(recorder))
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
}

@MainActor
@Test("model-selector/AC-5 : un refus du service est journalisé au motif exact")
func modelsRefusalIsJournalled() async throws {
    let fixture = StoreFixture()
    let recorder = ModelPostRecorder()
    let motif = "lotFeatureMissingRefusal"
    recorder.ack = ServiceCommandAck(
        id: "console-1700000000000-abcd", repo: "/x", kind: "models",
        state: .refused, reason: motif, at: 1
    )
    let model = makeActions(fixture, recorder: recorder)

    model.setModels(repoRoot: fixture.root, slug: "alpha", modelReqSpecs: "A", modelImplReview: "B")
    await model.commandTask?.value

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
    #expect(KanbanCardPresentation.modelLines(card, names: nil) == KanbanModelLines(
        reqSpecs: "Modèle /req et /specs : anthropic/claude-opus-4-7",
        implReview: "Modèle /impl et /review : défaut OMP"
    ))
    let slots = try #require(card.models)
    #expect(KanbanText.modelsLine(slots)
        == "Modèle /req et /specs : anthropic/claude-opus-4-7 · Modèle /impl et /review : défaut OMP")

    var bare = card
    bare.models = nil
    #expect(KanbanCardPresentation.modelLines(bare, names: nil) == nil, "sans modèle, aucune ligne")
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
