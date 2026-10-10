// L'état de l'écran Sessions de la coque iOS (S-1, S-2), PUR et testable sans
// rendre de vue : les cinq états du contrat, le filtre appliqué AVANT le
// groupement, et les jours que la liste affiche.
//
// Patron `PipelinesModel` : des fonctions STATIQUES sur l'instantané publié par
// le client. La dérivation des choix (`SessionList.make(of:)`), le filtre
// (`SessionFilter`) et le groupement (`SessionDays`) sont PARTAGÉS — l'écran ne
// recalcule rien, il choisit un état.
//
// Le type de l'instantané du magasin n'est JAMAIS nommé ici (jeton interdit des
// sources iOS) : `SessionList.make(of: client.snapshot)` le dérive par inférence.

import ConsoleClient
import ConsoleCore
import Foundation

/// L'état de l'écran, dans l'ordre de priorité de S-1 : non connecté sans
/// instantané (composant d'état de connexion), chargement, magasin absent, aucun
/// run, puis la liste groupée.
enum IOSSessionsScreenState: Equatable {
    case unavailable(IOSConnectionStatus)
    case loading
    case storeAbsent
    case empty
    case list([SessionDay])
}

@MainActor
enum IOSSessionsModel {
    /// L'instantané du client converti en liste (S-1), ou `nil` tant qu'aucune
    /// trame `store` n'est arrivée.
    static func list(of client: ConsoleClientModel) -> SessionList? {
        guard let snapshot = client.snapshot else { return nil }
        return SessionList.make(of: snapshot)
    }

    /// Le projet retenu : celui du filtre s'il est ENCORE proposé, sinon `nil`
    /// (la liste complète) — jamais une liste vide muette (S-2).
    static func resolvedProject(_ repo: String?, projects: [String]) -> String? {
        guard let repo, projects.contains(repo) else { return nil }
        return repo
    }

    /// La valeur affichée ET annoncée par le filtre (rangees-sessions-memoire-
    /// serrees, S-3) : le projet retenu, ou « Tous les projets ».
    static func filterTitle(_ project: String?, projects: [String]) -> String {
        resolvedProject(project, projects: projects) ?? IOSSessionText.allProjects
    }

    /// Les jours affichés : le filtre s'applique AVANT le groupement, donc les
    /// en-têtes de jour se recalculent (S-2).
    static func days(of list: SessionList, project: String?, nowMs: Double, calendar: Calendar) -> [SessionDay] {
        SessionDays.group(
            SessionFilter.apply(project, to: list.choices),
            nowMs: nowMs,
            calendar: calendar
        )
    }

    /// L'état de l'écran, dans l'ordre de priorité de S-1. Une liste reçue PRIME
    /// sur le statut de connexion : hors connexion, elle reste affichée sous le
    /// bandeau (etats-non-connecte-heterogenes-ios, S-4).
    static func screen(
        connection: IOSConnectionStatus,
        list: SessionList?,
        project: String?,
        nowMs: Double,
        calendar: Calendar
    ) -> IOSSessionsScreenState {
        guard let list else {
            // (1) non connectée sans instantané, (2) connectée sans instantané.
            return connection == .connected ? .loading : .unavailable(connection)
        }
        // (3) magasin absent, (4) aucun run, (5) la liste.
        if list.storeAbsent { return .storeAbsent }
        if list.choices.isEmpty { return .empty }
        return .list(days(of: list, project: project, nowMs: nowMs, calendar: calendar))
    }
}
