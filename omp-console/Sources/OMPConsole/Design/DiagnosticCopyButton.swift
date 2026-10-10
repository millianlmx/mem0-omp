// Le bouton « Copier le diagnostic » (S-1 de jargon-technique-expose-mac-et-ios).
//
// Au clic : copie du brut, puis « Diagnostic copié » pendant 2 s. Un nouveau clic
// pendant ce délai recopie et RELANCE le délai : `copiedAt` change, donc
// `.task(id:)` annule l'attente en cours et en ouvre une neuve.
// Jamais `.keyboardShortcut(.defaultAction)` : ↩ reste au bouton principal de la
// surface qui l'accueille.

import AppKit
import SwiftUI

struct DiagnosticCopyButton: View {
    let diagnostic: String
    let identifier: String
    var pasteboard: NSPasteboard = .general

    @State private var copiedAt: Date?

    var body: some View {
        Button {
            DiagnosticPasteboard.copy(diagnostic, to: pasteboard)
            copiedAt = Date()
        } label: {
            if copiedAt == nil {
                Label(DiagnosticText.copy, systemImage: "doc.on.doc")
            } else {
                Label(DiagnosticText.copied, systemImage: "checkmark")
            }
        }
        .controlSize(.small)
        .help(DiagnosticText.copyHelp)
        .disabled(diagnostic.isEmpty)
        .accessibilityIdentifier(identifier)
        .task(id: copiedAt) {
            guard copiedAt != nil else { return }
            do {
                try await Task.sleep(for: .seconds(2))
            } catch {
                return
            }
            copiedAt = nil
        }
    }
}
