// La feuille « Piloter un projet… » (S-1) : choix du dépôt et nom du projet.
//
// Aucun `@State` : le brouillon vit dans le modèle. Le dossier initial est LU
// (`ProjectRoot.resolve`), jamais écrit — aucune préférence n'est mémorisée.
// Boutons à droite : « Annuler » (Échap) puis « Piloter » (↩), seul bouton
// proéminent.

import ConsoleCore
import SwiftUI

struct ProjectLaunchSheet: View {
    @ObservedObject var model: ProjectConsoleModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(ProjectViewText.launchTitle)
                .font(.title3.bold())

            Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 12) {
                GridRow {
                    Text(ProjectViewText.launchRepository)
                        .gridColumnAlignment(.trailing)
                    HStack(spacing: 8) {
                        Text(model.draftRepository.map { ConsoleFormat.path($0.path) }
                            ?? ProjectViewText.repositoryPlaceholder)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .foregroundStyle(model.draftRepository == nil ? .secondary : .primary)
                            .help(model.draftRepository.map { ConsoleFormat.path($0.path) } ?? "")
                            .accessibilityIdentifier("projet.launch.repository")
                        Spacer(minLength: 8)
                        Button(ProjectViewText.chooseRepository) { model.chooseDraftRepository() }
                            .accessibilityIdentifier("projet.launch.choose")
                    }
                }
                GridRow {
                    Text(ProjectViewText.launchName)
                        .gridColumnAlignment(.trailing)
                    TextField(ProjectViewText.namePlaceholder, text: $model.draftName)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { model.commitLaunch() }
                        .accessibilityIdentifier("projet.launch.name")
                }
            }

            HStack(spacing: 8) {
                Spacer(minLength: 0)
                Button(ProjectViewText.launchCancel) { model.isLaunchSheetPresented = false }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("projet.launch.cancel")
                Button(ProjectViewText.launchCommit) { model.commitLaunch() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!model.canCommitLaunch)
                    .accessibilityIdentifier("projet.launch.commit")
            }
        }
        .padding(20)
        .frame(width: 520)
    }
}
