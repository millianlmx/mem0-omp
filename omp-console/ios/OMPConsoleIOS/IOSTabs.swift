import ConsoleCore

/// La valeur de sélection de la barre d'onglets / barre latérale : une des huit
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
/// sections — Accueil, Pipelines, Sessions, Audit — puis « Plus », qui pousse les
/// quatre autres ; l'iPad (largeur régulière) montre les huit sections dans la
/// barre latérale, sans « Plus ».
enum IOSTabs {
    /// Les sections que l'iPhone range sous « Plus », dans l'ordre de la liste
    /// (audit-ui-redesign, S-5 : Mémoire à l'ancienne place d'Audit).
    static let plusSections: [ConsoleSection] = [.repos, .project, .memory, .session, .stats]

    /// Les sections DÉCLARÉES dans le groupe, dans l'ordre de déclaration du
    /// `TabView` (audit-ui-redesign, S-5). En régulier : l'ordre de la barre
    /// latérale. En compact, la barre d'onglets suit l'ordre de déclaration À
    /// PLAT (Doc-1) : Audit quitte Pilotage et s'insère juste après Sessions, à
    /// l'ancienne place de Mémoire.
    static func declaredSections(of group: ConsoleSectionGroup, compact: Bool) -> [ConsoleSection] {
        let sections = IOSSection.sections(of: group)
        guard compact else { return sections }
        var declared = sections.filter { $0 != .audit }
        if let sessions = declared.firstIndex(of: .sessions) {
            declared.insert(.audit, at: sessions + 1)
        }
        return declared
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
