// La feuille « Piloter un projet… » de l'app iOS (S-8, S-9, BR-4) : la liste des
// dépôts CONNUS de la coque (y compris un dépôt jamais cadré), chacun avec son nom
// et son chemin, puis le nom du projet. Le client ne calcule JAMAIS le `repoKey` :
// il le reçoit dans la liste.
//
// La feuille ne se ferme que sur succès ; un échec laisse la feuille ouverte et
// affiche le message servi.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct IOSProjectLaunchSheet: View {
    @ObservedObject var client: ConsoleClientModel
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

    private var canCommit: Bool {
        selected != nil && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
            .navigationTitle(ProjectViewText.launchTitle)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(ProjectViewText.launchCancel) { dismiss() }
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier(ProjectAccessibility.launchCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(ProjectViewText.launchCommit, action: commit)
                        .disabled(!IOSConnectionStatus.of(client).gesturesEnabled || !canCommit || submitting)
                        .keyboardShortcut(.defaultAction)
                        .accessibilityIdentifier(ProjectAccessibility.launchCommit)
                }
            }
            .accessibilityIdentifier(ProjectAccessibility.launchSheet)
            .task { await load() }
        }
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
            ForEach(repos, id: \.repoKey) { repo in
                Button { choose(repo) } label: {
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(repo.name)
                                .foregroundStyle(.primary)
                            Text(ConsoleFormat.path(repo.repoRoot))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 8)
                        if selected == repo.repoKey {
                            Text(ProjectText.selectedMark)
                        }
                    }
                }
                .accessibilityAddTraits(selected == repo.repoKey ? .isSelected : [])
                .accessibilityIdentifier(ProjectAccessibility.launchRepo(repo.repoKey))
            }
        }
    }

    private func load() async {
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
              Self.mayCommit(gesturesEnabled: IOSConnectionStatus.of(client).gesturesEnabled,
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
