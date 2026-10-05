// Interface de la coque : fenêtre, barre latérale à neuf entrées, panneau de
// détail. Les neuf vues déclarent leur section, et TOUTES vivent dans la fenêtre
// principale (aucune fenêtre annexe : l'app reste utilisable en plein écran).
//
// Aucun attribut macro SwiftUI n'est employé ici (`@State`, `@Preview`, …) :
// sous les Command Line Tools seuls, ces macros échouent à la compilation (D3).

import SwiftUI

/// Contrat minimal d'une vue de section : se déclarer sur la section qu'elle sert.
/// C'est ce que la suite (S-4) confronte à `ConsoleSection.allCases` — une vue
/// manquante ou deux vues sur la même section font donc rougir le test.
protocol ConsoleSectionView: View {
    static var section: ConsoleSection { get }
}

/// La section Sessions : la liste, et la visionneuse poussée par-dessus (le
/// bouton retour de la barre d'outils y ramène).
struct SessionsView: ConsoleSectionView {
    static let section = ConsoleSection.sessions
    @ObservedObject var console: ConsoleModel

    var body: some View {
        NavigationStack(path: Binding(
            get: { console.sessionsPath },
            set: { console.sessionsPath = $0 }
        )) {
            SessionSelectorView(onOpen: { console.openSession($0) })
                .navigationDestination(for: ViewerTarget.self) { target in
                    SessionViewerContent(target: target)
                        .id(target)
                }
        }
    }
}

struct SessionConsoleSectionView: ConsoleSectionView {
    static let section = ConsoleSection.session
    @ObservedObject var model: SessionConsoleModel
    var body: some View { SessionConsoleView(model: model) }
}

struct TerminalSectionView: ConsoleSectionView {
    static let section = ConsoleSection.terminal
    @ObservedObject var model: TerminalConsoleModel
    var body: some View { TerminalConsoleView(model: model) }
}

struct StatsSectionView: ConsoleSectionView {
    static let section = ConsoleSection.stats
    @ObservedObject var model: StatsModel
    var body: some View { StatsView(model: model) }
}

/// SEUL endroit qui associe une section à sa vue : le `switch` est exhaustif,
/// donc ajouter un cas à `ConsoleSection` sans lui donner de vue ne compile pas.
struct SectionDetail: View {
    let section: ConsoleSection
    /// L'état propre à l'Accueil (disponibilité d'OMP, attente dépliée).
    @ObservedObject var home: HomeModel
    /// La coque : l'Accueil change de section (« Voir toutes les pipelines »).
    @ObservedObject var console: ConsoleModel
    let filesModel: FilesModel
    @ObservedObject var kanban: KanbanModel
    /// Le modèle d'action des gestes du Kanban (S-9), à l'échelle de l'app.
    @ObservedObject var actions: ActionsModel
    /// Le modèle de pilotage de projet : à l'échelle de l'app, comme les autres,
    /// pour que la session hébergée survive au changement de section.
    @ObservedObject var projectModel: ProjectConsoleModel
    /// Le modèle de la section « Mémoire » : même raison, la portée calculée, la
    /// liste affichée et la sélection survivent au passage d'une section à l'autre.
    @ObservedObject var memoryModel: MemoryModel
    /// Le modèle de la feuille Contrat (S-7) : l'Accueil et Pipelines ouvrent la
    /// feuille depuis leurs gestes, la racine la présente.
    @ObservedObject var contract: ContractModel
    /// Le modèle d'alertes : l'Accueil y montre l'état des notifications.
    @ObservedObject var alerts: AlertsModel
    /// La préparation de l'app (S-5) : l'Accueil montre son fond et son bandeau.
    @ObservedObject var setup: SetupModel
    /// Les modèles des sections Session OMP, Terminal et Statistiques, à
    /// l'échelle de l'app : la session et le shell hébergés survivent au
    /// changement de section.
    let sessionModel: SessionConsoleModel
    let terminalModel: TerminalConsoleModel
    let statsModel: StatsModel

    var body: some View {
        // Ancrée en HAUT : une section dont le contenu ne remplit pas la hauteur
        // (Fichiers et Mémoire sans projet ouvert) garde son en-tête sous la barre
        // d'outils au lieu de flotter au milieu de la fenêtre.
        content.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    @ViewBuilder
    private var content: some View {
        switch section {
        case .home: HomeView(home: home, kanban: kanban, actions: actions, console: console, alerts: alerts, contract: contract, setup: setup)
        case .kanban: KanbanView(model: kanban, actions: actions, contract: contract)
        case .sessions: SessionsView(console: console)
        case .session: SessionConsoleSectionView(model: sessionModel)
        case .terminal: TerminalSectionView(model: terminalModel)
        case .stats: StatsSectionView(model: statsModel)
        case .files: FilesView(model: filesModel)
        case .project: ProjectView(model: projectModel)
        case .memory: MemoryView(model: memoryModel)
        }
    }
}
