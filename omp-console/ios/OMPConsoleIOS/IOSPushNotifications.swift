import ConsoleClient
import UIKit

// Les alertes push de l'iPhone (APNs) : après l'appairage, l'app demande la permission
// de notifier, puis l'enregistrement de l'appareil auprès d'Apple ; le jeton que rend
// le système part au serveur relié (`HarnessModel.registerDevice`, passerelle lue dans
// le profil embarqué : `HarnessPushEnvironment.current`), qui y pousse ce qui attend
// l'humain. Les catégories, leurs gestes et la réponse aux actions vivent dans
// ConsoleClient (`HarnessNotificationCenter`), les mêmes que sur Mac.

/// Le délégué d'application : le système y rend le jeton APNs de l'appareil.
@MainActor
final class IOSAppDelegate: NSObject, UIApplicationDelegate, ObservableObject {
    /// Le jeton de l'appareil, tel que le système le rend.
    @Published private(set) var deviceToken: Data?

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        self.deviceToken = deviceToken
    }

    /// Simulateur, ou capacité Push Notifications absente du profil : pas d'alerte push,
    /// le reste de l'app ne change pas.
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {}
}

enum IOSPush {
    /// Un serveur relié : la permission (demandée une seule fois par le système), puis
    /// l'enregistrement auprès d'Apple. Sans permission, rien ne s'enregistre.
    @MainActor
    static func enable(_ notifications: HarnessNotificationCenter) async {
        guard await notifications.requestAuthorization() else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }
}
