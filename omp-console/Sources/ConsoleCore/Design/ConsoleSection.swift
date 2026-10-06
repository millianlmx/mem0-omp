// Les neuf sections de la coque, dans l'ordre d'affichage de la barre latérale,
// rangées en deux groupes (S-4 de omp-console-redesign) : « Pilotage » (Accueil,
// Pipelines, Projet, Session OMP, Terminal) et « Consultation » (Sessions,
// Fichiers, Mémoire, Statistiques).
//
// Depuis le 2026-10-02, TOUT vit dans la fenêtre principale : Session OMP,
// Terminal et Statistiques étaient des fenêtres annexes, et la visionneuse
// ouvrait une fenêtre par session — en plein écran, chacune partait dans son
// propre espace. Ce sont désormais des sections, et la visionneuse est poussée
// dans la section Sessions.
//
// Un enum plutôt qu'un tableau de vues : la section est l'identité PARTAGÉE entre
// la liste, le détail, les tests et les features métier. L'ordre de déclaration
// des cas EST l'ordre d'affichage (`CaseIterable`) et celui des raccourcis ⌘1…⌘9,
// donc il n'existe pas de seconde liste à tenir synchronisée.

public enum ConsoleSection: String, CaseIterable, Identifiable, Hashable, Sendable {
    case home
    case kanban
    case project
    case session
    case terminal
    case sessions
    case files
    case memory
    case stats

    public var id: String { rawValue }

    /// Libellé affiché dans la barre latérale, et titre de la fenêtre.
    public var title: String {
        switch self {
        case .home: "Accueil"
        case .kanban: "Pipelines"
        case .project: "Projet"
        case .session: "Session OMP"
        case .terminal: "Terminal"
        case .sessions: "Sessions"
        case .files: "Fichiers"
        case .memory: "Mémoire"
        case .stats: "Statistiques"
        }
    }

    /// Symbole SF associé à la section.
    public var systemImage: String {
        switch self {
        case .home: "house"
        case .kanban: "square.grid.2x2"
        case .project: "target"
        case .session: "bubble.left.and.bubble.right"
        case .terminal: "terminal"
        case .sessions: "bubble.left.and.text.bubble.right"
        case .files: "doc.text"
        case .memory: "brain"
        case .stats: "chart.bar"
        }
    }

    /// Le groupe de la barre latérale.
    public var group: ConsoleSectionGroup {
        switch self {
        case .home, .kanban, .project, .session, .terminal: .pilotage
        case .sessions, .files, .memory, .stats: .consultation
        }
    }
}

/// Les groupes de la barre latérale, dans leur ordre d'affichage.
public enum ConsoleSectionGroup: CaseIterable, Sendable {
    case pilotage
    case consultation

    public var title: String {
        switch self {
        case .pilotage: "Pilotage"
        case .consultation: "Consultation"
        }
    }

    /// Les sections du groupe, dans l'ordre de `ConsoleSection.allCases`.
    public var sections: [ConsoleSection] {
        ConsoleSection.allCases.filter { $0.group == self }
    }
}
