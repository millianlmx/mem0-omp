import ConsoleClient
import ConsoleCore
import SwiftUI

/// La feuille « Nouvelle feature… » de l'app (S-13) : dépôt (parmi les dépôts
/// réels de l'ardoise), deux modèles, un titre, un besoin. Les mots sont ceux de
/// macOS ; l'app n'invente aucune option.
struct NewFeatureSheetView: View {
    /// Les deux clients (S-6 de orchestrator-living-in-a-vps) : avec un VPS configuré, la
    /// feuille propose les dépôts unifiés dont la machine conductrice est joignable et
    /// envoie la feature À CETTE machine.
    @ObservedObject var clients: MachineClients
    /// Les dépôts forcés par la recette `-pipelines.recipe` ; `nil` hors recette
    /// (les dépôts viennent alors de l'ardoise).
    private let recipeRepos: [String]?
    /// Sous la recette, la fixture tient lieu de Mac : la feuille est connectée (S-4).
    private let underRecipe: Bool

    @Environment(\.dismiss) private var dismiss
    @State private var repo = ""
    @State private var reqSpecs = ModelCatalog.defaultChoice
    @State private var implReview = ModelCatalog.defaultChoice
    @State private var title = ""
    @State private var need = ""
    @State private var catalog: ModelCatalogState = .loading
    @State private var error: String?
    @State private var busy = false

    init(clients: MachineClients, recipe: IOSPipelinesRecipe? = nil) {
        self.clients = clients
        recipeRepos = recipe?.repos
        underRecipe = recipe != nil
        _repo = State(initialValue: recipe?.repo ?? "")
        _title = State(initialValue: recipe?.title ?? "")
        _need = State(initialValue: recipe?.need ?? "")
    }

    private var cards: [KanbanCard] {
        PipelinesModel.unifiedBoard(of: clients, nowMs: Date().timeIntervalSince1970 * 1000).state?.kanbanBoard?.cards ?? []
    }

    /// Les dépôts unifiés qu'on peut lancer : la machine conductrice répond. `nil` hors VPS
    /// configuré (la liste est alors celle de l'ardoise, comme avant) et sous la recette.
    private var launchLines: [UnifiedRepo]? {
        guard clients.vpsConfigured, recipeRepos == nil else { return nil }
        return clients.repos.lines.filter { $0.launchTarget != nil }
    }

    /// La machine et la ligne du dépôt choisi (dépôts unifiés seulement).
    private var chosenTarget: (machine: RepoMachine, row: RepoRow)? {
        launchLines?.first { $0.id == repo }?.launchTarget
    }

    /// Le client qui lancera la feature : celui de la machine du dépôt choisi, sinon celui
    /// de la machine qui répond aux écrans.
    private var client: ConsoleClientModel {
        chosenTarget.map { clients.client(for: $0.machine) } ?? clients.activeClient
    }

    private var repos: [String] {
        if let launchLines { return launchLines.map(\.id) }
        return recipeRepos ?? KanbanLaunchRepos.options(cards: cards, projectRoot: nil)
    }

    private var choices: [String] {
        ModelCatalog.choices(catalog)
    }

    private var ready: Bool {
        repos.contains(repo) && !title.isBlank && !need.isBlank
    }

    /// Le statut présenté (etats-non-connecte-heterogenes-ios, S-5) : « Lancer » et
    /// « Réessayer » exigent le Mac, actifs seulement à `.connected`.
    private var connection: IOSConnectionStatus {
        if underRecipe { return .connected }
        return IOSConnectionStatus.of(client)
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
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    IOSSheetIconButton(role: .cancel, label: NewFeatureText.cancel) { dismiss() }
                        .accessibilityIdentifier(PipelinesAccessibility.cancelButton)
                }
                ToolbarItem(placement: .confirmationAction) {
                    IOSSheetIconButton(role: .confirm, label: NewFeatureText.launch) { submit() }
                        .disabled(!ready || busy || !connection.gesturesEnabled)
                        .accessibilityIdentifier(PipelinesAccessibility.launchButton)
                }
            }
        }
        .accessibilityIdentifier(PipelinesText.newFeatureSheetId)
        .task { await loadCatalog() }
        // Le catalogue des modèles est celui de la machine qui lancera la feature.
        .onChange(of: chosenTarget?.machine) { Task { await loadCatalog() } }
    }

    /// La rangée « Dépôt » : un `Picker` natif (S-8 de ios-finitions-composants).
    /// Sans en-tête de section, le libellé du Picker est le seul « Dépôt » écrit, et
    /// il sert aussi de libellé VoiceOver. L'invite « Choisir un dépôt » est la
    /// valeur affichée tant que rien n'est choisi, inactive dans le menu : aucune
    /// présélection. Le tag porte la racine complète, la rangée montre le libellé.
    @ViewBuilder
    private var repoSection: some View {
        Section {
            if repos.isEmpty {
                Text(NewFeatureText.noKnownRepo)
                    .foregroundStyle(.secondary)
            } else {
                Picker(NewFeatureText.repo, selection: $repo) {
                    Text(NewFeatureText.repoPrompt).tag("").selectionDisabled()
                    if let launchLines {
                        // VPS configuré : les dépôts unifiés, marqués de leur machine conductrice.
                        ForEach(launchLines) { line in
                            if let machine = line.launchTarget?.machine {
                                Text(verbatim: ReposText.accessibility(line.name, machine: machine)).tag(line.id)
                            }
                        }
                    } else {
                        ForEach(KanbanLaunchRepos.choices(repos)) { choice in
                            Text(verbatim: choice.label).tag(choice.root)
                        }
                    }
                }
                .accessibilityIdentifier(PipelinesAccessibility.repoField)
            }
        }
    }

    @ViewBuilder
    private var modelSection: some View {
        Section {
            Picker(KanbanText.modelReqSpecs, selection: $reqSpecs) {
                ForEach(choices, id: \.self) { choice in
                    Text(verbatim: choice).tag(choice)
                }
            }
            .accessibilityIdentifier(PipelinesAccessibility.reqSpecsField)
            Picker(KanbanText.modelImplReview, selection: $implReview) {
                ForEach(choices, id: \.self) { choice in
                    Text(verbatim: choice).tag(choice)
                }
            }
            .accessibilityIdentifier(PipelinesAccessibility.implReviewField)
            if case .loading = catalog {
                Text(KanbanText.modelCatalogLoading)
                    .foregroundStyle(.secondary)
            }
            if case .failed(let message) = catalog {
                Text(message)
                    .font(.callout)
                    .iosBanner(tone: .danger)
                    .accessibilityIdentifier(PipelinesAccessibility.modelFailure)
                Button {
                    Task { await loadCatalog() }
                } label: {
                    Text(KanbanText.modelCatalogRetry)
                        .frame(minHeight: IOSMetrics.minimumTarget)
                        .contentShape(Rectangle())
                }
                .disabled(!connection.gesturesEnabled)
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
            TextField(NewFeatureText.needPlaceholder, text: $need, axis: .vertical)
                .lineLimit(IOSMetrics.needLines)
                .accessibilityIdentifier(PipelinesAccessibility.needField)
                .accessibilityLabel(NewFeatureText.need)
        }
    }

    private func loadCatalog() async {
        catalog = .loading
        catalog = await PipelinesModel.catalog { try await client.models() }
    }

    private func submit() {
        busy = true
        error = nil
        let repoRoot = chosenTarget?.row.repoRoot ?? repo
        let client = self.client
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
                self.error = IOSMacErrorText.message(for: error)
                busy = false
            }
        }
    }
}

private extension String {
    var isBlank: Bool { trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}
