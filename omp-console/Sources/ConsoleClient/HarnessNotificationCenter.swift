// Le pont des notifications vers `UserNotifications`, le même pour l'iPhone et le Mac :
// les catégories et leurs actions (HarnessNotificationRouting), la permission demandée
// après l'appairage, la réponse à une action (le geste part par `HarnessModel.execute`,
// un toucher ouvre l'app à l'endroit dit par `openRequest`) et, sur Mac, les
// notifications LOCALES tirées du flux du serveur quand l'app est en arrière-plan.
//
// L'iPhone reçoit ses alertes du serveur par APNs (omp-harness/push-alerts.ts) ; le
// jeton de l'appareil est enregistré par l'app (`HarnessModel.registerDevice`). Le Mac
// n'a pas d'APNs : tant qu'il tourne, chaque événement du flux qui attend l'humain
// devient une notification locale, avec les mêmes catégories.
//
// Rien ne touche le centre de notifications hors d'une app empaquetée (`.app`) : un
// lanceur de tests ou `swift run` n'en a pas, et le système l'interromprait.

import ConsoleCore
import Foundation
import UserNotifications

@MainActor
public final class HarnessNotificationCenter: NSObject, ObservableObject {
    /// L'endroit de l'app qu'un toucher demande d'ouvrir ; la racine l'exécute puis le remet à `nil`.
    @Published public var openRequest: HarnessPaletteCommand?
    private weak var server: HarnessModel?
    /// Le Mac : poster en local les événements du flux ? (app en arrière-plan) ; `nil` : jamais (iPhone).
    private var postsLocally: (@MainActor () -> Bool)?
    /// Le plus grand événement du flux déjà notifié : un rejeu ne notifie pas deux fois.
    private var lastEventId = 0

    /// L'app tourne empaquetée : le centre de notifications existe pour elle.
    public static var isAvailable: Bool { Bundle.main.bundleURL.pathExtension == "app" }

    override public init() {}

    /// Relie le serveur ; `postsLocally` (Mac) dit quand un événement du flux devient une
    /// notification locale. Pose le délégué et les catégories : à faire au lancement, avant
    /// qu'une notification touchée app fermée ne soit livrée.
    public func attach(_ server: HarnessModel, postsLocally: (@MainActor () -> Bool)? = nil) {
        self.server = server
        self.postsLocally = postsLocally
        if postsLocally != nil {
            server.streamObserver = { [weak self] events in self?.receive(events) }
        }
        guard Self.isAvailable else { return }
        UNUserNotificationCenter.current().delegate = self
        refreshCategories()
    }

    /// Redéclare les catégories : leurs actions dépendent du jeton (approbateur ou non).
    public func refreshCategories() {
        guard Self.isAvailable else { return }
        let approver = server?.client?.approver ?? false
        let categories = HarnessNotificationCategory.allCases.map { category in
            UNNotificationCategory(
                identifier: category.rawValue,
                actions: HarnessNotificationRouting.actions(for: category, approver: approver).map(Self.systemAction),
                intentIdentifiers: [],
                options: []
            )
        }
        UNUserNotificationCenter.current().setNotificationCategories(Set(categories))
    }

    /// Demande la permission de notifier (le système ne la demande qu'une fois) ; `true` si elle est donnée.
    public func requestAuthorization() async -> Bool {
        guard Self.isAvailable else { return false }
        return (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    private static func systemAction(_ spec: HarnessNotificationActionSpec) -> UNNotificationAction {
        var options: UNNotificationActionOptions = []
        if spec.authenticationRequired { options.insert(.authenticationRequired) }
        if spec.foreground { options.insert(.foreground) }
        if spec.destructive { options.insert(.destructive) }
        guard spec.textInput else {
            return UNNotificationAction(identifier: spec.action.rawValue, title: spec.title, options: options)
        }
        return UNTextInputNotificationAction(
            identifier: spec.action.rawValue, title: spec.title, options: options,
            textInputButtonTitle: spec.submitTitle ?? spec.title, textInputPlaceholder: spec.placeholder ?? ""
        )
    }

    // MARK: - Mac : le flux devient des notifications locales

    private func receive(_ events: [HarnessStreamEvent]) {
        guard let server, postsLocally?() == true, Self.isAvailable else { return }
        for event in events {
            guard let local = HarnessNotificationRouting.localAlert(for: event, client: server.client),
                  local.eventId > lastEventId
            else { continue }
            lastEventId = local.eventId
            let content = UNMutableNotificationContent()
            content.title = local.title
            content.body = local.body(runTitle: local.alert.runId.flatMap { server.knownRun($0)?.title })
            content.sound = .default
            content.categoryIdentifier = local.category.rawValue
            content.threadIdentifier = local.thread
            content.userInfo = local.alert.userInfo
            UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: "omp.event.\(local.eventId)", content: content, trigger: nil)
            )
        }
    }

    // MARK: - Réponse à une notification

    private func respond(category: String, action: HarnessNotificationAction?, alert: HarnessPushAlert?, text: String?) async {
        guard let server else { return }
        // Une action app fermée : le serveur, le jeton et le client (`/v1/me`) d'abord.
        await server.load()
        let gesture = HarnessNotificationRouting.gesture(
            category: category, action: action, alert: alert, text: text, approver: server.client?.approver ?? false
        )
        if case let .open(destination) = gesture {
            openRequest = destination
            return
        }
        guard await !server.execute(gesture), let alert else { return }
        await Self.notifyGestureFailed(alert)
    }

    /// Un geste fait hors de l'app (action d'une notification, bouton d'une Live Activity)
    /// que le serveur a refusé (révision périmée, droits) : rien n'est tranché, et l'humain
    /// le sait par une notification locale, qui ouvre l'app là où le geste se fait.
    public static func notifyGestureFailed(_ alert: HarnessPushAlert) async {
        guard isAvailable else { return }
        let content = UNMutableNotificationContent()
        content.title = NotificationText.gestureFailed
        content.body = NotificationText.gestureFailedBody
        content.categoryIdentifier = HarnessNotificationCategory.open.rawValue
        content.userInfo = alert.userInfo
        try? await UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: "omp.failed.\(UUID().uuidString)", content: content, trigger: nil)
        )
    }
}

extension HarnessNotificationCenter: UNUserNotificationCenterDelegate {
    /// App au premier plan : la notification se montre quand même (bannière et liste).
    public nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    public nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
    ) async {
        guard response.actionIdentifier != UNNotificationDismissActionIdentifier else { return }
        let content = response.notification.request.content
        let category = content.categoryIdentifier
        let alert = HarnessPushAlert(userInfo: content.userInfo)
        let action = HarnessNotificationAction(rawValue: response.actionIdentifier)
        let text = (response as? UNTextInputNotificationResponse)?.userText
        await respond(category: category, action: action, alert: alert, text: text)
    }
}
