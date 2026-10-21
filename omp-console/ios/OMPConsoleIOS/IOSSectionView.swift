import ConsoleClient
import ConsoleCore
import SwiftUI

/// L'aiguillage UNIQUE section → écran de l'app iOS : les cinq sections de
/// pilotage (Accueil, Pipelines, Projet, Audit, Statistiques) sont servies par le
/// serveur de pipelines du VPS (`HarnessModel`), Mémoire par la mémoire du même
/// serveur (`MemoryAccess`) — l'un et l'autre joints directement, sans Mac.
/// Chaque écran porte son propre cadre.
struct IOSSectionView: View {
    let section: ConsoleSection
    let state: IOSScreenState
    @ObservedObject var memory: MemoryAccess
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    /// Le crochet de recette `-memoire.recipe` de la section Mémoire.
    let memoryRecipe: IOSMemoryGraphRecipe?

    var body: some View {
        switch section {
        case .home: IOSHarnessHomeScreen(server: server, drafts: drafts)
        case .kanban: IOSHarnessPipelinesScreen(server: server, drafts: drafts)
        case .project: IOSHarnessProjectsScreen(server: server, drafts: drafts)
        case .audit: IOSHarnessAuditsScreen(server: server, drafts: drafts)
        case .stats: IOSHarnessStatsScreen(server: server, drafts: drafts)
        case .memory, .terminal, .files:
            // Terminal et Fichiers ne sont jamais atteints (`IOSSection.all`).
            // « Relier le serveur » de l'écran Mémoire ouvre la feuille Serveur.
            IOSMemoryScreen(client: memory, recipe: state, graphRecipe: memoryRecipe, showConnection: $drafts.serverSheetShown)
        }
    }
}
