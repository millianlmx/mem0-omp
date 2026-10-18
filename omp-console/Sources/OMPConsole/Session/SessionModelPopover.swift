// Le sélecteur de modèle et de réflexion de la section « Session OMP »
// (model-selector-in-embedded-omp-session, S-6) : le contenu du popover ouvert par
// `SessionModelButton`. Une liste FILTRABLE des modèles utilisables (le catalogue
// authentifié d'`omp models --json`), le niveau de réflexion que le modèle choisi
// supporte, et les boutons « Annuler » / « Appliquer ».
//
// Aucun attribut `@State` : le filtre, le brouillon, l'erreur et l'état
// « application en cours » vivent dans `SessionConsoleModel`. Les mots viennent de
// `SessionConsoleText.Model` (ConsoleCore, partagés avec l'iPhone).

import ConsoleCore
import SwiftUI

struct SessionModelPopover: View {
    @ObservedObject var model: SessionConsoleModel
    @FocusState private var filterFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            TextField(
                SessionConsoleText.Model.filter,
                text: $model.modelFilter,
                prompt: Text(SessionConsoleText.Model.filter)
            )
            .labelsHidden()
            .textFieldStyle(.roundedBorder)
            .focused($filterFocused)
            .accessibilityIdentifier("session.model.filter")

            catalog

            if !model.draftLevels.isEmpty {
                Picker(SessionConsoleText.Frame.thinkingLevel, selection: $model.draftLevel) {
                    ForEach(model.draftLevels, id: \.self) { level in
                        Text(SessionConsoleText.Model.levelName(level)).tag(Optional(level))
                    }
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("session.model.thinking")
            }

            if let error = model.modelError {
                Text(verbatim: error)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("session.model.error")
            }

            HStack(spacing: 8) {
                Spacer()
                Button(SessionConsoleText.Model.cancel) { model.cancelModelPicker() }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("session.model.cancel")
                if model.isApplyingModel {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityIdentifier("session.model.applying")
                } else {
                    Button(SessionConsoleText.Model.apply) { model.commitModelDraft() }
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(.defaultAction)
                        .disabled(!model.canApplyModel)
                        .accessibilityIdentifier("session.model.apply")
                }
            }
        }
        .disabled(model.isApplyingModel)
        .padding(16)
        .frame(width: 420)
        .onAppear { filterFocused = true }
    }

    // MARK: - Catalogue

    @ViewBuilder private var catalog: some View {
        switch model.modelCatalog {
        case .loading:
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text(SessionConsoleText.Model.loading)
                    .foregroundStyle(.secondary)
            }
            .frame(minHeight: 260)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("session.model.loading")
        case .failed(let reason):
            VStack(alignment: .leading, spacing: 8) {
                Text(KanbanText.modelCatalogUnavailable(reason))
                    .font(.callout)
                    .foregroundStyle(.red)
                Button(KanbanText.modelCatalogRetry) { model.retryModelCatalog() }
                    .accessibilityIdentifier("session.model.retry")
            }
            .frame(minHeight: 260, alignment: .topLeading)
        case .loaded:
            let visible = model.visibleModels
            if visible.isEmpty {
                Text(SessionConsoleText.Model.noMatch)
                    .foregroundStyle(.secondary)
                    .frame(minHeight: 260, alignment: .topLeading)
                    .accessibilityIdentifier("session.model.empty")
            } else {
                List(selection: selection) {
                    ForEach(visible, id: \.self) { selector in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: model.modelChoiceLabels[selector] ?? selector)
                            Text(verbatim: selector)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .tag(Optional(selector))
                    }
                }
                .frame(minHeight: 260)
                .accessibilityIdentifier("session.model.list")
            }
        }
    }

    private var selection: Binding<String?> {
        Binding(
            get: { model.draftModel },
            set: { model.selectDraftModel($0) }
        )
    }
}
