// Les preuves Swift du routage pur de la coque à onglets (ios-navigation-onglets-adaptables,
// S-1) : la barre d'onglets de l'iPhone, l'onglet « Plus », le masquage par classe de
// taille, la résolution de `-section` au lancement, la pile de « Plus » conservée, et la
// recette `-sessions.recipe longue` qui rend la liste de Sessions défilable (S-6).

import ConsoleCore
import Testing

@testable import OMPConsoleIOS

@MainActor
@Suite("ios-navigation-onglets-adaptables — onglets et barre latérale")
struct IOSTabsTests {
    @Test("ios-navigation-onglets-adaptables/AC-1 : l'iPhone montre quatre sections puis « Plus », dans l'ordre")
    func compactTabsAreFourSectionsThenPlus() {
        let expected: [IOSTab] = [.section(.home), .section(.kanban), .section(.sessions), .section(.memory), .plus]
        #expect(IOSTabs.compactTabs == expected)
        // L'ordre de déclaration du `TabView` (la barre latérale), filtré par le masquage.
        let declared = IOSSection.sidebarOrder.map(IOSTab.section).filter { !IOSTabs.isHidden($0, compact: true) } + [.plus]
        #expect(IOSTabs.compactTabs == declared)
    }

    @Test("ios-navigation-onglets-adaptables/AC-3 : « Plus » liste Projet, Session OMP et Statistiques, et elles seules")
    func plusListsTheThreeOtherSections() {
        #expect(IOSTabs.plusSections == [.project, .session, .stats])
        let tabSections: [ConsoleSection] = IOSTabs.compactTabs.compactMap {
            if case let .section(section) = $0 { section } else { nil }
        }
        #expect(Set(IOSTabs.plusSections).union(tabSections) == Set(IOSSection.all))
        #expect(Set(IOSTabs.plusSections).isDisjoint(with: tabSections))
    }

    @Test("ios-navigation-onglets-adaptables/AC-1, AC-4 : le masquage des onglets suit la classe de taille")
    func hiddenTabsFollowTheSizeClass() {
        for section in IOSSection.all {
            #expect(!IOSTabs.isHidden(.section(section), compact: false))
        }
        #expect(IOSTabs.isHidden(.plus, compact: false))

        let hiddenCompact = IOSSection.all.filter { IOSTabs.isHidden(.section($0), compact: true) }
        #expect(hiddenCompact == IOSTabs.plusSections)
        #expect(!IOSTabs.isHidden(.plus, compact: true))
    }

    @Test("ios-navigation-onglets-adaptables/AC-9, AC-11 : `-section` ouvre l'onglet attendu sur iPhone")
    func launchRoutesEachSectionOnIPhone() {
        let expected: [ConsoleSection: IOSTabRoute] = [
            .home: IOSTabRoute(tab: .section(.home), plusPath: []),
            .kanban: IOSTabRoute(tab: .section(.kanban), plusPath: []),
            .project: IOSTabRoute(tab: .plus, plusPath: [.project]),
            .session: IOSTabRoute(tab: .plus, plusPath: [.session]),
            .sessions: IOSTabRoute(tab: .section(.sessions), plusPath: []),
            .memory: IOSTabRoute(tab: .section(.memory), plusPath: []),
            .stats: IOSTabRoute(tab: .plus, plusPath: [.stats]),
        ]
        #expect(Set(expected.keys) == Set(IOSSection.all))
        for section in IOSSection.all {
            let launched = IOSTabRoute(tab: .section(IOSSection.resolve(["-section", section.rawValue])), plusPath: [])
            let route = IOSTabs.adapt(launched, compact: true)
            #expect(route == expected[section])
            #expect(IOSTabs.shown(route) == section)
        }
    }

    @Test("ios-navigation-onglets-adaptables/AC-10, AC-11 : `-section` sélectionne l'entrée attendue de la barre latérale de l'iPad")
    func launchRoutesEachSectionOnIPad() {
        let expected: [ConsoleSection: ConsoleSectionGroup] = [
            .home: .pilotage,
            .kanban: .pilotage,
            .project: .pilotage,
            .session: .pilotage,
            .sessions: .consultation,
            .memory: .consultation,
            .stats: .consultation,
        ]
        #expect(Set(expected.keys) == Set(IOSSection.all))
        for section in IOSSection.all {
            let launched = IOSTabRoute(tab: .section(IOSSection.resolve(["-section", section.rawValue])), plusPath: [])
            let route = IOSTabs.adapt(launched, compact: false)
            #expect(route == IOSTabRoute(tab: .section(section), plusPath: []))
            #expect(IOSTabs.shown(route) == section)
            #expect(section.group == expected[section])
            #expect(IOSSection.sections(of: section.group).contains(section))
        }
    }

