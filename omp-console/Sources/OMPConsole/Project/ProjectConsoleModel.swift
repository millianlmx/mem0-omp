// Le modèle de la vue « Projet » (S-1 … S-10, BR-1/BR-2/BR-4) : il possède la
// session servie de la conduite (comme `SessionConsoleModel` possède la sienne) et
// il est le SEUL endroit qui décide — armement, refus, clôture, dialogues,
// attention.
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
// l'identique, pas réinventées. La conversation suit le même patron (S-19 R3 de
// omp-console-redesign) : le fichier de session publié par `get_state`, lu par un
// `SessionViewerModel` — jamais les trames brutes, réservées à l'inspecteur.

import AppKit
import Combine
import ConsoleCore
import Foundation

@MainActor
final class ProjectConsoleModel: ObservableObject {
    let host: ServiceSessionModel

    // MARK: - État de la conduite

    @Published private(set) var state: ConduiteState = .none
    @Published private(set) var identity: ConduiteIdentity?
    /// Le SEUL texte d'échec affiché : le `userMessage` d'une erreur du service,
    /// ou le texte d'état de la session morte (`SessionConsoleModel.statusText`).
    @Published private(set) var statusMessage: String = ""
    /// La dernière notice publiée par le service (S-7), affichée telle quelle —
    /// jamais une trame brute.
    @Published private(set) var notice: String? {
        didSet { noticeBlocks = notice.map(MarkdownDocument.blocks) ?? [] }
    }
    /// La notice en blocs Markdown, analysée une fois par message : l'en-tête se
    /// réévalue à chaque trame reçue.
    private(set) var noticeBlocks: [MarkdownBlock] = []
    /// Le refus d'un second démarrage (S-2) — non nul ⇒ l'alerte est présentée.
    @Published private(set) var refusal: ConduiteRefusal?

    // MARK: - Saisie et dialogues

    @Published var prompt: String = ""
    @Published var dialogText: String = ""
    @Published var selectedOptionIndex: Int?
    /// L'inspecteur « Détails techniques » (session et journal) est ouvert.
    @Published var technicalShown = false
    /// La confirmation « Arrêter le pilotage » est présentée.
    @Published var isStopConfirmationPresented = false

    // MARK: - Conversation (S-19 R3)

    /// La conversation du fichier de session de l'hôte ; `nil` tant qu'aucun
    /// fichier n'est connu.
    @Published private(set) var conversation: SessionViewerModel?

    // MARK: - Feuille « Piloter un projet… » (aucun `@State` sous CLT seuls)

    @Published var isLaunchSheetPresented: Bool = false
    @Published var draftRepository: URL?
    @Published var draftName: String = ""

    // MARK: - Lecture du projet (BR-2)

    @Published private(set) var project: Project? {
        didSet { evaluateAttention() }
    }
    @Published private(set) var docText: String? {
        didSet { docBlocks = docText.map(MarkdownDocument.blocks) }
    }
    /// `PROJECT.md` en blocs Markdown, analysé UNE fois par version du texte (la
    /// vue se réévalue à chaque publication du modèle).
    private(set) var docBlocks: [MarkdownBlock]?
    /// Les segments dépliés dans le volet « Plan » (aucun `@State` sous CLT seuls).
    @Published var expandedSegments: Set<Int> = []

    // MARK: - Signal d'attention (BR-4)

    /// L'identifiant de la demande active, `nil` quand aucune ne l'est.
    @Published private(set) var attentionRequestID: Int?

    // MARK: - Suivi des PR (BR-2)

    /// Les lignes affichées, dans l'ordre du plan (S-1).
    @Published private(set) var prRows: [ProjectPRRow] = []
    /// L'échec de LECTURE du dernier rafraîchissement (S-7), jamais celui d'un geste.
    @Published private(set) var prFailure: String?
    /// L'échec ou le refus du DERNIER geste (S-4, S-5, S-6).
    @Published private(set) var prActionFailure: String?
    /// Une lecture est en cours (S-3 : jamais deux empilées).
    @Published private(set) var isRefreshingPRs = false
    /// La fusion proposée après une relecture fraîche (S-5), présentée en alerte.
    @Published private(set) var pendingMerge: PRMergeProposal?

