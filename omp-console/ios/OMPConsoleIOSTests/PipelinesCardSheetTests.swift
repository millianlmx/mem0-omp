import ConsoleCore
import Testing

@testable import OMPConsoleIOS
@testable import ConsoleCore

/// Les preuves Swift de la fiche d'une carte : le nom lisible du modèle est une
/// fonction PURE du catalogue servi par le Mac, et chaque élément de la fiche
/// porte son propre identifiant d'accessibilité.
@MainActor
@Suite("ios-fiche-carte-pipelines — la fiche d'une carte")
struct PipelinesCardSheetTests {
    private let known = "anthropic/claude-opus-5-5"
    private let unknown = "lm-studio/qwen3-coder-30b"
    private var catalog: [String: String] { [known: "Claude Opus 5.5"] }

    private func card(models: ModelSlots?) -> KanbanCard {
        KanbanCard(
            id: "feature:abc:slug",
            column: .enCours,
            repo: "depot",
            title: "depot/slug",
            state: "en cours",
            phase: nil,
            models: models,
            prUrl: nil,
            startMs: 0,
            endMs: nil,
            marks: [],
            sources: [],
            action: nil
        )
    }

    @Test("ios-fiche-carte-pipelines/AC-6 : le nom du catalogue remplace le sélecteur connu, le sélecteur brut reste sinon")
    func modelNameFromCatalog() {
        #expect(PipelinesModel.modelName(known, names: catalog) == "Claude Opus 5.5")
        #expect(PipelinesModel.modelName(unknown, names: catalog) == unknown)
        #expect(PipelinesModel.modelName(known, names: nil) == known)
        #expect(PipelinesModel.modelName(known, names: [known: "  "]) == known)
        #expect(PipelinesModel.modelName(known, names: [:]) == known)
    }

    @Test("ios-fiche-carte-pipelines/AC-6 : les lignes de modèle suivent les groupes de la carte")
    func modelLinesFollowSlots() {
        let both = ModelSlots(reqSpecs: known, implReview: unknown)
        #expect(
            PipelinesModel.modelLines(card(models: both), names: catalog)
                == PipelinesModelLines(
                    reqSpecs: "req+specs Claude Opus 5.5",
                    implReview: "impl+review lm-studio/qwen3-coder-30b"
                )
        )
        #expect(
            PipelinesModel.modelLines(card(models: both), names: nil)
                == PipelinesModelLines(
                    reqSpecs: "req+specs anthropic/claude-opus-5-5",
                    implReview: "impl+review lm-studio/qwen3-coder-30b"
                )
        )
        let noReview = ModelSlots(reqSpecs: known, implReview: nil)
        #expect(PipelinesModel.modelLines(card(models: noReview), names: catalog)?.implReview == "impl+review défaut OMP")
        #expect(PipelinesModel.modelLines(card(models: nil), names: catalog) == nil)
    }

    @Test("ios-fiche-carte-pipelines/AC-7 : les identifiants de la fiche sont deux à deux distincts")
    func sheetIdentifiersAreDistinct() {
        let ids = [
            PipelinesAccessibility.sheet,
            PipelinesAccessibility.sheetTitle,
            PipelinesAccessibility.sheetInfo,
            PipelinesAccessibility.sheetRepo,
            PipelinesAccessibility.sheetPhase,
            PipelinesAccessibility.sheetDuration,
            PipelinesAccessibility.sheetModelReqSpecs,
            PipelinesAccessibility.sheetModelImplReview,
            PipelinesAccessibility.sheetPR,
            PipelinesAccessibility.sheetMotif,
            PipelinesAccessibility.sheetEmpty,
            PipelinesAccessibility.sheetQuestionTitle,
            PipelinesAccessibility.sheetQuestion,
            PipelinesAccessibility.sheetPrompt,
            PipelinesAccessibility.sheetClose,
            PipelinesAccessibility.answerField,
            PipelinesAccessibility.answerSend,
            PipelinesAccessibility.error,
        ]
        #expect(Set(ids).count == ids.count)
        #expect(ids.allSatisfy { $0.hasPrefix("pipelines.card.sheet") })
        #expect(PipelinesAccessibility.sheetTitle == "pipelines.card.sheet.title")
    }
}
