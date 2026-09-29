// Interface de la coque : fenêtre, barre latérale à quatre entrées, panneau de
// détail. Les quatre vues ne partagent qu'un contrat — elles déclarent leur
// section — et trois d'entre elles sont VIVANTES (Kanban, Fichiers, Sessions) ;
// Projet rend encore un contenu de remplacement.
//
// Aucun attribut macro SwiftUI n'est employé ici (`@State`, `@Preview`, …) :
// sous les Command Line Tools seuls, ces macros échouent à la compilation (D3).

import SwiftUI

/// Contrat minimal d'une vue de section : se déclarer sur la section qu'elle sert.
/// C'est ce que la suite (S-4) confronte à `ConsoleSection.allCases` — une vue
/// manquante ou deux vues sur la même section font donc rougir le test.
protocol ConsoleSectionView: View {
    static var section: ConsoleSection { get }
}

/// Contenu de remplacement commun : titre et texte d'annonce de la section,
/// cadré sur toute la surface disponible.
struct PlaceholderPane: View {
    let section: ConsoleSection

    var body: some View {
        VStack(spacing: 12) {
            Text(section.title)
                .font(.largeTitle)
            Text(section.placeholder)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

struct SessionsView: ConsoleSectionView {
    static let section = ConsoleSection.sessions
    var body: some View { SessionSelectorView() }
}

struct ProjectView: ConsoleSectionView {
    static let section = ConsoleSection.project
    var body: some View { PlaceholderPane(section: Self.section) }
}

/// SEUL endroit qui associe une section à sa vue : le `switch` est exhaustif,
/// donc ajouter un cas à `ConsoleSection` sans lui donner de vue ne compile pas.
///
/// Kanban (son ardoise) et Fichiers (sa cible et son document) reçoivent leur
/// modèle ; Sessions rend le sélecteur de runs, qui porte le sien. Projet garde
/// exactement son contenu de remplacement.
struct SectionDetail: View {
    let section: ConsoleSection
    let filesModel: FilesModel
    @ObservedObject var kanban: KanbanModel

    var body: some View {
        switch section {
        case .kanban: KanbanView(model: kanban)
        case .sessions: SessionsView()
        case .files: FilesView(model: filesModel)
        case .project: ProjectView()
        }
    }
}
