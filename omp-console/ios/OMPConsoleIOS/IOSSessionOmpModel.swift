// Le modèle de l'écran « Session OMP » de l'app iOS (BR-4) : les décisions PURES
// (surface, disponibilités), le contrat d'entrée ÉTROIT (le protocole
// `IOSSessionOmpClient`), et les gestes (lecture, lancement, relance, arrêt,
// prompt, dialogue).
//
// Comme `IOSMemoryModel` : le modèle ne nomme PAS `ConsoleClientModel` — il tient
// un protocole étroit, auquel le client partagé se conforme par extension. C'est
// ce qui permet à une doublure comptante de prouver « un geste = un appel » sans
// ouvrir de socket.
//
// Le fil (S-4) est LE composant réutilisable `IOSSessionThreadModel`, monté sur
// le fichier `sessionFile` servi : le modèle ne dérive aucune ligne de
// conversation.

import Combine
import ConsoleClient
import ConsoleCore
import Foundation

/// Le contrat d'entrée de l'écran : le client partagé, plus les lectures et gestes
/// de la session hébergée. `ConsoleClientModel` s'y conforme par extension.
@MainActor
protocol IOSSessionOmpClient: IOSSessionSource {
    var state: ClientState { get }
    var hosted: RemoteHostedEvent? { get }
    func hostedSession() async throws -> RemoteHostedSessionPayload
    func repos() async throws -> RemoteReposPayload
    func launchHostedSession(repoKey: String) async throws -> RemoteHostedSessionPayload
    func relaunchHostedSession() async throws -> RemoteHostedSessionPayload
    func stopHostedSession() async throws -> RemoteHostedSessionPayload
    func answerHostedDialog(id: String, kind: String, value: String?, confirmed: Bool?) async throws -> RemoteAcceptedPayload
    func prompt(message: String) async throws -> RemoteSentPayload
}

extension ConsoleClientModel: IOSSessionOmpClient {}

/// La surface que l'écran doit montrer, décidée par l'état du client et l'état
/// servi de la session (S-2, BR-4).
enum SessionOmpSurface: Equatable {
    /// Client hors `.connected` : bandeau `attention`, gestes inactifs.
    case degraded(String)
    /// Premier `GET` en vol (`hosted == nil`).
    case loading
    /// `idle` : aucune session (ou prête à démarrer).
    case empty
    /// `launching`.
    case launching
    /// `stopping`.
    case stopping
    /// `running` : la session est vivante.
    case live
    /// `stopped`.
    case stopped
    /// `dead` : la session s'est interrompue, elle est relançable.
    case dead
    /// `failed` : le message servi par la coque.
    case failed(String)
}

@MainActor
final class IOSSessionOmpModel: ObservableObject {
    let client: any IOSSessionOmpClient

    @Published var error: String?
    @Published var isSubmitting = false
    /// Le fil réutilisé de la session servie (S-4), RECRÉÉ quand le fichier
    /// change — jamais autrement.
    @Published private(set) var thread: IOSSessionThreadModel?

    private var refreshTask: Task<Void, Never>?

    init(client: any IOSSessionOmpClient) {
        self.client = client
    }

    // MARK: - Décisions PURES (testables sans render)

    /// Seul `.connected` ouvre les gestes (S-6).
    static func gesturesEnabled(_ state: ClientState) -> Bool {
        if case .connected = state { return true }
        return false
    }

    /// La surface choisie pour un état de client et un état servi (S-2).
    static func surface(state: ClientState, hosted: RemoteHostedEvent?) -> SessionOmpSurface {
        guard gesturesEnabled(state) else { return .degraded(ConnectionText.state(state)) }
        guard let hosted else { return .loading }
        switch HostedSessionWire(rawValue: hosted.state) ?? .idle {
        case .idle: return .empty
        case .launching: return .launching
        case .stopping: return .stopping
        case .running: return .live
        case .stopped: return .stopped
        case .dead: return .dead
        case .failed: return .failed(hosted.stateLabel ?? "")
        }
    }

    /// Le lancement est indisponible tant qu'une session est en marche (S-1) : il
    /// n'est offert que dans `idle`, `stopped` ou `failed`.
    static func canLaunch(_ hosted: RemoteHostedEvent?) -> Bool {
        switch HostedSessionWire(rawValue: hosted?.state ?? "") ?? .idle {
        case .idle, .stopped, .failed: return true
        default: return false
        }
    }

    /// La relance est offerte pour `dead` seulement (S-1).
    static func canRelaunch(_ hosted: RemoteHostedEvent?) -> Bool {
        (HostedSessionWire(rawValue: hosted?.state ?? "") ?? .idle) == .dead
    }

