import ConsoleClient
import ConsoleCore
import ConsoleUI

// La logique PURE de la coque de la nouvelle interface (l'« OS agentique ») sur iPhone et
// iPad : ses cinq onglets, les pages qu'un onglet pousse dans sa pile, le choix de la
// coque au lancement (arguments de recette, réglage gardé), où mène une demande venue du
// dehors (lien, notification, palette, clavier) et les pastilles. Sans état partagé, sans
// UIKit : `IOSOSRootView` la rend, les tests la prouvent.

/// Les cinq onglets de la nouvelle interface, dans l'ordre de la barre. Leur `rawValue`
/// est la valeur de l'argument de recette `-os.view`.
enum IOSOSTab: String, CaseIterable, Hashable, Sendable {
    case now, threads, decisions, proposals, knowledge

    var title: String {
        switch self {
        case .now: OSText.now
        case .threads: IOSOSText.threads
        case .decisions: OSWatchText.decisions
        case .proposals: OSWatchText.proposals
        case .knowledge: OSWatchText.knowledge
        }
    }

    var systemImage: String {
        switch self {
        case .now: IOSOSText.nowSymbol
        case .threads: IOSOSText.threadsSymbol
        case .decisions: IOSOSText.decisionsSymbol
        case .proposals: IOSOSText.proposalsSymbol
        case .knowledge: IOSOSText.knowledgeSymbol
        }
    }

    /// La sélection de l'espace de travail quand l'onglet montre sa racine : les écrans
    /// partagés la lisent (`OSWorkspace.selection`).
    @MainActor var rootSelection: String? {
        switch self {
        case .now: OSWorkspace.now
        case .threads, .decisions: nil
        case .proposals: OSWorkspace.proposals
        case .knowledge: OSWorkspace.knowledge
        }
    }
}

/// Une page poussée dans la pile d'un onglet.
enum IOSOSRoute: Hashable, Sendable {
    /// Un fil, par son identifiant.
    case thread(String)
    /// La page d'un espace, par son identifiant.
    case space(String)
    case automations
    case memory

    /// La sélection de l'espace de travail quand la page est montrée.
    @MainActor var selection: String? {
        switch self {
        case let .thread(id): id
        case let .space(id): OSWorkspace.space(id)
        case .automations: OSWorkspace.automations
        // La Mémoire est un écran de l'app : elle s'ouvre depuis le Savoir, qui reste la sélection.
        case .memory: OSWorkspace.knowledge
        }
    }
}

/// L'onglet montré et la pile de chaque onglet. Les écrans partagés demandent un écran par
/// `OSWorkspace.selection` : `follow` traduit la demande en onglet et en page, `selection`
/// rend à l'espace de travail ce que l'écran montre.
struct IOSOSNavigation: Equatable {
    var tab: IOSOSTab = .now
    private var paths: [IOSOSTab: [IOSOSRoute]] = [:]

    init(tab: IOSOSTab = .now) {
        self.tab = tab
    }

    /// La pile d'un onglet, de la première page poussée à celle montrée.
    func path(of tab: IOSOSTab) -> [IOSOSRoute] {
        paths[tab] ?? []
    }

    mutating func setPath(_ path: [IOSOSRoute], of tab: IOSOSTab) {
        paths[tab] = path
    }

    /// La page montrée par l'onglet courant, ou `nil` à sa racine.
    var top: IOSOSRoute? { path(of: tab).last }

    /// Montre un onglet à sa racine (lien, notification, clavier, argument de recette).
    mutating func show(_ tab: IOSOSTab) {
        self.tab = tab
        paths[tab] = []
    }

    /// Pousse une page dans l'onglet courant ; la page déjà montrée n'est pas poussée deux fois.
    mutating func push(_ route: IOSOSRoute) {
        guard top != route else { return }
        paths[tab, default: []].append(route)
    }

    /// Montre une page seule dans la pile d'un onglet.
    mutating func show(_ route: IOSOSRoute, in tab: IOSOSTab) {
        self.tab = tab
        paths[tab] = [route]
    }

    /// Ce que l'écran montre, dit à l'espace de travail : la page du haut de la pile, sinon
    /// la racine de l'onglet.
    @MainActor var selection: String? {
        top.map { $0.selection } ?? tab.rootSelection
    }

    /// Suit ce qu'un écran partagé demande par `OSWorkspace.selection` : « Maintenant »
    /// referme la page montrée (un fil oublié) ou, à la racine, ouvre l'onglet ; les
    /// Propositions et le Savoir ouvrent leur onglet ; les Automatismes se poussent dans le
    /// Savoir ; un espace et un fil se poussent dans l'onglet courant. Sans effet quand
    /// l'écran montre déjà la sélection.
    @MainActor mutating func follow(selection: String?) {
        guard let selection, selection != self.selection else { return }
        switch selection {
        case OSWorkspace.now:
            if top == nil { show(.now) } else { paths[tab]?.removeLast() }
        case OSWorkspace.proposals:
            show(.proposals)
        case OSWorkspace.knowledge:
            show(.knowledge)
        case OSWorkspace.automations:
            show(.automations, in: .knowledge)
        default:
            push(OSWorkspace.spaceId(of: selection).map(IOSOSRoute.space) ?? .thread(selection))
        }
    }
}

