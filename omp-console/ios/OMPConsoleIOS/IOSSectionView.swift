import ConsoleClient
import ConsoleCore
import SwiftUI

/// L'aiguillage UNIQUE section → écran racine d'un onglet de l'app iOS : À traiter,
/// Features, Poste et Système sont servis par le serveur de pipelines du VPS
/// (`HarnessModel`, qui porte aussi le poste de travail), Mémoire par la mémoire du même
/// serveur (`MemoryAccess`) — l'un et l'autre joints directement, sans Mac. Chaque
/// écran porte son propre cadre ; la pile de navigation est celle de l'onglet. Sur
/// iPhone, la Mémoire n'a pas d'onglet : Système la pousse dans sa pile.
struct IOSSectionView: View {
    let section: ConsoleSection
    let state: IOSScreenState
    @ObservedObject var memory: MemoryAccess
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    /// Le crochet de recette `-memoire.recipe` de la section Mémoire.
    let memoryRecipe: IOSMemoryGraphRecipe?
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        switch section {
        case .inbox: IOSInboxScreen(server: server, drafts: drafts)
        case .runs: IOSFeaturesScreen(server: server, drafts: drafts)
        case .workstation: IOSWorkstationScreen(server: server, workstation: server.workstation, drafts: drafts)
        case .system:
            IOSSystemScreen(server: server, drafts: drafts, showsMemory: IOSTabs.isHidden(.memory, compact: sizeClass == .compact))
                .navigationDestination(for: IOSSystemRoute.self) { _ in memoryScreen }
        case .memory, .terminal, .files:
            // Terminal et Fichiers ne sont jamais atteints (`IOSSection.all`).
            memoryScreen
        }
    }

    /// La Mémoire. « Relier le serveur » de l'écran ouvre la feuille Serveur.
    private var memoryScreen: some View {
        IOSMemoryScreen(client: memory, recipe: state, graphRecipe: memoryRecipe, showConnection: $drafts.serverSheetShown, searchRequest: $drafts.memorySearchRequest)
    }
}
