// La feuille d'une session (S-3..S-9) : le titre et le sous-titre de la session,
// l'état de son run, la sortie, et le fil réutilisable.
//
// Deux entrées, un seul corps :
//   — `init(client:choice:)` ouvre la session d'un run de la liste, et c'est
//     l'INSTANTANÉ du client qui porte l'état du run (S-9 : « En cours » devient
//     « Terminé » sans rouvrir la session) ;
//   — `init(client:recipe:)` ouvre la session de la RECETTE, montée depuis la
//     fixture partagée `SessionParity` — jamais un écran fabriqué.
//
// Le client reste observé dans les deux cas : c'est lui qui déclenche la relecture
// de l'état du run. La feuille ne sait rien de plus : elle compose le fil.
//
// Aucun littéral alphabétique (les mots viennent d'`IOSSessionText`,
// `ConnectionText` ou du noyau) ; aucun type de la section Sessions (S-10).

import ConsoleClient
import ConsoleCore
import SwiftUI

struct IOSSessionViewerSheet: View {
    @ObservedObject var client: ConsoleClientModel
    @StateObject private var model: IOSSessionThreadModel
    @Environment(\.dismiss) private var dismiss

    /// La feuille d'un run de la liste.
    init(client: ConsoleClientModel, choice: RunChoice) {
        self.client = client
        _model = StateObject(
            wrappedValue: IOSSessionThreadModel(
                source: client,
                file: choice.sessionFile,
                title: choice.featureTitle,
                subtitle: choice.target.subtitle,
                tracksRun: true
            )
        )
    }

    /// La feuille d'une RECETTE : la source est la fixture partagée, le client
    /// reste observé (mais un run de recette n'y figure pas).
    init(client: ConsoleClientModel, recipe thread: IOSSessionsRecipeThread) {
        self.client = client
        _model = StateObject(
            wrappedValue: IOSSessionThreadModel(
                source: IOSSessionsRecipeSource(thread: thread),
                file: thread.file,
                title: thread.title,
                subtitle: thread.subtitle,
                tracksRun: true
            )
        )
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                header
                IOSSessionThreadView(model: model)
            }
            .iosPanel()
            .navigationTitle(model.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(ConnectionText.close) { dismiss() }
                        .accessibilityIdentifier(IOSSessionsAccessibility.close)
                }
            }
        }
        .onAppear { model.start() }
        .onDisappear { model.finish() }
        .onChange(of: client.snapshot) { model.refreshRunStatus() }
        .accessibilityIdentifier(IOSSessionsAccessibility.viewer)
    }

    /// L'en-tête : le sous-titre de la session (l'étape et le dépôt) et l'état de
    /// son run. Le titre est porté par la barre de navigation.
    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let subtitle = model.subtitle {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let status = model.runStatus {
                IOSStatusChip(status: status)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .iosCard()
    }
}
