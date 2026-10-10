// Le panneau Réglages de l'app (scène SwiftUI `Settings`, ⌘,) : un seul onglet,
// « Appareils » — l'accès depuis l'iPhone et l'iPad, le code d'appairage et les
// appareils appairés. SwiftUI titre la fenêtre du nom de l'onglet affiché.

import SwiftUI

struct ConsoleSettingsView: View {
    @ObservedObject var remote: RemoteServiceModel

    var body: some View {
        TabView {
            Tab(PairingText.devicesTab, systemImage: PairingText.devicesTabSymbol) {
                DevicesSettingsView(remote: remote, pairing: remote.pairing, registry: remote.registry)
            }
        }
    }
}
