import ConsoleClient
import ConsoleCore
import Foundation
import WidgetKit

// Le pont entre l'app et son widget d'écran d'accueil (extension `OMPConsoleWidgets`) :
// à chaque boîte relue, l'instantané de la boîte part dans le groupe d'apps et le
// widget se redessine s'il a changé ; à chaque changement de serveur, l'adresse et le
// jeton y sont copiés (le jeton dans un article de trousseau du groupe), pour que le
// widget relise la boîte lui-même, app fermée. Oublier le serveur les efface.

@MainActor
final class IOSWidgetBridge: ObservableObject {
    private let store = HarnessWidgetStore.fromBundle()
    private var last: HarnessWidgetSnapshot?
    /// L'adresse déjà partagée (`.some(nil)` : partagé « aucun serveur »).
    private var sharedAddress: String??

    func sync(with model: HarnessModel) {
        guard let store, model.isLoaded else { return }
        let snapshot = HarnessWidgetSnapshot(inbox: model.inbox, configured: model.isConfigured)
        if !snapshot.sameContent(as: last) {
            store.save(snapshot)
            last = snapshot
            WidgetCenter.shared.reloadAllTimelines()
        }
        guard sharedAddress != .some(model.address) else { return }
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
