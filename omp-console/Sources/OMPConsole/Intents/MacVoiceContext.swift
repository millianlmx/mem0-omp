// Le contexte des intents Siri du Mac (siri-mac-questions-en-attente, S-5) : les
// modèles mêmes que les vues et l'API distante, et l'attente bornée qui laisse une
// app lancée à froid par Siri lire son état avant de répondre. Le pilotage
// (siri-mac-pilotage-pipelines) y lit l'ardoise et les dépôts lançables.

import AppIntents
import Combine
import ConsoleCore
import Foundation

@MainActor
final class MacVoiceContext {
    /// La borne de l'attente « état lu » : celle de l'iPhone
    /// (`ClientRetry.readinessTimeout`).
    static let readinessTimeout: Duration = .seconds(5)

    /// Les gestes typés que sert aussi le routeur HTTP : la SEULE voie d'écriture
    /// des intents.
    let remoteActions: RemoteActions

    private let storeHub: StoreHub
    private let kanban: KanbanModel
    private let project: ProjectConsoleModel
    private let session: SessionConsoleModel
    private let startModels: @MainActor () -> Void
    private let projectRoot: @MainActor () -> String?
    private let readinessTimeout: Duration

    init(
        storeHub: StoreHub,
        kanban: KanbanModel,
        project: ProjectConsoleModel,
        session: SessionConsoleModel,
        remoteActions: RemoteActions,
        startModels: @escaping @MainActor () -> Void,
        projectRoot: @escaping @MainActor () -> String?,
        readinessTimeout: Duration = MacVoiceContext.readinessTimeout
    ) {
        self.storeHub = storeHub
        self.kanban = kanban
        self.project = project
        self.session = session
        self.remoteActions = remoteActions
        self.startModels = startModels
        self.projectRoot = projectRoot
        self.readinessTimeout = readinessTimeout
    }

    /// La liste des attentes du Mac, une fois l'ardoise dérivée d'au moins un
    /// instantané : c'est elle que consultent les gestes de carte. Un processus
    /// lancé sans fenêtre n'a jamais démarré ses modèles : la lecture les démarre,
    /// puis attend au plus `readinessTimeout` ; au-delà, elle lève `MacStateUnreadable`.
    func pending() async throws -> [PendingRequest] {
        try await waitForBoard()
        return LocalPendingRequests.list(storeHub: storeHub, project: project, session: session)
    }

    /// Les cartes de l'ardoise, après la même attente bornée que `pending()`.
    func board() async throws -> [KanbanCard] {
        try await waitForBoard()
        return kanban.state.kanbanBoard?.cards ?? []
    }

    /// Les dépôts que propose la feuille « Nouvelle feature » (ceux de l'ardoise et
    /// le projet choisi de l'app), sauf le dossier choisi à la main et sauf les
    /// dossiers qui ne sont pas des racines git.
    func launchRepos() async throws -> [String] {
        LaunchRepo.options(cards: try await board(), projectRoot: projectRoot(), chosen: nil)
            .filter { LaunchRepo.isGitRoot(path: $0) }
    }

    /// L'issue qu'énonce Siri pour un échec d'intent : l'état non lu à temps, ou le
    /// motif EXACT que rend la route HTTP du même geste refusé.
    static func issue(of error: Error) -> VoiceIssue {
        if error is MacStateUnreadable { return .stateUnreadable }
        guard let refusal = error as? GestureRefusal else { return .macRefused(motive: "") }
        return .macRefused(motive: refusal.apiError.message ?? "")
    }

    /// Démarre l'ardoise d'un processus lancé sans fenêtre, puis attend au plus
    /// `readinessTimeout` qu'elle quitte `.loading` ; au-delà, lève `MacStateUnreadable`.
    private func waitForBoard() async throws {
        guard kanban.state == .loading else { return }
        startModels()
        guard await boardLoaded() else { throw MacStateUnreadable() }
    }

    /// Vrai dès que l'ardoise publiée quitte `.loading`, faux à l'échéance : un
    /// abonnement à `kanban.$state` mis en course avec la borne, jamais une boucle
    /// d'attente active.
    private func boardLoaded() async -> Bool {
        let gate = ReadinessGate()
        let timeout = readinessTimeout
        return await withCheckedContinuation { continuation in
            gate.continuation = continuation
            gate.timer = Task { @MainActor in
                try? await Task.sleep(for: timeout)
                gate.finish(false)
            }
            // `KanbanModel` publie sur le fil principal : la valeur courante arrive
            // dès l'abonnement, les suivantes à chaque instantané appliqué.
            gate.subscription = kanban.$state.sink { state in
                MainActor.assumeIsolated {
                    if state != .loading { gate.finish(true) }
                }
            }
        }
    }

    /// Enregistre `context` comme dépendance des intents (clé = le type) et le rend
    /// tel quel : chaque résolution rend la même instance.
    @discardableResult
    static func install(_ context: MacVoiceContext, in manager: AppDependencyManager) -> MacVoiceContext {
        manager.add(dependency: context)
        return context
    }
}

/// L'ardoise n'a pas quitté `.loading` dans le délai borné : rien n'est lu, rien
/// n'est envoyé (issue `stateUnreadable`).
struct MacStateUnreadable: Error {}

/// L'issue unique de l'attente « état lu » : le premier de l'abonnement ou de la
/// borne reprend la tâche en attente, puis tous deux sont annulés.
@MainActor
private final class ReadinessGate {
    var continuation: CheckedContinuation<Bool, Never>?
    var subscription: AnyCancellable?
    var timer: Task<Void, Never>?

    func finish(_ loaded: Bool) {
        guard let continuation else { return }
        self.continuation = nil
        subscription?.cancel()
        timer?.cancel()
        continuation.resume(returning: loaded)
    }
}
