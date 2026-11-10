// Un OUTIL dans le détail de la nouvelle interface : l'écran classique existant (Mémoire,
// Poste, Santé, Administration, Serveur, Terminal, Fichiers), tel quel, sous le Radar et à
// côté de la liste des fils — sans changer d'interface. Mémoire, Poste, Terminal et
// Fichiers sont les vues de section de la coque classique (`SectionDetail`) ; Santé et
// Administration sont les pages du hub Système, sans le hub ; Serveur est la feuille de
// connexion, posée en page.

import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

struct OSToolDetail: View {
    let tool: OSTool
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let filesModel: FilesModel
    let memoryModel: MemoryModel
    let memoryGraph: MemoryGraphModel
    let podmanCleanup: PodmanCleanupModel
    let terminalModel: TerminalConsoleModel
    let projectChooser: ProjectChooserModel

    var body: some View {
        switch tool {
        case .memory: section(.memory)
        case .workstation: section(.workstation)
        case .terminal: section(.terminal)
        case .files: section(.files)
        case .health:
            HarnessSection(server: server, drafts: drafts, catalog: true, form: false) {
                SystemStatsPage(server: server, drafts: drafts)
            }
            .controlGestures(server: server, drafts: drafts)
        case .admin:
            HarnessSection(server: server, drafts: drafts, catalog: true, form: false, reload: { await server.admin.refresh() }) {
                HarnessForm(server: server, drafts: drafts) { AdminSections(server: server, drafts: drafts) }
                    .task(id: server.isAdmin) { await server.admin.refresh() }
                    .accessibilityIdentifier("admin.harness")
            }
            .controlGestures(server: server, drafts: drafts)
        case .server:
            ServerSheet(server: server, drafts: drafts, embedded: true)
        }
    }

    /// La vue d'une section classique, par le seul aiguillage section → vue.
    private func section(_ section: ConsoleSection) -> some View {
        SectionDetail(
            section: section,
            server: server,
            drafts: drafts,
            filesModel: filesModel,
            memoryModel: memoryModel,
            memoryGraph: memoryGraph,
            podmanCleanup: podmanCleanup,
            terminalModel: terminalModel,
            projectChooser: projectChooser
        )
    }
}
