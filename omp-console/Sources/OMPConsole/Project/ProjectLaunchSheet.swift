// La feuille « Conduire un projet… » (S-1) : choix du dépôt et nom du projet.
//
// Aucun `@State` : le brouillon vit dans le modèle. Le dossier initial est LU
// (`ProjectRoot.resolve`), jamais écrit — aucune préférence n'est mémorisée.

import SwiftUI

struct ProjectLaunchSheet: View {
    @ObservedObject var model: ProjectConsoleModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(ProjectViewText.launchTitle)
                .font(.headline)

            HStack(spacing: 8) {
                Text(ProjectViewText.launchRepository)
                Text(model.draftRepository?.path ?? ProjectViewText.repositoryPlaceholder)
                    .font(.system(.callout, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .foregroundStyle(model.draftRepository == nil ? .secondary : .primary)
                    .accessibilityIdentifier("projet.launch.repository")
                Spacer(minLength: 8)
                Button(ProjectViewText.chooseRepository) { model.chooseDraftRepository() }
                    .accessibilityIdentifier("projet.launch.choose")
            }

            HStack(spacing: 8) {
                Text(ProjectViewText.launchName)
                TextField(ProjectViewText.namePlaceholder, text: $model.draftName)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { model.commitLaunch() }
                    .accessibilityIdentifier("projet.launch.name")
            }

            HStack(spacing: 8) {
                Spacer(minLength: 0)
                Button(ProjectViewText.launchCancel) { model.isLaunchSheetPresented = false }
                    .keyboardShortcut(.escape, modifiers: [])
                    .accessibilityIdentifier("projet.launch.cancel")
                Button(ProjectViewText.launchConduire) { model.commitLaunch() }
                    .keyboardShortcut(.return, modifiers: [])
                    .disabled(!model.canCommitLaunch)
                    .accessibilityIdentifier("projet.launch.commit")
            }
        }
        .padding(20)
        .frame(minWidth: 480)
    }
}
