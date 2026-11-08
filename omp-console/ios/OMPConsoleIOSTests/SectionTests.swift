import ConsoleCore
import Testing

@testable import OMPConsoleIOS

/// Les preuves Swift des critères de la coque iOS : la dérivation des cinq
/// sections, la résolution de l'argument de lancement et l'exclusion des deux
/// sections hors périmètre. Le préfixe de slug rend chaque critère retrouvable
/// par `grep` (invariant du dépôt).
@Suite("coque-ios — sections de l'app iOS")
struct SectionTests {
    @Test("coque-ios/AC-2 : les cinq sections sont allCases moins deux, dans l'ordre de allCases")
    func fiveSections() {
        #expect(IOSSection.all == [.inbox, .runs, .workstation, .memory, .system])
        #expect(IOSSection.all.count == ConsoleSection.allCases.count - 2)
    }

    @Test("coque-ios/AC-3 : chaque groupe ne montre que ses sections des cinq, dans l'ordre")
    func groupedSections() {
        #expect(IOSSection.sections(of: .work) == [.inbox, .runs, .workstation])
        #expect(IOSSection.sections(of: .tools) == [.memory])
        #expect(IOSSection.sections(of: .system) == [.system])
    }

    @Test("coque-ios/AC-4 : l'argument de lancement désigne la section, sinon « À traiter »")
    func resolveLaunchArgument() {
        for section in IOSSection.all {
            #expect(IOSSection.resolve(["-section", section.rawValue]) == section)
        }
        #expect(IOSSection.resolve([]) == .inbox)
        #expect(IOSSection.resolve(["-section"]) == .inbox)
        #expect(IOSSection.resolve(["-section", "inconnue"]) == .inbox)
        #expect(IOSSection.resolve(["-section", "terminal"]) == .inbox)
        #expect(IOSSection.resolve(["-section", "files"]) == .inbox)
        // Les sections d'avant la refonte ne désignent plus rien.
        #expect(IOSSection.resolve(["-section", "home"]) == .inbox)
        #expect(IOSSection.resolve(["-section", "kanban"]) == .inbox)
        // La DERNIÈRE paire reconnue gagne ; une paire invalide plus loin ne
        // défait pas un choix valide.
        #expect(IOSSection.resolve(["-section", "memory", "-section", "system"]) == .system)
        #expect(IOSSection.resolve(["-section", "memory", "-section", "inconnue"]) == .memory)
    }

    @Test("coque-ios/AC-8 : les deux sections exclues sont Terminal et Fichiers")
    func excludedSections() {
        let excluded = ConsoleSection.allCases.filter { !IOSSection.all.contains($0) }
        #expect(excluded == [.terminal, .files])
        #expect(IOSSection.all.count == 5)
    }
}
