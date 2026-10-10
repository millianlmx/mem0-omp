// Le modèle de la fenêtre « Terminal » (S-1, S-7, S-8, S-9, S-10, BR-3 ; S-18 R6) :
// l'état de la fenêtre, le catalogue des répertoires choisis, et le câblage du
// shell de connexion hébergé au rendu. `omp` se lance À LA DEMANDE, tapé dans ce
// shell par « Lancer omp » : son binaire n'est pas un prérequis du terminal.
//
// Trois décisions structurent ce fichier :
//
//   1. Le modèle ne parle JAMAIS le protocole du PTY : il appelle le host et
//      traduit ses échecs en texte via `TerminalHostError.userMessage`, seule table
//      des échecs du terminal. Aucun état n'est laissé sans texte (S-10).
//   2. Aucun état partagé avec la session servie : le modèle ne connaît ni
//      `SessionConsoleModel` ni `ServiceSessionModel`, et `canStart` ne dépend que
//      de son propre état.
//   3. La sortie du PTY ne change pas l'ÉTAT : elle est accumulée dans l'émulateur
//      et signalée par une trame coalescée (au plus une par tour de boucle
//      principale), pour qu'un TUI bavard ne fasse pas re-rendre la fenêtre à
//      chaque octet.
//
// Le modèle vit à l'échelle de l'APP (`@StateObject` sur la structure `App`) :
// fermer la fenêtre ne laisse pas un shell orphelin, et l'accroche de terminaison
// existe avant la première ouverture de la fenêtre.

import AppKit
import Combine
import Foundation

@MainActor
final class TerminalConsoleModel: ObservableObject {
    /// Les états de la fenêtre (S-1). `starting` est publié avant le `forkpty`,
    /// `running` porte le pid de l'enfant DIRECT de l'app (BR-1).
    enum State: Equatable, Sendable {
        case idle
        case starting
        case running(pid: Int32)
        case exited(ProcessExit)
        case failed(String)
    }

    /// Les états de la feuille de choix (S-2). `empty` n'est pas un échec : le
    /// dépôt principal reste sélectionnable.
    enum TargetsState: Equatable, Sendable {
        case idle
        case loading
        case ready(Int)
        case empty
        case failed(String)
    }

    static let defaultColumns = 80
    static let defaultRows = 24

    @Published private(set) var state: State = .idle
    @Published private(set) var target: FilesTarget?
    @Published private(set) var emulator: TerminalEmulator?
    @Published private(set) var palette: TerminalPalette
    /// Le compteur de trames : la sortie du PTY ne change aucun état affichable,
    /// donc c'est lui qui réveille la vue (au plus une fois par tour de boucle).
    @Published private(set) var frameCount: Int = 0
    /// « Lancer omp » a été tapé dans le shell vivant : le sous-titre dit « omp ».
    /// Remis à faux à chaque nouveau shell.
    @Published private(set) var ompLaunched = false

    // MARK: - Feuille de choix

    @Published var isPickerPresented = false
    @Published var selectedTargetPath: String?
    @Published private(set) var targets: [FilesTarget] = []
    @Published private(set) var targetsState: TargetsState = .idle
    /// Le refus de S-2 (« Répertoire introuvable : … ») : la feuille reste OUVERTE,
    /// donc il ne peut pas vivre dans `state`.
    @Published private(set) var sheetError: String?

    // MARK: - Dépendances

    private let host: TerminalHost
    private let defaults: UserDefaults
    private let fileManager: FileManager
    private let environment: [String: String]
    private let store: StoreReader
    private let git: GitCLI?
    private let gitFailure: String?

    private var window: NSWindow?
    private var windowObserver: NSObjectProtocol?
    private var paletteObserver: NSObjectProtocol?
    private var pendingColumns = TerminalConsoleModel.defaultColumns
    private var pendingRows = TerminalConsoleModel.defaultRows
    private var frameScheduled = false
    /// Une fermeture (fenêtre ou ⌘Q) a été demandée : la sortie du process qui suit
    /// ne doit pas se présenter comme une fin subie par l'utilisateur.
    private var closeRequested = false

