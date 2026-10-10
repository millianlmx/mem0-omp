// Le composant d'état de connexion PARTAGÉ par les sept sections (feature
// etats-non-connecte-heterogenes-ios, S-2, S-3, S-4) : une seule vue, deux
// statuts (« non connecté » avec sa cause, « connexion en cours ») et deux formes
// (plein écran quand la section n'a rien chargé, bandeau au-dessus des données
// conservées). Une section n'en rend qu'UNE instance : les deux statuts ne
// coexistent jamais.
//
// Les mots viennent de `IOSConnectionStateText`. Aucune taille de police fixe,
// aucun `lineLimit` : les textes se replient en Dynamic Type maximum. Le ton ne
// fait que doubler le mot.

import ConsoleClient
import SwiftUI

/// La forme du composant : plein écran (rien chargé) ou bandeau (données
/// conservées).
enum IOSConnectionStateLayout: Equatable {
    case screen
    case banner
}

struct IOSConnectionStateView: View {
    /// Jamais `.connected` : l'appelant ne rend la vue que hors connexion.
    let status: IOSConnectionStatus
    let layout: IOSConnectionStateLayout
    /// Ouvre la feuille Connexion de la racine.
    let onConnect: () -> Void

    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        switch status {
        case .connected:
            EmptyView()
        case .connecting:
            switch layout {
            case .screen: connectingScreen
            case .banner: connectingBanner
            }
        case .disconnected(let cause):
            switch layout {
            case .screen: offlineScreen(cause)
            case .banner: offlineBanner(cause)
            }
        }
    }

    // MARK: - « non connecté »

    private func offlineScreen(_ cause: IOSDisconnectCause) -> some View {
        ContentUnavailableView {
            Label(IOSConnectionStateText.title, systemImage: "wifi.slash")
                .accessibilityIdentifier(IOSConnectionStateAccessibility.title)
        } description: {
            Text(IOSConnectionStateText.cause(cause))
                .accessibilityIdentifier(IOSConnectionStateAccessibility.cause)
        } actions: {
            connectButton
                .buttonStyle(.borderedProminent)
        }
        .padding(IOSMetrics.margin(sizeClass))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSConnectionStateAccessibility.offlineScreen)
    }

    /// Le patron bandeau puis bouton de la Mémoire et des Statistiques : le
    /// message teinté, puis « Se connecter » hors de la teinte.
    private func offlineBanner(_ cause: IOSDisconnectCause) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Label(IOSConnectionStateText.title, systemImage: "wifi.slash")
                    .font(.headline)
                Text(IOSConnectionStateText.cause(cause))
                    .font(.callout)
            }
            .iosBanner(tone: .attention)
            .accessibilityIdentifier(IOSConnectionStateAccessibility.message)
            connectButton
                .buttonStyle(.bordered)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSConnectionStateAccessibility.offlineBanner)
    }

    /// « Se connecter », la même cible dans les deux formes : le cadre de 44 pt
    /// est porté par le LIBELLÉ, donc par le cadre d'accessibilité du bouton
    /// (accessibilite-et-localisation-ios-residu, S-4).
    private var connectButton: some View {
        Button { onConnect() } label: {
            Text(IOSConnectionStateText.connect)
                .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget)
                .contentShape(Rectangle())
        }
        .accessibilityIdentifier(IOSConnectionStateAccessibility.connect)
    }

    // MARK: - « connexion en cours » (aucun bouton)

    private var connectingScreen: some View {
        ContentUnavailableView {
            Label(IOSConnectionStateText.connectingTitle, systemImage: "wifi")
        } description: {
            ProgressView()
                .accessibilityLabel(IOSConnectionStateText.connectingTitle)
                .accessibilityIdentifier(IOSConnectionStateAccessibility.progress)
        }
        .padding(IOSMetrics.margin(sizeClass))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSConnectionStateAccessibility.connectingScreen)
    }

    private var connectingBanner: some View {
        HStack(spacing: 8) {
            ProgressView()
            Text(IOSConnectionStateText.connectingTitle)
                .font(.headline)
        }
        .iosBanner(tone: .info)
        .accessibilityIdentifier(IOSConnectionStateAccessibility.connectingBanner)
    }
}

extension View {
    /// Lance `perform` quand le statut présenté du client PASSE à `.connected`
    /// (relecture au retour du Mac, S-4) — jamais au premier rendu.
    @MainActor
    func onMacReconnected(_ client: ConsoleClientModel, perform: @escaping () -> Void) -> some View {
        onChange(of: IOSConnectionStatus.of(client) == .connected) { old, new in
            if !old && new { perform() }
        }
    }
}
