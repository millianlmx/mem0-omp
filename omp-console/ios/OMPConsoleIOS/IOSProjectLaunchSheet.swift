// La feuille « Piloter un projet… » de l'app iOS (S-8, S-9, BR-4) : la liste des
// dépôts CONNUS de la coque (y compris un dépôt jamais cadré), chacun désigné par son
// nom (`IOSRepoRows`), puis le nom du projet. Le client ne calcule JAMAIS le
// `repoKey` : il le reçoit dans la liste.
//
// La feuille ne se ferme que sur succès ; un échec laisse la feuille ouverte et
// affiche le message servi.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct IOSProjectLaunchSheet: View {
    @ObservedObject var client: ConsoleClientModel
    /// La fixture du crochet de recette `-projet.recipe lancement` : elle remplace
    /// `client.repos()` et présélectionne un dépôt. `nil` hors recette.
    private let recipe: IOSLaunchRecipe.Fixture?
    /// Rend `nil` sur succès, sinon le message d'échec à afficher.
    let onLaunch: (String, String) async -> String?

    @Environment(\.dismiss) private var dismiss
    @State private var repos: [RemoteRepoRow] = []
    @State private var loading = true
    @State private var loadFailure: String?
    @State private var selected: String?
    @State private var name = ""
    @State private var error: String?
    @State private var submitting = false
    @FocusState private var nameFocused: Bool
    /// La hauteur mesurée du formulaire : la hauteur de la feuille ajustée sur
    /// iPad, qui suit chaque état (chargement, liste, erreur).
    @State private var contentHeight: CGFloat = 0

    private var canCommit: Bool {
        selected != nil && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    init(
        client: ConsoleClientModel,
        recipe: IOSLaunchRecipe.Fixture? = nil,
        onLaunch: @escaping (String, String) async -> String?
    ) {
        self.client = client
        self.recipe = recipe
        self.onLaunch = onLaunch
    }

    /// Les gestes vers le Mac : actifs connecté ; sous le crochet de recette, la
    /// fixture tient lieu de Mac (etats-non-connecte-heterogenes-ios, S-5).
    private var gesturesEnabled: Bool {
        recipe != nil || IOSConnectionStatus.of(client).gesturesEnabled
    }

    /// La garde de `commit()`, que la touche Retour du champ nom atteint même quand
    /// « Valider » est grisé : hors connexion, ni requête ni fermeture (S-5, AC-9).
    static func mayCommit(gesturesEnabled: Bool, selected: String?, name: String, submitting: Bool) -> Bool {
        gesturesEnabled && selected != nil && !submitting
            && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(ProjectViewText.launchRepository) {
                    repositoryList
                }
                Section(ProjectViewText.launchName) {
                    TextField(ProjectViewText.namePlaceholder, text: $name)
                        .focused($nameFocused)
                        .onSubmit(commit)
                        .accessibilityIdentifier(ProjectAccessibility.launchName)
                }
                if let error {
                    Text(error)
                        .font(.callout)
                        .iosBanner(tone: .danger)
                        .accessibilityIdentifier(ProjectAccessibility.launchError)
                }
            }
            .iosSheetContentHeight($contentHeight)
            .navigationTitle(ProjectViewText.launchTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    IOSSheetIconButton(role: .cancel, label: ProjectViewText.launchCancel) { dismiss() }
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier(ProjectAccessibility.launchCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    IOSSheetIconButton(role: .confirm, label: ProjectViewText.launchCommit, action: commit)
                        .disabled(!gesturesEnabled || !canCommit || submitting)
                        .keyboardShortcut(.defaultAction)
                        .accessibilityIdentifier(ProjectAccessibility.launchCommit)
                }
            }
            .accessibilityIdentifier(ProjectAccessibility.launchSheet)
            .task { await load() }
        }
        .iosFittedSheet(contentHeight: contentHeight)
    }

    @ViewBuilder private var repositoryList: some View {
        if loading {
            ProgressView()
        } else if let loadFailure {
            Text(loadFailure)
                .foregroundStyle(.secondary)
        } else if repos.isEmpty {
            Text(ProjectViewText.noRepository)
                .foregroundStyle(.secondary)
        } else {
            IOSRepoRows(
                repos: repos,
                selected: selected,
                identifier: ProjectAccessibility.launchRepo,
                choose: choose)
        }
    }

    private func load() async {
        if let recipe {
            repos = recipe.repos
            loading = false
            if let chosen = recipe.repos.first(where: { $0.repoKey == recipe.selectedKey }) {
                choose(chosen)
            }
            return
        }
        loading = true
        loadFailure = nil
        do {
            let payload = try await client.repos()
            repos = payload.rows
        } catch {
            loadFailure = ProjectText.failure(error, state: client.state)
        }
        loading = false
    }

    private func choose(_ repo: RemoteRepoRow) {
        selected = repo.repoKey
        name = repo.name
    }

    private func commit() {
        guard let repoKey = selected,
              Self.mayCommit(gesturesEnabled: gesturesEnabled,
                             selected: selected, name: name, submitting: submitting)
        else { return }
        submitting = true
        Task {
            let message = await onLaunch(repoKey, name)
            submitting = false
            if let message {
                error = message
            } else {
                dismiss()
            }
        }
    }
}
