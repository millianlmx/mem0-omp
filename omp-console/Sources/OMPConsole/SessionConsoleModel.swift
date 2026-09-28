// Modèle de la fenêtre « Session OMP » (S-9) : projet, mode, prompt, dialogue,
// statut, disponibilités.
//
// Le modèle ne parle JAMAIS le protocole : il appelle le host et traduit ses
// erreurs en texte via `SessionHostError.userMessage` — c'est le seul endroit qui
// produit du texte affiché pour un échec (S-3). Tout le reste de l'affichage est
// la donnée publiée par le host, montrée telle quelle.
//
// Deux invariants de S-9 sont tenus par la forme du code :
//   - le choix du projet n'est JAMAIS écrit en `UserDefaults` sans un geste
//     explicite (`chooseProject`) : `init` ne fait que LIRE ;
//   - la fenêtre « Session OMP » est une scène à instance unique, donc « une seule
//     session hébergée » est structurellement vrai ; `canLaunch` est faux dès que
//     l'état est `launching|running|stopping`.
//
// Le modèle vit à l'échelle de l'APP (`@StateObject` sur la structure `App`), pas
// de la fenêtre : fermer la fenêtre pendant une session ne doit pas laisser un
// `omp` orphelin, et l'accroche de terminaison doit exister avant la première
// ouverture de la fenêtre.

import AppKit
import Combine
import Foundation

@MainActor
final class SessionConsoleModel: ObservableObject {
    static let projectRootKey = "session.projectRoot"
    static let modeKey = "session.mode"

    let host: SessionHost

    @Published var projectRoot: URL?
    @Published var mode: RpcMode = .rpcUI
    @Published var prompt: String = ""
    @Published var dialogText: String = ""
    @Published var selectedOptionIndex: Int?
    @Published var journalExpanded: Bool = true
    @Published var statusMessage: String = ""

    private let defaults: UserDefaults
    private let fileManager: FileManager
    private var cancellables: Set<AnyCancellable> = []

    init(host: SessionHost? = nil, defaults: UserDefaults = .standard, fileManager: FileManager = .default) {
        let host = host ?? SessionHost()
        self.host = host
        self.defaults = defaults
        self.fileManager = fileManager
        self.mode = RpcMode(rawValue: defaults.string(forKey: Self.modeKey) ?? "") ?? .rpcUI
        self.projectRoot = Self.restoredProjectRoot(defaults: defaults, fileManager: fileManager)
        self.statusMessage = Self.statusText(
            for: host.state,
            pid: host.pid,
            sessionId: host.sessionId
        )

        // Le statut suit l'ÉTAT, pas chaque trame : `removeDuplicates` évite qu'une
        // transcription qui grandit écrase le message d'une commande expirée
        // (AC-13 : l'erreur reste affichée sans changer d'état).
        host.$state
            .removeDuplicates()
            .sink { [weak self] _ in
                Task { @MainActor in self?.refreshStatus() }
            }
            .store(in: &cancellables)

        // … et l'IDENTITÉ de session : `get_state` publie `sessionId` SANS changer
        // d'état (S-2), donc l'abonnement à l'état seul laissait le statut sur
        // « Session vivante (pid <n>) » alors que la session était déjà connue —
        // S-9 exige « Session vivante (pid <n>, session <8 premiers>) » dès que
        // `get_state` a répondu.
        host.$sessionId
            .removeDuplicates()
            .sink { [weak self] _ in
                Task { @MainActor in self?.refreshStatus() }
            }
            .store(in: &cancellables)

        // Fermeture de l'app : l'unique chemin de sortie passe par le host (S-8).
        AppDelegate.terminateSession = { [weak self] in
            await self?.host.terminateForQuit()
        }
    }

    // MARK: - Persistance

