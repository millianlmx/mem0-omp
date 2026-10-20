// La Session OMP HÉBERGÉE SUR LE VPS, conduite depuis omp-console (S-8 de
// orchestrator-living-in-a-vps) : le modèle parle le protocole distant par le client du
// VPS (`MachineHub.vps`, slot `.vps`), jamais un process local.
//
// Invariant de S-8, tenu par la forme du code : la session vit SUR LE VPS. Fermer la
// fenêtre, changer de section ou quitter omp-console n'émet JAMAIS `/v1/session/stop` —
// `stop()` est le seul chemin vers cette route, et il n'est appelé que par le geste
// « Arrêter ». `terminateForQuit()` ne fait que lâcher la lecture du fil. À la
// réouverture, `GET /v1/session` retrouve la session en cours et son fil.
//
// Le fil de conversation est celui du fichier de session servi (`hosted.sessionFile`) :
// `GET /v1/sessions/:fichier` puis les trames `sessions` du flux, par un
// `SessionViewerModel` en mode distant. Le modèle ne dérive aucune ligne.

import Combine
import ConsoleClient
import ConsoleCore
import Foundation

/// L'état d'une session hébergée tel que l'API le publie (`hosted.state`).
private enum VpsHostedState: String {
    case idle, launching, running, stopping, stopped, dead, failed
}

/// Ce que la section montre (états de S-8).
enum VpsSessionSurface: Equatable {
    /// Le VPS n'est pas appairé : « Appairez le VPS dans Dépôts ».
    case notPaired
    /// Le VPS ne répond pas : la session continue sur le VPS, la saisie est désactivée.
    case unreachable
    /// Premier `GET /v1/session` en vol.
    case loading
    /// Aucune session sur le VPS.
    case empty
    case launching
    case stopping
    case live
    case stopped
    case dead
    case failed(String)
}

@MainActor
final class VpsSessionModel: ObservableObject {
    let client: ConsoleClientModel

    @Published var prompt = ""
    @Published var dialogText = ""
    @Published var selectedOptionIndex: Int?
    @Published private(set) var error: String?
    /// Le fil de la session servie ; `nil` tant qu'aucun fichier n'est connu.
    @Published private(set) var conversation: SessionViewerModel?
    /// Les dépôts du VPS proposés au lancement (`GET /v1/repos`).
    @Published private(set) var repos: [RepoRow] = []
    @Published private(set) var modelCatalog: [String] = []
    @Published private(set) var isApplyingModel = false

    private let source: ClientMachineSource
    private var cancellables: Set<AnyCancellable> = []
    private var refreshTask: Task<Void, Never>?

    init(client: ConsoleClientModel) {
        self.client = client
        source = ClientMachineSource(client)
        // Chaque publication du client (état, session servie) redessine la section ; un
        // changement de fichier remonte le fil.
        client.objectWillChange
            .receive(on: DispatchQueue.main)
            .sink { [weak self] in
                guard let self else { return }
                self.objectWillChange.send()
                self.syncConversation()
            }
            .store(in: &cancellables)
    }

    // MARK: - Décisions pures

    static func surface(availability: MachineAvailability, hosted: ConsoleClient.RemoteHostedEvent?) -> VpsSessionSurface {
        switch availability {
        case .notConfigured: return .notPaired
        case .unreachable: return .unreachable
        case .reachable: break
        }
        guard let hosted else { return .loading }
        switch VpsHostedState(rawValue: hosted.state) ?? .idle {
        case .idle: return .empty
        case .launching: return .launching
        case .stopping: return .stopping
        case .running: return .live
        case .stopped: return .stopped
        case .dead: return .dead
        case .failed: return .failed(hosted.stateLabel ?? "")
        }
    }

    /// Le lancement n'est offert que sans session en marche.
    static func canLaunch(_ surface: VpsSessionSurface) -> Bool {
        switch surface {
        case .empty, .stopped, .failed: return true
        default: return false
        }
    }

    static func canStop(_ surface: VpsSessionSurface) -> Bool {
        surface == .live || surface == .launching
    }

    static func canRelaunch(_ surface: VpsSessionSurface) -> Bool { surface == .dead }

