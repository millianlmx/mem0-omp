// Le vocabulaire des destinations que nomment les liens `ompconsole://<section>`, les
// notifications et la palette ⌘K : ce qui attend l'humain (`inbox`, le tri de l'OS), les
// features (leur fil), le Poste, la Mémoire et le hub Système. Chaque coque traduit une
// section en écran de l'« OS agentique ».
//
// `SystemPage` nomme les écrans du hub Système (`ompconsole://system/<page>`, palette).

public enum ConsoleSection: String, CaseIterable, Identifiable, Hashable, Sendable {
    case inbox
    case runs
    case workstation
    case memory
    case system

    public var id: String { rawValue }

    /// Le libellé de la destination (palette, titre).
    public var title: String {
        switch self {
        case .inbox: L10n.text("À traiter")
        case .runs: L10n.text("Features")
        case .workstation: L10n.text("Poste")
        case .memory: L10n.text("Mémoire")
        case .system: L10n.text("Système")
        }
    }

    /// Symbole SF de la destination.
    public var systemImage: String {
        switch self {
        case .inbox: "tray.full"
        case .runs: "square.stack.3d.up"
        case .workstation: "desktopcomputer"
        case .memory: "brain"
        case .system: "gearshape.2"
        }
    }
}

/// Les écrans du hub Système : ce qui se règle ou se consulte rarement.
public enum SystemPage: String, CaseIterable, Identifiable, Hashable, Sendable {
    case repos
    case schedules
    case autonomy
    case vigie
    case stats
    case issues
    case admin
    case server

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .repos: L10n.text("Dépôts")
        case .schedules: L10n.text("Planifications")
        case .autonomy: L10n.text("Autonomie")
        case .vigie: L10n.text("Vigie")
        case .stats: L10n.text("Statistiques et santé")
        case .issues: L10n.text("Issues")
        case .admin: L10n.text("Administration")
        case .server: L10n.text("Serveur")
        }
    }

    public var systemImage: String {
        switch self {
        case .repos: "shippingbox"
        case .schedules: "calendar.badge.clock"
        case .autonomy: "checkmark.seal"
        case .vigie: "binoculars"
        case .stats: "chart.xyaxis.line"
        case .issues: "exclamationmark.bubble"
        case .admin: "person.2.badge.key"
        case .server: "server.rack"
        }
    }

    /// Les dépôts et l'administration ne se montrent qu'à un administrateur.
    public var isAdminOnly: Bool { self == .admin || self == .repos }

    /// Les pages montrées à ce jeton : celles d'administrateur à un administrateur seulement,
    /// l'Autonomie seulement si le serveur relié la sert (`autonomy` faux : 404).
    public static func visible(isAdmin: Bool, autonomy: Bool) -> [SystemPage] {
        allCases.filter { (isAdmin || !$0.isAdminOnly) && (autonomy || $0 != .autonomy) }
    }
}
