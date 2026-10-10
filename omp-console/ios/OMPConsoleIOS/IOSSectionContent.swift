import ConsoleCore

/// Le contenu d'un écran de section, PUR et sans UI (S-2, BR-3) : le modèle que
/// le test fige mot pour mot et que l'unique `IOSSectionView` rend.
///
/// Chaque chaîne est une constante PUBLIQUE de `ConsoleCore` — l'app iOS ne
/// réinvente aucun libellé durable (B-3). Un `detail` vaut `nil` quand la
/// constante partagée n'existe pas ou quand elle nomme un raccourci macOS (⌘N,
/// ⌘4) : ces raccourcis n'existent pas sur iPhone/iPad, et on ne réécrit pas la
/// constante du noyau pour autant.
struct IOSSectionContent: Equatable {
    let section: ConsoleSection
    /// Toujours `section.title` (ConsoleCore).
    let title: String
    /// Le symbole iOS de la section (`IOSSection.systemImage(of:)`).
    let systemImage: String
    /// Le mot de l'état vide, mot pour mot celui de la coque macOS.
    let message: String
    /// La phrase d'aide, mot pour mot, ou `nil`.
    let detail: String?
    /// La pastille de l'écran ; `nil` quand la section n'a pas d'état.
    let status: ConsoleStatus?
    /// Le bandeau ; non `nil` en état `.error` (S-3).
    let banner: ConsoleStatus?
    /// Le message provisoire du bandeau (`IOSText`), en état `.error` seulement.
    let bannerMessage: String?

    /// Le contenu d'une des SEPT sections ; `nil` pour une section hors périmètre
    /// (Terminal, Fichiers), que `IOSSection.all` n'atteint jamais.
    static func of(_ section: ConsoleSection, state: IOSScreenState) -> IOSSectionContent? {
        func content(
            message: String,
            detail: String?,
            status: ConsoleStatus? = nil
        ) -> IOSSectionContent {
            IOSSectionContent(
                section: section,
                title: section.title,
                systemImage: IOSSection.systemImage(of: section),
                message: message,
                detail: detail,
                status: status,
                banner: state.banner,
                bannerMessage: state.bannerMessage
            )
        }

        switch section {
        case .home:
            return content(message: HomeText.firstRunTitle, detail: HomeText.firstRunBody)
        case .kanban:
            // `KanbanText.emptyHint` nomme ⌘N : le raccourci ne s'affiche pas ici.
            return content(message: KanbanText.noPipeline, detail: nil)
        case .project:
            return content(message: ProjectViewText.emptyTitle, detail: ProjectViewText.emptyHelp)
        case .session:
            return content(
                message: SessionConsoleText.noProjectTitle,
                detail: SessionConsoleText.noProjectBody,
                status: ConsoleStatus(text: SessionConsoleText.Status.idleNoProject, tone: .neutral)
            )
        case .sessions:
            return content(message: SessionSelectorText.emptyTitle, detail: SessionSelectorText.noRun)
        case .memory:
            // `MemoryText.noProjectDescription` nomme ⌘4 : même raison.
            return content(message: MemoryText.noProjectTitle, detail: nil)
        case .stats:
            return content(message: StatsPresentation.noProjectTitle, detail: StatsPresentation.noProject)
        default:
            return nil
        }
    }
}
