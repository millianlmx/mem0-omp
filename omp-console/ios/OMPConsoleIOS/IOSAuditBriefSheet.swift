// La feuille du brief de l'app iOS (audit-panel-in-omp-console, S-6, S-8, BR-5) :
// le `briefDraft` de l'audit, éditable, qui contient la rubrique Orientation (AC-1).
// « Valider et lancer » poste la sélection et le texte ensemble ; une rubrique
// manquante est signalée DANS la feuille avant tout envoi. « Annuler », Échap ou le
// glissement de fermeture ne postent RIEN (AC-3).

import ConsoleCore
import SwiftUI

struct IOSAuditBriefSheet: View {
    @ObservedObject var model: IOSAuditModel
    let card: AuditCard

    private var launching: Bool { model.isInFlight(.launch(auditId: card.id)) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(AuditText.briefHelp)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    Text(AuditText.checkedCount(model.selectedSlugs(of: card).count))
                        .font(.callout.weight(.semibold))
                }
                if let error = model.briefError {
                    Text(error)
                        .font(.callout)
                        .iosBanner(tone: .danger)
                        .accessibilityIdentifier(IOSAuditAccessibility.briefError)
                }
                Section {
                    TextEditor(text: $model.briefText)
                        .font(.body.monospaced())
                        .frame(minHeight: 320)
                        .accessibilityLabel(AuditText.briefTitle)
                        .accessibilityIdentifier(IOSAuditAccessibility.briefEditor)
                }
            }
            .navigationTitle(AuditText.briefTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    IOSSheetIconButton(role: .cancel, label: AuditText.cancel) { model.cancelBrief() }
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier(IOSAuditAccessibility.briefCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if launching {
                        ProgressView()
                    } else {
                        IOSSheetIconButton(role: .confirm, label: AuditText.commitBrief) {
                            Task { await model.commitBrief() }
                        }
                        .disabled(!model.gesturesEnabled)
                        .keyboardShortcut(.defaultAction)
                        .accessibilityIdentifier(IOSAuditAccessibility.briefConfirm)
                    }
                }
            }
            .accessibilityIdentifier(IOSAuditAccessibility.briefSheet)
        }
        .interactiveDismissDisabled(launching)
    }
}
