// Les huit sections de la coque, dans l'ordre d'affichage de la barre latérale,
// rangées en deux groupes : « Pilotage » (Accueil, Pipelines, Projet, Audit,
// Statistiques — servis par le serveur de pipelines du VPS) et « Consultation »
// (Terminal, Fichiers, Mémoire — locaux). TOUT vit dans la fenêtre principale.
//
// Un enum plutôt qu'un tableau de vues : la section est l'identité PARTAGÉE entre
// la liste, le détail, les tests et les features métier. L'ordre de déclaration
// des cas EST l'ordre d'affichage (`CaseIterable`) et celui des raccourcis ⌘1…⌘8,
// donc il n'existe pas de seconde liste à tenir synchronisée.

public enum ConsoleSection: String, CaseIterable, Identifiable, Hashable, Sendable {
    case home
    case kanban
    case project
    case audit
    case stats
    case terminal
    case files
    case memory

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
        }
    }

    /// Le groupe de la barre latérale.
    public var group: ConsoleSectionGroup {
        switch self {
        case .home, .kanban, .project, .audit, .stats: .pilotage
        case .terminal, .files, .memory: .consultation
        }
    }
}

/// Les groupes de la barre latérale, dans leur ordre d'affichage.
public enum ConsoleSectionGroup: CaseIterable, Sendable {
    case pilotage
    case consultation

    public var title: String {
        switch self {
        case .pilotage: L10n.text("Pilotage")
        case .consultation: L10n.text("Consultation")
        }
    }

    /// Les sections du groupe, dans l'ordre de `ConsoleSection.allCases`.
    public var sections: [ConsoleSection] {
        ConsoleSection.allCases.filter { $0.group == self }
    }
}
