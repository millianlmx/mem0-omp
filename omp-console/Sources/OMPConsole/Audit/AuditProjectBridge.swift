// « Ouvrir dans Projet » depuis un audit (audit-ui-redesign S-12) : la coque
// bascule sur la section Projet, puis selon le pilotage en cours —
//   — ce dépôt est déjà piloté : il est simplement montré ;
//   — aucun pilotage : la feuille « Piloter un projet… » s'ouvre préremplie avec
//     ce dépôt (rien ne démarre sans confirmation) ;
//   — un autre dépôt est piloté : l'alerte de refus existante.
// La règle est `AuditPresentation.projectOpening`, pure et partagée avec iOS.

import ConsoleCore
import Foundation

@MainActor
enum AuditProjectBridge {
    static func open(_ card: AuditCard, console: ConsoleModel, project: ProjectConsoleModel) {
        console.select(.project)
        let opening = AuditPresentation.projectOpening(
            auditRepoKey: card.repoKey,
            pilotedRepoKey: project.identity.map { KanbanRepoKey.key(forRoot: $0.repoRoot.path) },
            pilotActive: !project.canStartConduite
        )
        switch opening {
        case .show:
            return
        case .proposeLaunch:
            project.draftRepository = URL(fileURLWithPath: card.repoRoot, isDirectory: true)
            project.draftName = card.repoName
            project.presentLaunchSheet()
        case .refuse:
            project.refuse()
        }
    }
}