/// Où mène, dans la nouvelle interface, une demande venue du dehors.
enum IOSOSDestination: Equatable {
    case tab(IOSOSTab)
    /// Le fil d'une feature : l'onglet Fils, puis son fil dès qu'il est connu.
    case run(String)
    /// La Mémoire, poussée dans le Savoir.
    case memory
    /// Sans équivalent dans la nouvelle interface : la coque classique, à cette section.
    case classic(ConsoleSection)
    /// Une page du hub Système de la coque classique.
    case classicPage(SystemPage)
}

enum IOSOSRouting {
    /// Une section demandée (⌘<n>, palette, notification) : ce qui attend l'humain est
    /// l'onglet Décisions, envois du poste compris ; les features sont les Fils — ou le
    /// fil de la feature à ouvrir (`openedRun`) ; la Mémoire se pousse dans le Savoir. Le
    /// Système n'existe que dans la coque classique.
    static func destination(of section: ConsoleSection, openedRun: String? = nil) -> IOSOSDestination {
        switch section {
        case .inbox, .workstation: .tab(.decisions)
        case .runs: openedRun.map(IOSOSDestination.run) ?? .tab(.threads)
        case .memory: .memory
        default: .classic(section)
        }
    }

    /// Un lien `ompconsole://` (widget, Live Activity, raccourci).
    static func destination(of link: HarnessWidgetLink.Destination) -> IOSOSDestination {
        switch link {
        case .now: .tab(.now)
        case .decisions: .tab(.decisions)
        case let .thread(runId): .run(runId)
        case let .section(section): destination(of: section)
        case let .system(page): .classicPage(page)
        }
    }

    /// La pastille d'un onglet : les décisions qui attendent, les propositions ouvertes.
    static func badge(of tab: IOSOSTab, decisions: Int, proposals: Int) -> Int {
        switch tab {
        case .decisions: decisions
        case .proposals: proposals
        default: 0
        }
    }

    /// Le fil qu'un identifiant désigne : le sien, sinon celui de la feature qui porte cet
    /// identifiant (l'argument `-os.thread` accepte l'un et l'autre).
    static func thread(named id: String, in threads: [OSThread]) -> OSThread? {
        threads.first { $0.id == id } ?? threads.first { candidate in candidate.runs.contains { $0.id == id } }
    }

    /// L'espace qu'un argument de recette nomme, par identifiant ou par nom.
    static func space(named name: String, in spaces: [HarnessSpace]) -> HarnessSpace? {
        spaces.first { $0.id == name } ?? spaces.first { $0.name == name }
    }
}

/// La coque montrée au lancement et, pour la recette, l'écran de la nouvelle interface à
/// ouvrir. Lu dans les arguments de lancement :
///
/// - `-section`, `-ios.state`, `-memoire.recipe` : les crochets de recette de la coque
///   classique l'ouvrent TOUJOURS (les scripts de capture et leurs gardes en dépendent) ;
/// - `-os.view <now|threads|decisions|proposals|knowledge>`, `-os.thread <fil ou feature>`,
///   `-os.space <identifiant ou nom>` : la nouvelle interface, à cet écran, quel que soit
///   le réglage ;
/// - sinon le réglage gardé : la nouvelle interface, sauf si la classique a été choisie.
///
/// Même tolérance que `IOSSection.resolve` : la dernière paire reconnue gagne, une valeur
/// absente ou inconnue est ignorée.
struct IOSShellLaunch: Equatable {
    var classic: Bool
    var tab: IOSOSTab?
    var thread: String?
    var space: String?

    /// Les crochets de recette de la coque classique.
    static let classicFlags = ["-section", "-ios.state", "-memoire.recipe"]
    static let viewFlag = "-os.view"
    static let threadFlag = "-os.thread"
    static let spaceFlag = "-os.space"

    static func resolve(_ arguments: [String], prefersClassic: Bool) -> IOSShellLaunch {
        if arguments.contains(where: classicFlags.contains) { return IOSShellLaunch(classic: true) }
        var launch = IOSShellLaunch(classic: prefersClassic)
        var index = 0
        while index + 1 < arguments.count {
            let value = arguments[index + 1]
            switch arguments[index] {
            case viewFlag:
                if let tab = IOSOSTab(rawValue: value) { launch.tab = tab }
            case threadFlag:
                launch.thread = value
            case spaceFlag:
                launch.space = value
            default:
                break
            }
            index += 1
        }
        if launch.tab != nil || launch.thread != nil || launch.space != nil { launch.classic = false }
        return launch
    }

    /// L'onglet ouvert au lancement de la nouvelle interface : celui que nomme la recette ;
    /// un fil s'ouvre dans les Fils, un espace dans le Savoir ; sinon « Maintenant ».
    var initialTab: IOSOSTab {
        if let tab { return tab }
        if thread != nil { return .threads }
        if space != nil { return .knowledge }
        return .now
    }
}

/// Le serveur que la recette donne à l'app par ses arguments de lancement
/// (`-os.server <adresse> -os.token <jeton>`) : il ne sert que si l'app n'en a enregistré
/// aucun (`HarnessModel.live(fallback:)`), et rien n'est écrit. Le script de captures y
/// relie le simulateur au serveur de démonstration.
enum IOSRecipeServer {
    static let addressFlag = "-os.server"
    static let tokenFlag = "-os.token"

    static func resolve(_ arguments: [String]) -> (address: String, token: String)? {
        guard let address = value(of: addressFlag, in: arguments), let token = value(of: tokenFlag, in: arguments),
              let normalized = HarnessModel.normalizedAddress(address), !token.isEmpty else { return nil }
        return (normalized, token)
    }

    private static func value(of flag: String, in arguments: [String]) -> String? {
        guard let index = arguments.lastIndex(of: flag), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
    }
}