    /// L'arrêt est offert pour une session en marche ou en lancement (S-7).
    static func canStop(_ hosted: RemoteHostedEvent?) -> Bool {
        switch HostedSessionWire(rawValue: hosted?.state ?? "") ?? .idle {
        case .launching, .running: return true
        default: return false
        }
    }

    /// Parité stricte de `SessionConsoleModel.canSendPrompt` : en marche, aucun
    /// dialogue en attente, texte non blanc (S-3).
    static func canSendPrompt(state: String?, dialogs: [RpcDialogRequest], text: String) -> Bool {
        (HostedSessionWire(rawValue: state ?? "") ?? .idle) == .running
            && dialogs.isEmpty
            && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Le mot de la cause, affiché sous le composeur (S-3).
    static func composerHint(state: String?, dialogs: [RpcDialogRequest]) -> String {
        guard (HostedSessionWire(rawValue: state ?? "") ?? .idle) == .running else {
            return SessionConsoleText.composerIdle
        }
        return dialogs.isEmpty ? SessionConsoleText.composerRunning : ProjectViewText.composerBlocked
    }

    // MARK: - Faits dérivés du client

    var surface: SessionOmpSurface { Self.surface(state: client.state, hosted: client.hosted) }
    var canLaunch: Bool { Self.canLaunch(client.hosted) }
    var canRelaunch: Bool { Self.canRelaunch(client.hosted) }
    var canStop: Bool { Self.canStop(client.hosted) }

    // MARK: - Cycle de vie (S-6)

    /// À l'apparition : une lecture de l'état servi.
    func appeared() {
        refresh()
    }

    /// Relit `GET /v1/session` — appelé à l'apparition et à chaque retour de la
    /// connexion. La réponse remonte le fil si le fichier a changé.
    func refresh() {
        guard Self.gesturesEnabled(client.state) else { return }
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await self.client.hostedSession()
                self.error = nil
            } catch {
                if Task.isCancelled { return }
                self.error = ProjectText.failure(error, state: self.client.state)
            }
            self.syncThread()
        }
    }

    /// Monte le fil du fichier servi, ou le démonte quand il n'y en a pas. Un
    /// fichier INCHANGÉ garde le même fil (S-4) : aucun remontage.
    func syncThread() {
        guard let file = client.hosted?.sessionFile, !file.isEmpty else {
            thread?.finish()
            thread = nil
            return
        }
        if thread?.file == file { return }
        thread?.finish()
        thread = IOSSessionThreadModel(
            source: client,
            file: file,
            title: client.hosted?.projectName ?? "",
            subtitle: client.hosted?.stateLabel,
            tracksRun: false
        )
    }

    // MARK: - Gestes

    /// Lance la session hébergée sur ce dépôt (S-1). Rend `nil` sur succès, sinon
    /// le message d'échec à afficher dans la feuille, qui reste ouverte.
    func launch(repoKey: String) async -> String? {
        error = nil
        do {
            _ = try await client.launchHostedSession(repoKey: repoKey)
            syncThread()
            return nil
        } catch {
            return ProjectText.failure(error, state: client.state)
        }
    }

    func relaunch() async {
        error = nil
        do {
            _ = try await client.relaunchHostedSession()
            syncThread()
        } catch {
            self.error = ProjectText.failure(error, state: client.state)
        }
    }

    func stop() async {
        error = nil
        do {
            _ = try await client.stopHostedSession()
            syncThread()
        } catch {
            self.error = ProjectText.failure(error, state: client.state)
        }
    }

    /// Envoie un prompt (S-3). Rend `true` sur succès : l'écran vide alors le
    /// champ ; sur échec le message est affiché et le champ reste rempli.
    func sendPrompt(_ text: String) async -> Bool {
        error = nil
        do {
            _ = try await client.prompt(message: text)
            return true
        } catch {
            self.error = ProjectText.failure(error, state: client.state)
            return false
        }
    }

    /// Tranche le dialogue de tête (S-5). Rend `nil` sur succès, sinon le message
    /// d'échec à afficher dans la feuille, qui reste ouverte.
    func answer(_ request: RemoteDialogAnswerRequest) async -> String? {
        guard let dialog = client.hosted?.dialogs.first else { return nil }
        do {
            _ = try await client.answerHostedDialog(
                id: dialog.id,
                kind: request.kind,
                value: request.value,
                confirmed: request.confirmed
            )
            return nil
        } catch {
            return ProjectText.failure(error, state: client.state)
        }
    }
}
