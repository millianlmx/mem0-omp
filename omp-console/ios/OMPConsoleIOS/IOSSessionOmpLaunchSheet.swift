// La feuille « Lancer une session OMP » de l'app iOS (BR-5, S-1) : la liste des
// dépôts CONNUS de la coque, chacun désigné par son nom (`IOSRepoRows`). Le client ne
// calcule JAMAIS le `repoKey` : il le reçoit dans la liste, et n'envoie que lui —
// aucune saisie de chemin, aucun champ « nom » (la session n'en prend pas).
//
// La feuille ne se ferme que sur succès ; un échec la laisse ouverte et affiche
// le message servi.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct IOSSessionOmpLaunchSheet: View {
    @ObservedObject var client: ConsoleClientModel
    /// La fixture du crochet de recette `-sessionomp.recipe lancement` : elle remplace
    /// `client.repos()` et présélectionne un dépôt. `nil` hors recette.
    private let recipe: IOSLaunchRecipe.Fixture?
    /// Rend `nil` sur succès, sinon le message d'échec à afficher DANS la feuille.
    let onLaunch: (String) async -> String?

    @Environment(\.dismiss) private var dismiss
    @State private var repos: [RemoteRepoRow] = []
    @State private var loading = true
    @State private var loadFailure: String?
    @State private var selected: String?
    @State private var error: String?
    @State private var submitting = false
    /// La hauteur mesurée du formulaire : la hauteur de la feuille ajustée sur
    /// iPad, qui suit chaque état (chargement, liste, erreur).
    @State private var contentHeight: CGFloat = 0

    init(
        client: ConsoleClientModel,
        recipe: IOSLaunchRecipe.Fixture? = nil,
        onLaunch: @escaping (String) async -> String?
    ) {
        self.client = client
        self.recipe = recipe
        self.onLaunch = onLaunch
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(ProjectViewText.launchRepository) {
                    repositoryList
                }
                if let error {
                    Text(error)
                        .font(.callout)
                        .iosBanner(tone: .danger)
                        .accessibilityIdentifier(SessionOmpAccessibility.launchError)
                }
            }
            .iosSheetContentHeight($contentHeight)
            .navigationTitle(IOSSessionOmpText.launchSheetTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    IOSSheetIconButton(role: .cancel, label: SessionConsoleText.cancel) { dismiss() }
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier(SessionOmpAccessibility.launchCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    IOSSheetIconButton(role: .confirm, label: SessionConsoleText.launch, action: commit)
                        .disabled(selected == nil || submitting)
                        .keyboardShortcut(.defaultAction)
                        .accessibilityIdentifier(SessionOmpAccessibility.launchCommit)
                }
            }
            .accessibilityIdentifier(SessionOmpAccessibility.launchSheet)
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
                .accessibilityIdentifier(SessionOmpAccessibility.launchRepositories)
        } else {
            IOSRepoRows(
                repos: repos,
                selected: selected,
                identifier: SessionOmpAccessibility.launchRepo,
                choose: choose)
        }
    }

    private func load() async {
        if let recipe {
            repos = recipe.repos
            selected = recipe.selectedKey
            loading = false
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
    }

    private func commit() {
        guard let repoKey = selected, !submitting else { return }
        submitting = true
        Task {
            let message = await onLaunch(repoKey)
            submitting = false
            guard let message else {
                dismiss()
                return
            }
            error = message
        }
    }
}
