import ConsoleCore

/// La valeur de sélection de la barre d'onglets / barre latérale : une des
/// sections, ou l'onglet « Plus » de l'iPhone.
enum IOSTab: Hashable {
    case section(ConsoleSection)
    case plus
}

/// L'état de navigation racine : l'onglet sélectionné et la pile de l'onglet « Plus ».
struct IOSTabRoute: Equatable {
    var tab: IOSTab
    var plusPath: [ConsoleSection]
}

/// Le routage pur entre onglets et sections de la coque iOS : sans état, sans
/// UIKit, dérivé de `IOSSection`. L'iPhone (largeur compacte) montre quatre
/// sections — Accueil, Pipelines, Projet, Audit — puis « Plus », qui pousse
/// Statistiques, Poste et Mémoire ; l'iPad (largeur régulière) montre toutes les
/// sections dans la barre latérale, sans « Plus ».
///
/// Le Poste est sous « Plus » : la barre d'onglets de l'iPhone garde quatre
/// sections et « Plus » (cinq onglets au plus, HIG Tab bars). Ses envois à
/// approuver ne s'y perdent pas : ils remontent sur l'Accueil, et l'onglet « Plus »
/// porte leur badge.
enum IOSTabs {
    /// Les sections que l'iPhone range sous « Plus », dans l'ordre de la liste.
    static let plusSections: [ConsoleSection] = [.stats, .workstation, .memory]

    /// Les sections DÉCLARÉES dans le groupe, dans l'ordre de déclaration du
    /// `TabView` : l'ordre de la barre latérale, quelle que soit la largeur.
    static func declaredSections(of group: ConsoleSectionGroup, compact: Bool) -> [ConsoleSection] {
        IOSSection.sections(of: group)
    }

    /// La barre d'onglets de l'iPhone, dans l'ordre affiché : les sections
    /// déclarées en compact et non masquées, puis « Plus ».
    static var compactTabs: [IOSTab] {
        ConsoleSectionGroup.allCases
            .flatMap { declaredSections(of: $0, compact: true) }
            .filter { !plusSections.contains($0) }
            .map(IOSTab.section) + [.plus]
    }

    /// Vrai quand l'onglet est masqué pour cette classe de taille : en compact, les
    /// sections de « Plus » ; en régulier, « Plus » lui-même.
    static func isHidden(_ tab: IOSTab, compact: Bool) -> Bool {
        switch tab {
        case let .section(section): compact && plusSections.contains(section)
        case .plus: !compact
        }
    }

    /// Le badge de l'onglet « Plus » : en compact, la somme des badges des sections
    /// qu'il range (un envoi à approuver du Poste ne s'y cache pas) ; en régulier,
    /// « Plus » est masqué et chaque section porte le sien.
    static func plusBadge(compact: Bool, badge: (ConsoleSection) -> Int) -> Int {
        compact ? plusSections.reduce(0) { $0 + badge($1) } : 0
    }

    /// Ramène une route à ce que la classe de taille peut afficher. En compact, une
    /// section de « Plus » sélectionnée passe sous « Plus », poussée seule ; en
    /// régulier, « Plus » sélectionné rouvre la dernière section poussée, sinon la
    /// première de « Plus ». Idempotent.
    static func adapt(_ route: IOSTabRoute, compact: Bool) -> IOSTabRoute {
        switch route.tab {
        case let .section(section) where compact && plusSections.contains(section):
            IOSTabRoute(tab: .plus, plusPath: [section])
        case .plus where !compact:
            IOSTabRoute(tab: .section(route.plusPath.last ?? plusSections[0]), plusPath: route.plusPath)
        default:
            route
        }
    }

    /// La route qui affiche `section` depuis `current` (⌘<n>, « Voir dans
    /// Pipelines »). Une section hors de l'app laisse la route inchangée ; en
    /// compact, une section de « Plus » REMPLACE la pile de « Plus » ; sinon la
    /// section est sélectionnée et la pile de « Plus » est conservée.
    static func route(from current: IOSTabRoute, to section: ConsoleSection, compact: Bool) -> IOSTabRoute {
        guard IOSSection.all.contains(section) else { return current }
        if compact && plusSections.contains(section) {
            return IOSTabRoute(tab: .plus, plusPath: [section])
        }
        return IOSTabRoute(tab: .section(section), plusPath: current.plusPath)
    }

    /// La section affichée par une route ; `nil` quand c'est la liste « Plus » elle-même.
    static func shown(_ route: IOSTabRoute) -> ConsoleSection? {
        switch route.tab {
        case let .section(section): section
        case .plus: route.plusPath.last
        }
    }
}