    @Test("ios-navigation-onglets-adaptables/AC-8 : changer d'onglet conserve la pile de « Plus » ; une section de « Plus » la remplace")
    func routeKeepsThePlusPath() {
        let pushed = IOSTabRoute(tab: .plus, plusPath: [.project])
        let home = IOSTabs.route(from: pushed, to: .home, compact: true)
        #expect(home == IOSTabRoute(tab: .section(.home), plusPath: [.project]))
        #expect(IOSTabs.shown(home) == .home)
        let stats = IOSTabs.route(from: home, to: .stats, compact: true)
        #expect(stats == IOSTabRoute(tab: .plus, plusPath: [.stats]))
        #expect(IOSTabs.shown(stats) == .stats)

        let outside = ConsoleSection.allCases.filter { !IOSSection.all.contains($0) }
        #expect(!outside.isEmpty)
        for section in outside {
            for compact in [true, false] {
                #expect(IOSTabs.route(from: pushed, to: section, compact: compact) == pushed)
                #expect(IOSTabs.route(from: home, to: section, compact: compact) == home)
            }
        }
    }

    @Test("ios-navigation-onglets-adaptables/AC-9, AC-10 : changer de classe de taille range les sections sous « Plus » et inversement")
    func sizeClassChangeMovesBetweenPlusAndSidebar() {
        #expect(IOSTabs.adapt(IOSTabRoute(tab: .section(.stats), plusPath: []), compact: true)
            == IOSTabRoute(tab: .plus, plusPath: [.stats]))
        #expect(IOSTabs.adapt(IOSTabRoute(tab: .plus, plusPath: [.session]), compact: false)
            == IOSTabRoute(tab: .section(.session), plusPath: [.session]))
        #expect(IOSTabs.adapt(IOSTabRoute(tab: .plus, plusPath: []), compact: false)
            == IOSTabRoute(tab: .section(.project), plusPath: []))
        // Une section visible dans les deux tailles ne bouge pas.
        #expect(IOSTabs.adapt(IOSTabRoute(tab: .section(.memory), plusPath: [.project]), compact: true)
            == IOSTabRoute(tab: .section(.memory), plusPath: [.project]))

        var routes = IOSSection.all.map { IOSTabRoute(tab: .section($0), plusPath: []) }
        routes += [IOSTabRoute(tab: .plus, plusPath: []), IOSTabRoute(tab: .plus, plusPath: [.stats])]
        for route in routes {
            for compact in [true, false] {
                let once = IOSTabs.adapt(route, compact: compact)
                #expect(IOSTabs.adapt(once, compact: compact) == once)
                #expect(!IOSTabs.isHidden(once.tab, compact: compact))
            }
        }
    }

    @Test("ios-navigation-onglets-adaptables/AC-12 : ⌘1…⌘7 sélectionnent l'entrée de la barre latérale de l'iPad")
    func keyboardSelectsTheSidebarEntry() {
        let start = IOSTabRoute(tab: .section(.home), plusPath: [])
        for (index, entry) in IOSKeyboard.sections.enumerated() {
            let route = IOSTabs.route(from: start, to: entry.section, compact: false)
            #expect(route.tab == .section(entry.section))
            #expect(IOSTabs.shown(route) == entry.section)
            #expect(entry.shortcut.key == Character(String(index + 1)))
        }
        #expect(IOSKeyboard.sections.map(\.section) == IOSSection.sidebarOrder)
    }

    @Test("ios-navigation-onglets-adaptables/AC-8 : la recette `longue` montre vingt-quatre sessions distinctes, de quoi défiler")
    func longRecipeListsDistinctSessions() throws {
        let resolved = IOSSessionsRecipe.resolve(["-sessions.recipe", "longue"])
        #expect(resolved == .longue)
        let longue = try #require(resolved)

        let choices = longue.list.choices
        #expect(choices.count == 24)
        #expect(Set(choices.map(\.id)).count == 24)
        #expect(choices.allSatisfy { $0.state == .ended(.done) })
        let phases = PipelinePhase.allCases
        #expect(choices.map(\.phase) == (0..<24).map { phases[$0 % phases.count] })
        #expect(choices.allSatisfy { !$0.label.contains("/") })
        #expect(longue.thread == nil)
    }
}
