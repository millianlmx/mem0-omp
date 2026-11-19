// Le toucher d'une notification (ou son action « Ouvrir ») ouvre l'app à l'endroit
// qu'elle désigne — ce qui attend sur l'Accueil, le Poste, ou la feature — par la même
// exécution que la palette (`ConsolePaletteActions`), écrite une fois pour le Mac et
// l'iPhone/iPad.

import ConsoleClient
import ConsoleCore
import SwiftUI

extension View {
    /// Pose, sous la racine d'une app, l'ouverture demandée par une notification ;
    /// `select` montre une section.
    public func consoleNotificationRoutes(
        _ notifications: HarnessNotificationCenter, server: HarnessModel, drafts: HarnessDrafts,
        select: @escaping @MainActor (ConsoleSection) -> Void
    ) -> some View {
        modifier(NotificationRoutes(notifications: notifications, server: server, drafts: drafts, select: select))
    }
}

private struct NotificationRoutes: ViewModifier {
    @ObservedObject var notifications: HarnessNotificationCenter
    let server: HarnessModel
    let drafts: HarnessDrafts
    let select: @MainActor (ConsoleSection) -> Void

    func body(content: Content) -> some View {
        // `initial` : une notification touchée app fermée arrive avant la première vue.
        content.onChange(of: notifications.openRequest, initial: true) { _, request in
            guard let request else { return }
            notifications.openRequest = nil
            ConsolePaletteActions.perform(request, server: server, drafts: drafts, select: select)
        }
    }
}
