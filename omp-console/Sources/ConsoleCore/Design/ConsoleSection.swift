// Les sept sections de la coque, dans l'ordre d'affichage de la barre latérale (Mac,
// iPad) et des onglets (iPhone), rangées en trois groupes :
//  · « Travail » — À traiter (la file unique de ce qui attend l'humain), Features (une
//    ligne par feature, une page par feature) et Poste (le poste de travail observé
//    par l'extension Chrome et l'agent 24/24) ;
//  · « Outils » — Mémoire, Terminal et Fichiers (ces deux derniers sur le Mac seul) ;
//  · « Système » — un hub qui pousse ce qu'on règle rarement : vigie, planifications,
//    statistiques et santé, administration, serveur (`SystemPage`).
//
// Moins de destinations, plus de profondeur : les projets, audits et issues sont des
// PORTÉES de la section Features (`RunsScope`), pas des sections ; ce qui se règle
// rarement vit sous Système. L'ordre de déclaration des cas EST l'ordre d'affichage
// (`CaseIterable`) et celui des raccourcis ⌘1…⌘7 : aucune seconde liste à tenir.

public enum ConsoleSection: String, CaseIterable, Identifiable, Hashable, Sendable {
    case inbox
    case runs
    case workstation
    case memory
    case terminal
    case files
    case system

    public var id: String { rawValue }

    /// Libellé affiché dans la barre latérale ou l'onglet, et titre de la fenêtre.
    public var title: String {
        switch self {
        case .inbox: L10n.text("À traiter")
        case .runs: L10n.text("Features")
        case .workstation: L10n.text("Poste")
        case .memory: L10n.text("Mémoire")
        case .terminal: L10n.text("Terminal")
        case .files: L10n.text("Fichiers")
        case .system: L10n.text("Système")
        }
    }

    /// Symbole SF de la section.
    public var systemImage: String {
        switch self {
        case .inbox: "tray.full"
        case .runs: "square.stack.3d.up"
        case .workstation: "desktopcomputer"
        case .memory: "brain"
        case .terminal: "terminal"
        case .files: "doc.text"
        case .system: "gearshape.2"
        }
    }

    public var group: ConsoleSectionGroup {
        switch self {
        case .inbox, .runs, .workstation: .work
        case .memory, .terminal, .files: .tools
        case .system: .system
        }
    }
}

public enum ConsoleSectionGroup: CaseIterable, Sendable {
    case work
    case tools
    case system

    public var title: String {
        switch self {
        case .work: L10n.text("Travail")
        case .tools: L10n.text("Outils")
        case .system: L10n.text("Système")
        }
    }

    public var sections: [ConsoleSection] {
        ConsoleSection.allCases.filter { $0.group == self }
    }
}

/// Les portées de la section Features : les features elles-mêmes, puis ce qui en lance
/// plusieurs (projets), en propose (audits) ou en demande (issues d'un dépôt).
public enum RunsScope: String, CaseIterable, Identifiable, Hashable, Sendable {
    case features
    case projects
    case audits
    case issues

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .features: L10n.text("Features")
        case .projects: L10n.text("Projets")
        case .audits: L10n.text("Audits")
        case .issues: L10n.text("Issues")
        }
    }

    public var systemImage: String {
        switch self {
        case .features: "square.stack.3d.up"
        case .projects: "target"
        case .audits: "checklist"
        case .issues: "exclamationmark.bubble"
        }
    }
}

/// Les pages du hub Système : ce qui se règle ou se consulte rarement.
public enum SystemPage: String, CaseIterable, Identifiable, Hashable, Sendable {
    case vigie
    case schedules
    case autonomy
    case stats
    case admin
    case server

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .vigie: L10n.text("Vigie")
        case .schedules: L10n.text("Planifications")
        case .autonomy: L10n.text("Autonomie")
        case .stats: L10n.text("Statistiques et santé")
        case .admin: L10n.text("Administration")
        case .server: L10n.text("Serveur")
        }
    }

    public var systemImage: String {
        switch self {
        case .vigie: "binoculars"
        case .schedules: "calendar.badge.clock"
        case .autonomy: "checkmark.seal"
        case .stats: "chart.xyaxis.line"
        case .admin: "person.2.badge.key"
        case .server: "server.rack"
        }
    }

    /// Ce que décrit la rangée du hub, sous son titre.
    public var summary: String {
        switch self {
        case .vigie: L10n.text("Surveillance du serveur, issues ouvertes et correctifs lancés par l’agent.")
        case .schedules: L10n.text("Features, audits et relèves d’issues à heure fixe.")
        case .autonomy: L10n.text("Règles par dépôt, validations prises seules et propositions de palier.")
        case .stats: L10n.text("Débit, coûts, étapes, tests et santé du serveur.")
        case .admin: L10n.text("Clients, dépôts déclarés et configuration.")
        case .server: L10n.text("Connexion, fournisseurs et modèles.")
        }
    }

    public var isAdminOnly: Bool { self == .admin }

    /// Les pages montrées à ce jeton : l'Administration à un administrateur seulement,
    /// l'Autonomie seulement si le serveur relié la sert (`autonomy` faux : 404).
    public static func visible(isAdmin: Bool, autonomy: Bool) -> [SystemPage] {
        allCases.filter { (isAdmin || !$0.isAdminOnly) && (autonomy || $0 != .autonomy) }
    }
}
