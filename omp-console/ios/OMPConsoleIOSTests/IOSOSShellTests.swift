// Les preuves Swift de la coque de la nouvelle interface (l'« OS agentique ») sur iPhone et
// iPad : le choix de la coque au lancement (arguments de recette, réglage gardé), où mène
// une demande venue du dehors (lien, notification, palette, clavier), la traduction de ce
// qu'un écran partagé demande en onglet et en page, et les pastilles. Logique pure : aucun
// écran n'est rendu.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsoleIOS

@MainActor
@Suite("coque iOS de la nouvelle interface — lancement, routage, pastilles")
struct IOSOSShellTests {
    @Test("la nouvelle interface est le défaut : un lancement sans argument ni réglage l'ouvre sur « Maintenant »")
    func newInterfaceIsTheDefault() {
        let launch = IOSShellLaunch.resolve([], prefersClassic: false)
        #expect(!launch.classic)
        #expect(launch.initialTab == .now)
        #expect(IOSOSTab.allCases == [.now, .threads, .decisions, .proposals, .knowledge])
    }

    @Test("les crochets de recette de la coque classique l'ouvrent toujours, quel que soit le réglage et même à côté de -os.view")
    func classicRecipeHooksAlwaysOpenTheClassicShell() {
        for arguments in [["-section", "runs"], ["-ios.state", "error"], ["-memoire.recipe", "graphe"], ["-section", "inbox", "-os.view", "threads"]] {
            #expect(IOSShellLaunch.resolve(arguments, prefersClassic: false) == IOSShellLaunch(classic: true))
        }
    }

    @Test("le réglage gardé choisit la coque ; -os.view, -os.thread et -os.space ouvrent la nouvelle interface malgré lui")
    func storedChoiceAndRecipeScreens() {
        #expect(IOSShellLaunch.resolve([], prefersClassic: true).classic)
        for tab in IOSOSTab.allCases {
            let launch = IOSShellLaunch.resolve(["-os.view", tab.rawValue], prefersClassic: true)
            #expect(!launch.classic && launch.initialTab == tab)
        }
        let onThread = IOSShellLaunch.resolve(["-os.thread", "r1"], prefersClassic: true)
        #expect(!onThread.classic && onThread.thread == "r1" && onThread.initialTab == .threads)
        let onSpace = IOSShellLaunch.resolve(["-os.space", "Client Acme"], prefersClassic: false)
        #expect(onSpace.space == "Client Acme" && onSpace.initialTab == .knowledge)
        // Une valeur inconnue ou absente est ignorée : le réglage décide.
        #expect(IOSShellLaunch.resolve(["-os.view", "ailleurs"], prefersClassic: true).classic)
        #expect(IOSShellLaunch.resolve(["-os.view"], prefersClassic: false) == IOSShellLaunch(classic: false))
    }

    @Test("le choix d'interface est gardé d'un lancement à l'autre ; une page de Système montre la classique sans rien garder")
    func interfaceChoiceIsKept() {
        let preferences = InMemoryClientPreferences()
        let first = IOSInterface(arguments: [], preference: ConsoleInterfacePreference(preferences: preferences))
        #expect(!first.classic)
        first.showClassic()
        #expect(first.classic)
        #expect(!IOSInterface(arguments: [], preference: ConsoleInterfacePreference(preferences: preferences)).classic)

        first.choose(classic: true)
        let second = IOSInterface(arguments: [], preference: ConsoleInterfacePreference(preferences: preferences))
        #expect(second.classic)
        second.choose(classic: false)
        #expect(!IOSInterface(arguments: [], preference: ConsoleInterfacePreference(preferences: preferences)).classic)
    }

    @Test("un lien mène à « Maintenant », au tri ou au fil d'une feature ; une section mène à son onglet, le Système à la coque classique")
    func destinationsReachTheirScreen() {
        #expect(IOSOSRouting.destination(of: HarnessWidgetLink.Destination.now) == .tab(.now))
        #expect(IOSOSRouting.destination(of: HarnessWidgetLink.Destination.decisions) == .tab(.decisions))
        #expect(IOSOSRouting.destination(of: HarnessWidgetLink.Destination.thread("r1")) == .run("r1"))
        #expect(IOSOSRouting.destination(of: HarnessWidgetLink.Destination.section(.runs)) == .tab(.threads))
        #expect(IOSOSRouting.destination(of: HarnessWidgetLink.Destination.system(.vigie)) == .classicPage(.vigie))

        // Une notification : ce qui attend l'humain (envois du poste compris) est aux Décisions.
        #expect(IOSOSRouting.destination(of: ConsoleSection.inbox) == .tab(.decisions))
        #expect(IOSOSRouting.destination(of: ConsoleSection.workstation) == .tab(.decisions))
        #expect(IOSOSRouting.destination(of: ConsoleSection.runs, openedRun: "r7") == .run("r7"))
        #expect(IOSOSRouting.destination(of: ConsoleSection.memory) == .memory)
        #expect(IOSOSRouting.destination(of: ConsoleSection.system) == .classic(.system))
    }

