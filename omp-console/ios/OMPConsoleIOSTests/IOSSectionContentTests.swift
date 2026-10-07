import ConsoleCore
import Testing

@testable import OMPConsoleIOS

/// Les preuves Swift des sept écrans de la coque iOS (S-2, S-3, BR-3) : chaque
/// état vide rend le mot PARTAGÉ de `ConsoleCore`, mot pour mot celui de la coque
/// macOS, et l'état d'erreur pose un bandeau `danger` sur les sept.
@Suite("design-ios — les sept écrans et leurs états")
struct IOSSectionContentTests {
    /// Le tableau de S-2, section par section.
    private static let expected: [(section: ConsoleSection, message: String, detail: String?)] = [
        (.home, HomeText.firstRunTitle, HomeText.firstRunBody),
        (.kanban, KanbanText.noPipeline, nil),
        (.project, ProjectViewText.emptyTitle, ProjectViewText.emptyHelp),
        (.session, SessionConsoleText.noProjectTitle, SessionConsoleText.noProjectBody),
        (.sessions, SessionSelectorText.emptyTitle, SessionSelectorText.noRun),
        (.memory, MemoryText.noProjectTitle, nil),
        (.stats, StatsPresentation.noProjectTitle, StatsPresentation.noProject),
    ]

    @Test("design-ios/AC-3 : chaque état vide porte le mot partagé, mot pour mot")
    func emptyStatesUseSharedWords() {
        #expect(IOSSection.all == Self.expected.map(\.section))

        for (section, message, detail) in Self.expected {
            let content = IOSSectionContent.of(section, state: .ready)
            #expect(content?.message == message, "\(section.rawValue)")
            #expect(content?.detail == detail, "\(section.rawValue)")
            #expect(content?.banner == nil, "\(section.rawValue)")
        }

        // Les mots sont ceux de la coque macOS : les figer ici, c'est figer la
        // valeur du noyau partagé, pas une seconde déclaration.
        #expect(HomeText.firstRunTitle == "Lancez votre première feature")
        #expect(KanbanText.noPipeline == "Aucune pipeline pour l'instant.")
        #expect(ProjectViewText.emptyTitle == "Aucun projet piloté.")
        #expect(SessionConsoleText.noProjectTitle == "Aucune session")
        #expect(SessionSelectorText.emptyTitle == "Aucune session")
        #expect(SessionSelectorText.noRun == "Les sessions des pipelines apparaîtront ici.")
        #expect(MemoryText.noProjectTitle == "Aucun projet ouvert")
        #expect(StatsPresentation.noProjectTitle == "Aucun projet")
        #expect(StatsPresentation.noProject == "Les statistiques apparaîtront dès qu'un projet sera piloté.")
    }

    @Test("design-ios/AC-1 : le titre et l'icône viennent de ConsoleSection")
    func titlesAndIconsComeFromConsoleCore() {
        for section in IOSSection.all {
            let content = IOSSectionContent.of(section, state: .ready)
            #expect(content?.title == section.title, "\(section.rawValue)")
            #expect(content?.systemImage == section.systemImage, "\(section.rawValue)")
        }
    }

    @Test("design-ios/AC-1 : la section Session porte la pastille de l'état partagé")
    func sessionCarriesSharedStatus() {
        let content = IOSSectionContent.of(.session, state: .ready)
        #expect(content?.status == ConsoleStatus(text: SessionConsoleText.Status.idleNoProject, tone: .neutral))
        #expect(SessionConsoleText.Status.idleNoProject == "Aucun projet")
        for (section, _, _) in Self.expected where section != .session {
            #expect(IOSSectionContent.of(section, state: .ready)?.status == nil, "\(section.rawValue)")
        }
    }

    @Test("design-ios/AC-4 : les sept sections rendent le bandeau danger en état d'erreur")
    func errorStateBannersAllSeven() {
        for section in IOSSection.all {
            let content = IOSSectionContent.of(section, state: .error(IOSText.recipeError))
            #expect(content?.banner == ConsoleStatus(text: IOSText.recipeError, tone: .danger), "\(section.rawValue)")
            #expect(content?.bannerMessage == IOSText.recipeError, "\(section.rawValue)")
        }
        #expect(IOSText.recipeError == "Impossible de lire les données de cet écran.")
    }

    @Test("design-ios/AC-2 : aucun composant orphelin — seule une section du périmètre a un contenu")
    func outOfScopeSectionsHaveNoContent() {
        for section in ConsoleSection.allCases where !IOSSection.all.contains(section) {
            #expect(IOSSectionContent.of(section, state: .ready) == nil, "\(section.rawValue)")
        }
    }
}
