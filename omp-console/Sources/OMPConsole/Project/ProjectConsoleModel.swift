// Le modèle de la fenêtre « Projet » (S-1 … S-10, BR-1/BR-2/BR-4) : il possède un
// `SessionHost` (comme `SessionConsoleModel` possède le sien) et il est le SEUL
// endroit qui décide — armement, refus, clôture, dialogues, attention.
//
// Deux règles de forme valent pour tout ce fichier :
//   — l'app n'ÉCRIT JAMAIS l'état du projet (ni `projects/<clé>.json`, ni le
//     worktree `.doc`, ni le lot) : elle lit le magasin et envoie les réponses
//     dans la session ;
//   — l'app ne réimplémente aucune règle du pilote (plan, segments, jalons, PR) :
//     elle affiche ce que le magasin porte.
//
// Les règles de dialogue et de gating sont celles de `SessionConsoleModel`
// (`canAnswerDialog`, `dialogAppeared` pour le `prefill`) : elles sont REPRISES à
// l'identique, pas réinventées.

import AppKit
import Combine
import Foundation

@MainActor
final class ProjectConsoleModel: ObservableObject {
    let host: SessionHost

    // MARK: - État de la conduite

    @Published private(set) var state: ConduiteState = .none
    @Published private(set) var identity: ConduiteIdentity?
    /// Le SEUL texte d'échec affiché : le `userMessage` d'une `SessionHostError`,
    /// ou le texte d'état de la session morte (`SessionConsoleModel.statusText`).
    @Published private(set) var statusMessage: String = ""
    /// Dernière présentation `notify` du pilote (résumé du journal du host).
    @Published private(set) var notice: String?
    /// Le refus d'un second démarrage (S-2) — non nul ⇒ l'alerte est présentée.
    @Published private(set) var refusal: ConduiteRefusal?

    // MARK: - Saisie et dialogues

    @Published var prompt: String = ""
    @Published var dialogText: String = ""
    @Published var selectedOptionIndex: Int?

    // MARK: - Feuille « Conduire un projet… » (aucun `@State` sous CLT seuls)

    @Published var isLaunchSheetPresented: Bool = false
    @Published var draftRepository: URL?
    @Published var draftName: String = ""

    // MARK: - Lecture du projet (BR-2)

    @Published private(set) var project: Project? {
        didSet { evaluateAttention() }
    }
    @Published private(set) var docText: String?
    /// Les segments dépliés dans le volet « Plan » (aucun `@State` sous CLT seuls).
    @Published var expandedSegments: Set<Int> = []

    // MARK: - Signal d'attention (BR-4)

    /// L'identifiant de la demande active, `nil` quand aucune ne l'est.
    @Published private(set) var attentionRequestID: Int?

    // MARK: - Dépendances

    private let attention: AttentionRequesting
    private let presence: any WindowFrontmostReporting
    private let stateDir: String
    private let defaults: UserDefaults
    private let fileManager: FileManager

    private var hub: StoreHub
    private let makeHub: () -> StoreHub
    private var hubTask: Task<Void, Never>?
    private var hubStopped = false
    private var latestSnapshot: StoreSnapshot?

    private var docWatcher: FileWatcher?
    private var docTask: Task<Void, Never>?
    /// L'identifiant du dialogue dont les contrôles ont déjà été initialisés.
    private var lastDialogID: String?

    private var cancellables: Set<AnyCancellable> = []

    init(
        host: SessionHost? = nil,
        attention: AttentionRequesting = SystemAttention(),
        presence: any WindowFrontmostReporting = ProjectWindowPresence(),
        stateDir: String = PipelineStore.stateDir(),
        defaults: UserDefaults = .standard,
        fileManager: FileManager = .default
    ) {
        let host = host ?? SessionHost()
        self.host = host
        self.attention = attention
        self.presence = presence
        self.stateDir = stateDir
        self.defaults = defaults
        self.fileManager = fileManager
        let hub = StoreHub(stateDir: stateDir)
        self.hub = hub
        self.makeHub = { StoreHub(stateDir: stateDir) }

        // Statut, mort de session et attention suivent l'ÉTAT du host.
        host.$state
            .removeDuplicates()
            .sink { [weak self] hostState in
                Task { @MainActor in self?.hostStateChanged(hostState) }
            }
            .store(in: &cancellables)

        // Un dialogue en file change l'attente (S-9) ; son ouverture remet les
        // contrôles à leur état initial (le `prefill` d'un `editor`, S-5).
        host.$dialogQueue
            .removeDuplicates()
            .sink { [weak self] queue in
                Task { @MainActor in
                    guard let self else { return }
                    if let first = queue.first, first.id != self.lastDialogID {
                        self.lastDialogID = first.id
                        self.dialogAppeared(first)
                    } else if queue.isEmpty {
                        self.lastDialogID = nil
                    }
                    self.evaluateAttention()
                }
            }
            .store(in: &cancellables)

        // La notice est la dernière présentation `notify` (S-1).
        host.$journal
            .sink { [weak self] _ in
                Task { @MainActor in self?.refreshNotice() }
            }
            .store(in: &cancellables)

        // La présence de la fenêtre est une entrée de la décision (S-9).
        presence.isFrontmostPublisher
            .removeDuplicates()
            .sink { [weak self] _ in
                Task { @MainActor in self?.evaluateAttention() }
            }
            .store(in: &cancellables)

        // Fermeture de l'app : la conduite a son propre process à attendre.
        AppDelegate.terminateProject = { [weak self] in
            await self?.host.terminateForQuit()
        }
    }

