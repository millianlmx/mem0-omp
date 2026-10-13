// La liste des attentes calculée sur le Mac (attentes-dispersees-entre-sources,
// S-7) : l'instantané courant du magasin, l'ardoise dérivée avec la vivacité
// locale, et les files de dialogues de la conduite et de la session hébergée.
// Lecture seule : aucune écriture, aucune publication.

import ConsoleCore
import Foundation

@MainActor
enum LocalPendingRequests {
    /// La liste des attentes de la coque. Une conduite ou une session fermée a une
    /// file vide : elle ne contribue aucune attente. `prFacts` n'influence que les
    /// colonnes livrées, hors de la liste.
    static func list(
        storeHub: StoreHub,
        project: ProjectConsoleModel,
        session: SessionConsoleModel
    ) -> [PendingRequest] {
        let snapshot = storeHub.current()
        let board = KanbanBoardState.derive(
            snapshot: snapshot,
            nowMs: storeHub.nowMs(),
            stateDir: storeHub.stateDir,
            isAlive: .processLocal,
            prFacts: [:]
        )
        return PendingRequests.list(PendingSources(
            snapshot: snapshot,
            board: board,
            conduiteDialogs: project.host.dialogQueue,
            sessionDialogs: session.host.dialogQueue
        ))
    }
}
