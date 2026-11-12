// Le déroulé unique de la sortie de l'app (mac-quitter-sans-confirmation, S-4).
//
// Tous les chemins de sortie y passent (S-5) : menu ⌘Q, Apple Event de quit (Dock,
// fermeture de session macOS) et toute autre demande à `NSApp.terminate`. Rien ne
// s'arrête avec l'app (les agents vivent sur le serveur du VPS) : aucune alerte. Une
// demande lance UNE tâche : fermeture des feuilles attachées, puis terminaison
// redemandée — que `shouldTerminate()` laisse alors passer.
//
// Pas de `.terminateLater` (Doc-4) : AppKit attendrait la réponse dans une boucle
// imbriquée, et une feuille SwiftUI attachée bloquait la sortie (mesuré).

import AppKit

@MainActor
final class QuitFlow {
    enum Phase: Equatable { case idle, quitting, terminating }

    private(set) var phase: Phase = .idle

    /// Ferme les feuilles attachées, qui bloqueraient `NSApp.terminate` (S-6).
    var closeAttachedSheets: @MainActor () -> Void
    /// La terminaison redemandée une fois les feuilles fermées. Injectable : un test ne
    /// doit pas terminer le process qui l'exécute.
    var requestTermination: @MainActor () -> Void

    init(
        closeAttachedSheets: @escaping @MainActor () -> Void,
        requestTermination: @escaping @MainActor () -> Void
    ) {
        self.closeAttachedSheets = closeAttachedSheets
        self.requestTermination = requestTermination
    }

    /// Demande de sortie. Une demande pendant la sortie la rejoint, sans la relancer.
    func request() {
        guard phase == .idle else { return }
        phase = .quitting
        Task { @MainActor in
            self.closeAttachedSheets()
            self.phase = .terminating
            self.requestTermination()
        }
    }

    /// La réponse à `applicationShouldTerminate` : seule la redemande finale
    /// termine ; une demande neuve passe par `request()` et est d'abord annulée.
    func shouldTerminate() -> NSApplication.TerminateReply {
        switch phase {
        case .terminating:
            return .terminateNow
        case .idle:
            request()
            return .terminateCancel
        case .quitting:
            return .terminateCancel
        }
    }
}
