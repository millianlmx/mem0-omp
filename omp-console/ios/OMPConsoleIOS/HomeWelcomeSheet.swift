// La feuille de bienvenue de l'Accueil iOS (S-15) : une seule fois par
// installation neuve, gouvernée par la préférence `home.welcomeSeen` (couture
// `ClientPreferences`). Contenu identique mot pour mot à macOS : le titre, les
// trois promesses et l'unique bouton « Continuer ».
//
// Le titre est porté par la barre, en ligne (feuilles-ios-presentation-et-depots,
// S-2) ; sur iPad, la feuille épouse la hauteur de son contenu (S-1). Les icônes
// des promesses occupent une colonne de largeur fixe, mise à l'échelle avec
// `.title2` : les textes commencent tous au même x (S-5). Toute fermeture
// (bouton ou balayage) enregistre la bienvenue comme vue : RootView le fait dans
// l'`onDismiss` de la feuille.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct HomeWelcomeSheet: View {
    @ObservedObject var client: ConsoleClientModel

    @Environment(\.dismiss) private var dismiss
    /// La hauteur mesurée du contenu défilant : la hauteur de la feuille ajustée
    /// sur iPad (0 tant qu'elle n'est pas mesurée).
    @State private var contentHeight: CGFloat = 0
    /// La colonne des icônes de promesse, à l'échelle de `.title2` (Dynamic Type).
    @ScaledMetric(relativeTo: .title2) private var iconWidth: CGFloat = IOSMetrics.welcomeIconWidth

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    ForEach(HomeText.welcomePromises, id: \.title) { promise in
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: promise.symbol)
                                .font(.title2)
                                .foregroundStyle(.tint)
                                .accessibilityHidden(true)
                                .frame(width: iconWidth)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(promise.title).font(.headline)
                                Text(promise.detail).font(.callout).foregroundStyle(.secondary)
                            }
                        }
                    }
                    Button(HomeText.welcomeContinue) {
                        client.closeWelcome()
                        dismiss()
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier(IOSHomeAccessibility.welcomeContinue)
                }
                .iosPanel()
            }
            .iosSheetContentHeight($contentHeight)
            .accessibilityIdentifier(IOSHomeAccessibility.welcomeSheet)
            .navigationTitle(HomeText.welcomeTitle)
            .navigationBarTitleDisplayMode(.inline)
        }
        .iosFittedSheet(contentHeight: contentHeight)
    }
}
