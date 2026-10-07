// La feuille de bienvenue de l'Accueil iOS (S-15) : une seule fois par
// installation neuve, gouvernée par la préférence `home.welcomeSeen` (couture
// `ClientPreferences`). Contenu identique mot pour mot à macOS : le titre, les
// trois promesses et l'unique bouton « Continuer ».
//
// L'illustration de tête est un symbole système (`sparkles`) : le projet iOS n'a
// pas de catalogue d'assets (divergence cosmétique assumée, documentée).

import ConsoleClient
import ConsoleCore
import SwiftUI

struct HomeWelcomeSheet: View {
    @ObservedObject var client: ConsoleClientModel

    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Label(HomeText.welcomeTitle, systemImage: "sparkles")
                        .font(.title2.bold())
                    ForEach(HomeText.welcomePromises, id: \.title) { promise in
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: promise.symbol)
                                .foregroundStyle(.tint)
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
                .padding(IOSMetrics.margin(sizeClass))
            }
            .accessibilityIdentifier(IOSHomeAccessibility.welcomeSheet)
        }
    }
}
