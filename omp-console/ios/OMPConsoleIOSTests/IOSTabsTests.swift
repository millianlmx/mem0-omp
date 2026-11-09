// Les preuves Swift du routage pur de la coque à onglets (ios-navigation-onglets-adaptables,
// S-1, revu par la refonte) : les cinq sections puis la recherche sur iPad, quatre puis
// la recherche sur iPhone (la Mémoire passe sous Système, plus d'onglet « Plus »), la
// sélection d'une section, ses badges, et les onglets de la page d'une feature.

import ConsoleClient
import ConsoleCore
import Testing

@testable import OMPConsoleIOS

@MainActor
@Suite("ios-navigation-onglets-adaptables — onglets et barre latérale")
struct IOSTabsTests {
    @Test("ios-navigation-onglets-adaptables/AC-1 : les cinq sections, dans l'ordre de la barre latérale, puis la recherche")
    func tabsAreTheSectionsThenSearch() {
        #expect(IOSSection.sidebarOrder == [.inbox, .runs, .workstation, .memory, .system])
        #expect(IOSSection.sidebarOrder.map(IOSTab.section).compactMap(\.section) == IOSSection.sidebarOrder)
        #expect(IOSTab.search.section == nil)
    }

    @Test("refonte : sur iPhone, la Mémoire n'a pas d'onglet et s'affiche sous Système ; sur iPad, rien n'est masqué")
    func memoryMovesUnderSystemOnIPhone() {
        let compactTabs = IOSSection.sidebarOrder.filter { !IOSTabs.isHidden($0, compact: true) }
        #expect(compactTabs == [.inbox, .runs, .workstation, .system])
        let regularTabs = IOSSection.sidebarOrder.filter { !IOSTabs.isHidden($0, compact: false) }
        #expect(regularTabs == IOSSection.sidebarOrder)
        #expect(IOSTabs.shown(.section(.memory), compact: true) == .section(.system))
        #expect(IOSTabs.shown(.section(.memory), compact: false) == .section(.memory))
        #expect(IOSTabs.shown(.search, compact: true) == .search)
        for section in IOSSection.all {
            for compact in [true, false] {
                let shown = IOSTabs.shown(.section(section), compact: compact)
                #expect(shown.section.map { !IOSTabs.isHidden($0, compact: compact) } == true)
            }
        }
    }

    @Test("ios-navigation-onglets-adaptables/AC-9, AC-11 : `-section` sélectionne l'onglet de la section")
    func launchSelectsEachSection() {
        for section in IOSSection.all {
            let tab = IOSTabs.tab(from: .section(.inbox), to: IOSSection.resolve(["-section", section.rawValue]))
            #expect(tab == .section(section))
            #expect(tab.section == section)
        }
    }

    @Test("ios-navigation-onglets-adaptables/AC-8 : Terminal et Fichiers, absents de l'iPhone, laissent l'onglet inchangé")
    func sectionsOutsideTheAppKeepTheTab() {
        let outside = ConsoleSection.allCases.filter { !IOSSection.all.contains($0) }
        #expect(outside == [.terminal, .files])
        for section in outside {
            #expect(IOSTabs.tab(from: .search, to: section) == .search)
            #expect(IOSTabs.tab(from: .section(.memory), to: section) == .section(.memory))
        }
        #expect(IOSTabs.tab(from: .search, to: .runs) == .section(.runs))
    }

    @Test("ios-navigation-onglets-adaptables/AC-12 : ⌘1…⌘5 sélectionnent l'entrée de la barre latérale de l'iPad")
    func keyboardSelectsTheSidebarEntry() {
        for (index, entry) in IOSKeyboard.sections.enumerated() {
            #expect(IOSTabs.tab(from: .section(.inbox), to: entry.section) == .section(entry.section))
            #expect(entry.shortcut.key == Character(String(index + 1)))
        }
        #expect(IOSKeyboard.sections.map(\.section) == IOSSection.sidebarOrder)
    }

    @Test("refonte : À traiter porte tout ce qui attend, Poste ses approbations, Système la vigie muette")
    func badgesFollowWhatWaits() {
        #expect(IOSTabs.badge(of: .inbox, pending: 4, approvals: 2, vigieSilent: false) == 6)
        #expect(IOSTabs.badge(of: .workstation, pending: 4, approvals: 2, vigieSilent: false) == 2)
        #expect(IOSTabs.badge(of: .system, pending: 4, approvals: 2, vigieSilent: true) == 1)
        #expect(IOSTabs.badge(of: .system, pending: 4, approvals: 2, vigieSilent: false) == 0)
        for section in [ConsoleSection.runs, .memory] {
            #expect(IOSTabs.badge(of: section, pending: 4, approvals: 2, vigieSilent: true) == 0)
        }
    }

    @Test("refonte : la page d'une feature s'ouvre sur ses preuves quand sa revue attend, sur ce qu'elle attend sinon, sur son direct quand elle tourne")
    func runPageOpensOnTheRightTab() {
        #expect(IOSRunTab.initial(.proofs) == .proofs)
        #expect(IOSRunTab.initial(.overview) == .overview)
        #expect(IOSRunTab.initial(.live) == .live)
        #expect(IOSRunTab.allCases.map(\.session) == [nil, nil, .live, .changes, .tests, .timeline])
        // Les Preuves n'ont pas d'onglet quand le serveur ne les sert pas.
        #expect(IOSRunTab.shown(proofs: false) == [.overview, .live, .changes, .tests, .timeline])
        #expect(IOSRunTab.shown(proofs: true).contains(.proofs))
    }
}
