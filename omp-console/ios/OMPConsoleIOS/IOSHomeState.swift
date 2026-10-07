// La machine à états de l'Accueil iOS (S-10) : une fonction PURE de l'état du
// client, de l'ardoise publiée et de l'état d'OMP — vérifiable sans rendre une
// vue.
//
// La SEULE couche propre à iOS est la priorité (1) : hors `.connected`, l'Accueil
// montre un état dégradé explicite et n'offre aucun geste. Les cas (2) à (5) sont
// EXACTEMENT `HomePresentation.state(omp:board:)`, le noyau partagé des deux
// coques.

import ConsoleClient
import ConsoleCore

enum IOSHomeState: Equatable {
    /// (1) Le client n'est pas connecté : état dégradé, aucun geste.
    case disconnected(ClientState)
    /// (2) Le Mac est connecté et dit OMP absent.
    case macMissingOMP
    /// (3) Connecté, aucun instantané encore arrivé.
    case loading
    /// (4) L'instantané dit un magasin absent ou vide.
    case firstRun
    /// (5) Le tableau de bord.
    case dashboard(HomeDashboard)

    /// L'état de l'Accueil, dans l'ordre de priorité de S-10.
    static func resolve(state: ClientState, board: KanbanBoardState, omp: OmpStatus) -> IOSHomeState {
        guard case .connected = state else { return .disconnected(state) }
        switch HomePresentation.state(omp: omp, board: board) {
        case .ompMissing: return .macMissingOMP
        case .loading: return .loading
        case .firstRun: return .firstRun
        case .dashboard(let dashboard): return .dashboard(dashboard)
        }
    }
}
