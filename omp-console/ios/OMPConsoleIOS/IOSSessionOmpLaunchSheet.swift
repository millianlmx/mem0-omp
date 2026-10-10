// La feuille « Lancer une session OMP » de l'app iOS (BR-5, S-1) : la liste des
// dépôts CONNUS de la coque, chacun avec son nom et son chemin. Le client ne
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
    /// Rend `nil` sur succès, sinon le message d'échec à afficher DANS la feuille.
    let onLaunch: (String) async -> String?

    @Environment(\.dismiss) private var dismiss
    @State private var repos: [RemoteRepoRow] = []
    @State private var loading = true
    @State private var loadFailure: String?
    @State private var selected: String?
    @State private var error: String?
    @State private var submitting = false

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
            .navigationTitle(IOSSessionOmpText.launchSheetTitle)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(SessionConsoleText.cancel) { dismiss() }
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier(SessionOmpAccessibility.launchCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(SessionConsoleText.launch, action: commit)
                        .disabled(!IOSConnectionStatus.of(client).gesturesEnabled || selected == nil || submitting)
                        .keyboardShortcut(.defaultAction)
                        .accessibilityIdentifier(SessionOmpAccessibility.launchCommit)
                }
            }
            .accessibilityIdentifier(SessionOmpAccessibility.launchSheet)
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
                .accessibilityIdentifier(SessionOmpAccessibility.launchRepositories)
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
                .accessibilityIdentifier(SessionOmpAccessibility.launchRepo(repo.repoKey))
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
