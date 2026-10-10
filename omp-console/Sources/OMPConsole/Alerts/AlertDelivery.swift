// Livraison des notifications, autorisation, et réception du clic (BR-2, S-8 ;
// notifications-mac-lien-profond S-3).
//
// SEUL fichier du dépôt qui importe `UserNotifications` : mesuré (Doc-3), le premier
// appel à `UNUserNotificationCenter` dans un processus NON bundle tue le process sur
// une exception Objective-C non rattrapable (`mainBundle.bundleURL` n'a pas
// l'extension `app`). Toute la suite de tests mourrait si un autre fichier y
// touchait, donc la garde d'instanciation est ici, et nulle part ailleurs — le
// récepteur de clics (`AlertOpenReceiver`, délégué du centre) compris.
//
// `@preconcurrency import` (Doc-10) : les closures de complétion de UserNotifications
// ne sont pas annotées `Sendable` vis-à-vis de Swift 6 ; l'import les traite en
// avertissements, et l'API est exposée en façade `async` pour qu'aucune closure C ne
// traverse une frontière d'isolation.

import Foundation
import Synchronization
@preconcurrency import UserNotifications

/// L'état d'autorisation, tel que l'app le publie (S-8).
enum AlertAuthorization: String, Sendable {
    case unknown
    case authorized
    case denied
    /// Processus NON bundle : aucune API UserNotifications n'est appelable (Doc-3).
    case unavailable
}

/// Le message remis à un livreur : la clé sert d'identifiant de requête (une même
/// clé ré-`add` irait s'écraser, mais S-7 empêche déjà la seconde livraison) ;
/// `opening` est la destination du clic (famille + carte).
struct AlertMessage: Sendable, Equatable {
    var key: String
    var title: String
    var body: String
    var opening: AlertOpening
}

/// Le résultat d'une livraison — `delivered`, ou l'échec nommé. Un échec n'est PAS
/// une erreur applicative (l'autorisation peut être accordée en cours de session,
/// Doc-4).
enum AlertDeliveryOutcome: Sendable, Equatable {
    case delivered
    case failed(String)
}

/// Le contrat d'un livreur : façade `async` injectable. Les tests fournissent un
/// enregistreur ; la production, `AlertDeliverer.live()`.
protocol AlertDelivering: Sendable {
    /// Relit le statut SANS nouvelle demande (S-8 : relecture à l'activation).
    func authorization() async -> AlertAuthorization
    /// Demande l'autorisation PUIS relit le statut (S-8, au démarrage).
    func requestAuthorization() async -> AlertAuthorization
    func deliver(_ message: AlertMessage) async -> AlertDeliveryOutcome
    /// Confie le traitement des clics : `handler` reçoit, sur le `MainActor`, la
    /// destination décodée du payload (`nil` : payload absent ou illisible).
    func observeOpenings(_ handler: @escaping @MainActor @Sendable (AlertOpening?) -> Void)
}

/// Le délégué du centre de notifications : il ne traite que le clic sur la
/// bannière ou sur l'entrée du Centre de notifications (Doc-3). `willPresent`
/// n'est pas déclaré : `AlertsModel` ne livre jamais quand l'app est active.
final class AlertOpenReceiver: NSObject, UNUserNotificationCenterDelegate, Sendable {
    private let handler = Mutex<(@MainActor @Sendable (AlertOpening?) -> Void)?>(nil)

    func observe(_ handler: @escaping @MainActor @Sendable (AlertOpening?) -> Void) {
        self.handler.withLock { $0 = handler }
    }

    /// Seule l'action par défaut (le clic) route ; le `completionHandler` est
    /// appelé dans TOUS les cas (Doc-3). Le payload, non `Sendable`, est décodé
    /// AVANT le saut vers le `MainActor`.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping @Sendable () -> Void
    ) {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let handler = handler.withLock({ $0 })
        else {
            completionHandler()
            return
        }
        let opening = AlertOpening(userInfo: response.notification.request.content.userInfo)
        Task { @MainActor in
            handler(opening)
            completionHandler()
        }
    }
}

/// Le livreur réel : le seul à parler à `UNUserNotificationCenter`.
final class SystemAlertDeliverer: AlertDelivering {
    /// Retenu ici : la référence `delegate` du centre est FAIBLE (Doc-2).
    private let receiver = AlertOpenReceiver()

    func authorization() async -> AlertAuthorization {
        await withCheckedContinuation { continuation in
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                continuation.resume(returning: Self.projection(of: settings.authorizationStatus))
            }
        }
    }

    /// `requestAuthorization` ne présente le dialogue qu'UNE fois par app (Doc-1) ;
    /// le statut est relu juste après, quel que soit le résultat de la demande.
    func requestAuthorization() async -> AlertAuthorization {
        await withCheckedContinuation { continuation in
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert]) { _, _ in
                continuation.resume()
            }
        }
        return await authorization()
    }

    func deliver(_ message: AlertMessage) async -> AlertDeliveryOutcome {
        let content = UNMutableNotificationContent()
        content.title = message.title
        content.body = message.body
        content.userInfo = message.opening.userInfo
        let request = UNNotificationRequest(identifier: message.key, content: content, trigger: nil)
        return await withCheckedContinuation { continuation in
            UNUserNotificationCenter.current().add(request) { error in
                continuation.resume(returning: error.map { .failed($0.localizedDescription) } ?? .delivered)
            }
        }
    }

    func observeOpenings(_ handler: @escaping @MainActor @Sendable (AlertOpening?) -> Void) {
        receiver.observe(handler)
        UNUserNotificationCenter.current().delegate = receiver
    }

    /// La projection du statut système vers l'état de l'app (S-8) : `authorized`,
    /// `provisional` et `ephemeral` valent autorisé ; tout autre cas vaut `unknown`.
    static func projection(of status: UNAuthorizationStatus) -> AlertAuthorization {
        switch status {
        case .authorized, .provisional, .ephemeral: .authorized
        case .denied: .denied
        case .notDetermined: .unknown
        @unknown default: .unknown
        }
    }
}

/// Le livreur des processus NON bundle : un no-op qui n'appelle jamais
/// UserNotifications (Doc-3) et annonce son état `unavailable`.
struct UnavailableAlertDeliverer: AlertDelivering {
    func authorization() async -> AlertAuthorization { .unavailable }
    func requestAuthorization() async -> AlertAuthorization { .unavailable }
    func deliver(_ message: AlertMessage) async -> AlertDeliveryOutcome {
        .failed("Notifications indisponibles hors d'un bundle .app")
    }
    /// Aucun délégué : aucun appel UserNotifications hors bundle (Doc-7).
    func observeOpenings(_ handler: @escaping @MainActor @Sendable (AlertOpening?) -> Void) {}
}

enum AlertDeliverer {
    /// Le livreur adapté au processus : le réel SEULEMENT dans un bundle `.app`
    /// (garde MESURÉE, Doc-3), le no-op partout ailleurs.
    static func live() -> AlertDelivering {
        Bundle.main.bundleURL.pathExtension == "app" ? SystemAlertDeliverer() : UnavailableAlertDeliverer()
    }
}
