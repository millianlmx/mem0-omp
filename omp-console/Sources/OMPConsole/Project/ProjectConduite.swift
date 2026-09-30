// Les types de valeur de la conduite d'un projet (S-1, S-2) : l'identité choisie,
// l'état de la conduite et le refus d'un second démarrage.
//
// Aucun comportement ici : ce sont des valeurs pures, `Equatable`, ce qui rend les
// preuves lisibles sans machine d'état.

import Foundation

/// Le dépôt choisi et le nom du projet, tels que la conduite les a fixés.
struct ConduiteIdentity: Equatable, Sendable {
    let repoRoot: URL
    let name: String
}

/// L'état d'une conduite. `none` : aucune conduite ; `closed` : conduite close par
/// l'utilisateur (une nouvelle conduite est possible).
enum ConduiteState: Equatable, Sendable {
    case none
    case starting
    case live
    case closing
    case closed
}

/// Le refus d'un second démarrage (S-2) : le message exact affiché et les deux
/// éléments qui le composent, pour que l'alerte n'ait pas à re-découper un texte.
struct ConduiteRefusal: Equatable, Sendable {
    let message: String
    let repositoryName: String
    let repositoryPath: String
}
