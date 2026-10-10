// La machine à états de l'Accueil iOS (S-10) : une fonction PURE du statut de
// connexion présenté, de l'ardoise publiée et de l'état d'OMP — vérifiable sans
// rendre une vue.
//
// La SEULE couche propre à iOS est la priorité (1) : hors `.connected` et tant
// qu'aucune ardoise n'est arrivée, l'Accueil est indisponible et rend le
// composant partagé d'état de connexion en plein écran (feature
// etats-non-connecte-heterogenes-ios, S-4). Une ardoise reçue reste affichée hors
// connexion, sous le bandeau du même composant. Les cas (2) à (5) sont EXACTEMENT
// `HomePresentation.state(omp:board:)`, le noyau partagé des deux coques.

import ConsoleClient
import ConsoleCore

enum IOSHomeState: Equatable {
    /// (1) Hors connexion, rien chargé : le composant d'état de connexion.
    case unavailable(IOSConnectionStatus)
    /// (2) Le Mac a dit OMP absent.
    case macMissingOMP
    /// (3) Connecté, aucun instantané encore arrivé.
    case loading
    /// (4) L'instantané dit un magasin absent ou vide.
    case firstRun
    /// (5) Le tableau de bord.
    case dashboard(HomeDashboard)

    /// L'état de l'Accueil, dans l'ordre de priorité de S-10.
    static func resolve(connection: IOSConnectionStatus, board: KanbanBoardState, omp: OmpStatus) -> IOSHomeState {
        if connection != .connected, board == .loading { return .unavailable(connection) }
        switch HomePresentation.state(omp: omp, board: board) {
        case .ompMissing: return .macMissingOMP
        case .loading: return .loading
        case .firstRun: return .firstRun
        case .dashboard(let dashboard): return .dashboard(dashboard)
        }
    }
}
