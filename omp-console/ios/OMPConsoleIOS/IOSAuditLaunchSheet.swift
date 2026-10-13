// La feuille « Lancer un audit » de l'app iOS (audit-panel-in-omp-console, S-8,
// BR-5) : le dépôt parmi les dépôts CONNUS de la coque (`IOSRepoRows` sur
// `GET /v1/repos` — le client ne calcule jamais un `repoKey`), puis l'orientation
// sur plusieurs lignes. « Lancer l'audit » n'est actif qu'avec un dépôt choisi et
// une orientation rognée de 1 à 2 000 caractères (S-6).
//
// La feuille ne se ferme que sur succès — l'audit créé est alors poussé ; un échec
// la laisse ouverte avec le message. Échap ou « Annuler » ferment sans rien envoyer.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct IOSAuditLaunchSheet: View {
    @ObservedObject var model: IOSAuditModel

    @Environment(\.dismiss) private var dismiss
    @State private var repos: [RemoteRepoRow] = []
    @State private var loading = true
    @State private var loadFailure: String?
    @State private var selected: String?
    @State private var orientation = ""
    @State private var error: String?
    @State private var submitting = false
    @FocusState private var orientationFocused: Bool

    private var mayStart: Bool {
        IOSAuditModel.mayStart(
            gesturesEnabled: model.gesturesEnabled,
            repoKey: selected,
            orientation: orientation,
            submitting: submitting
        )
    }

    private var tooLong: Bool {
        orientation.trimmingCharacters(in: .whitespacesAndNewlines).count > IOSAuditModel.orientationLimit
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(AuditText.repository) {
                    repositoryList
                }
                Section {
                    TextField(AuditText.orientationPrompt, text: $orientation, axis: .vertical)
                        .lineLimit(IOSMetrics.auditOrientationLines)
                        .focused($orientationFocused)
                        .accessibilityLabel(AuditText.orientation)
                        .accessibilityIdentifier(IOSAuditAccessibility.launchOrientation)
                } header: {
                    Text(AuditText.orientation)
                } footer: {
                    if tooLong {
                        Text(AuditText.orientationTooLong)
                            .foregroundStyle(.red)
                    }
                }
                if let error {
                    Text(error)
                        .font(.callout)
                        .iosBanner(tone: .danger)
                        .accessibilityIdentifier(IOSAuditAccessibility.launchError)
                }
            }
            .navigationTitle(AuditText.launchTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    IOSSheetIconButton(role: .cancel, label: AuditText.cancel) { dismiss() }
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier(IOSAuditAccessibility.launchCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if submitting {
                        ProgressView()
                    } else {
                        IOSSheetIconButton(role: .confirm, label: AuditText.commitLaunch, action: commit)
                            .disabled(!mayStart)
                            .keyboardShortcut(.defaultAction)
                            .accessibilityIdentifier(IOSAuditAccessibility.launchConfirm)
                    }
                }
            }
            .accessibilityIdentifier(IOSAuditAccessibility.launchSheet)
            .task { await load() }
        }
        .interactiveDismissDisabled(submitting)
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
                identifier: IOSAuditAccessibility.launchRepo,
                choose: { selected = $0.repoKey }
            )
        }
    }

    /// Les dépôts connus du Mac ; sous la recette, ceux de la fixture des feuilles
    /// de lancement (aucun réseau).
    private func load() async {
        if model.recipe != nil {
            repos = IOSLaunchRecipe.repos
            loading = false
            return
        }
        loading = true
        loadFailure = nil
        do {
            repos = try await model.client.repos().rows
            if repos.count == 1 { selected = repos[0].repoKey }
        } catch {
            loadFailure = ProjectText.failure(error, state: model.client.state)
        }
        loading = false
    }

    private func commit() {
        guard let repoKey = selected, mayStart else { return }
        submitting = true
        error = nil
        Task {
            let message = await model.start(repoKey: repoKey, orientation: orientation)
            submitting = false
            if let message {
                error = message
            } else {
                dismiss()
            }
        }
    }
}
