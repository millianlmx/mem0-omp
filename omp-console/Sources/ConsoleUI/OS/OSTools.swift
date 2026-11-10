// L'« OS agentique » : UNE SEULE interface. Les écrans classiques encore nécessaires
// (Mémoire, Poste, Santé, Administration, Serveur, Terminal, Fichiers) sont des OUTILS :
// ils s'ouvrent dans le détail de la nouvelle coque — le Radar et la liste restent —
// depuis l'entrée « Outils » au pied de la liste des fils. Ce fichier porte aussi le
// routage pur de tout ce qui visait une section classique (liens `ompconsole://…`,
// notifications, palette, raccourcis) vers un écran de la nouvelle coque : plus rien
// n'écrit la préférence d'interface, hors le choix explicite du menu Présentation.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Un écran classique ouvert dans le détail de la nouvelle coque.
public enum OSTool: String, CaseIterable, Identifiable, Sendable {
    case memory, workstation, health, admin, server, terminal, files

    public var id: String { rawValue }

    private static let prefix = "tool:"

    /// La sélection de l'espace de travail qui montre cet outil.
    public var selection: String { Self.prefix + rawValue }

    /// L'outil qu'une sélection montre, ou `nil` (autre écran, fil).
    public init?(selection: String?) {
        guard let selection, selection.hasPrefix(Self.prefix) else { return nil }
        self.init(rawValue: String(selection.dropFirst(Self.prefix.count)))
    }

    /// Le nom de l'écran classique que l'outil ouvre.
    public var title: String {
        switch self {
        case .memory: ConsoleSection.memory.title
        case .workstation: ConsoleSection.workstation.title
        case .health: DashboardText.healthTitle
        case .admin: SystemPage.admin.title
        case .server: SystemPage.server.title
        case .terminal: ConsoleSection.terminal.title
        case .files: ConsoleSection.files.title
        }
    }

    public var symbol: String {
        switch self {
        case .memory: ConsoleSection.memory.systemImage
        case .workstation: ConsoleSection.workstation.systemImage
        case .health: SystemPage.stats.systemImage
        case .admin: SystemPage.admin.systemImage
        case .server: SystemPage.server.systemImage
        case .terminal: ConsoleSection.terminal.systemImage
        case .files: ConsoleSection.files.systemImage
        }
    }

    /// Les outils montrés à ce jeton : l'Administration à un administrateur seulement.
    public static func available(isAdmin: Bool) -> [OSTool] {
        allCases.filter { isAdmin || $0 != .admin }
    }
}

/// Où mène, dans la nouvelle coque, une demande venue d'ailleurs que la liste.
public enum OSRoute: Equatable, Sendable {
    /// Un écran du détail : la sélection de l'espace de travail (« Maintenant », Propositions,
    /// Automatismes, Savoir, un outil).
    case screen(String)
    /// « À vous » : ce qui attend l'humain, à trier.
    case triage
}

/// Les écrans que ⌘1…⌘5 et la palette ouvrent, dans cet ordre.
public enum OSScreen: String, CaseIterable, Identifiable, Sendable {
    case now, yours, proposals, automations, knowledge

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .now: OSText.now
        case .yours: OSText.yours
        case .proposals: OSWatchText.proposals
        case .automations: OSText.automations
        case .knowledge: OSWatchText.knowledge
        }
    }

    public var symbol: String {
        switch self {
        case .now: "dot.radiowaves.left.and.right"
        case .yours: "rectangle.stack.fill"
        case .proposals: "lightbulb"
        case .automations: "gearshape.arrow.triangle.2.circlepath"
        case .knowledge: "books.vertical"
        }
    }

    /// La touche du raccourci : ⌘1…⌘5.
    public var key: Character {
        Character(String((Self.allCases.firstIndex(of: self) ?? 0) + 1))
    }

    @MainActor
    public var route: OSRoute {
        switch self {
        case .now: .screen(OSWorkspace.now)
        case .yours: .triage
        case .proposals: .screen(OSWorkspace.proposals)
        case .automations: .screen(OSWorkspace.automations)
        case .knowledge: .screen(OSWorkspace.knowledge)
        }
    }
}

