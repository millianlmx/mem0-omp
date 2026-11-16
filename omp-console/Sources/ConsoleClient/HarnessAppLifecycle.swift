// Le cycle de vie de l'app iOS pour ses flux et ses lectures partagés. `ConsoleClient` n'importe
// pas SwiftUI : l'app traduit sa `ScenePhase` en `HarnessAppPhase`.
//
// Deux niveaux : la phase AGRÉGÉE de l'app (lue par l'`App`) pilote ce que toutes les fenêtres
// partagent — le flux de la boîte, le direct suivi, les lectures de `HarnessModel` ; la phase de
// CHAQUE fenêtre ne pilote que son pouls (`OSPulse.phaseChanged`).

import Foundation

/// La phase d'une scène ou de l'app, traduite par l'app.
public enum HarnessAppPhase: Sendable, Equatable {
    case active
    case inactive
    case background
}

@MainActor
public final class HarnessAppLifecycle {
    /// L'app a quitté le premier plan : le prochain `.active` est un retour. Sans cet état, `.inactive`
    /// puis `.active` (Centre de contrôle, bannière, Face ID) se confondrait avec un retour d'arrière-plan,
    /// qui passe lui aussi par `.inactive`.
    private var inBackground = false
    private var returning: Task<Void, Never>?

    public init() {}

    /// Reçoit la phase AGRÉGÉE de l'app. Rend la tâche du retour (lectures et réouverture des flux),
    /// sinon `nil`.
    @discardableResult
    public func phaseChanged(to phase: HarnessAppPhase, harness: HarnessModel) -> Task<Void, Never>? {
        switch phase {
        case .background:
            guard !inBackground else { return nil }
            inBackground = true
            returning?.cancel()
            returning = nil
            harness.suspendStreams()
            return nil
        case .inactive:
            return nil
        case .active:
            guard inBackground else { return nil }
            inBackground = false
            // La boîte fraîche et les lectures de la coque partent ensemble ; le flux et le direct
            // s'ouvrent après la boîte, sur son curseur neuf : rien n'est rejoué ni relu deux fois.
            let task = Task { [weak harness] in
                guard let harness else { return }
                async let inbox: Void = Self.reopen(harness)
                async let shell: Void = harness.readShell(.refreshing)
                _ = await (inbox, shell)
            }
            returning = task
            return task
        }
    }

    private static func reopen(_ harness: HarnessModel) async {
        await harness.refresh()
        // Repassé en arrière-plan pendant la lecture : aucun flux ne s'ouvre.
        guard !Task.isCancelled else { return }
        harness.startLive()
        harness.resumeSession()
    }
}
