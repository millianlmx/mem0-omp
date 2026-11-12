// Les preuves Swift de la coque de l'app (l'« OS agentique ») sur iPhone et iPad : l'écran
// ouvert au lancement (arguments de recette), où mène une demande venue du dehors (lien,
// notification, palette, clavier), la traduction de ce qu'un écran partagé demande en
// onglet et en page, le hub Système dans la pile, et les pastilles. Logique pure : aucun
// écran n'est rendu.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsoleIOS

@MainActor
@Suite("coque iOS — lancement, routage, Système, pastilles")
struct IOSOSShellTests {
    @Test("un lancement sans argument ouvre « Maintenant », pile vide")
    func launchOpensNow() {
        let launch = IOSShellLaunch.resolve([])
        #expect(launch == IOSShellLaunch())
        #expect(launch.initialTab == .now)
        #expect(launch.initialNavigation == IOSOSNavigation(tab: .now))
        #expect(IOSOSTab.allCases == [.now, .threads, .decisions, .proposals, .knowledge])
    }

    @Test("-os.view, -os.thread et -os.space ouvrent leur écran ; une valeur inconnue ou absente est ignorée")
    func recipeScreens() {
        for tab in IOSOSTab.allCases {
            #expect(IOSShellLaunch.resolve(["-os.view", tab.rawValue]).initialTab == tab)
        }
        let onThread = IOSShellLaunch.resolve(["-os.thread", "r1"])
        #expect(onThread.thread == "r1" && onThread.initialTab == .threads)
        let onSpace = IOSShellLaunch.resolve(["-os.space", "Client Acme"])
        #expect(onSpace.space == "Client Acme" && onSpace.initialTab == .knowledge)
        #expect(IOSShellLaunch.resolve(["-os.view", "ailleurs"]) == IOSShellLaunch())
        #expect(IOSShellLaunch.resolve(["-os.view"]) == IOSShellLaunch())
        #expect(IOSShellLaunch.resolve(["-os.system", "ailleurs"]) == IOSShellLaunch())
        // La dernière paire reconnue gagne.
        #expect(IOSShellLaunch.resolve(["-os.view", "threads", "-os.view", "decisions"]).initialTab == .decisions)
    }

    @Test("les crochets de l'écran Mémoire (-ios.state, -memoire.recipe) ouvrent la Mémoire dans le Savoir")
    func memoryRecipeHooksOpenTheMemory() {
        for arguments in [["-ios.state", "error"], ["-memoire.recipe", "graphe"]] {
            let launch = IOSShellLaunch.resolve(arguments)
            #expect(launch.memory && launch.initialTab == .knowledge)
            #expect(launch.initialNavigation.path(of: .knowledge) == [.memory])
        }
    }

    @Test("-os.system ouvre la page demandée par-dessus le hub, dans l'onglet ; le Serveur n'est jamais poussé")
    func recipeOpensASystemPage() {
        let repos = IOSShellLaunch.resolve(["-os.system", "repos"])
        #expect(repos.system == .repos && repos.initialTab == .now)
        #expect(repos.initialNavigation.path(of: .now) == [.system, .systemPage(.repos)])
        let vigie = IOSShellLaunch.resolve(["-os.view", "threads", "-os.system", "vigie"]).initialNavigation
        #expect(vigie.tab == .threads && vigie.path(of: .threads) == [.system, .systemPage(.vigie)])
        #expect(IOSShellLaunch.resolve(["-os.system", "server"]).initialNavigation.path(of: .now) == [.system])
    }

    @Test("un lien mène à « Maintenant », au tri, au fil d'une feature ou à une page du Système ; une section à son écran")
    func destinationsReachTheirScreen() {
        #expect(IOSOSRouting.destination(of: HarnessWidgetLink.Destination.now) == .tab(.now))
        #expect(IOSOSRouting.destination(of: HarnessWidgetLink.Destination.decisions) == .tab(.decisions))
        #expect(IOSOSRouting.destination(of: HarnessWidgetLink.Destination.thread("r1")) == .run("r1"))
        #expect(IOSOSRouting.destination(of: HarnessWidgetLink.Destination.section(.runs)) == .tab(.threads))
        #expect(IOSOSRouting.destination(of: HarnessWidgetLink.Destination.system(.vigie)) == .systemPage(.vigie))
        #expect(IOSOSRouting.destination(of: HarnessWidgetLink.Destination.system(.server)) == .systemPage(.server))

        // Une notification, la palette : ce qui attend l'humain est aux Décisions, le Poste
        // est sa page du Système.
        #expect(IOSOSRouting.destination(of: ConsoleSection.inbox) == .tab(.decisions))
        #expect(IOSOSRouting.destination(of: ConsoleSection.workstation) == .systemPage(.workstation))
        #expect(IOSOSRouting.destination(of: ConsoleSection.runs, openedRun: "r7") == .run("r7"))
        #expect(IOSOSRouting.destination(of: ConsoleSection.memory) == .memory)
        // Le Système : la page posée par la palette (`drafts.systemPage`), sinon le hub.
        #expect(IOSOSRouting.destination(of: ConsoleSection.system) == .system)
        #expect(IOSOSRouting.destination(of: ConsoleSection.system, page: .schedules) == .systemPage(.schedules))
        #expect(IOSOSRouting.destination(of: ConsoleSection.system, page: .repos) == .systemPage(.repos))
    }

    @Test("le hub Système se pousse dans l'onglet courant sans changer la sélection ; une page se pose par-dessus")
    func systemStacksInTheCurrentTab() throws {
        let home = try #require(IOSOSTab.now.rootSelection)
        var navigation = IOSOSNavigation(tab: .now)
        navigation.push(.system)
        #expect(navigation.path(of: .now) == [.system])
        // Le Système est un écran de l'app : l'espace de travail garde la racine de l'onglet.
        #expect(navigation.selection == home)
        navigation.push(.systemPage(.stats))
        #expect(navigation.top == .systemPage(.stats) && navigation.selection == home)
        // Rien à suivre : « Maintenant » est déjà la sélection, la page reste.
        navigation.follow(selection: home)
        #expect(navigation.path(of: .now) == [.system, .systemPage(.stats)])

        // Une demande du dehors remplace la pile de l'onglet courant.
        navigation.show(.decisions)
        navigation.showSystem(.admin)
        #expect(navigation.tab == .decisions && navigation.path(of: .decisions) == [.system, .systemPage(.admin)])
        navigation.showSystem()
        #expect(navigation.path(of: .decisions) == [.system])
        navigation.showSystem(.server)
        #expect(navigation.path(of: .decisions) == [.system])
        // ⌘<n> : l'onglet repart de sa racine.
        navigation.show(.decisions)
        #expect(navigation.top == nil)
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