/// Le routage vers la nouvelle coque de ce qui nommait une section classique. Pur : il ne
/// touche ni la préférence d'interface, ni la sélection classique.
@MainActor
public enum OSRouter {
    /// Où mène une section classique demandée par un lien `ompconsole://<section>`, une
    /// notification ou la palette. `page` : la page de Système demandée. `opensRun` : une
    /// tâche est demandée (`drafts.openedRun`), la coque ouvre son fil elle-même.
    /// `pendingAtPoste` : des envois du poste attendent une approbation (le popup de
    /// l'extension ouvre `ompconsole://workstation` pour approuver). `nil` : rien de plus à faire.
    public static func route(section: ConsoleSection, page: SystemPage? = nil, opensRun: Bool = false, pendingAtPoste: Bool = false) -> OSRoute? {
        switch section {
        case .inbox: return .triage
        case .runs: return opensRun ? nil : .screen(OSWorkspace.now)
        case .workstation: return pendingAtPoste ? .triage : .screen(OSTool.workstation.selection)
        case .memory: return .screen(OSTool.memory.selection)
        case .terminal: return .screen(OSTool.terminal.selection)
        case .files: return .screen(OSTool.files.selection)
        case .system: return route(page: page)
        }
    }

    /// Une page de Système : la vigie et les planifications sont des Automatismes, les
    /// paliers d'autonomie du Savoir ; le reste est un outil.
    private static func route(page: SystemPage?) -> OSRoute {
        switch page {
        case .vigie, .schedules: .screen(OSWorkspace.automations)
        case .autonomy: .screen(OSWorkspace.knowledge)
        case .admin: .screen(OSTool.admin.selection)
        case .server: .screen(OSTool.server.selection)
        case .stats, nil: .screen(OSTool.health.selection)
        }
    }

    /// L'écran qu'un lien propre à la nouvelle interface ouvre (`ompconsole://now`,
    /// `ompconsole://decisions`) ; `nil` pour tout autre hôte.
    public static func route(host: String?) -> OSRoute? {
        switch host {
        case "now": .screen(OSWorkspace.now)
        case "decisions": .triage
        default: nil
        }
    }

    /// Ce qu'une route montre vraiment : un écran que ce serveur ne sert pas (Propositions
    /// d'un vieux serveur) ou un outil hors de portée (Administration sans le rôle) retombe
    /// sur « Maintenant ».
    public static func resolve(_ route: OSRoute, proposalsServed: Bool, isAdmin: Bool) -> OSRoute {
        guard case let .screen(selection) = route else { return route }
        if selection == OSWorkspace.proposals, !proposalsServed { return .screen(OSWorkspace.now) }
        if OSTool(selection: selection) == .admin, !isAdmin { return .screen(OSWorkspace.now) }
        return route
    }
}

#if os(macOS)
/// L'entrée « Outils », au pied de la liste des fils : un menu des écrans classiques.
/// L'outil montré s'y lit (« Outils · Mémoire »).
public struct OSToolsEntry: View {
    @ObservedObject var workspace: OSWorkspace
    let tools: [OSTool]

    public init(workspace: OSWorkspace, tools: [OSTool]) {
        self.workspace = workspace
        self.tools = tools
    }

    public var body: some View {
        let shown = OSTool(selection: workspace.selection)
        Menu {
            ForEach(tools) { tool in
                Button {
                    workspace.selection = tool.selection
                } label: {
                    Label(tool.title, systemImage: tool.symbol)
                }
            }
        } label: {
            Label(shown.map { ConsoleSectionGroup.tools.title + " · " + $0.title } ?? ConsoleSectionGroup.tools.title, systemImage: "wrench.and.screwdriver")
                .foregroundStyle(shown == nil ? Color.primary : Color.accentColor)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.visible)
        .fixedSize()
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .accessibilityIdentifier("os.tools")
    }
}
#endif
