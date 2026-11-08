// Interface de la coque : les vues de section, et le SEUL aiguillage section → vue.
// Les sections de pilotage (Accueil, Pipelines, Projet, Audit, Statistiques, Poste)
// sont servies par le serveur de pipelines du VPS ; Terminal, Fichiers et Mémoire
// sont locaux.
//
// Aucun attribut macro SwiftUI n'est employé ici (`@State`, `@Preview`, …) :
// sous les Command Line Tools seuls, ces macros échouent à la compilation (D3).

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Contrat minimal d'une vue de section : se déclarer sur la section qu'elle sert.
/// C'est ce que la suite confronte à `ConsoleSection.allCases` — une vue
/// manquante ou deux vues sur la même section font donc rougir le test.
protocol ConsoleSectionView: View {
    static var section: ConsoleSection { get }
}

struct HomeSectionView: ConsoleSectionView {
    static let section = ConsoleSection.home
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    var body: some View { HarnessHomeView(server: server, drafts: drafts) }
}

struct PipelinesSectionView: ConsoleSectionView {
    static let section = ConsoleSection.kanban
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    var body: some View { HarnessPipelinesView(server: server, drafts: drafts) }
}

struct ProjectSectionView: ConsoleSectionView {
    static let section = ConsoleSection.project
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    var body: some View { HarnessProjectsView(server: server, drafts: drafts) }
}

struct AuditSectionView: ConsoleSectionView {
    static let section = ConsoleSection.audit
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    var body: some View { HarnessAuditsView(server: server, drafts: drafts) }
}

struct StatsSectionView: ConsoleSectionView {
    static let section = ConsoleSection.stats
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    var body: some View { HarnessStatsView(server: server, drafts: drafts) }
}

/// Le poste de travail : extension Chrome, agent 24/24, envois à approuver, profil,
/// journal des décisions et réunions — servi par le même serveur.
struct WorkstationSectionView: ConsoleSectionView {
    static let section = ConsoleSection.workstation
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    var body: some View { WorkstationView(server: server, workstation: server.workstation, drafts: drafts) }
}

/// La vigie : mode, plafonds, battement de cœur et incidents.
struct VigieSectionView: ConsoleSectionView {
    static let section = ConsoleSection.vigie
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    var body: some View { HarnessVigieView(server: server, drafts: drafts) }
}

/// Les planifications récurrentes : runs, audits, relève d'issues.
struct SchedulesSectionView: ConsoleSectionView {
    static let section = ConsoleSection.schedules
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    var body: some View { HarnessSchedulesView(server: server, drafts: drafts) }
}

/// Les issues des dépôts et leur correction.
struct IssuesSectionView: ConsoleSectionView {
    static let section = ConsoleSection.issues
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    var body: some View { HarnessIssuesView(server: server, drafts: drafts) }
}

/// L'administration du serveur (admin seulement).
struct AdminSectionView: ConsoleSectionView {
    static let section = ConsoleSection.admin
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    var body: some View { HarnessAdminView(server: server, drafts: drafts) }
}

struct TerminalSectionView: ConsoleSectionView {
    static let section = ConsoleSection.terminal
    @ObservedObject var model: TerminalConsoleModel
    let chooser: ProjectChooserModel
    var body: some View { TerminalConsoleView(model: model, chooser: chooser) }
}

/// SEUL endroit qui associe une section à sa vue : le `switch` est exhaustif,
/// donc ajouter un cas à `ConsoleSection` sans lui donner de vue ne compile pas.
struct SectionDetail: View {
    let section: ConsoleSection
    /// Le serveur de pipelines et ses brouillons, uniques pour la fenêtre.
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let filesModel: FilesModel
    @ObservedObject var memoryModel: MemoryModel
    @ObservedObject var memoryGraph: MemoryGraphModel
    @ObservedObject var podmanCleanup: PodmanCleanupModel
    let terminalModel: TerminalConsoleModel
    /// Le sélecteur de projet des états vides de Mémoire, Fichiers et Terminal.
    let projectChooser: ProjectChooserModel

    var body: some View {
        // Ancrée en HAUT : une section dont le contenu ne remplit pas la hauteur
        // garde son en-tête sous la barre d'outils.
        content.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            // La recherche de mémoire demandée par la palette (⌘F) : la liste la lance.
            .task(id: section.rawValue + "|" + (drafts.memorySearchRequest ?? "")) {
                guard section == .memory, let query = drafts.memorySearchRequest else { return }
                drafts.memorySearchRequest = nil
                if memoryGraph.shown { memoryGraph.hide() }
                await memoryModel.search(query)
            }
    }

    @ViewBuilder
    private var content: some View {
        switch section {
        case .home: HomeSectionView(server: server, drafts: drafts)
        case .kanban: PipelinesSectionView(server: server, drafts: drafts)
        case .project: ProjectSectionView(server: server, drafts: drafts)
        case .audit: AuditSectionView(server: server, drafts: drafts)
        case .stats: StatsSectionView(server: server, drafts: drafts)
        case .workstation: WorkstationSectionView(server: server, drafts: drafts)
        case .terminal: TerminalSectionView(model: terminalModel, chooser: projectChooser)
        case .files: FilesView(model: filesModel, chooser: projectChooser)
        case .memory: MemoryView(model: memoryModel, graph: memoryGraph, chooser: projectChooser, cleanup: podmanCleanup)
        case .vigie: VigieSectionView(server: server, drafts: drafts)
        case .schedules: SchedulesSectionView(server: server, drafts: drafts)
        case .issues: IssuesSectionView(server: server, drafts: drafts)
        case .admin: AdminSectionView(server: server, drafts: drafts)
        }
    }
}