    /// Clé absente ⇒ repli mesuré : le cwd de l'app s'il est un dossier contenant
    /// une entrée `.git`, sinon rien. Une clé PRÉSENTE mais invalide (dossier
    /// supprimé) ne déclenche pas le repli : l'utilisateur a choisi, et S-9 exige
    /// que ce choix ne soit pas réécrit tout seul.
    private static func restoredProjectRoot(defaults: UserDefaults, fileManager: FileManager) -> URL? {
        if let path = defaults.string(forKey: projectRootKey) {
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue else {
                return nil
            }
            return URL(fileURLWithPath: path)
        }
        let cwd = URL(fileURLWithPath: fileManager.currentDirectoryPath)
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: cwd.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            return nil
        }
        guard fileManager.fileExists(atPath: cwd.appendingPathComponent(".git").path) else { return nil }
        return cwd
    }

    // MARK: - Disponibilités (S-9)

    private var isProjectUsable: Bool {
        guard let projectRoot else { return false }
        var isDirectory: ObjCBool = false
        return fileManager.fileExists(atPath: projectRoot.path, isDirectory: &isDirectory) && isDirectory.boolValue
    }

    var canLaunch: Bool {
        switch host.state {
        case .idle, .stopped, .failed: return isProjectUsable
        default: return false
        }
    }

    var canStop: Bool {
        switch host.state {
        case .launching, .running: return true
        default: return false
        }
    }

    var canRelaunch: Bool {
        if case .dead = host.state { return true }
        return false
    }

    var canSendPrompt: Bool {
        host.state == .running
            && host.dialogQueue.isEmpty
            && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var canAnswerDialog: Bool {
        guard let dialog = host.dialogQueue.first else { return false }
        switch dialog.method {
        case .select:
            guard let index = selectedOptionIndex else { return false }
            return dialog.options.indices.contains(index)
        case .confirm, .editor:
            return true
        case .input:
            return !dialogText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    /// Note de relance de l'état `dead` (S-9).
    var relaunchNote: String? {
        guard case .dead = host.state, let sessionFile = host.sessionFile else { return nil }
        return "La relance reprend \(sessionFile)."
    }

    /// Un dialogue en attente capte le raccourci d'arrêt : « ⌘. arrête la session
    /// (état vivant) OU annule le dialogue en attente » (S-9).
    var hasPendingDialog: Bool { !host.dialogQueue.isEmpty }

    /// Action du raccourci ⌘. — un seul point de décision, pour que la fenêtre
    /// n'ait pas deux règles à tenir synchronisées : dialogue en attente ⇒ annulation
    /// de celui-ci, sinon arrêt de la session. Le BOUTON « Arrêter la session »
    /// reste, lui, l'arrêt à la souris dans les deux cas.
    func performStopShortcut() {
        if hasPendingDialog {
            cancelDialog()
        } else {
            stop()
        }
    }

    // MARK: - Actions (S-9)

    func chooseProject() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.prompt = "Choisir"
        panel.message = "Choisissez le dossier du projet à héberger."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        projectRoot = url
        defaults.set(url.path, forKey: Self.projectRootKey)
    }

    func setMode(_ mode: RpcMode) {
        self.mode = mode
        defaults.set(mode.rawValue, forKey: Self.modeKey)
    }

    func launch() {
        guard canLaunch, let projectRoot else { return }
        let mode = mode
        Task { @MainActor in
            do {
                try await host.start(mode: mode, projectRoot: projectRoot, resume: false)
            } catch {
                present(error)
            }
        }
    }

    func relaunch() {
        guard canRelaunch else { return }
        Task { @MainActor in
            do {
                try await host.relaunch()
            } catch {
                present(error)
            }
        }
    }

    func stop() {
        Task { @MainActor in
            await host.stop()
        }
    }

    func sendPrompt() {
        guard canSendPrompt else { return }
        let text = prompt
        Task { @MainActor in
            do {
                try await host.send(prompt: text)
                prompt = ""
            } catch {
                present(error)
            }
        }
    }

    func answerSelectedOption() {
        guard
            let dialog = host.dialogQueue.first,
            dialog.method == .select,
            let index = selectedOptionIndex,
            dialog.options.indices.contains(index)
        else { return }
        answer(.value(id: dialog.id, value: dialog.options[index]))
    }

    func answerDialogText() {
        guard let dialog = host.dialogQueue.first, dialog.method == .input || dialog.method == .editor else { return }
        answer(.value(id: dialog.id, value: dialogText))
    }

    func confirmDialog(_ confirmed: Bool) {
        guard let dialog = host.dialogQueue.first, dialog.method == .confirm else { return }
        answer(.confirmed(id: dialog.id, confirmed: confirmed))
    }

    func cancelDialog() {
        guard let dialog = host.dialogQueue.first else { return }
        answer(.cancelled(id: dialog.id))
    }

    /// Un dialogue qui apparaît remet les contrôles à son état initial : `editor`
    /// part de son `prefill` (S-6), rien d'autre n'hérite du dialogue précédent.
    func dialogAppeared(_ dialog: RpcDialogRequest) {
        dialogText = dialog.method == .editor ? (dialog.prefill ?? "") : ""
        selectedOptionIndex = nil
    }

    func applicationWillTerminate() async {
        await host.terminateForQuit()
    }

    // MARK: - Statut

    private func refreshStatus() {
        statusMessage = Self.statusText(for: host.state, pid: host.pid, sessionId: host.sessionId)
    }

    static func statusText(for state: SessionHost.State, pid: Int32?, sessionId: String?) -> String {
        switch state {
        case .idle:
            return "Aucune session"
        case .launching:
            return "Lancement…"
        case .running:
            guard let pid else { return "Session vivante" }
            guard let sessionId else { return "Session vivante (pid \(pid))" }
            return "Session vivante (pid \(pid), session \(sessionId.prefix(8)))"
        case .stopping:
            return "Arrêt en cours…"
        case .stopped:
            return "Session arrêtée"
        case .dead(let exit):
            switch exit.reason {
            case .exited: return "Process mort (code \(exit.status))."
            case .uncaughtSignal: return "Process mort (signal \(exit.status))."
            }
        case .failed(let message):
            return message
        }
    }

    private func answer(_ response: RpcDialogResponse) {
        do {
            try host.answer(response)
            dialogText = ""
            selectedOptionIndex = nil
        } catch {
            present(error)
        }
    }

    private func present(_ error: Error) {
        statusMessage = (error as? SessionHostError)?.userMessage ?? String(describing: error)
    }
}
