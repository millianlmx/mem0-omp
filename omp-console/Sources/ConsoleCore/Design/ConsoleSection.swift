// Les treize sections de la coque, dans l'ordre d'affichage de la barre latérale,
// rangées en trois groupes : « Pilotage » (Accueil, Pipelines, Projet, Audit,
// Statistiques, Poste — servis par le serveur de pipelines du VPS), « Consultation »
// (Terminal, Fichiers, Mémoire — locaux) et « Exploitation » (Vigie, Planifications,
// Issues, Administration — la tour de contrôle du même serveur). TOUT vit dans la
// fenêtre principale.
//
// Le Poste (le poste de travail observé par l'extension Chrome et l'agent 24/24)
// est en Pilotage : il est servi par le même serveur, et l'humain y POSE des
// gestes (approuver ou refuser un envoi, régler l'autonomie, mettre en pause) —
// ce n'est pas une simple consultation.
//
// L'Exploitation vient en dernier : les raccourcis ⌘1…⌘9 des neuf premières sections
// ne bougent pas, la Vigie prend ⌘0 sur le Mac. L'Administration n'est montrée qu'à un
// jeton administrateur (le filtre est posé par chaque app, qui connaît le jeton).
//
// Un enum plutôt qu'un tableau de vues : la section est l'identité PARTAGÉE entre
// la liste, le détail, les tests et les features métier. L'ordre de déclaration
// des cas EST l'ordre d'affichage (`CaseIterable`) et celui des raccourcis ⌘1…⌘0,
// donc il n'existe pas de seconde liste à tenir synchronisée.

public enum ConsoleSection: String, CaseIterable, Identifiable, Hashable, Sendable {
    case home
    case kanban
    case project
    case audit
    case stats
    case workstation
    case terminal
    case files
    case memory
    case vigie
    case schedules
    case issues
    case admin

    public var id: String { rawValue }

    /// Libellé affiché dans la barre latérale, et titre de la fenêtre.
    public var title: String {
        switch self {
        case .home: L10n.text("Accueil")
        case .kanban: L10n.text("Pipelines")
        case .project: L10n.text("Projet")
        case .audit: L10n.text("Audit")
        case .terminal: L10n.text("Terminal")
        case .files: L10n.text("Fichiers")
        case .memory: L10n.text("Mémoire")
        case .stats: L10n.text("Statistiques")
        case .workstation: L10n.text("Poste")
        case .vigie: ControlText.vigieTitle
        case .schedules: ControlText.schedulesTitle
        case .issues: ControlText.issuesTitle
        case .admin: ControlText.adminTitle
        }
    }

    /// Symbole SF associé à la section.
    public var systemImage: String {
        switch self {
        case .home: "house"
        case .kanban: "square.grid.2x2"
        case .project: "target"
        case .audit: "checklist"
        case .terminal: "terminal"
        case .files: "doc.text"
        case .memory: "brain"
        case .stats: "chart.bar"
        case .workstation: "desktopcomputer"
        case .vigie: ControlText.vigieSymbol
        case .schedules: ControlText.schedulesSymbol
        case .issues: ControlText.issuesSymbol
        case .admin: ControlText.adminSymbol
        }
    }

    /// Le groupe de la barre latérale.
    public var group: ConsoleSectionGroup {
        switch self {
        case .home, .kanban, .project, .audit, .stats, .workstation: .pilotage
        case .terminal, .files, .memory: .consultation
        case .vigie, .schedules, .issues, .admin: .exploitation
        }
    }

    /// La section n'est montrée qu'à un jeton administrateur.
    public var isAdminOnly: Bool { self == .admin }

    /// Les sections montrées à un jeton : l'Administration seulement à un administrateur.
    public static func visible(_ sections: [ConsoleSection], isAdmin: Bool) -> [ConsoleSection] {
        sections.filter { isAdmin || !$0.isAdminOnly }
    }
}

/// Les groupes de la barre latérale, dans leur ordre d'affichage.
public enum ConsoleSectionGroup: CaseIterable, Sendable {
    case pilotage
    case consultation
    case exploitation

    public var title: String {
        switch self {
        case .pilotage: L10n.text("Pilotage")
        case .consultation: L10n.text("Consultation")
        case .exploitation: ControlText.groupTitle
        }
    }

    /// Les sections du groupe, dans l'ordre de `ConsoleSection.allCases`.
    public var sections: [ConsoleSection] {
        ConsoleSection.allCases.filter { $0.group == self }
    }
}
