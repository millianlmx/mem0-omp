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
// Seul l'en-tête est une section groupée native (ios-listes-groupees-natives,
// S-7, décision U-2) : un `Form` non défilant, haut de son contenu mesuré, posé
// au-dessus du fil partagé `IOSSessionThreadView`, qui garde son propre rendu.
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
    @Environment(\.horizontalSizeClass) private var sizeClass
    /// La hauteur du contenu de l'en-tête, relue à chaque mise en page (Dynamic
    /// Type compris). Elle part de trois cibles pour que les rangées soient
    /// rendues — et donc mesurées — dès le premier passage.
    @State private var headerHeight = IOSMetrics.minimumTarget * 3

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
            VStack(spacing: 0) {
                Form {
                    Section {
                        header
                    }
                }
                .formStyle(.grouped)
                .scrollDisabled(true)
                .onScrollGeometryChange(for: CGFloat.self, of: { $0.contentSize.height }) { _, height in
                    headerHeight = height
                }
                .frame(height: headerHeight)
                IOSSessionThreadView(model: model, sessionEnded: model.runEnded)
                    .padding(.horizontal, IOSMetrics.margin(sizeClass))
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle(IOSSessionText.viewerNavigationTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(ConnectionText.close) { dismiss() }
                        .accessibilityIdentifier(IOSSessionsAccessibility.close)
                }
            }
        }
        .iosPageSheet()
        .onAppear { model.start() }
        .onDisappear { model.finish() }
        .onChange(of: client.snapshot) { model.refreshRunStatus() }
        .accessibilityIdentifier(IOSSessionsAccessibility.viewer)
    }

    /// L'en-tête : le titre de la feature (entier, sur autant de lignes qu'il
    /// faut), le sous-titre de la session (l'étape et le dépôt) et l'état de son
    /// run. La barre ne porte que le titre court et statique de la feuille.
    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: model.title)
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier(IOSSessionsAccessibility.viewerTitle)
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
    }
}
