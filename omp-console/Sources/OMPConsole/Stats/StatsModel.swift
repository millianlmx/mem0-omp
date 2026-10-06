// Le modèle de la fenêtre « Statistiques » (S-6) : il s'abonne au flux global du
// magasin, tient les lecteurs de session et les veilles de fichier des runs
// vivants du projet affiché, et publie le tableau.
//
// Trois sources de réveil, aucune scrutation :
//   1. le magasin (`StoreHub.snapshots()`) : un run apparaît, se clôt, change de
//      phase ;
//   2. le fichier de session de chaque run VIVANT du projet affiché
//      (`FileWatcher`) : les tokens et les tours montent dès l'écriture ;
//   3. le temps : les durées sont recalculées à l'instant de rendu par la vue
//      (`TimelineView`), pas ici.
//
// `start()`/`stop()` sont idempotents (patron `KanbanModel`), et un hub arrêté ne
// se rouvre pas — un `start()` suivant en construit un neuf sur le même magasin.

import Combine
import ConsoleCore
import Foundation

@MainActor
final class StatsModel: ObservableObject {
    /// L'état publié : `loading` jusqu'au premier instantané.
    @Published private(set) var state: StatsViewState = .loading
    /// Les projets du magasin, dans l'ordre `projectOrder`, pour le sélecteur.
    @Published private(set) var projects: [StatsProjectOption] = []
    /// La clé du projet affiché. `nil` = le premier de l'ordre `projectOrder`.
    @Published private(set) var selectedKey: String?
    /// Le tri du tableau des runs. Vide = l'ordre de S-1 (features puis runs).
    @Published var sortOrder: [KeyPathComparator<StatsRow>] = []

    /// Comment ouvrir un abonnement NEUF : un `StoreHub` arrêté ne se rouvre pas.
    private let makeHub: () -> StoreHub
    private var hub: StoreHub
    private var task: Task<Void, Never>?

    let stateDir: String

    private var latest: StoreSnapshot?
    /// Un `SessionReader` par `sessionFile` vu, conservé tant que le run est dans
    /// le projet affiché.
    private var readers: [String: SessionReader] = [:]
    /// Une veille par `sessionFile` de run vivant du projet affiché.
    private var watchers: [String: FileWatcher] = [:]
    private var watchTasks: [String: Task<Void, Never>] = [:]
    private var hubStopped = false

    init(stateDir: String = PipelineStore.stateDir()) {
        self.stateDir = stateDir
        let hub = StoreHub(stateDir: stateDir)
        self.hub = hub
        self.makeHub = { StoreHub(stateDir: hub.stateDir, nowMs: hub.nowMs) }
        // La sélection initiale suit la préférence partagée (`session.projectRoot`),
        // puis le premier projet de l'ordre `projectOrder` (repli de `statsBoard`).
        if let root = ProjectRoot.resolve(defaults: .standard, fileManager: .default) {
            selectedKey = ProjectPaths.key(forRoot: root.path)
        }
    }

    /// Le nombre de veilles armées : une mesure des tests (jamais affichée).
    var activeWatchCount: Int { watchers.count }
    /// Les sessions veillées : une mesure des tests.
    var watchedSessionFiles: Set<String> { Set(watchers.keys) }
    /// Le nombre de lecteurs conservés : une mesure des tests.
    var retainedReaderCount: Int { readers.count }

    /// S'abonne au flux global en UNE tâche de longue durée. Idempotent.
    func start() {
        guard task == nil else { return }
        if hubStopped {
            hub = makeHub()
            hubStopped = false
        }
        apply(hub.current())
        let hub = self.hub
        task = Task { [weak self] in
            for await snapshot in hub.snapshots() {
                guard let self else { return }
                self.apply(snapshot)
            }
        }
    }

    /// Annule l'abonnement, arrête le hub, les veilles et les tâches. Idempotent.
    func stop() {
        task?.cancel()
        task = nil
        hub.stop()
        hubStopped = true
        stopWatches()
    }