    /// `git == nil` déclenche la résolution du binaire, comme `FilesModel` : son
    /// échec ne lève pas, il pose le message de la feuille (aucun crash au lancement).
    init(
        host: TerminalHost = TerminalHost(),
        defaults: UserDefaults = .standard,
        fileManager: FileManager = .default,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        store: StoreReader = StoreReader(),
        git: GitCLI? = nil,
        palette: TerminalPalette? = nil
    ) {
        self.host = host
        self.defaults = defaults
        self.fileManager = fileManager
        self.environment = environment
        self.store = store
        self.palette = palette ?? TerminalPalette.live()
        if let git {
            self.git = git
            self.gitFailure = nil
        } else {
            let root = ProjectRoot.resolve(defaults: defaults, fileManager: fileManager)
            switch GitBinary.resolve(
                environment: environment,
                path: root?.path ?? "ce projet",
                fileManager: fileManager
            ) {
            case let .success(binary):
                self.git = GitCLI(binary: binary)
                self.gitFailure = nil
            case let .failure(error):
                self.git = nil
                self.gitFailure = error.userMessage
            }
        }

        host.onOutput = { [weak self] bytes in
            self?.receive(bytes)
        }
        host.onExit = { [weak self] exit in
            self?.handleExit(exit)
        }
        // Le fond peint et la réponse OSC 11 doivent rester LA MÊME couleur (S-4) :
        // la palette est recalculée quand l'app redevient active, seul moment où un
        // changement d'apparence système est observable sans dépendre d'une API non
        // documentée.
        paletteObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.refreshPalette() }
        }

        // Fermeture de l'app : c'est l'UNIQUE chemin de sortie (S-8), et il partage
        // sa séquence avec la fermeture de fenêtre (S-7).
        AppDelegate.terminateTerminal = { [weak self] in
            await self?.shutdown()
        }
        // Inventaire du Quitter (mac-quitter-sans-confirmation, S-1) : lu à la
        // demande de sortie, jamais suivi en continu.
        AppDelegate.terminalQuitActivity = { [weak self] in
            self?.quitActivity
        }
    }

    // Les observations posées ici visent un objet qui vit à l'échelle de l'app :
    // aucune n'est retirée à la disparition du modèle, qui n'en a pas. Celle de la
    // fenêtre, elle, est retirée à chaque fermeture (`detachWindow`).

    // MARK: - Disponibilités

    /// `false` dès qu'un lancement est en cours ou qu'un terminal vit : c'est le
    /// second verrou de l'unicité de S-1 (le premier étant la scène `Window`).
    var canStart: Bool {
        switch state {
        case .starting, .running: return false
        case .idle, .exited, .failed: return true
        }
    }

    var canRelaunch: Bool {
        switch state {
        case .exited, .failed: return target != nil
        case .idle, .starting, .running: return false
        }
    }

    var canOpenSelected: Bool {
        guard let selectedTargetPath else { return false }
        return targets.contains { $0.path == selectedTargetPath }
    }

    /// Le projet ouvert, celui dont on liste les worktrees (S-2) : la MÊME
    /// résolution que la fenêtre « Session OMP » et la visionneuse de fichiers.
    var projectPath: String? {
        ProjectRoot.resolve(defaults: defaults, fileManager: fileManager)?.path
    }

    var isRunning: Bool {
        if case .running = state { return true }
        return false
    }

    /// Une commande tourne au premier plan du shell vivant (S-2) : c'est elle, et
    /// non le shell au repos sur son invite, que le Quitter arrêtera.
    var quitActivity: QuitActivity? {
        guard isRunning, let command = host.foregroundCommand() else { return nil }
        return .terminalCommand(named: command.name)
    }

    /// « Lancer omp » n'a de sens que si un shell vit pour lire la commande. Le
    /// binaire `omp` n'est PAS résolu ici : s'il manque, le shell le dit.
    var canLaunchOmp: Bool { isRunning }

    // MARK: - Texte d'état (S-10)

    /// Chaque état a UN texte, et aucun n'est un rectangle vide. L'état `listing`
    /// de S-10 est celui de la fenêtre pendant que la feuille charge son catalogue.
    var statusText: String {
        switch state {
        case .idle:
            if case .loading = targetsState { return TerminalViewText.listing }
            return TerminalViewText.chooseHint
        case .starting:
            return TerminalViewText.starting
        case .running:
            return TerminalViewText.running
        case .exited:
            return TerminalViewText.exited
        case let .failed(message):
            return message
        }
    }

    /// Le titre de la fenêtre : le nom du répertoire du shell, « Terminal » tant
    /// qu'aucun n'a été choisi.
    var windowTitle: String {
        guard let target, state != .idle else { return TerminalViewText.windowTitle }
        return URL(fileURLWithPath: target.path).lastPathComponent
    }

    /// Le sous-titre : le programme au premier plan et l'état en un mot.
    var windowSubtitle: String {
        let word: String?
        switch state {
        case .idle: word = nil
        case .starting: word = TerminalViewText.stateStarting
        case .running: word = TerminalViewText.stateRunning
        case .exited: word = TerminalViewText.stateExited
        case .failed: word = TerminalViewText.stateFailed
        }
        let kind = ompLaunched && isRunning ? TerminalViewText.ompKind : TerminalViewText.shellKind
        return TerminalViewText.subtitle(kind: kind, state: word)
    }

    // MARK: - Lancement

    /// Lance le shell de connexion (`TerminalShell.command`) sur une cible du
    /// catalogue. Sans effet si un terminal vit déjà (AC-2) : c'est ce refus, et non
    /// la scène, qui garantit qu'aucun second shell n'est lancé.
    func start(target: FilesTarget) {
        guard canStart else { return }
        self.target = target
        ompLaunched = false
        guard isDirectory(target.path) else {
            state = .failed(TerminalViewText.cwdMissing(target.path))
            return
        }
        let shell = TerminalShell.command(environment: environment, fileManager: fileManager)

        state = .starting
        let emulator = TerminalEmulator(columns: pendingColumns, rows: pendingRows, palette: palette)
        emulator.onReply = { [weak self] bytes in
            self?.reply(bytes)
        }
        self.emulator = emulator
        do {
            try host.start(
                executable: shell.executable,
                arguments: shell.arguments,
                cwd: URL(fileURLWithPath: target.path),
                columns: pendingColumns,
                rows: pendingRows
            )
        } catch let error as TerminalHostError {
            self.emulator = nil
            state = .failed(error.userMessage)
            return
        } catch {
            self.emulator = nil
            // `TerminalHost.start` ne lève QUE des `TerminalHostError` (BR-1) : cette
            // branche est inatteignable et le dit, plutôt que d'inventer un état.
            state = .failed(String(describing: error))
            return
        }
        // Le pid est connu dès le `forkpty` (BR-1) : `running` décrit un process
        // vivant, pas une intention.
        state = .running(pid: host.pid ?? 0)
        publishFrame()
    }

    /// Relance depuis `exited`/`failed`, sur la MÊME cible : aucune nouvelle
    /// sélection, aucune préférence écrite.
    func relaunch() {
        guard canRelaunch, let target else { return }
        start(target: target)
    }

    /// « Lancer omp » : la commande est TAPÉE dans le shell, par le chemin de la
    /// frappe clavier — `omp` devient un job du shell, jamais un second enfant de
    /// l'app.
    func launchOmp() {
        guard canLaunchOmp else { return }
        send(keys: TerminalShell.launchOmpKeys)
        ompLaunched = true
    }

    // MARK: - Frappe et mesure

    /// Une frappe de S-5, déjà traduite en octets. La discipline de ligne du PTY
    /// fait de Ctrl-C un `SIGINT` pour le job au premier plan du shell, et une TUI
    /// en mode brut (omp) le reçoit comme `0x03` (BR-1) : l'app n'interprète rien.
    func send(keys bytes: [UInt8]) {
        guard isRunning else { return }
        do {
            try host.write(bytes)
        } catch let error as TerminalHostError {
            // Une écriture refusée par un process encore vivant est un état
            // affichable ; quand le process est mort, c'est `onExit` qui fait foi.
            if host.isRunning { state = .failed(error.userMessage) }
        } catch {
            // Inatteignable : le host ne lève que des `TerminalHostError`.
        }
    }

    /// La zone d'affichage a mesuré sa grille (S-6) : la taille est mémorisée, et
    /// appliquée au process quand il vit — jamais un `ioctl` par pixel, la vue
    /// coalesce déjà ses mesures.
    func viewDidMeasure(columns: Int, rows: Int) {
        let columns = max(columns, TerminalRenderView.minimumColumns)
        let rows = max(rows, TerminalRenderView.minimumRows)
        guard columns != pendingColumns || rows != pendingRows else { return }
        pendingColumns = columns
        pendingRows = rows
        guard isRunning else { return }
        host.resize(columns: columns, rows: rows)
        emulator?.resize(columns: columns, rows: rows)
        publishFrame()
    }

    private func receive(_ bytes: [UInt8]) {
        guard let emulator else { return }
        emulator.feed(bytes)
        publishFrame()
    }

    /// Les réponses de l'émulateur aux sondes de la TUI (DA1, CPR, OSC 11) partent
    /// sur le maître du PTY, au fil du parsing (S-3).
    private func reply(_ bytes: [UInt8]) {
        guard isRunning else { return }
        try? host.write(bytes)
    }

    private func publishFrame() {
        guard !frameScheduled else { return }
        frameScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.frameScheduled = false
            self.frameCount &+= 1
        }
    }

    private func handleExit(_ exit: ProcessExit) {
        if closeRequested {
            state = .idle
            return
        }
        switch state {
        case .starting, .running:
            state = .exited(exit)
        case .idle, .exited, .failed:
            break
        }
    }

    // MARK: - Feuille « Choisir un répertoire » (S-2)

    func openPicker() {
        sheetError = nil
        isPickerPresented = true
        Task { await loadTargets() }
    }

    func dismissPicker() {
        isPickerPresented = false
        sheetError = nil
    }

    func retryTargets() {
        guard case .failed = targetsState else { return }
        sheetError = nil
        Task { await loadTargets() }
    }

    /// Le catalogue est CELUI de la visionneuse de fichiers : `TargetCatalog.list`
    /// (dépôt principal d'abord, puis les worktrees `feat/*`). Aucune seconde
    /// énumération de worktrees n'existe ici.
    func loadTargets() async {
        targetsState = .loading
        targets = []
        selectedTargetPath = nil
        guard let git else {
            targetsState = .failed(gitFailure ?? TerminalViewText.noProject)
            return
        }
        guard let root = ProjectRoot.resolve(defaults: defaults, fileManager: fileManager) else {
            targetsState = .failed(TerminalViewText.noProject)
            return
        }
        do {
            let listed = try await TargetCatalog.list(git: git, store: store, projectRoot: root.path)
            targets = listed
            targetsState = listed.contains { !$0.isPrimary } ? .ready(listed.count) : .empty
            let canonicalRoot = canonicalPath(root.path)
            let preselected = listed.first { $0.path == canonicalRoot }
                ?? listed.first { $0.isPrimary }
                ?? listed.first
            selectedTargetPath = preselected?.path
        } catch {
            targetsState = .failed(FilesError.message(for: error))
        }
    }

    /// Ouvre la cible sélectionnée. Une cible disparue entre l'affichage et le clic
    /// est REFUSÉE sans fermer la feuille (S-2) : l'utilisateur en choisit une autre.
    func openSelectedTarget() {
        guard let path = selectedTargetPath, let chosen = targets.first(where: { $0.path == path }) else {
            return
        }
        guard isDirectory(chosen.path) else {
            sheetError = TerminalViewText.cwdMissing(chosen.path)
            return
        }
        isPickerPresented = false
        sheetError = nil
        start(target: chosen)
    }

    private func isDirectory(_ path: String) -> Bool {
        var isDirectory: ObjCBool = false
        return fileManager.fileExists(atPath: path, isDirectory: &isDirectory) && isDirectory.boolValue
    }

    // MARK: - Fermeture (S-7, S-8)

    /// Le pont `WindowAccessor` livre la fenêtre de la scène : le modèle observe SA
    /// fermeture, et rien d'autre. Une seule observation par fenêtre.
    func attach(window: NSWindow?) {
        guard let window, window !== self.window else { return }
        detachWindow()
        self.window = window
        windowObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.windowWillClose() }
        }
    }

    private func detachWindow() {
        if let windowObserver { NotificationCenter.default.removeObserver(windowObserver) }
        windowObserver = nil
        window = nil
    }

    /// Fermer la fenêtre tue le shell et ce qu'il a lancé — sans confirmation, sans
    /// alerte, et sans toucher à la session RPC (S-7, AC-10).
    func windowWillClose() {
        detachWindow()
        Task { @MainActor in await self.shutdown() }
    }

    /// ⌘Q : la MÊME séquence que la fermeture de fenêtre, jamais une seconde
    /// implémentation (S-8).
    func terminateForQuit() async {
        await shutdown()
    }

    private func shutdown() async {
        closeRequested = true
        // La fenêtre se ferme (ou l'app quitte) : l'image gelée de S-1 n'a plus de
        // sens, l'écran repart de l'accueil dès la demande de mort — pas après.
        emulator = nil
        await host.kill()
        state = .idle
        closeRequested = false
    }

    // MARK: - Palette (S-4)

    /// Recalcule la palette depuis l'apparence effective et la pose à l'émulateur :
    /// la réponse OSC 11 et la peinture gardent ainsi la même source.
    func refreshPalette() {
        let fresh = TerminalPalette.live()
        guard fresh != palette else { return }
        palette = fresh
        emulator?.palette = fresh
        publishFrame()
    }
}
