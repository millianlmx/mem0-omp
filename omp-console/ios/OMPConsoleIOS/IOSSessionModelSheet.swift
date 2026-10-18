// La feuille « Modèle et réflexion » de l'écran Session OMP (model-selector-in-
// embedded-omp-session, S-8) : les modèles utilisables du Mac (le catalogue
// authentifié servi par `GET /v1/models`), filtrables, et les niveaux de réflexion
// que le modèle choisi supporte.
//
// Les décisions (liste filtrée, niveaux proposés, disponibilité, application) vivent
// dans `IOSSessionOmpModel` ; la feuille ne garde que le brouillon, le filtre et le
// message du refus. Elle ne se ferme que sur succès : un refus la laisse ouverte, le
// message du Mac en bandeau, et l'en-tête garde la valeur réellement active.
//
// Aucun littéral alphabétique : mots de `SessionConsoleText.Model`, `KanbanText` et
// `IOSSessionOmpText`, identifiants de `SessionOmpAccessibility`.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct IOSSessionModelSheet: View {
    @ObservedObject var model: IOSSessionOmpModel

    @Environment(\.dismiss) private var dismiss
    @State private var draftModel: String?
    @State private var draftLevel: String?
    @State private var filter = ""
    @State private var error: String?
    /// Le niveau actif du Mac, posé en brouillon une fois les efforts du catalogue
    /// connus (`auto` n'est jamais proposé : il se replie sur un niveau proposé).
    private let levelSeed: String?

    /// Le brouillon part de la valeur affichée.
    init(model: IOSSessionOmpModel) {
        self.model = model
        let shown = model.client.hosted
        _draftModel = State(initialValue: shown?.model)
        levelSeed = shown?.thinkingLevel
    }

    private var levels: [String] {
        IOSSessionOmpModel.offeredLevels(model: draftModel, thinking: model.modelThinking)
    }

    /// Le niveau envoyé : aucun quand le modèle n'en propose pas.
    private var levelToSend: String? {
        levels.isEmpty ? nil : draftLevel
    }

    private var canApply: Bool {
        guard draftModel != nil, case .loaded = model.modelCatalog else { return false }
        return model.canChangeModel
    }

    var body: some View {
        NavigationStack {
            Form {
                catalogSection
                if !levels.isEmpty {
                    Section {
                        Picker(SessionConsoleText.Frame.thinkingLevel, selection: $draftLevel) {
                            ForEach(levels, id: \.self) { level in
                                Text(SessionConsoleText.Model.levelName(level)).tag(Optional(level))
                            }
                        }
                        .accessibilityIdentifier(SessionOmpAccessibility.modelThinking)
                    }
                }
                if let error {
                    Text(error)
                        .font(.callout)
                        .iosBanner(tone: .danger)
                        .accessibilityIdentifier(SessionOmpAccessibility.modelError)
                }
            }
            .searchable(text: $filter, prompt: Text(verbatim: SessionConsoleText.Model.filter))
            .navigationTitle(IOSSessionOmpText.modelSheetTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    IOSSheetIconButton(role: .cancel, label: SessionConsoleText.Model.cancel) { dismiss() }
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier(SessionOmpAccessibility.modelCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model.isApplyingModel {
                        ProgressView()
                    } else {
                        IOSSheetIconButton(role: .confirm, label: SessionConsoleText.Model.apply, action: commit)
                            .disabled(!canApply)
                            .keyboardShortcut(.defaultAction)
                            .accessibilityIdentifier(SessionOmpAccessibility.modelApply)
                    }
                }
            }
            .accessibilityIdentifier(SessionOmpAccessibility.modelSheet)
            .task {
                await model.loadCatalog()
                seedLevel()
            }
        }
        .iosPageSheet()
        .presentationDetents([.large])
    }

    // MARK: - Catalogue

    @ViewBuilder private var catalogSection: some View {
        switch model.modelCatalog {
        case .loading:
            Section {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(SessionConsoleText.Model.loading)
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier(SessionOmpAccessibility.modelLoading)
            }
        case .failed(let reason):
            Section {
                Text(reason)
                    .font(.callout)
                    .iosBanner(tone: .danger)
                    .accessibilityIdentifier(SessionOmpAccessibility.modelFailure)
                Button(KanbanText.modelCatalogRetry) {
                    Task {
                        await model.loadCatalog(force: true)
                        seedLevel()
                    }
                }
            }
        case .loaded:
            let visible = IOSSessionOmpModel.visibleModels(
                catalog: model.modelCatalog, filter: filter, names: model.modelNames)
            Section {
                if visible.isEmpty {
                    Text(SessionConsoleText.Model.noMatch)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier(SessionOmpAccessibility.modelEmpty)
                } else {
                    modelRows(visible)
                }
            }
            .accessibilityIdentifier(SessionOmpAccessibility.modelList)
        }
    }

    @ViewBuilder private func modelRows(_ visible: [String]) -> some View {
        let labels = ModelCatalog.choiceLabels(visible, names: model.modelNames)
        ForEach(visible, id: \.self) { selector in
            let isSelected = draftModel == selector
            Button { choose(selector) } label: {
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: labels[selector] ?? selector)
                        Text(verbatim: selector)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    if isSelected {
                        Image(systemName: IOSHomeText.selectedSymbol)
                            .fontWeight(.semibold)
                            .foregroundStyle(Color.accentColor)
                            .accessibilityHidden(true)
                    }
                }
            }
            .tint(.primary)
            .accessibilityAddTraits(isSelected ? .isSelected : [])
            .accessibilityIdentifier(SessionOmpAccessibility.modelRow(selector))
        }
    }

    // MARK: - Gestes

    /// Le niveau actif du Mac, retenu pour le modèle du brouillon une fois les
    /// efforts connus.
    private func seedLevel() {
        guard draftLevel == nil else { return }
        draftLevel = ModelCatalog.retainedLevel(levelSeed, offered: levels)
    }

    /// Un autre modèle : niveau gardé s'il est proposé, sinon le plus haut proposé
    /// qui ne le dépasse pas, sinon le premier (`ModelCatalog.retainedLevel`).
    private func choose(_ selector: String) {
        draftModel = selector
        let offered = IOSSessionOmpModel.offeredLevels(model: selector, thinking: model.modelThinking)
        draftLevel = ModelCatalog.retainedLevel(draftLevel ?? levelSeed, offered: offered)
        error = nil
    }

    private func commit() {
        guard canApply, let selector = draftModel else { return }
        error = nil
        Task {
            let message = await model.applyModel(model: selector, thinkingLevel: levelToSend)
            guard let message else {
                dismiss()
                return
            }
            error = message
        }
    }
}
