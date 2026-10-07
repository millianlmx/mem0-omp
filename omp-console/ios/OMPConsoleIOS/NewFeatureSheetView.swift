import ConsoleClient
import ConsoleCore
import SwiftUI

/// La feuille « Nouvelle feature… » de l'app (S-13) : dépôt (parmi les dépôts
/// réels de l'ardoise), deux modèles, un titre, un besoin. Les mots sont ceux de
/// macOS ; l'app n'invente aucune option.
struct NewFeatureSheetView: View {
    @ObservedObject var client: ConsoleClientModel

    @Environment(\.dismiss) private var dismiss
    @State private var repo = ""
    @State private var reqSpecs = ModelCatalog.defaultChoice
    @State private var implReview = ModelCatalog.defaultChoice
    @State private var title = ""
    @State private var need = ""
    @State private var catalog: ModelCatalogState = .loading
    @State private var error: String?
    @State private var busy = false

    private var cards: [KanbanCard] {
        PipelinesModel.boardState(of: client, nowMs: Date().timeIntervalSince1970 * 1000)?.kanbanBoard?.cards ?? []
    }

    private var repos: [String] {
        KanbanLaunchRepos.options(cards: cards, projectRoot: nil)
    }

    private var choices: [String] {
        ModelCatalog.choices(catalog)
    }

    private var ready: Bool {
        !repos.isEmpty && !repo.isEmpty && !title.isBlank && !need.isBlank
    }

    var body: some View {
        NavigationStack {
            Form {
                repoSection
                modelSection
                detailsSection
                if let error {
                    Section {
                        Text(error)
                            .font(.callout)
                            .iosBanner(tone: .danger)
                            .accessibilityIdentifier(PipelinesAccessibility.error)
                    }
                }
            }
            .navigationTitle(NewFeatureText.title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NewFeatureText.cancel) { dismiss() }
                        .accessibilityIdentifier(PipelinesAccessibility.cancelButton)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(NewFeatureText.launch) { submit() }
                        .disabled(!ready || busy)
                        .accessibilityIdentifier(PipelinesAccessibility.launchButton)
                }
            }
        }
        .accessibilityIdentifier(PipelinesText.newFeatureSheetId)
        .task { await loadCatalog() }
    }

    @ViewBuilder
    private var repoSection: some View {
        Section(NewFeatureText.repo) {
            if repos.isEmpty {
                Text(NewFeatureText.noKnownRepo)
                    .foregroundStyle(.secondary)
            } else {
                Picker(NewFeatureText.repo, selection: $repo) {
                    ForEach(repos, id: \.self) { root in
                        Text(verbatim: ConsoleFormat.path(root)).tag(root)
                    }
                }
                .accessibilityIdentifier(PipelinesAccessibility.repoField)
            }
        }
    }

    @ViewBuilder
    private var modelSection: some View {
        Section {
            Picker(KanbanText.modelReqSpecsField, selection: $reqSpecs) {
                ForEach(choices, id: \.self) { choice in
                    Text(verbatim: choice).tag(choice)
                }
            }
            .accessibilityIdentifier(PipelinesAccessibility.reqSpecsField)
            Picker(KanbanText.modelImplReviewField, selection: $implReview) {
                ForEach(choices, id: \.self) { choice in
                    Text(verbatim: choice).tag(choice)
                }
            }
            .accessibilityIdentifier(PipelinesAccessibility.implReviewField)
            if case .loading = catalog {
                Text(KanbanText.modelCatalogLoading)
                    .foregroundStyle(.secondary)
            }
            if case .failed(let reason) = catalog {
                Text(KanbanText.modelCatalogUnavailable(reason))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Button(KanbanText.modelCatalogRetry) {
                    Task { await loadCatalog() }
                }
                .accessibilityIdentifier(PipelinesAccessibility.modelRetry)
            }
        }
    }

    @ViewBuilder
    private var detailsSection: some View {
        Section {
            TextField(NewFeatureText.titlePlaceholder, text: $title)
                .accessibilityIdentifier(PipelinesAccessibility.titleField)
            Text(NewFeatureText.titleHelp)
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField(NewFeatureText.needPlaceholder, text: $need, axis: .vertical)
                .accessibilityIdentifier(PipelinesAccessibility.needField)
        }
    }

    private func loadCatalog() async {
        catalog = .loading
        do {
            let payload = try await client.models()
            if let failure = payload.failure {
                catalog = .failed(failure)
            } else {
                catalog = .loaded(payload.selectors)
            }
        } catch {
            catalog = .failed(PipelinesText.gestureError(error))
        }
    }

    private func submit() {
        busy = true
        error = nil
        let repoRoot = repo
        let featureTitle = title
        let description = need
        let req = reqSpecs == ModelCatalog.defaultChoice ? nil : reqSpecs
        let impl = implReview == ModelCatalog.defaultChoice ? nil : implReview
        Task { @MainActor in
            do {
                _ = try await client.launch(
                    repoRoot: repoRoot,
                    title: featureTitle,
                    description: description,
                    modelReqSpecs: req,
                    modelImplReview: impl
                )
                busy = false
                dismiss()
            } catch {
                self.error = PipelinesText.gestureError(error)
                busy = false
            }
        }
    }
}

private extension String {
    var isBlank: Bool { trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}