    deinit { task?.cancel() }

    /// Change le projet affiché (seul point de mutation de la sélection).
    func selectProject(_ key: String) {
        guard key != selectedKey else { return }
        selectedKey = key
        rebuild()
    }

    // MARK: - Construction

    private func apply(_ snapshot: StoreSnapshot) {
        latest = snapshot
        rebuild()
    }

    private func rebuild() {
        guard let snapshot = latest else {
            state = .loading
            return
        }
        projects = statsProjectOptions(snapshot)
        let board = statsBoard(snapshot: snapshot, selectedKey: selectedKey, read: readMetrics)
        if snapshot.root == .absent {
            state = .storeAbsent(dir: stateDir)
        } else if let board {
            state = board.project.features.isEmpty ? .empty : .board(board)
        } else {
            state = .noProject(dir: stateDir)
        }
        syncWatches(snapshot: snapshot)
    }

    /// Le projet affiché du dernier instantané.
    private func displayedProject(_ snapshot: StoreSnapshot) -> Project? {
        statsDisplayedProject(snapshot, selectedKey: selectedKey)
    }

    /// Lit (ou relit) la session d'un run et rend son état de métriques.
    private func readMetrics(_ sessionFile: String) -> RunMetricsState {
        let reader: SessionReader
        if let existing = readers[sessionFile] {
            reader = existing
        } else {
            let fresh = SessionReader(path: sessionFile)
            readers[sessionFile] = fresh
            reader = fresh
        }

        let delta = reader.read()
        if let issue = delta.issue {
            if let reason = statsUnreadableReason(issue) { return .unreadable(reason) }
            // Réécriture (`truncated`/`replaced`) : jamais montrée — lecteur NEUF
            // PUIS relecture immédiate dans la même passe (règle `SessionViewerModel`).
            let fresh = SessionReader(path: sessionFile)
            readers[sessionFile] = fresh
            let reread = fresh.read()
            if let issue = reread.issue, let reason = statsUnreadableReason(issue) {
                return .unreadable(reason)
            }
            return .measured(sessionMetrics(fresh.conversation))
        }
        return .measured(sessionMetrics(reader.conversation))
    }

    // MARK: - Veilles et lecteurs

    /// Ré-arme les veilles quand l'ensemble des runs vivants du projet affiché
    /// change, et libère les lecteurs qui ne sont plus dans le projet affiché.
    private func syncWatches(snapshot: StoreSnapshot) {
        // Les runs de TOUTES les features du plan du projet affiché — listées ou
        // non : un run vivant dont la session n'existe pas encore doit être veillé
        // pour que son apparition réveille le tableau.
        var retained: Set<String> = []
        var watched: Set<String> = []
        if let project = displayedProject(snapshot) {
            for planFeature in statsPlan(of: snapshot, project: project) {
                for run in planFeature.runs {
                    retained.insert(run.sessionFile)
                    if storeRunIsLive(run) { watched.insert(run.sessionFile) }
                }
            }
        }

        for file in Array(readers.keys) where !retained.contains(file) {
            readers.removeValue(forKey: file)
        }

        for (file, watcher) in Array(watchers) where !watched.contains(file) {
            watcher.stop()
            watchTasks.removeValue(forKey: file)?.cancel()
            watchers.removeValue(forKey: file)
        }
        for file in watched where watchers[file] == nil {
            let watcher = FileWatcher(path: file)
            watchers[file] = watcher
            let changes = watcher.changes
            watchTasks[file] = Task { [weak self] in
                for await _ in changes {
                    guard let self else { return }
                    self.rebuild()
                }
            }
        }
    }

    private func stopWatches() {
        for watcher in watchers.values { watcher.stop() }
        watchers.removeAll()
        for task in watchTasks.values { task.cancel() }
        watchTasks.removeAll()
    }
}
