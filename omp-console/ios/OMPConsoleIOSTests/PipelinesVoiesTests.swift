import ConsoleClient
import ConsoleCore
import SwiftUI
import Testing

@testable import OMPConsoleIOS
@testable import ConsoleCore

/// Les preuves Swift de l'écran Pipelines sur iPad et iPhone : voies de largeur
/// fixe, en-têtes empilés, cartes livrées — et l'outillage de mesure qui les
/// rend observables (crochet `-pipelines.board`, fixture `KanbanBoardParity`).
@MainActor
@Suite("pipelines-ipad-voies-sans-largeur — voies iPad, en-têtes et cartes")
struct PipelinesVoiesTests {
    @Test("pipelines-ipad-voies-sans-largeur/AC-14 : le crochet -pipelines.board reconnaît « pleine », la dernière paire reconnue gagne")
    func boardRecipeResolves() {
        let flag = PipelinesText.boardRecipeFlag
        #expect(IOSPipelinesBoardRecipe.resolve([flag, "pleine"]) == .pleine)
        #expect(IOSPipelinesBoardRecipe.resolve([flag, "pleine", flag, "inconnue"]) == .pleine)
        #expect(IOSPipelinesBoardRecipe.resolve([flag, "inconnue"]) == nil)
        #expect(IOSPipelinesBoardRecipe.resolve([flag]) == nil)
        #expect(IOSPipelinesBoardRecipe.resolve([]) == nil)
        // Distinct du crochet de la feuille « Nouvelle feature ».
        #expect(IOSPipelinesBoardRecipe.resolve([PipelinesText.recipeFlag, "pleine"]) == nil)
        #expect(IOSPipelinesBoardRecipe.pleine.screenState == .board(.board(KanbanBoardParity.board)))
    }

    @Test("jargon-technique-expose-mac-et-ios/AC-5 : -pipelines.board marques rend l'ardoise de HomeParity, dont la carte au pilote arrêté se lit par une phrase, sans marque brute")
    func boardRecipeMarquesShowsSentences() throws {
        let flag = PipelinesText.boardRecipeFlag
        #expect(IOSPipelinesBoardRecipe.resolve([flag, "marques"]) == .marques)
        #expect(IOSPipelinesBoardRecipe.resolve([flag, "marques", flag, "pleine"]) == .pleine)
        #expect(IOSPipelinesBoardRecipe.marques.screenState == .board(IOSPipelinesBoardRecipe.derivedBoard))

        let board = try #require(IOSPipelinesBoardRecipe.derivedBoard.kanbanBoard)
        let dead = board.cards.filter { $0.marks.contains(.mort) }
        #expect(!dead.isEmpty)
        for card in dead {
            let sentence = try #require(KanbanText.marksSentence(card.marks))
            #expect(sentence.contains(KanbanText.markSentence(.mort)))
            #expect(!sentence.contains("Marques"))
            for raw in [KanbanMark.mort.rawValue, KanbanMark.doublon.rawValue] {
                #expect(sentence.range(of: "\\b\(raw)\\b", options: .regularExpression) == nil)
            }
        }
        // Une carte saine ne montre aucune ligne.
        let healthy = try #require(board.cards.first { $0.marks.isEmpty })
        #expect(KanbanText.marksSentence(healthy.marks) == nil)
    }

    @Test("pipelines-ipad-voies-sans-largeur/AC-14 : la fixture reproduit les défauts mesurés — voie vide, 100 livrées, noms longs")
    func boardFixtureReproducesTheMeasuredDefects() throws {
        let board = KanbanBoardParity.board
        let lanes = board.lanes
        #expect(lanes.map(\.lane) == [.pasCommencees, .enCours, .aVous, .livrees, .arretees])

        let notStarted = try #require(lanes.first { $0.lane == .pasCommencees })
        #expect(notStarted.cards.isEmpty)

        let delivered = try #require(lanes.first { $0.lane == .livrees })
        #expect(delivered.cards.count == 100)
        let withPR = delivered.cards.filter { $0.prUrl != nil }
        #expect(withPR.count >= 2)
        #expect(Set(withPR.map(\.title.count)).count >= 2)
        #expect(delivered.cards.contains { $0.prUrl == nil })

        #expect(board.cards.contains { $0.title.count >= 60 })
        #expect(Set(board.cards.map(\.repo)).count == 2)
    }

    @Test("pipelines-ipad-voies-sans-largeur/AC-2 : la largeur d'une voie iPad suit la taille de texte tant qu'elle tient dans la largeur visible")
    func laneWidthFollowsTextSize() {
        #expect(IOSMetrics.laneWidth == 280)
        #expect(PipelinesModel.laneWidth(scaled: 280, container: 936, endMargin: 24) == 280)
        #expect(PipelinesModel.laneWidth(scaled: 658, container: 936, endMargin: 24) == 658)
    }

    @Test("pipelines-ipad-voies-sans-largeur/AC-5 : une voie iPad ne dépasse jamais la largeur visible moins la marge de fin")
    func laneWidthNeverExceedsTheViewport() {
        #expect(PipelinesModel.laneWidth(scaled: 870, container: 738, endMargin: 24) == 714)
        // Conteneur pas encore mesuré, ou plus étroit que la marge : la largeur mise à l'échelle.
        #expect(PipelinesModel.laneWidth(scaled: 280, container: 0, endMargin: 24) == 280)
        #expect(PipelinesModel.laneWidth(scaled: 280, container: 24, endMargin: 24) == 280)
    }

    @Test("pipelines-ipad-voies-sans-largeur/AC-7 AC-8 : l'en-tête de voie s'empile aux tailles d'accessibilité, et seulement à elles")
    func laneHeaderStacksAtAccessibilitySizes() {
        #expect(PipelinesModel.headerAxis(.large) == .horizontal)
        #expect(PipelinesModel.headerAxis(.xxxLarge) == .horizontal)
        #expect(PipelinesModel.headerAxis(.accessibility1) == .stacked)
        #expect(PipelinesModel.headerAxis(.accessibility3) == .stacked)
        #expect(PipelinesModel.headerAxis(.accessibility5) == .stacked)
    }
}
