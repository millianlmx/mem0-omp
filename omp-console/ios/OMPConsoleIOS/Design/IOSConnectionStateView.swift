// Le composant d'état de la mémoire du serveur (feature
// etats-non-connecte-heterogenes-ios, S-2, S-3, S-4) : une seule vue, deux
// statuts (« mémoire non reliée » avec sa cause, « lecture des réglages ») et deux
// formes (plein écran quand rien n'est chargé, bandeau au-dessus des données
// conservées). L'écran n'en rend qu'UNE instance : les deux statuts ne coexistent
// jamais.
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
    /// Ouvre la feuille Serveur de la racine (le code d'appairage).
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

    /// Le patron bandeau puis bouton : le message teinté, puis « Relier le
    /// serveur » hors de la teinte.
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

    /// « Relier le serveur », la même cible dans les deux formes : le cadre de 44 pt
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
    /// Lance `perform` quand la mémoire DEVIENT reliée (un code d'appairage vient
    /// d'être collé, S-4) — jamais au premier rendu.
    @MainActor
    func onMemoryConfigured(_ memory: MemoryAccess, perform: @escaping () -> Void) -> some View {
        onChange(of: memory.isConfigured) { old, new in
            if !old && new { perform() }
        }
    }
}
