// La feuille de bienvenue de l'Accueil iOS (S-15) : une seule fois par
// installation neuve, gouvernée par la préférence `home.welcomeSeen` (couture
// `ClientPreferences`). Contenu identique mot pour mot à macOS : le titre, les
// trois promesses et l'unique bouton « Continuer ».
//
// Style Apple (S-1 d'ios-onboarding-et-connexion) : page sans barre de
// navigation, grand titre centré DANS le contenu, promesses à grande icône sans
// panneau, « Continuer » pleine largeur ancré en bas hors de la zone défilante
// (`safeAreaInset`) : aux tailles d'accessibilité, le contenu défile au-dessus du
// bouton, qui reste à l'écran. Les icônes occupent une colonne de largeur fixe,
// mise à l'échelle avec `.largeTitle` : les textes commencent tous au même x.
// Sur iPad, la feuille garde la taille par défaut (formulaire).
//
// Une seule feuille (S-2) : « Continuer » enregistre la bienvenue comme vue puis
// POUSSE la Connexion dans la même pile (`ConnectionForm`, sortie « Plus tard »),
// sauf pour un appareil appairé, où la feuille se ferme. La fermeture passe
// TOUJOURS par `onFinish`, fournie par RootView (qui possède `showWelcome`) :
// dans la vue poussée, `dismiss()` dépilerait l'écran au lieu de fermer la
// feuille. Toute fermeture (bouton, balayage, appairage réussi) aboutit à
// l'`onDismiss` de RootView.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct HomeWelcomeSheet: View {
    @ObservedObject var client: ConsoleClientModel
    /// Ferme la feuille : « Plus tard », appairage réussi, « Continuer » d'un
    /// appareil appairé.
    let onFinish: () -> Void

    @Environment(\.horizontalSizeClass) private var sizeClass
    /// Vrai quand la Connexion est poussée dans la feuille ; le retour système le
    /// remet à faux.
    @State private var showsConnection = false
    /// La colonne des icônes de promesse, à l'échelle de `.largeTitle` (Dynamic Type).
    @ScaledMetric(relativeTo: .largeTitle) private var iconWidth: CGFloat = IOSMetrics.welcomeIconWidth

    var body: some View {
        NavigationStack {
            page
                .navigationDestination(isPresented: $showsConnection) {
                    ConnectionForm(model: client, exit: .later(onFinish), onPaired: onFinish)
                }
        }
    }

    private var page: some View {
        ScrollView {
            VStack(spacing: IOSMetrics.welcomeTitleSpacing) {
                Text(HomeText.welcomeTitle)
                    .font(.largeTitle)
                    .bold()
                    .multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                VStack(alignment: .leading, spacing: IOSMetrics.welcomeRowSpacing) {
                    ForEach(HomeText.welcomePromises, id: \.title) { promise in
                        promiseRow(promise)
                    }
                }
            }
            .padding(.horizontal, IOSMetrics.margin(sizeClass))
            .padding(.top, IOSMetrics.welcomeTopPadding)
            .iosReadableWidth()
        }
        .accessibilityIdentifier(IOSHomeAccessibility.welcomeSheet)
        .toolbarVisibility(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            continueBar
        }
    }

    private func promiseRow(_ promise: HomePromise) -> some View {
        HStack(alignment: .top, spacing: 16) {
            Image(systemName: promise.symbol)
                .font(.largeTitle)
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
                .frame(width: iconWidth)
            VStack(alignment: .leading, spacing: 4) {
                Text(promise.title).font(.headline)
                Text(promise.detail).font(.body).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var continueBar: some View {
        VStack {
            Button {
                continueTapped()
            } label: {
                Text(HomeText.welcomeContinue).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .keyboardShortcut(.defaultAction)
            .accessibilityIdentifier(IOSHomeAccessibility.welcomeContinue)
        }
        .padding(.horizontal, IOSMetrics.margin(sizeClass))
        .padding(.vertical, 16)
        .iosReadableWidth()
        .frame(maxWidth: .infinity)
        .background(.bar)
    }

    /// Enregistre la bienvenue comme vue AVANT de pousser la Connexion : l'app
    /// tuée sur l'écran Connexion ne la remontre pas au lancement suivant.
    private func continueTapped() {
        client.closeWelcome()
        switch IOSHomeContent.welcomeContinuation(pairing: client.pairing) {
        case .showConnection:
            showsConnection = true
        case .finish:
            onFinish()
        }
    }
}
