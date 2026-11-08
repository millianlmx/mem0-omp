// Interface de la coque : les vues de section, et le SEUL aiguillage section → vue.
// « À traiter », Features, Poste et Système sont servis par le serveur de pipelines du
// VPS ; Mémoire, Terminal et Fichiers sont locaux.
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

/// La file unique de ce qui attend l'humain.
struct InboxSectionView: ConsoleSectionView {
    static let section = ConsoleSection.inbox
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    var body: some View { HarnessInboxView(server: server, drafts: drafts) }
}

/// Les features (et leurs portées : projets, audits, issues), une page par feature.
struct RunsSectionView: ConsoleSectionView {
    static let section = ConsoleSection.runs
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    var body: some View { HarnessRunsView(server: server, drafts: drafts) }
}

/// Le poste de travail, servi par le même serveur.
struct WorkstationSectionView: ConsoleSectionView {
    static let section = ConsoleSection.workstation
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    var body: some View { WorkstationView(server: server, workstation: server.workstation, drafts: drafts) }
}

/// Le hub de ce qui se règle rarement : vigie, planifications, statistiques,
/// administration, serveur.
struct SystemSectionView: ConsoleSectionView {
    static let section = ConsoleSection.system
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    var body: some View { HarnessSystemView(server: server, drafts: drafts) }
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
        case .inbox: InboxSectionView(server: server, drafts: drafts)
        case .runs: RunsSectionView(server: server, drafts: drafts)
        case .workstation: WorkstationSectionView(server: server, drafts: drafts)
        case .memory: MemoryView(model: memoryModel, graph: memoryGraph, chooser: projectChooser, cleanup: podmanCleanup)
        case .terminal: TerminalSectionView(model: terminalModel, chooser: projectChooser)
        case .files: FilesView(model: filesModel, chooser: projectChooser)
        case .system: SystemSectionView(server: server, drafts: drafts)
        }
    }
}
