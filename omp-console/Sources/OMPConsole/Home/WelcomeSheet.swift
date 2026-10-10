// La feuille « Bienvenue » (S-5 de omp-console-redesign) : une page, l'icône de
// l'app, trois promesses et UN bouton « Continuer » (style « Nouveautés » d'Apple :
// large et centré). ↩ et Échap la ferment tous deux. Montrée au premier lancement
// d'une installation neuve, puis seulement sur demande (Aide ▸ « Bienvenue dans
// OMP Console », HIG Onboarding). La politique `MainSheetPolicy` la présente ;
// aucun `@State` : l'état vit dans `HomeModel`.

import AppKit
import ConsoleCore
import SwiftUI

struct WelcomeSheet: View {
    @ObservedObject var home: HomeModel

    var body: some View {
        VStack(spacing: 20) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 96, height: 96)
                .accessibilityHidden(true)
            Text(HomeText.welcomeTitle)
                .font(.largeTitle.bold())
                .multilineTextAlignment(.center)
            VStack(alignment: .leading, spacing: 14) {
                ForEach(HomeText.welcomePromises, id: \.symbol) { promise in
                    HStack(alignment: .top, spacing: 14) {
                        Image(systemName: promise.symbol)
                            .font(.title2)
                            .foregroundStyle(Color.accentColor)
                            .frame(width: 32)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(promise.title).font(.headline)
                            Text(promise.detail)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button { home.closeWelcome() } label: {
                Text(HomeText.welcomeContinue).frame(maxWidth: .infinity)
            }
            .controlSize(.extraLarge)
            .keyboardShortcut(.defaultAction)
            .accessibilityIdentifier("welcome.continue")
        }
        .padding(28)
        .frame(width: 480)
        // Échap ferme aussi (convention des feuilles du dépôt) : la feuille n'a
        // qu'UN bouton visible, le défaut.
        .onExitCommand { home.closeWelcome() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("welcome.sheet")
    }
}