    // MARK: - Dépendances

    private let attention: AttentionRequesting
    private let presence: any WindowFrontmostReporting
    private let stateDir: String
    private let defaults: UserDefaults
    private let fileManager: FileManager
    private let prService: (any PRServicing)?
    private let prServiceFailure: String?
    private let urlOpener: any URLOpening
    private let prRefreshInterval: Duration

    private var hub: StoreHub
    private let makeHub: () -> StoreHub
    private var hubTask: Task<Void, Never>?
    private var hubStopped = false
    private var latestSnapshot: StoreSnapshot?

    private var docWatcher: FileWatcher?
    private var docTask: Task<Void, Never>?
    /// L'identifiant du dialogue dont les contrôles ont déjà été initialisés.
    private var lastDialogID: String?

    /// Ce que le modèle sait de chaque PR suivie, entre deux rafraîchissements (S-7).
    private var prKnowledge: [String: PRKnowledge] = [:]
    /// La signature (`slug|url`) de la liste suivie : un changement déclenche un
    /// rafraîchissement immédiat (S-3).
    private var prFollowedSignature: [String] = []
    /// Le nombre de surfaces ouvertes : la boucle ne tourne que si au moins une l'est.
    private var prWatchHolders = 0
    private var prWatchTask: Task<Void, Never>?
    /// Le corps de la PR relu, employé par la fusion (S-6) — jamais exposé à la vue.
    private var pendingMergeBody = ""

    private let makeConversation: @MainActor (ViewerTarget) -> SessionViewerModel
    /// Le nom de la conduite en cours d'armement : le fichier de session est
    /// publié PENDANT l'armement, avant que `identity` ne soit posée.
    private var conversationTitle = ""
    private var cancellables: Set<AnyCancellable> = []

    init(
        host: ServiceSessionModel? = nil,
        attention: AttentionRequesting = SystemAttention(),
        presence: any WindowFrontmostReporting = ProjectWindowPresence(),
        stateDir: String = PipelineStore.stateDir(),
        prService: (any PRServicing)? = nil,
        urlOpener: any URLOpening = SystemURLOpener(),
        prRefreshInterval: Duration = .seconds(60),
        environment: [String: String] = ProcessInfo.processInfo.environment,
        defaults: UserDefaults = .standard,
        fileManager: FileManager = .default,
        makeConversation: @escaping @MainActor (ViewerTarget) -> SessionViewerModel = { SessionViewerModel(target: $0) }
    ) {
        let host = host ?? ServiceSessionModel(purpose: "project")
        self.host = host
        self.attention = attention
        self.presence = presence
        self.stateDir = stateDir
        self.defaults = defaults
        self.fileManager = fileManager
        self.makeConversation = makeConversation
        let hub = StoreHub(stateDir: stateDir)
        self.hub = hub
        self.makeHub = { StoreHub(stateDir: stateDir) }
        self.urlOpener = urlOpener
        self.prRefreshInterval = prRefreshInterval
        // Un service `nil` déclenche la résolution de `gh` (patron `FilesModel`) :
        // son échec ne lève pas, il pose le message de lecture.
        if let prService {
            self.prService = prService
            self.prServiceFailure = nil
        } else {
            switch GhBinary.resolve(environment: environment, fileManager: fileManager) {
            case let .success(binary):
                self.prService = GhPRService(cli: GhCLI(binary: binary))
                self.prServiceFailure = nil
            case let .failure(error):
                self.prService = nil
                self.prServiceFailure = error.userMessage
            }
        }
        self.prFailure = self.prServiceFailure

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

        // La notice est la dernière notice publiée par le service (S-7).
        host.$lastNotice
            .removeDuplicates()
            .sink { [weak self] message in
                Task { @MainActor in self?.notice = message }
            }
            .store(in: &cancellables)

        // La conversation suit le FICHIER de session (patron `SessionConsoleModel`) :
        // même fichier ⇒ même conversation, `nil` ⇒ plus de conversation. La
        // valeur reçue est la NOUVELLE (`@Published` émet avant d'écrire).
        host.$sessionFile
            .removeDuplicates()
            .sink { [weak self] file in
                Task { @MainActor in self?.follow(sessionFile: file) }
            }
            .store(in: &cancellables)

        // La présence de la fenêtre est une entrée de la décision (S-9).
        presence.isFrontmostPublisher
            .removeDuplicates()
            .sink { [weak self] _ in
                Task { @MainActor in self?.evaluateAttention() }
            }
            .store(in: &cancellables)

        // Fermeture de l'app : la session servie de la conduite est fermée (S-7).
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
        SessionConsoleModel.statusText(for: host.state)
    }

