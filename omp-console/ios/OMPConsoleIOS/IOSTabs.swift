import ConsoleCore

/// La valeur de sélection de la barre d'onglets / barre latérale : une des
/// sections, ou l'onglet de recherche (la palette, atteignable sans clavier).
enum IOSTab: Hashable, Sendable {
    case section(ConsoleSection)
    case search

    /// La section montrée par l'onglet ; `nil` pour la recherche.
    var section: ConsoleSection? {
        if case let .section(section) = self { section } else { nil }
    }
}

/// Une destination de la pile de Système qui n'est pas une page du hub : la Mémoire,
/// rangée en tête du hub sur iPhone.
enum IOSSystemRoute: Hashable {
    case memory
}

/// Le routage pur entre onglets et sections de la coque iOS : sans état, sans
/// UIKit, dérivé de `IOSSection`. L'iPad montre les cinq sections en barre latérale,
/// groupe par groupe (Travail, Outils, Système), puis la recherche. L'iPhone n'a que
/// cinq places, recherche comprise (au-delà, le système ajouterait un onglet
/// « Autre ») : il montre À traiter, Features, Poste et Système, puis la recherche ;
/// la Mémoire y est une rangée en tête du hub Système, poussée dans sa pile.
enum IOSTabs {
    /// Vrai quand l'onglet de la section est masqué pour cette largeur : la Mémoire,
    /// en compact.
    static func isHidden(_ section: ConsoleSection, compact: Bool) -> Bool {
        compact && section == .memory
    }

    /// L'onglet affiché pour une sélection : en compact, la Mémoire s'affiche dans
    /// l'onglet Système (sa pile la pousse). Jamais un onglet masqué.
    static func shown(_ tab: IOSTab, compact: Bool) -> IOSTab {
        if let section = tab.section, isHidden(section, compact: compact) { return .section(.system) }
        return tab
    }

    /// L'onglet qui montre `section` depuis `current` (⌘<n>, palette, notification).
    /// Une section hors de l'app (Terminal, Fichiers) laisse l'onglet inchangé.
    static func tab(from current: IOSTab, to section: ConsoleSection) -> IOSTab {
        IOSSection.all.contains(section) ? .section(section) : current
    }

    /// Le badge d'une section : sur À traiter, tout ce qui attend l'humain (la boîte et
    /// les envois du poste à approuver, qui expirent) ; sur Poste, ces envois ; sur
    /// Système, 1 quand la vigie se tait (son battement manque).
    static func badge(of section: ConsoleSection, pending: Int, approvals: Int, vigieSilent: Bool) -> Int {
        switch section {
        case .inbox: pending + approvals
        case .workstation: approvals
        case .system: vigieSilent ? 1 : 0
        case .runs, .memory, .terminal, .files: 0
        }
    }
}
