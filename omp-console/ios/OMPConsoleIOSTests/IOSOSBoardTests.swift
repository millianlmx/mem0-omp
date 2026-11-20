// Les preuves Swift de la navigation du Tableau sur iPhone et iPad : le bouton de l'onglet Fils
// pousse la page dans sa pile (cinq onglets inchangés), l'argument de recette l'ouvre d'office,
// une carte touchée pousse son fil par-dessus et le retour ramène au tableau. Logique pure.

import ConsoleClient
import ConsoleCore
import ConsoleUI
import Foundation
import Testing

@testable import OMPConsoleIOS

@MainActor
@Suite("coque iOS — Tableau")
struct IOSOSBoardTests {
    @Test("vue-kanban-dans-les-apps-macos-et-ios/AC-3 : le bouton pousse le tableau dans la pile des Fils, la barre garde cinq onglets")
    func buttonPushesTheBoard() {
        var navigation = IOSOSNavigation(tab: .threads)
        navigation.push(.board)
        #expect(navigation.path(of: .threads) == [.board])
        #expect(navigation.selection == OSWorkspace.board)
        #expect(navigation.tab == .threads)
        #expect(IOSOSTab.allCases.count == 5)
        // Le retour rend la liste des fils.
        navigation.setPath([], of: .threads)
        #expect(navigation.path(of: .threads).isEmpty)
        #expect(navigation.selection == nil)
    }

    @Test("vue-kanban-dans-les-apps-macos-et-ios/AC-4 : -os.board ouvre le tableau dans les Fils, même avec -os.view ; sans valeur, ignoré")
    func recipeOpensTheBoardInThreads() {
        let launch = IOSShellLaunch.resolve(["-os.board", "1"])
        #expect(launch.board)
        #expect(launch.initialTab == .threads)
        #expect(launch.initialNavigation.path(of: .threads) == [.board])

        let withView = IOSShellLaunch.resolve(["-os.view", "now", "-os.board", "1"])
        #expect(withView.initialTab == .threads)
        #expect(withView.initialNavigation.path(of: .threads) == [.board])
        #expect(withView.initialNavigation.path(of: .now).isEmpty)

        #expect(IOSShellLaunch.resolve(["-os.board"]) == IOSShellLaunch())
        #expect(IOSOSTab.allCases == [.now, .threads, .decisions, .proposals, .knowledge])
    }

    @Test("vue-kanban-dans-les-apps-macos-et-ios/AC-9 : un fil touché se pousse au-dessus du tableau, le retour ramène au tableau")
    func threadOpensAboveTheBoard() {
        var navigation = IOSShellLaunch.resolve(["-os.board", "1"]).initialNavigation
        navigation.follow(selection: "t1")
        #expect(navigation.path(of: .threads) == [.board, .thread("t1")])
        #expect(navigation.selection == "t1")

        navigation.setPath([.board], of: .threads)
        #expect(navigation.selection == OSWorkspace.board)

        // Le tableau est déjà montré : rien de plus.
        let before = navigation
        navigation.follow(selection: OSWorkspace.board)
        #expect(navigation == before)
    }

    @Test("vue-kanban-dans-les-apps-macos-et-ios/AC-3 : demander le tableau depuis un autre onglet l'ouvre dans les Fils")
    func boardSelectionShowsInThreads() {
        var navigation = IOSOSNavigation(tab: .now)
        navigation.follow(selection: OSWorkspace.board)
        #expect(navigation.tab == .threads)
        #expect(navigation.path(of: .threads) == [.board])
    }
}