    /// L'état de la session en un mot et un ton, pour le badge de l'en-tête.
    var sessionStatus: ConsoleStatus {
        .of(session: host.state, hasProject: true)
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
        conversationTitle = normalized
        do {
            try await host.startConduite(repoRoot: repoRoot, name: normalized)
            identity = ConduiteIdentity(repoRoot: repoRoot, name: normalized)
            state = .live
            await host.refreshState()
            refreshProject()
            armDocWatch()
        } catch {
            state = .none
            identity = nil
            project = nil
            docText = nil
            statusMessage = ServiceSessionModel.userMessage(of: error)
        }
        evaluateAttention()
    }

    // MARK: - Refus et clôture (S-2)

    func refuse() {
        let name = identity?.name ?? ""
        let path = identity?.repoRoot.path ?? ""
        refusal = ConduiteRefusal(
            message: ProjectViewText.refusal(name: name, path: ConsoleFormat.path(path)),
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
        panel.message = "Choisissez le dossier du projet à piloter."
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
        notice = nil
        prompt = ""
        dialogText = ""
        selectedOptionIndex = nil
        prFollowedSignature = []
        pendingMerge = nil
        pendingMergeBody = ""
        prActionFailure = nil
        clearPRs()
        conversation?.stop()
        conversation = nil
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
        prWatchTask?.cancel()
        prWatchTask = nil
        prWatchHolders = 0
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
            reconcilePRs(with: nil)
            return
        }
        let key = ProjectPaths.key(forRoot: identity.repoRoot.path)
        let found = snapshot.projects.projects.first { $0.repoKey == key }
        project = found
        if let found { expandedSegments.insert(found.current) }
        reconcilePRs(with: found)
    }

    /// Réconcilie la connaissance des PR avec le plan : les slugs encore suivis avec
    /// la MÊME `prUrl` sont gardés, les autres oubliés (S-1) ; un changement de la
    /// liste suivie déclenche un rafraîchissement immédiat (S-3).
    private func reconcilePRs(with project: Project?) {
        let followed = followedPRs(of: project)
        prunePRKnowledge(followed)
        let signature = followed.map { "\($0.slug)|\($0.url)" }
        let changed = signature != prFollowedSignature
        prFollowedSignature = signature
        prRows = projectPRRows(followed: followed, knowledge: prKnowledge)
        if changed {
            Task { [weak self] in await self?.refreshPRs() }
        }
    }

    private func prunePRKnowledge(_ followed: [FollowedPR]) {
        let urls = Dictionary(uniqueKeysWithValues: followed.map { ($0.slug, $0.url) })
        prKnowledge = prKnowledge.filter { urls[$0.key] == $0.value.url }
    }

    // MARK: - Suivi des PR (BR-2)

