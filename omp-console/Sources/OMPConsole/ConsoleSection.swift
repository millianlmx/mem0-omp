// Les cinq sections de la coque, dans l'ordre d'affichage de la barre latérale.
//
// Un enum plutôt qu'un tableau de vues : la section est l'identité PARTAGÉE entre
// la liste, le détail, les tests et, plus tard, les features métier. L'ordre de
// déclaration des cas EST l'ordre d'affichage (`CaseIterable`), donc il n'existe
// pas de seconde liste à tenir synchronisée.

enum ConsoleSection: String, CaseIterable, Identifiable, Hashable, Sendable {
    case kanban
    case sessions
    case files
    case project
    case memory

    var id: String { rawValue }

    /// Libellé affiché dans la barre latérale et dans le détail.
    var title: String {
        switch self {
        case .kanban: "Kanban"
        case .sessions: "Sessions"
        case .files: "Fichiers"
        case .project: "Projet"
        case .memory: "Mémoire"
        }
    }

    /// Symbole SF associé à la section.
    var systemImage: String {
        switch self {
        case .kanban: "square.grid.2x2"
        case .sessions: "bubble.left.and.text.bubble.right"
        case .files: "doc.text"
        case .project: "target"
        case .memory: "brain"
        }
    }

    /// Contenu de remplacement de la vue : la coque n'a aucune logique métier,
    /// chaque section annonce donc ce qui arrivera ici. Chaque texte est propre
    /// à sa section (deux sections ne partagent jamais le même).
    var placeholder: String {
        switch self {
        case .kanban: "Le tableau Kanban des pipelines arrivera ici."
        case .sessions: "La liste des sessions OMP arrivera ici."
        case .files: "La visionneuse de fichiers et de diffs arrivera ici."
        case .project: "La vue Projet arrivera ici."
        case .memory: "La mémoire du projet arrivera ici."
        }
    }
}
