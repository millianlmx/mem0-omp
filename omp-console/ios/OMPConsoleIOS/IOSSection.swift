import ConsoleCore

/// La dérivation des sections de la coque iOS, à partir du type PARTAGÉ
/// `ConsoleSection` : l'app n'écrit aucune seconde liste, aucun libellé et aucune
/// valeur brute de section — `allCases` reste l'unique source, et le filtre des
/// deux sections hors périmètre est calculé.
enum IOSSection {
    /// Les sections de l'app iOS : `ConsoleSection.allCases` moins `terminal` et
    /// `files`, dans l'ordre de `allCases`.
    static let all: [ConsoleSection] = ConsoleSection.allCases.filter { $0 != .terminal && $0 != .files }

    /// Les sections d'un groupe de la barre latérale, dans l'ordre de `allCases`.
    static func sections(of group: ConsoleSectionGroup) -> [ConsoleSection] {
        group.sections.filter { all.contains($0) }
    }

    /// Les sept sections dans l'ordre AFFICHÉ par la barre latérale : groupe par
    /// groupe, comme la `List` de `RootView`. Les raccourcis ⌘1…⌘7 suivent cet
    /// ordre ; si la barre latérale change, ils la suivent.
    static var sidebarOrder: [ConsoleSection] {
        ConsoleSectionGroup.allCases.flatMap(sections(of:))
    }

    /// Le symbole SF d'une section sur iOS : celui de `ConsoleSection`, sauf Sessions
    /// (`IOSSessionText.sectionSymbol`), pour qu'elle ne ressemble plus à Session OMP.
    static func systemImage(of section: ConsoleSection) -> String {
        section == .sessions ? IOSSessionText.sectionSymbol : section.systemImage
    }

    /// La section désignée par l'argument de lancement `-section <rawValue>`.
    ///
    /// La DERNIÈRE paire reconnue gagne. Rien à lire, un drapeau sans valeur ou une
    /// valeur qui ne désigne pas l'une des sept sections rendent l'Accueil : jamais
    /// d'alerte, jamais de persistance (l'app n'écrit rien).
    static func resolve(_ arguments: [String]) -> ConsoleSection {
        var resolved: ConsoleSection = .home
        var index = 0
        while index < arguments.count {
            if arguments[index] == "-section",
               index + 1 < arguments.count,
               let section = all.first(where: { $0.rawValue == arguments[index + 1] }) {
                resolved = section
            }
            index += 1
        }
        return resolved
    }
}
