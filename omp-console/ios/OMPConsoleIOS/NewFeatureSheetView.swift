import ConsoleClient
import ConsoleCore
import SwiftUI

/// La feuille « Nouvelle feature… » de l'app (S-13) : dépôt (parmi les dépôts
/// réels de l'ardoise), deux modèles, un titre, un besoin. Les mots sont ceux de
/// macOS ; l'app n'invente aucune option.
struct NewFeatureSheetView: View {
    @ObservedObject var client: ConsoleClientModel
    /// Les dépôts forcés par la recette `-pipelines.recipe` ; `nil` hors recette
    /// (les dépôts viennent alors de l'ardoise).
    private let recipeRepos: [String]?

    @Environment(\.dismiss) private var dismiss
    @State private var repo = ""
    @State private var reqSpecs = ModelCatalog.defaultChoice
    @State private var implReview = ModelCatalog.defaultChoice
    @State private var title = ""
    @State private var need = ""
    @State private var catalog: ModelCatalogState = .loading
    @State private var error: String?
    @State private var busy = false

    init(client: ConsoleClientModel, recipe: IOSPipelinesRecipe? = nil) {
        self.client = client
        recipeRepos = recipe?.repos
        _repo = State(initialValue: recipe?.repo ?? "")
        _title = State(initialValue: recipe?.title ?? "")
        _need = State(initialValue: recipe?.need ?? "")
    }

    private var cards: [KanbanCard] {
        PipelinesModel.boardState(of: client, nowMs: Date().timeIntervalSince1970 * 1000)?.kanbanBoard?.cards ?? []
    }

    private var repos: [String] {
        recipeRepos ?? KanbanLaunchRepos.options(cards: cards, projectRoot: nil)
    }

    private var choices: [String] {
        ModelCatalog.choices(catalog)
    }

    private var ready: Bool {
        repos.contains(repo) && !title.isBlank && !need.isBlank
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
                repoMenu
            }
        }
    }

    /// Le sélecteur de dépôt : le nom choisi, ou l'invite. Le mot « Dépôt » n'est
    /// que l'en-tête de section ; le contrôle le porte pour VoiceOver.
    private var repoMenu: some View {
        let options = KanbanLaunchRepos.choices(repos)
        let current = options.first { $0.root == repo }
        let shown = current?.label ?? NewFeatureText.repoPrompt
        return Menu {
            ForEach(options) { choice in
                Button { repo = choice.root } label: {
                    repoChoice(choice, isCurrent: choice.root == repo)
                }
            }
        } label: {
            HStack {
                Text(verbatim: shown)
                    .foregroundStyle(current == nil ? .secondary : .primary)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                Image(systemName: PipelinesText.repoMenuSymbol)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, minHeight: IOSMetrics.minimumTarget, alignment: .leading)
            .contentShape(Rectangle())
        }
        .accessibilityIdentifier(PipelinesAccessibility.repoField)
        .accessibilityLabel(NewFeatureText.repo)
        .accessibilityValue(shown)
    }

    /// Une entrée du menu de dépôts : la marque du choix courant.
    @ViewBuilder private func repoChoice(_ choice: KanbanLaunchRepoChoice, isCurrent: Bool) -> some View {
        if isCurrent {
            Label {
                Text(verbatim: choice.label)
            } icon: {
                Image(systemName: IOSHomeText.selectedSymbol)
            }
        } else {
            Text(verbatim: choice.label)
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
                .accessibilityLabel(NewFeatureText.featureTitle)
            Text(NewFeatureText.titleHelp)
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField(NewFeatureText.needPlaceholder, text: $need, axis: .vertical)
                .lineLimit(IOSMetrics.needLines)
                .accessibilityIdentifier(PipelinesAccessibility.needField)
                .accessibilityLabel(NewFeatureText.need)
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
