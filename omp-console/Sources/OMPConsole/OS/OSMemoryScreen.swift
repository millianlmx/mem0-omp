// La MÉMOIRE au centre de l'OS du Mac : les souvenirs du projet ouvert, en liste ou en
// graphe (`MemoryView`). Ses modèles vivent à l'échelle de l'app (la position, la
// sélection et les filtres survivent au passage d'un écran à l'autre) ; la coque les
// porte sans les observer, seul cet écran le fait.

import ConsoleClient
import SwiftUI

/// Les modèles de la Mémoire du Mac, créés par l'app.
struct OSMemoryModels {
    let model: MemoryModel
    let graph: MemoryGraphModel
    let cleanup: PodmanCleanupModel
    /// Le sélecteur de projet de l'état « Aucun projet ouvert ».
    let chooser: ProjectChooserModel
}

struct OSMemoryScreen: View {
    let models: OSMemoryModels
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        MemoryView(model: models.model, graph: models.graph, chooser: models.chooser, cleanup: models.cleanup)
            // La recherche de mémoire demandée par la palette (⌘F) : la liste la lance.
            .task(id: drafts.memorySearchRequest ?? "") {
                guard let query = drafts.memorySearchRequest else { return }
                drafts.memorySearchRequest = nil
                if models.graph.shown { models.graph.hide() }
                await models.model.search(query)
            }
    }
}
