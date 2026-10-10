// L'action « Choisir un projet… » des états vides de Mémoire, Fichiers et
// Terminal (S-1, S-2 de mac-etats-vides-sans-issue), et l'état vide qui la porte.
//
// Deux formes, jamais un menu vide ni un bouton inactif (D-3) :
//  - des projets sont connus → un bouton de menu (`MenuStyle.button`, D-2) : une
//    entrée par projet, un séparateur, puis « Choisir un dossier… » ;
//  - aucun projet connu (AC-5) → un bouton simple qui ouvre directement le
//    panneau de Session OMP (`SessionConsoleModel.chooseProject()`).
// Ce qui s'affiche est décidé par `ProjectChooserForm`, pur, donc figé par les
// tests sans rendre la vue.
//
// Le choix ne touche jamais la section affichée : `onChosen` remplit l'écran
// COURANT (rafraîchissement de Mémoire ou de Fichiers, feuille du Terminal).
//
// Aucun attribut macro SwiftUI (`@State`, `@Preview`) : sous les Command Line
// Tools seuls, ils ne compilent pas. La liste vit dans `ProjectChooserModel`.

import ConsoleCore
import SwiftUI

/// La forme de l'action, selon les projets connus.
enum ProjectChooserForm: Equatable {
    /// Aucun projet connu : le panneau de Session OMP, sans menu intermédiaire.
    case folderButton
    /// Le menu déroulant, dans l'ordre de ses éléments.
    case menu([ProjectChooserMenuItem])

    static func of(_ entries: [ProjectChooserModel.Entry]) -> ProjectChooserForm {
        guard !entries.isEmpty else { return .folderButton }
        return .menu(entries.map { .project($0) } + [.separator, .chooseFolder])
    }
}

/// Un élément du menu des projets connus.
enum ProjectChooserMenuItem: Identifiable, Equatable {
    case project(ProjectChooserModel.Entry)
    case separator
    case chooseFolder

    /// Une racine est un chemin absolu : elle ne peut pas valoir les deux
    /// identités fixes.
    var id: String {
        switch self {
        case let .project(entry): entry.id
        case .separator: "separator"
        case .chooseFolder: "chooseFolder"
        }
    }
}

struct ProjectChooserButton: View {
    @ObservedObject var chooser: ProjectChooserModel
    /// L'identifiant AX de l'action (`memory.chooseProject`, …).
    let identifier: String
    /// Appelé après un choix RÉUSSI seulement : un panneau annulé ou une entrée
    /// disparue laissent l'état vide tel quel, sans message.
    let onChosen: () -> Void

    var body: some View {
        Group {
            switch ProjectChooserForm.of(chooser.entries) {
            case .folderButton:
                Button(ProjectChooserText.choose) { chooseFolder() }
            case let .menu(items):
                Menu(ProjectChooserText.choose) {
                    ForEach(items) { item in
                        switch item {
                        case let .project(entry):
                            Button(entry.label) {
                                if chooser.choose(entry) { onChosen() }
                            }
                        case .separator:
                            Divider()
                        case .chooseFolder:
                            Button(SessionConsoleText.chooseFolder) { chooseFolder() }
                        }
                    }
                }
                .menuStyle(.button)
            }
        }
        .buttonStyle(.borderedProminent)
        .accessibilityIdentifier(identifier)
        // Le contenu d'un `Menu` est construit au rendu : la liste est relue
        // AVANT que l'utilisateur ne puisse l'ouvrir.
        .onAppear { chooser.refresh() }
    }

    private func chooseFolder() {
        if chooser.chooseFolder() { onChosen() }
    }
}

/// L'état vide « sans projet » d'une des trois sections : ses mots et
/// l'identifiant de son action. Aucun ne nomme de raccourci clavier (AC-6).
struct NoProjectState: Equatable {
    let title: String
    let description: String
    let chooserIdentifier: String

    static let systemImage = "folder.badge.questionmark"

    static let memory = NoProjectState(
        title: MemoryText.noProjectTitle,
        description: MemoryText.noProjectDescription,
        chooserIdentifier: "memory.chooseProject"
    )
    static let files = NoProjectState(
        title: FilesText.noProjectTitle,
        description: FilesText.noProjectDescription,
        chooserIdentifier: "files.chooseProject"
    )
    static let terminal = NoProjectState(
        title: TerminalViewText.noProjectTitle,
        description: TerminalViewText.noProjectDescription,
        chooserIdentifier: "terminal.chooseProject"
    )
}

/// L'état vide lui-même : titre, phrase, et l'action « Choisir un projet… »
/// (patron `ContentUnavailableView` + `actions:` de SessionConsoleView).
struct NoProjectView: View {
    let state: NoProjectState
    let chooser: ProjectChooserModel
    let onChosen: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label(state.title, systemImage: NoProjectState.systemImage)
        } description: {
            Text(state.description)
        } actions: {
            ProjectChooserButton(chooser: chooser, identifier: state.chooserIdentifier, onChosen: onChosen)
        }
    }
}