    @Test("un fil demandé se pousse dans l'onglet courant, revenir rend la racine ; « Maintenant » referme le fil oublié")
    func sharedScreensDriveTheStacks() throws {
        let home = try #require(IOSOSTab.now.rootSelection)
        var navigation = IOSOSNavigation(tab: .threads)
        #expect(navigation.selection == nil)

        navigation.follow(selection: "t1")
        #expect(navigation.tab == .threads && navigation.path(of: .threads) == [.thread("t1")])
        #expect(navigation.selection == "t1")
        // La même demande ne pousse pas deux fois ; une autre feature citée se pousse par-dessus.
        navigation.follow(selection: "t1")
        navigation.follow(selection: "t2")
        #expect(navigation.path(of: .threads) == [.thread("t1"), .thread("t2")])

        // Le fil oublié : « Maintenant » referme sa page ; à la racine, il ouvre l'onglet.
        navigation.follow(selection: home)
        #expect(navigation.tab == .threads && navigation.path(of: .threads) == [.thread("t1")])
        navigation.setPath([], of: .threads)
        navigation.follow(selection: home)
        #expect(navigation.tab == .now && navigation.top == nil)
        #expect(navigation.selection == home)
    }

    @Test("Propositions et Savoir ouvrent leur onglet, les Automatismes et un espace se poussent ; un onglet montré repart de sa racine")
    func fixedScreensOpenTheirTab() throws {
        var navigation = IOSOSNavigation()
        navigation.follow(selection: IOSOSTab.proposals.rootSelection)
        #expect(navigation.tab == .proposals && navigation.top == nil)

        navigation.follow(selection: IOSOSRoute.automations.selection)
        #expect(navigation.tab == .knowledge && navigation.path(of: .knowledge) == [.automations])

        let spacePage = try #require(IOSOSRoute.space("s1").selection)
        navigation.follow(selection: spacePage)
        #expect(navigation.path(of: .knowledge) == [.automations, .space("s1")])
        #expect(navigation.selection == spacePage)

        navigation.follow(selection: IOSOSTab.knowledge.rootSelection)
        #expect(navigation.tab == .knowledge && navigation.top == nil)

        // Un lien ou une notification : l'onglet à sa racine, ou une page seule dans sa pile.
        navigation.show(.thread("t9"), in: .threads)
        navigation.show(.decisions)
        #expect(navigation.tab == .decisions && navigation.path(of: .threads) == [.thread("t9")])
        navigation.show(.threads)
        #expect(navigation.top == nil)
        // Rien à suivre : l'écran ne bouge pas.
        let before = navigation
        navigation.follow(selection: nil)
        #expect(navigation == before)
    }

    @Test("la pastille des Décisions compte ce qui attend, celle des Propositions les propositions ; les autres onglets n'en ont pas")
    func badgesCountWhatWaits() {
        #expect(IOSOSRouting.badge(of: .decisions, decisions: 3, proposals: 5) == 3)
        #expect(IOSOSRouting.badge(of: .proposals, decisions: 3, proposals: 5) == 5)
        for tab in [IOSOSTab.now, .threads, .knowledge] {
            #expect(IOSOSRouting.badge(of: tab, decisions: 3, proposals: 5) == 0)
        }
        #expect(IOSShellText.sectionRowLabel(IOSOSTab.decisions.title, badge: 3) == "Décisions, 3 en attente")
        #expect(IOSShellText.sectionRowLabel(IOSOSTab.threads.title, badge: 0) == "Fils")
    }

    @Test("la recette ouvre un fil par son identifiant ou par celui d'une de ses features")
    func recipeFindsAThreadByItsRun() {
        let run = HarnessRun(id: "r1", repo: "demo", slug: "r1", title: "Export du panier", request: "Export du panier", state: "running", step: "impl")
        let threads = OSThreads.build(runs: [run], inbox: nil, projects: [], audits: [], requests: [], incidents: [])
        let found = IOSOSRouting.thread(named: "r1", in: threads)
        #expect(found != nil)
        #expect(found.flatMap { IOSOSRouting.thread(named: $0.id, in: threads) } == found)
        #expect(IOSOSRouting.thread(named: "inconnu", in: threads) == nil)
    }

    @Test("le serveur de recette vient des deux arguments à la fois, adresse normalisée ; sinon aucun")
    func recipeServerNeedsBothArguments() {
        let server = IOSRecipeServer.resolve(["-os.server", "serveur.exemple:18804/", "-os.token", "jeton"])
        #expect(server?.address == HarnessModel.normalizedAddress("serveur.exemple:18804") && server?.token == "jeton")
        #expect(IOSRecipeServer.resolve(["-os.server", "serveur.exemple:18804"]) == nil)
        #expect(IOSRecipeServer.resolve(["-os.server", "pas une adresse", "-os.token", "jeton"]) == nil)
        #expect(IOSRecipeServer.resolve([]) == nil)
    }
}
