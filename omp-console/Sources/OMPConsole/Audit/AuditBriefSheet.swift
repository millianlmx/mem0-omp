// La feuille « Brief de l'audit » (audit-panel-in-omp-console S-6, AC-2, AC-3) :
// le `briefDraft` éditable, le compteur des cases cochées, le message de rubrique
// manquante (avant tout envoi), puis « Annuler » et « Valider et lancer ».
//
// « Annuler », Échap et la fermeture ne postent RIEN : ils passent tous par
// `cancelBrief`. « Valider et lancer » est désactivé pendant l'envoi ; au succès
// la feuille se ferme. Le focus va à l'éditeur à l'ouverture.

import ConsoleCore
import SwiftUI

struct AuditBriefSheet: View {
    @ObservedObject var model: AuditConsoleModel
    @FocusState private var editorFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(AuditText.briefTitle)
                .font(.title3.bold())
            Text(AuditText.briefHelp)
                .foregroundStyle(.secondary)
            if let card = model.selectedCard {
                Text(AuditText.checkedCount(model.checkedCount(of: card)))
                    .font(.callout)
                    .accessibilityIdentifier(AuditAccessibility.checkedCount)
            }

            TextEditor(text: $model.briefText)
                .font(.body.monospaced())
                .scrollContentBackground(.hidden)
                .focused($editorFocused)
                .padding(4)
                .background(Color(nsColor: .textBackgroundColor), in: .rect(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.separator))
                .frame(minHeight: 320, maxHeight: .infinity)
                .accessibilityLabel(AuditText.briefTitle)
                .accessibilityIdentifier(AuditAccessibility.briefEditor)

            if let error = model.briefError {
                Text(error)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier(AuditAccessibility.briefError)
            }
            if let failure = model.failure {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle")
                    Text(verbatim: failure.message)
                    Spacer(minLength: 8)
                    DiagnosticCopyButton(diagnostic: failure.diagnostic, identifier: AuditAccessibility.failureDiagnostic)
                }
                .font(.callout)
                .frame(maxWidth: .infinity, alignment: .leading)
                .consoleBanner(tint: .orange)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier(AuditAccessibility.briefFailure)
            }

            HStack(spacing: 8) {
                Spacer(minLength: 0)
                Button(AuditText.cancel) { model.cancelBrief() }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier(AuditAccessibility.briefCancel)
                if model.busy { ProgressView().controlSize(.small) }
                Button(AuditText.commitBrief) {
                    Task { @MainActor in await model.commitBrief() }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(model.busy)
                .accessibilityIdentifier(AuditAccessibility.briefCommit)
            }
        }
        .padding(20)
        .frame(width: 680, height: 600)
        .onExitCommand { model.cancelBrief() }
        .onAppear { editorFocused = true }
    }
}