    // MARK: - Disponibilités

    var canStartConduite: Bool { state == .none || state == .closed }
    var canCloseConduite: Bool { state == .starting || state == .live }
    var hasPendingDialog: Bool { !host.dialogQueue.isEmpty }
    var pendingDialog: RpcDialogRequest? { host.dialogQueue.first }
    var waitingDialogCount: Int { host.dialogQueue.count }

    /// La définition figée de S-9 : session vivante ET dialogue répondable.
    var awaitingUser: Bool { state == .live && !host.dialogQueue.isEmpty }

    var isProjectDone: Bool { project?.status == .done }

    /// Le statut de session, formulé par `SessionConsoleModel` (référence BR-3).
    var sessionStatusText: String {
        SessionConsoleModel.statusText(for: host.state, pid: host.pid, sessionId: host.sessionId)
    }

    // MARK: - Armement (S-1)

    static func isGitRepository(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.appendingPathComponent(".git").path)
    }

    /// « rogné, retours à la ligne remplacés par une espace, blancs consécutifs
    /// réduits à une espace, borné à 120 caractères » (S-1).
    static func normalizeName(_ raw: String) -> String {
        let collapsed = raw
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
        var result = collapsed.split(whereSeparator: { $0 == " " || $0 == "\t" }).joined(separator: " ")
        if result.count > 120 { result = String(result.prefix(120)) }
        return result
    }

    func startConduite(repoRoot: URL, name: String) async {
        guard canStartConduite else {
            refuse()
            return
        }
        state = .starting
        statusMessage = ""
        notice = nil
        let normalized = Self.normalizeName(name)
        guard !normalized.isEmpty else {
            state = .none
            return
        }
        guard Self.isGitRepository(repoRoot) else {
            state = .none
            statusMessage = ProjectViewText.notGitRepository
            return
        }
        do {
            try await host.start(mode: .rpcUI, projectRoot: repoRoot, resume: false)
            try await host.send(prompt: "/project " + normalized)
            identity = ConduiteIdentity(repoRoot: repoRoot, name: normalized)
            state = .live
            refreshProject()
            armDocWatch()
        } catch {
            state = .none
            identity = nil
            project = nil
            docText = nil
            statusMessage = (error as? SessionHostError)?.userMessage ?? String(describing: error)
        }
        evaluateAttention()
    }

    // MARK: - Refus et clôture (S-2)

    func refuse() {
        let name = identity?.name ?? ""
        let path = identity?.repoRoot.path ?? ""
        refusal = ConduiteRefusal(
            message: ProjectViewText.refusal(name: name, path: path),
            repositoryName: name,
            repositoryPath: path
        )
    }

    func dismissRefusal() {
        refusal = nil
    }

    func presentLaunchSheet() {
        guard canStartConduite else {
            refuse()
            return
        }
        if draftRepository == nil {
            draftRepository = ProjectRoot.resolve(defaults: defaults, fileManager: fileManager)
        }
        if draftName.isEmpty, let repo = draftRepository {
            draftName = repo.lastPathComponent
        }
        isLaunchSheetPresented = true
    }

    func chooseDraftRepository() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.prompt = "Choisir"
        panel.message = "Choisissez le dossier du projet à conduire."
        if let start = draftRepository { panel.directoryURL = start }
        guard panel.runModal() == .OK, let url = panel.url else { return }
        draftRepository = url
        draftName = url.lastPathComponent
    }

    var canCommitLaunch: Bool {
        canStartConduite && draftRepository != nil && !Self.normalizeName(draftName).isEmpty
    }

    func commitLaunch() {
        guard canCommitLaunch, let repo = draftRepository else { return }
        let name = draftName
        isLaunchSheetPresented = false
        Task { @MainActor in await startConduite(repoRoot: repo, name: name) }
    }

    func closeConduite() async {
        guard canCloseConduite else { return }
        state = .closing
        await host.stop()
        disarmDocWatch()
        project = nil
        docText = nil
        identity = nil
        prompt = ""
        dialogText = ""
        selectedOptionIndex = nil
        state = .closed
        evaluateAttention()
    }

    // MARK: - Lecture du projet et veille du document (S-7)

    /// Abonne le hub du magasin et arme la veille du document. Idempotent.
    func start() {
        guard hubTask == nil else { return }
        if hubStopped {
            hub = makeHub()
            hubStopped = false
        }
        let hub = self.hub
        hubTask = Task { [weak self] in
            for await snapshot in hub.snapshots() {
                guard let self else { return }
                self.latestSnapshot = snapshot
                self.applyProject(snapshot)
            }
        }
        if identity != nil { armDocWatch() }
    }

    /// Annule l'abonnement, arrête le hub et désarme la veille. Aucune scrutation
    /// ne prend le relais.
    func stop() {
        hubTask?.cancel()
        hubTask = nil
        hub.stop()
        hubStopped = true
        disarmDocWatch()
        if let id = attentionRequestID {
            attention.cancel(id)
            attentionRequestID = nil
        }
    }

    private func refreshProject() {
        if let snapshot = latestSnapshot {
            applyProject(snapshot)
        } else {
            applyProject(hub.current())
        }
    }

    private func applyProject(_ snapshot: StoreSnapshot) {
        guard let identity else {
            project = nil
            return
        }
        let key = ProjectPaths.key(forRoot: identity.repoRoot.path)
        let found = snapshot.projects.projects.first { $0.repoKey == key }
        project = found
        if let found { expandedSegments.insert(found.current) }
    }

    /// La présence de la fenêtre « Projet », alimentée par `WindowAccessor`.
    func attachWindow(_ window: NSWindow?) {
        presence.attach(window)
    }

    private func armDocWatch() {
        guard let identity else { return }
        let key = ProjectPaths.key(forRoot: identity.repoRoot.path)
        let path = ProjectPaths.docFile(stateDir: stateDir, repoKey: key)
        disarmDocWatch()
        let watcher = FileWatcher(path: path)
        docWatcher = watcher
        let changes = watcher.changes
        docTask = Task { [weak self] in
            for await _ in changes {
                guard let self else { return }
                self.readDoc(path: path)
            }
        }
        readDoc(path: path)
    }

    private func disarmDocWatch() {
        docTask?.cancel()
        docTask = nil
        docWatcher?.stop()
        docWatcher = nil
    }

    private func readDoc(path: String) {
        if let data = fileManager.contents(atPath: path) {
            docText = String(decoding: data, as: UTF8.self)
        } else {
            docText = nil
        }
    }

    // MARK: - Saisie libre et dialogues (S-4, S-5, S-6)

    var canSendText: Bool {
        state == .live
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

    func sendText() async {
        guard canSendText else { return }
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try await host.send(prompt: text)
            prompt = ""
        } catch {
            statusMessage = (error as? SessionHostError)?.userMessage ?? String(describing: error)
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
    /// part de son `prefill`, rien d'autre n'hérite du dialogue précédent (S-5).
    func dialogAppeared(_ dialog: RpcDialogRequest) {
        dialogText = dialog.method == .editor ? (dialog.prefill ?? "") : ""
        selectedOptionIndex = nil
    }

    private func answer(_ response: RpcDialogResponse) {
        do {
            try host.answer(response)
            dialogText = ""
            selectedOptionIndex = nil
        } catch {
            statusMessage = (error as? SessionHostError)?.userMessage ?? String(describing: error)
        }
    }

    // MARK: - Statut et attention

    private func hostStateChanged(_ hostState: SessionHost.State) {
        switch hostState {
        case .dead(let exit):
            if state == .live || state == .starting { state = .closed }
            statusMessage = SessionConsoleModel.statusText(for: .dead(exit: exit), pid: nil, sessionId: nil)
        case .stopped:
            if state == .live || state == .starting { state = .closed }
        case .failed(let message):
            statusMessage = message
        default:
            break
        }
        evaluateAttention()
    }

    private func refreshNotice() {
        let last = host.journal.last { entry in
            entry.kind == .presentation && entry.message.hasPrefix("présentation notify")
        }
        notice = last?.message
    }

    /// Applique `AttentionDecision.action(for:)` à chaque changement d'entrée
    /// (dialogue en attente, présence, statut du projet, état du host).
    private func evaluateAttention() {
        let input = AttentionInput(
            awaitingUser: awaitingUser,
            projectDone: project?.status == .done,
            windowFrontmost: presence.isFrontmost,
            activeRequest: attentionRequestID != nil
        )
        switch AttentionDecision.action(for: input) {
        case .none:
            break
        case .cancel:
            if let id = attentionRequestID {
                attention.cancel(id)
                attentionRequestID = nil
            }
        case .request(let kind):
            if let id = attentionRequestID {
                attention.cancel(id)
                attentionRequestID = nil
            }
            attentionRequestID = attention.request(kind)
        }
    }
}
