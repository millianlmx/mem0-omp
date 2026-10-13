// La feuille « Lancer un audit » (audit-panel-in-omp-console S-6) : le dépôt,
// prérempli par le projet choisi de l'app (`ProjectRoot.resolve`), « Choisir… »,
// puis l'orientation. « Lancer l'audit » n'est actif que si le dossier porte
// `.git` et si l'orientation rognée compte de 1 à 2 000 caractères.
//
// Patron `ProjectLaunchSheet` : le brouillon vit dans le modèle ; boutons à droite,
// « Annuler » (Échap) puis « Lancer l'audit » (↩). Le focus va à l'orientation à
// l'ouverture.

import ConsoleCore
import SwiftUI

struct AuditLaunchSheet: View {
    @ObservedObject var model: AuditConsoleModel
    @FocusState private var orientationFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(AuditText.launchTitle)
                .font(.title3.bold())

            Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 12) {
                GridRow {
                    Text(AuditText.repository)
                        .gridColumnAlignment(.trailing)
                    HStack(spacing: 8) {
                        Text(verbatim: model.draftRepository.map { ConsoleFormat.path($0.path) } ?? "")
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .help(model.draftRepository.map { ConsoleFormat.path($0.path) } ?? "")
                            .accessibilityIdentifier(AuditAccessibility.launchRepository)
                        Spacer(minLength: 8)
                        Button(AuditText.choose) { model.chooseDraftRepository() }
                            .accessibilityIdentifier(AuditAccessibility.launchChoose)
                    }
                }
                GridRow(alignment: .top) {
                    Text(AuditText.orientation)
                        .gridColumnAlignment(.trailing)
                    ZStack(alignment: .topLeading) {
                        TextEditor(text: $model.draftOrientation)
                            .font(.body)
                            .scrollContentBackground(.hidden)
                            .focused($orientationFocused)
                            .accessibilityLabel(AuditText.orientation)
                            .accessibilityIdentifier(AuditAccessibility.launchOrientation)
                        if model.draftOrientation.isEmpty {
                            Text(AuditText.orientationPrompt)
                                .foregroundStyle(.tertiary)
                                .padding(.leading, 5)
                                .allowsHitTesting(false)
                                .accessibilityHidden(true)
                        }
                    }
                    .padding(4)
                    .frame(height: 110)
                    .background(Color(nsColor: .textBackgroundColor), in: .rect(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.separator))
                }
            }

            if let message = model.launchFieldMessage {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier(AuditAccessibility.launchMessage)
            }

            HStack(spacing: 8) {
                Spacer(minLength: 0)
                Button(AuditText.cancel) { model.cancelLaunch() }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier(AuditAccessibility.launchCancel)
                Button(AuditText.commitLaunch) { model.commitLaunch() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!model.canCommitLaunch)
                    .accessibilityIdentifier(AuditAccessibility.launchCommit)
            }
        }
        .padding(20)
        .frame(width: 560)
        .onAppear { orientationFocused = true }
    }
}
