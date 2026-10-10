// Le déroulé unique de la sortie de l'app (mac-quitter-sans-confirmation, S-4).
//
// Tous les chemins de sortie y passent (S-5) : menu ⌘Q, Apple Event de quit (Dock,
// fermeture de session macOS) et toute autre demande à `NSApp.terminate`. Une
// demande prend un instantané des activités, montre AU PLUS une alerte, puis
// lance UNE tâche : accroches de sortie existantes, fermeture des feuilles
// attachées, terminaison redemandée — que `shouldTerminate()` laisse alors passer.
//
// Pas de `.terminateLater` (Doc-4) : AppKit attendrait la réponse dans une boucle
// imbriquée, et une feuille SwiftUI attachée bloquait la sortie (mesuré).

import AppKit

@MainActor
final class QuitFlow {
    enum Phase: Equatable { case idle, asking, quitting, terminating }
    /// Ce que devient la demande : annulée (l'app reste) ou en cours (elle quitte).
    enum Decision: Equatable { case cancelled, proceeding }
    /// Le choix de l'utilisateur dans l'alerte « Quitter arrêtera… » (S-3).
    enum Choice: Equatable { case quit, cancel }

    private(set) var phase: Phase = .idle

    /// L'instantané des activités, lu une fois par demande (S-1).
    var activities: @MainActor () -> [QuitActivity]
    /// L'alerte modale (`QuitAlert.run` dans l'app).
    var confirm: @MainActor (QuitPrompt) -> Choice
    /// Les accroches de sortie existantes, attendues dans leur ordre.
    var runHooks: @MainActor () async -> Void
    /// Ferme les feuilles attachées, qui bloqueraient `NSApp.terminate` (S-6).
    var closeAttachedSheets: @MainActor () -> Void
    /// La terminaison redemandée une fois les accroches passées. Injectable : un
    /// test ne doit pas terminer le process qui l'exécute.
    var requestTermination: @MainActor () -> Void

    init(
        activities: @escaping @MainActor () -> [QuitActivity],
        confirm: @escaping @MainActor (QuitPrompt) -> Choice,
        runHooks: @escaping @MainActor () async -> Void,
        closeAttachedSheets: @escaping @MainActor () -> Void,
        requestTermination: @escaping @MainActor () -> Void
    ) {
        self.activities = activities
        self.confirm = confirm
        self.runHooks = runHooks
        self.closeAttachedSheets = closeAttachedSheets
        self.requestTermination = requestTermination
    }

    /// Demande de sortie. Annuler n'a AUCUN effet de bord et ramène à `.idle` :
    /// la demande suivante reprend un instantané neuf. Une demande pendant
    /// l'alerte est refusée (la décision appartient à l'alerte ouverte) ; une
    /// demande pendant la sortie la rejoint sans relancer les accroches.
    @discardableResult
    func request() -> Decision {
        switch phase {
        case .asking:
            return .cancelled
        case .quitting, .terminating:
            return .proceeding
        case .idle:
            break
        }
        if let prompt = QuitPrompt.make(activities()) {
            phase = .asking
            guard confirm(prompt) == .quit else {
                phase = .idle
                return .cancelled
            }
        }
        phase = .quitting
        Task { @MainActor in
            await self.runHooks()
            self.closeAttachedSheets()
            self.phase = .terminating
            self.requestTermination()
        }
        return .proceeding
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
        case .asking, .quitting:
            return .terminateCancel
        }
    }
}
