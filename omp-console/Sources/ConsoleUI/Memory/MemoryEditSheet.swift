// La feuille « Modifier le souvenir », écrite une fois pour le Mac et l'iPhone/iPad :
// le texte et les étiquettes (séparées par des virgules). Ouverte depuis la LISTE de la
// Mémoire (menu d'une rangée) ; chaque app garde son modèle et son client — le service
// de la machine sur le Mac, `MemoryWriter` sur iOS — et lui passe sa saisie.

import ConsoleCore
import SwiftUI

public struct MemoryEditSheet: View {
    @Binding var text: String
    @Binding var tags: String
    let isSaving: Bool
    let error: String?
    let save: @MainActor () -> Void
    let cancel: @MainActor () -> Void

    public init(
        text: Binding<String>, tags: Binding<String>, isSaving: Bool, error: String?,
        save: @escaping @MainActor () -> Void, cancel: @escaping @MainActor () -> Void
    ) {
        _text = text
        _tags = tags
        self.isSaving = isSaving
        self.error = error
        self.save = save
        self.cancel = cancel
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(MemoryText.textLabel, text: $text, axis: .vertical)
                        .lineLimit(4...16)
                        .consoleID("memory.edit.text")
                    TextField(MemoryText.tagsLabel, text: $tags)
                        .consolePlainInput()
                        .consoleID("memory.edit.tags")
                }
                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(MemoryText.editTitle)
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(MemoryText.cancel) { cancel() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(MemoryText.save) { save() }
                        .disabled(isSaving || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .consoleID("memory.edit.save")
                }
            }
        }
        .consoleSheetSize(minWidth: 480, minHeight: 320)
    }
}