    /// Attache une surface à la veille (S-3). Idempotent : deux surfaces ouvertes ne
    /// font tourner qu'UNE boucle.
    func attachPRWatch() {
        prWatchHolders += 1
        guard prWatchTask == nil else { return }
        prWatchTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refreshPRs()
                do {
                    try await Task.sleep(for: self.prRefreshInterval)
                } catch {
                    return
                }
            }
        }
    }

    /// Détache une surface : la boucle s'arrête quand la DERNIÈRE se ferme.
    func detachPRWatch() {
        prWatchHolders = max(0, prWatchHolders - 1)
        guard prWatchHolders == 0 else { return }
        prWatchTask?.cancel()
        prWatchTask = nil
    }

    /// Un rafraîchissement : les lectures des PR suivies sont CONCURRENTES, l'ordre
    /// d'affichage reste celui du plan. Aucun `gh` n'est lancé si l'état n'est pas
    /// vivant, si le projet manque ou si la liste suivie est vide (S-3) ; un
    /// rafraîchissement en cours n'est jamais empilé.
    func refreshPRs() async {
        guard !isRefreshingPRs else { return }
        guard state == .live, let project else {
            clearPRs()
            return
        }
        let followed = followedPRs(of: project)
        guard !followed.isEmpty else {
            clearPRs()
            return
        }
        isRefreshingPRs = true
        defer { isRefreshingPRs = false }
        prunePRKnowledge(followed)

        guard let prService else {
            prFailure = prServiceFailure
            prRows = projectPRRows(followed: followed, knowledge: prKnowledge)
            return
        }
        let directory = projectDirectory
        // Les lectures sont CONCURRENTES et hors du fil principal. Chaque lecture
        // dépose son résultat dans un collecteur verrouillé : la tâche détachée ne
        // REND rien (mesuré sur ce toolchain, Swift 6.4 CLT + `swift test -c release` :
        // un `Task`/`TaskGroup` qui rend un tuple portant une `String` corrompt
        // aléatoirement cette chaîne — groupes rendant zéro résultat, puis SIGSEGV
        // dans le hachage du dictionnaire de résultats).
        let collector = PRReadCollector()
        let reads = followed.map { pr -> Task<Void, Never> in
            Task.detached {
                do {
                    collector.store(pr.slug, .success(try await prService.read(prUrl: pr.url, in: directory)))
                } catch {
                    collector.store(pr.slug, .failure(GhError.from(error, command: "pr view")))
                }
            }
        }
        for read in reads { await read.value }
        let results = collector.results

        // S-7 : une erreur de lecture ne fait jamais disparaître une ligne ; elle
        // marque la connaissance périmée et remonte le message du PREMIER échec dans
        // l'ordre du plan.
        var firstFailure: String?
        for pr in followed {
            switch results[pr.slug] {
            case let .success(snapshot):
                prKnowledge[pr.slug] = PRKnowledge(snapshot: snapshot, freshness: .fresh, url: pr.url)
            case let .failure(error):
                if firstFailure == nil { firstFailure = error.userMessage }
                let existing = prKnowledge[pr.slug]?.snapshot
                prKnowledge[pr.slug] = PRKnowledge(
                    snapshot: existing,
                    freshness: existing == nil ? .unknown : .stale,
                    url: pr.url
                )
            case .none:
                break
            }
        }
        prFailure = firstFailure
        prRows = projectPRRows(followed: followed, knowledge: prKnowledge)
    }

    /// Ouvre l'URL d'une ligne dans le navigateur par défaut (S-4) : aucune
    /// normalisation, aucun appel réseau.
    func openPR(slug: String) {
        prActionFailure = nil
        guard let row = prRows.first(where: { $0.slug == slug }) else { return }
        guard let url = httpURL(row.url) else {
            prActionFailure = ProjectViewText.prNotOpenable(url: row.url)
            return
        }
        if !urlOpener.open(url) {
            prActionFailure = ProjectViewText.prOpenFailed(number: row.number)
        }
    }

    /// Relit la PR avant toute confirmation (S-5) : refuse si la relecture échoue ou
    /// si l'un des trois statuts frais n'est pas vert.
    func beginMerge(slug: String) async {
        pendingMerge = nil
        pendingMergeBody = ""
        prActionFailure = nil
        guard let row = prRows.first(where: { $0.slug == slug }) else { return }
        guard let prService else {
            prFailure = prServiceFailure
            return
        }
        let directory = projectDirectory
        do {
            let snapshot = try await prService.read(prUrl: row.url, in: directory)
            prKnowledge[slug] = PRKnowledge(snapshot: snapshot, freshness: .fresh, url: row.url)
            prRows = projectPRRows(followed: followedPRs(of: project), knowledge: prKnowledge)
            guard
                snapshot.checks.count == RequiredCheck.allCases.count,
                snapshot.checks.allSatisfy({ $0.state == .green })
            else {
                prActionFailure = ProjectViewText.prMergeRefused(number: row.number)
                return
            }
            pendingMerge = PRMergeProposal(
                slug: slug,
                number: row.number,
                title: snapshot.title,
                url: row.url,
                headOid: snapshot.headOid
            )
            pendingMergeBody = snapshot.body
        } catch {
            prFailure = GhError.from(error, command: "pr view").userMessage
            markPRStale(slug)
        }
    }

    /// Fusionne la PR proposée (S-6) : squash, sujet et corps de la PR, tête bornée
    /// au sha de la relecture. Un rafraîchissement immédiat suit, succès comme échec.
    func confirmMerge() async {
        guard let proposal = pendingMerge else { return }
        let body = pendingMergeBody
        pendingMerge = nil
        pendingMergeBody = ""
        prActionFailure = nil
        guard let prService else {
            prFailure = prServiceFailure
            return
        }
        do {
            try await prService.merge(
                prUrl: proposal.url,
                title: proposal.title,
                body: body,
                headOid: proposal.headOid,
                in: projectDirectory
            )
        } catch {
            let failure = GhError.from(error, command: "pr merge")
            prActionFailure = ProjectViewText.prMergeRejected(
                detail: failure.failureDetail,
                number: proposal.number
            )
        }
        await refreshPRs()
    }

    /// Annule la proposition sans autre effet.
    func cancelMerge() {
        pendingMerge = nil
        pendingMergeBody = ""
    }

    private var projectDirectory: String {
        identity?.repoRoot.path ?? project?.repoRoot ?? ""
    }

    private func markPRStale(_ slug: String) {
        guard let known = prKnowledge[slug] else { return }
        prKnowledge[slug] = PRKnowledge(
            snapshot: known.snapshot,
            freshness: known.snapshot == nil ? .unknown : .stale,
            url: known.url
        )
        prRows = projectPRRows(followed: followedPRs(of: project), knowledge: prKnowledge)
    }

    /// Aucune ligne, aucune connaissance, aucun message — l'état d'un projet absent
    /// ou d'une liste vide (S-3).
    private func clearPRs() {
        prKnowledge = [:]
        prRows = []
        prFailure = nil
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
            statusMessage = ServiceSessionModel.userMessage(of: error)
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

    /// Répond à l'escalade `dialogId` SI et seulement si elle est encore la tête de
    /// la file. Le contrôle et l'écriture sont dans la MÊME exécution synchrone :
    /// la file ne peut pas glisser entre les deux (S-4, S-5).
    func answer(dialogId: String, response: RpcDialogResponse) -> Bool {
        guard host.dialogQueue.first?.id == dialogId else { return false }
        answer(response)
        return true
    }

    private func answer(_ response: RpcDialogResponse) {
        Task { @MainActor in
            do {
                try await host.answer(response)
                dialogText = ""
                selectedOptionIndex = nil
            } catch {
                statusMessage = ServiceSessionModel.userMessage(of: error)
            }
        }
    }

    // MARK: - Conversation (S-19 R3)

    private func follow(sessionFile file: String?) {
        guard let file else {
            conversation?.stop()
            conversation = nil
            return
        }
        guard file != conversation?.target.sessionFile else { return }
        conversation?.stop()
        let title = identity?.name ?? conversationTitle
        conversation = makeConversation(ViewerTarget(sessionFile: file, title: title))
    }

    // MARK: - Statut et attention

    private func hostStateChanged(_ hostState: ServiceSessionModel.State) {
        switch hostState {
        case .dead:
            if state == .live || state == .starting { state = .closed }
            statusMessage = SessionConsoleModel.statusText(for: .dead)
        case .stopped:
            if state == .live || state == .starting { state = .closed }
        case .failed(let message):
            statusMessage = message
        default:
            break
        }
        evaluateAttention()
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
