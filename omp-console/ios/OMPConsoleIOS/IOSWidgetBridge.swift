import ConsoleClient
import ConsoleCore
import Foundation
import WidgetKit

// Le pont entre l'app et ce qui vit hors d'elle (le widget d'écran d'accueil, le bouton
// « Valider » d'une Live Activity) : à chaque boîte relue, l'instantané de la boîte part
// dans le groupe d'apps et le widget se redessine s'il a changé ; à chaque changement de
// serveur, l'adresse et le jeton y sont copiés (le jeton dans un article de trousseau du
// groupe), pour que le widget relise la boîte lui-même, app fermée, et que « Valider »
// agisse sur le même serveur. Un serveur relié mais injoignable se partage aussi : ce
// qui agit hors de l'app échoue alors pour la vraie cause. Oublier le serveur les efface.

@MainActor
final class IOSWidgetBridge: ObservableObject {
    private let store = HarnessWidgetStore.fromBundle()
    private var last: HarnessWidgetSnapshot?
    /// L'adresse déjà partagée (`.some(nil)` : partagé « aucun serveur »).
    private var sharedAddress: String??

    func sync(with model: HarnessModel) {
        guard let store else { return }
        if model.isLoaded {
            let snapshot = HarnessWidgetSnapshot(inbox: model.inbox, configured: model.isConfigured)
            if !snapshot.sameContent(as: last) {
                store.save(snapshot)
                last = snapshot
                WidgetCenter.shared.reloadAllTimelines()
            }
        }
        // Avant la fin du chargement, seul un serveur déjà connu se partage : « aucun
        // serveur » ne s'écrit qu'une fois le réglage lu.
        guard model.isLoaded || model.isConfigured, sharedAddress != .some(model.address) else { return }
        sharedAddress = .some(model.address)
        let address = model.address
        Task {
            store.saveAddress(address)
            let shared = store.tokens
            if address != nil,
               let token = try? await KeychainTokenStore(service: HarnessModel.keychainService).token(for: HarnessModel.tokenAccount) {
                try? await shared.save(token, for: HarnessWidgetStore.tokenAccount)
            } else {
                try? await shared.remove(deviceId: HarnessWidgetStore.tokenAccount)
            }
            WidgetCenter.shared.reloadAllTimelines()
        }
    }
}