    /// En marche, aucun dialogue en attente, texte non blanc.
    static func canSendPrompt(surface: VpsSessionSurface, dialogs: [RpcDialogRequest], text: String) -> Bool {
        surface == .live && dialogs.isEmpty && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: - Faits dérivés

    var surface: VpsSessionSurface { Self.surface(availability: source.availability, hosted: client.hosted) }
    var canLaunch: Bool { Self.canLaunch(surface) }
    var canStop: Bool { Self.canStop(surface) }
    var canRelaunch: Bool { Self.canRelaunch(surface) }
    var canSendPrompt: Bool {
        Self.canSendPrompt(surface: surface, dialogs: client.hosted?.dialogs ?? [], text: prompt)
    }
    var projectName: String? { client.hosted?.projectName }
    var turnRunning: Bool { client.hosted?.turnRunning == true }
    var pendingDialog: RpcDialogRequest? { client.hosted?.dialogs.first }
    /// « Répondre » est actif : un choix pour `select`, une saisie non blanche pour `input`.
    var canAnswerDialog: Bool {
        guard surface == .live, let dialog = pendingDialog else { return false }
        switch dialog.method {
        case .select:
            guard let index = selectedOptionIndex else { return false }
            return dialog.options.indices.contains(index)
        case .input:
            return !dialogText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .confirm, .editor:
            return true
        }
    }
    /// Le modèle ne change ni pendant un tour ni sans session en marche.
    var canChangeModel: Bool { surface == .live && !turnRunning && !isApplyingModel }
    var modelLabel: String {
        guard let model = client.hosted?.model else { return SessionConsoleText.Model.defaultModel }
        return SessionConsoleText.Model.label(name: model, level: client.hosted?.thinkingLevel)
    }

    // MARK: - Cycle de vie

    /// À l'ouverture de la section : relit la session servie (la retrouve après une
    /// fermeture) et monte son fil.
    func appeared() {
        refresh()
    }

    func refresh() {
        guard source.availability == .reachable else { return }
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await self.client.hostedSession()
                self.error = nil
            } catch {
                if Task.isCancelled { return }
                self.error = MachineHub.reason(error)
            }
            self.syncConversation()
        }
    }

    /// Monte le fil du fichier servi, le démonte sans fichier ; un fichier inchangé garde
    /// son fil.
    func syncConversation() {
        guard let file = client.hosted?.sessionFile, !file.isEmpty else {
            conversation?.stop()
            conversation = nil
            return
        }
        if conversation?.target.sessionFile == file { return }
        conversation?.stop()
        conversation = SessionViewerModel(
            remote: client,
            target: ViewerTarget(
                sessionFile: file,
                title: client.hosted?.projectName ?? "",
                subtitle: client.hosted?.stateLabel
            )
        )
    }

    /// Fermeture de l'app ou de la fenêtre : la lecture du fil est lâchée, AUCUNE requête
    /// n'est émise — la session continue sur le VPS (S-8).
    func terminateForQuit() async {
        refreshTask?.cancel()
        conversation?.stop()
        conversation = nil
    }

    // MARK: - Gestes

    /// Lit les dépôts du VPS pour la feuille de lancement.
    func loadRepos() async {
        do {
            repos = try await client.repos().rows
            error = nil
        } catch {
            self.error = MachineHub.reason(error)
        }
    }

    /// Lance la session hébergée sur un dépôt du VPS. Rend le motif de l'échec, `nil` sinon.
    func launch(repoKey: String) async -> String? {
        error = nil
        do {
            _ = try await client.launchHostedSession(repoKey: repoKey)
            syncConversation()
            return nil
        } catch {
            return MachineHub.reason(error)
        }
    }

    func relaunch() async {
        error = nil
        do {
            _ = try await client.relaunchHostedSession()
            syncConversation()
        } catch {
            self.error = MachineHub.reason(error)
        }
    }

    /// LE seul chemin vers `/v1/session/stop` : le geste « Arrêter ».
    func stop() async {
        error = nil
        do {
            _ = try await client.stopHostedSession()
            syncConversation()
        } catch {
            self.error = MachineHub.reason(error)
        }
    }

    /// Envoie le prompt par `POST /v1/session/prompt` ; le champ n'est vidé que sur succès.
    func sendPrompt() async {
        guard canSendPrompt else { return }
        error = nil
        do {
            _ = try await client.prompt(message: prompt)
            prompt = ""
        } catch {
            self.error = MachineHub.reason(error)
        }
    }

    // MARK: Dialogues

    func dialogAppeared(_ dialog: RpcDialogRequest) {
        dialogText = dialog.method == .editor ? (dialog.prefill ?? "") : ""
        selectedOptionIndex = nil
    }

    func answerSelectedOption() async {
        guard let dialog = pendingDialog, dialog.method == .select,
              let index = selectedOptionIndex, dialog.options.indices.contains(index)
        else { return }
        await answer(dialog, ConsoleClient.RemoteDialogAnswerRequest(kind: "value", value: dialog.options[index]))
    }

    func answerDialogText() async {
        guard let dialog = pendingDialog, dialog.method == .input || dialog.method == .editor else { return }
        await answer(dialog, ConsoleClient.RemoteDialogAnswerRequest(kind: "value", value: dialogText))
    }

    func confirmDialog(_ confirmed: Bool) async {
        guard let dialog = pendingDialog, dialog.method == .confirm else { return }
        await answer(dialog, ConsoleClient.RemoteDialogAnswerRequest(kind: "confirmed", confirmed: confirmed))
    }

    func cancelDialog() async {
        guard let dialog = pendingDialog else { return }
        await answer(dialog, ConsoleClient.RemoteDialogAnswerRequest(kind: "cancelled"))
    }

    private func answer(_ dialog: RpcDialogRequest, _ request: ConsoleClient.RemoteDialogAnswerRequest) async {
        do {
            _ = try await client.answerHostedDialog(
                id: dialog.id, kind: request.kind, value: request.value, confirmed: request.confirmed
            )
            dialogText = ""
            selectedOptionIndex = nil
            error = nil
        } catch {
            self.error = MachineHub.reason(error)
        }
    }

    // MARK: Modèle

    /// Le catalogue des modèles utilisables du VPS (`GET /v1/models`).
    func loadModels() async {
        do {
            modelCatalog = try await client.models().selectors
        } catch {
            self.error = MachineHub.reason(error)
        }
    }

    /// Change le modèle de la session (`POST /v1/session/model`) ; un refus du VPS est
    /// montré mot pour mot.
    func applyModel(_ selector: String) async {
        guard canChangeModel else { return }
        isApplyingModel = true
        defer { isApplyingModel = false }
        do {
            try await client.setHostedModel(model: selector, thinkingLevel: nil)
            error = nil
        } catch {
            self.error = MachineHub.reason(error)
        }
    }
}
