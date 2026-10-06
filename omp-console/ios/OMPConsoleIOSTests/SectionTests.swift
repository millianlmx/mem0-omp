import ConsoleCore
import Testing

@testable import OMPConsoleIOS

/// Les preuves Swift des critères de la coque iOS : la dérivation des sept
/// sections, la résolution de l'argument de lancement et l'exclusion des deux
/// sections hors périmètre. Le préfixe de slug rend chaque critère retrouvable
/// par `grep` (invariant du dépôt).
@Suite("coque-ios — sections de l'app iOS")
struct SectionTests {
    @Test("coque-ios/AC-2 : les sept sections sont allCases moins deux, dans l'ordre de allCases")
    func sevenSections() {
        #expect(IOSSection.all == [.home, .kanban, .project, .session, .sessions, .memory, .stats])
        #expect(IOSSection.all.count == ConsoleSection.allCases.count - 2)
    }

    @Test("coque-ios/AC-3 : chaque groupe ne montre que ses sections des sept, dans l'ordre")
    func groupedSections() {
        #expect(IOSSection.sections(of: .pilotage) == [.home, .kanban, .project, .session])
        #expect(IOSSection.sections(of: .consultation) == [.sessions, .memory, .stats])
    }

    @Test("coque-ios/AC-4 : l'argument de lancement désigne la section, sinon l'Accueil")
    func resolveLaunchArgument() {
        for section in IOSSection.all {
            #expect(IOSSection.resolve(["-section", section.rawValue]) == section)
        }
        #expect(IOSSection.resolve([]) == .home)
        #expect(IOSSection.resolve(["-section"]) == .home)
        #expect(IOSSection.resolve(["-section", "inconnue"]) == .home)
        #expect(IOSSection.resolve(["-section", "terminal"]) == .home)
        #expect(IOSSection.resolve(["-section", "files"]) == .home)
        // La DERNIÈRE paire reconnue gagne ; une paire invalide plus loin ne
        // défait pas un choix valide.
        #expect(IOSSection.resolve(["-section", "memory", "-section", "stats"]) == .stats)
        #expect(IOSSection.resolve(["-section", "memory", "-section", "inconnue"]) == .memory)
    }

    @Test("coque-ios/AC-8 : les deux sections exclues sont Terminal et Fichiers")
    func excludedSections() {
        let excluded = ConsoleSection.allCases.filter { !IOSSection.all.contains($0) }
        #expect(excluded == [.terminal, .files])
        #expect(IOSSection.all.count == 7)
    }
}
