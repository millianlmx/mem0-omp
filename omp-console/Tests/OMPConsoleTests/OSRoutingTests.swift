// Le routage de l'OS du Mac : chaque destination nommée par un lien, une notification ou
// la palette s'ouvre dans l'OS (tri, centre, écran du hub Système, feuille du serveur),
// les pages du hub ont chacune leur écran, et ⌘1…⌘6 suivent les entrées fixes du centre.

import ConsoleClient
import ConsoleCore
@testable import ConsoleUI
import Foundation
@testable import OMPConsole
import Testing

@Suite("Routage de l'OS du Mac")
@MainActor
struct OSRoutingTests {
    /// Un client sans serveur relié : en mémoire, il n'appelle personne.
    private func unlinkedServer() -> HarnessModel {
        HarnessModel(transport: URLSessionHarnessTransport(), preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore())
    }

    @Test("Chaque destination nommée s'ouvre dans l'OS")
    func sectionsRouteInsideTheOS() {
        #expect(OSMacRoute.of(.inbox, page: nil) == .triage)
        #expect(OSMacRoute.of(.runs, page: nil) == .none)
        #expect(OSMacRoute.of(.workstation, page: nil) == .system(.workstation))
        #expect(OSMacRoute.of(.memory, page: nil) == .center(OSWorkspace.memory))
        #expect(OSMacRoute.of(.system, page: nil) == .center(OSWorkspace.system))
        #expect(OSMacRoute.of(.system, page: .server) == .serverSheet)
        for page in SystemPage.allCases where page != .server {
            #expect(OSMacRoute.of(.system, page: page) == .system(OSSystemDestination(page)))
        }
    }

    @Test("Chaque page du hub a son écran, et le Poste en plus")
    func everySystemPageHasItsDestination() {
        for page in SystemPage.allCases {
            #expect(OSSystemDestination(page).page == page)
        }
        #expect(OSSystemDestination.workstation.page == nil)
        #expect(OSSystemDestination.workstation.title == ConsoleSection.workstation.title)
        #expect(Set(OSSystemDestination.allCases.compactMap(\.page)) == Set(SystemPage.allCases))
    }

    @Test("Les dépôts et l'administration ne se montrent qu'à un administrateur, l'autonomie qu'au serveur qui la sert")
    func hubTilesFollowTheToken() {
        let admin = OSSystemDestination.visible(isAdmin: true, autonomy: true)
        #expect(admin == OSSystemDestination.allCases)
        let member = OSSystemDestination.visible(isAdmin: false, autonomy: false)
        #expect(!member.contains(.repos))
        #expect(!member.contains(.admin))
        #expect(!member.contains(.autonomy))
        #expect(member.contains(.workstation))
        #expect(member.contains(.server))
    }

    @Test("Ouvrir un écran du hub sélectionne Système et pose l'écran sur le hub")
    func openingADestinationStacksItOnTheHub() {
        let workspace = OSWorkspace(server: unlinkedServer())
        workspace.open(.vigie)
        #expect(workspace.selection == OSWorkspace.system)
        #expect(workspace.systemPath.count == 1)
    }

    @Test("⌘1…⌘6 suivent les entrées fixes du centre, Maintenant d'abord")
    func shortcutsFollowTheFixedEntries() {
        #expect(OSMacDestinations.shortcuts.map(\.selection) == [
            OSWorkspace.now, OSWorkspace.proposals, OSWorkspace.automations,
            OSWorkspace.knowledge, OSWorkspace.memory, OSWorkspace.system,
        ])
    }
}
