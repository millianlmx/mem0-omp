// L'état observable de la section « Fichiers » : quelle cible est active, quel
// arbre elle porte, quel document est affiché, et pourquoi rien ne l'est (S-1 à
// S-7).
//
// Trois canaux de message, et chacun a UN sens (une erreur, un texte) :
//  - `errorMessage` : rien à afficher du tout (git introuvable, hors dépôt,
//    `ls-files` en échec, cible disparue) — la vue rend un `ContentUnavailableView` ;
//  - `notice` : la vue reste utilisable (échec d'armement de la veille) — bandeau ;
//  - `diffFailure` : le diff SEUL a échoué (sha de base inconnu, objet corrompu) —
//    le contenu du fichier reste lisible.
//
// Aucune scrutation : la seule horloge est celle de la veille FSEvents (S-7), et le
// seul délai est l'anti-rebond de 300 ms qui suit un lot d'événements.

import Combine
import Foundation

@MainActor
final class FilesModel: ObservableObject {
    /// Ce que la colonne de droite affiche. Activer un accès dédié remplace le
    /// document ET désélectionne la ligne d'arbre : l'état n'est plus un fichier.
    enum Pane: Equatable {
        case none
        case file(FilesEntry)
        case contract
        case projectDocument
    }

    /// Les deux documents de pilotage, atteints HORS arbre : le contrat est ignoré
    /// par git, il ne peut donc pas figurer dans l'arbre (S-6).
    /// `nonisolated` : ce sont des constantes, lisibles depuis les textes comme
    /// depuis les tests, sans passer par le fil principal.
    nonisolated static let contractRelativePath = ".omp/pipeline/contract.md"
    nonisolated static let projectDocumentRelativePath = "PROJECT.md"

    /// L'anti-rebond de S-7 : un lot d'événements ne déclenche qu'un rechargement
    /// par 300 ms d'accalmie, quelle que soit la rafale (checkout, build).
    static let watchDebounceMilliseconds = 300

    @Published private(set) var projectRoot: URL?
    @Published private(set) var targets: [FilesTarget] = []
    @Published private(set) var target: FilesTarget?
    @Published private(set) var tree: FilesTree?
    /// L'état de dépliage vit ici, jamais dans un `@State` (interdit sous les CLT).
    @Published private(set) var expanded: Set<String> = []
    @Published private(set) var highlight: String?
    @Published private(set) var pane: Pane = .none
    @Published private(set) var diff: FilesDiff?
    /// La base employée pour le document affiché : « HEAD », « base <sha7> » — ou la
    /// raison pour laquelle il n'y a pas de diff.
    @Published private(set) var diffBase: FilesBase?
    @Published private(set) var content: FilesContent?
    @Published private(set) var diffFailure: String?
    @Published private(set) var notice: String?
    @Published private(set) var errorMessage: String?
    @Published private(set) var isLoading = false
    /// Ce que montre le document (S-18 R5) : rendu ou source d'un Markdown, contenu
    /// d'un fichier de code, diff. Le choix survit au changement de fichier ; un
    /// mode indisponible pour le document affiché se résout par `effective(in:)`.
    @Published var documentMode: FilesDocumentMode = .content

    /// L'arbre de la vue (vide tant que rien n'est chargé).
    var nodes: [FilesNode] { tree?.nodes ?? [] }

    private let git: GitCLI?
    private let gitFailure: String?
    private let store: StoreReader
    private let defaults: UserDefaults
    private let fileManager: FileManager

    /// Le numéro de chargement courant : un résultat dont la génération n'est plus la
    /// courante est ÉCARTÉ — un aller-retour git lent ne peut pas écraser un état
    /// plus récent (S-7).
    private var generation = 0
    private var watcher: TreeWatcher?
    private var watchedPath: String?
    private var watchTask: Task<Void, Never>?
    private var debounceTask: Task<Void, Never>?

    /// `git == nil` déclenche la résolution du binaire : son échec ne lève pas, il
    /// pose `errorMessage` (aucun crash au lancement de l'app).
    ///
    /// `projectRoot` et `environment` sont injectables pour les preuves : un test
    /// fixe le projet ET un `PATH` sans git, sans toucher aux préférences de la
    /// machine.
    init(
        projectRoot: URL? = ProjectRoot.resolve(defaults: .standard, fileManager: .default),
        git: GitCLI? = nil,
        store: StoreReader = StoreReader(),
        defaults: UserDefaults = .standard,
        fileManager: FileManager = .default,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.projectRoot = projectRoot
        self.store = store
        self.defaults = defaults
        self.fileManager = fileManager
        if let git {
            self.git = git
            self.gitFailure = nil
        } else {
            switch GitBinary.resolve(
                environment: environment,
                path: projectRoot?.path ?? "ce projet",
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
        self.errorMessage = self.gitFailure
    }

    // MARK: - Rechargements

    /// Recharge tout : le projet (la fenêtre « Session OMP » a pu le changer), le
    /// catalogue des cibles, l'arbre de la cible active, puis son document.
    func refresh() async {
        followProjectRoot()
        guard let git else {
            errorMessage = gitFailure
            return
        }
        guard let projectRoot else {
            errorMessage = nil
            notice = nil
            targets = []
            target = nil
            publish(tree: nil)
            resetDocument()
            stopWatching()
            return
        }
        errorMessage = nil
        isLoading = true
        generation += 1
        let generation = self.generation
        defer { if generation == self.generation { isLoading = false } }

        do {
            let listed = try await TargetCatalog.list(git: git, store: store, projectRoot: projectRoot.path)
            guard generation == self.generation else { return }
            targets = listed
            // Une cible dont le répertoire a disparu sort du catalogue (S-1 : jamais
            // une cible morte) ; si c'était la cible active, on le DIT au lieu de
            // basculer en silence sur le principal (S-7).
            let vanished = target.flatMap { current in
                listed.contains { $0.path == current.path } ? nil : current.path
            }
            let chosen = chooseTarget(from: listed)
            target = chosen
            guard let chosen else {
                publish(tree: nil)
                stopWatching()
                return
            }
            try await load(target: chosen, git: git, generation: generation)
            if let vanished {
                notice = FilesError.targetGone(path: vanished).userMessage
            }
        } catch {
            guard generation == self.generation else { return }
            errorMessage = FilesError.message(for: error)
            targets = []
            target = nil
            publish(tree: nil)
            resetDocument()
            stopWatching()
        }
    }

    /// La cible active, à partir de la liste fournie : celle déjà choisie si elle
    /// existe encore, sinon celle du projet ouvert, sinon le principal.
    private func chooseTarget(from listed: [FilesTarget]) -> FilesTarget? {
        if let current = target, let kept = listed.first(where: { $0.path == current.path }) {
            return kept
        }
        if let root = projectRoot?.path {
            let canonical = canonicalPath(root)
            if let matching = listed.first(where: { $0.path == canonical }) {
                return matching
            }
        }
        return listed.first { $0.isPrimary } ?? listed.first
    }

    /// Le projet peut avoir changé dans la fenêtre « Session OMP » : la préférence
    /// partagée est relue à chaque rechargement, et un projet différent repart d'un
    /// état neuf (les cibles et les chemins d'un autre projet n'ont aucun sens ici).
    private func followProjectRoot() {
        let resolved = ProjectRoot.resolve(defaults: defaults, fileManager: fileManager)
        guard resolved?.path != projectRoot?.path else { return }
        projectRoot = resolved
        targets = []
        target = nil
        expanded = []
        publish(tree: nil)
        resetDocument()
        stopWatching()
    }

    /// Charge l'arbre d'une cible, arme sa veille, puis relit le document affiché.
    private func load(target: FilesTarget, git: GitCLI, generation: Int) async throws {
        guard fileManager.fileExists(atPath: target.path) else {
            throw FilesError.targetGone(path: target.path)
        }
        let fresh = try await readTree(target: target, git: git)
        guard generation == self.generation else { return }
        publish(tree: fresh)
        armWatch(target: target)
        try await loadDocument(target: target, git: git, generation: generation)
    }

    /// Les deux `ls-files` de S-2, dans la cible, puis la construction de l'arbre à
    /// partir de ce que le disque dit réellement de chaque chemin.
    private func readTree(target: FilesTarget, git: GitCLI) async throws -> FilesTree {
        let tracked = try await git.run(GitCommand.lsTracked(), in: target.path)
        try requireSuccess(tracked, command: "ls-files")
        let untracked = try await git.run(GitCommand.lsUntracked(), in: target.path)
        try requireSuccess(untracked, command: "ls-files")
        return FilesTree.build(
            tracked: nulSeparated(tracked.stdout),
            untracked: nulSeparated(untracked.stdout),
            disk: { filesDiskState(joinPath(target.path, $0), fileManager: self.fileManager) }
        )
    }

    /// Le document de droite : diff et/ou contenu, selon le geste.
    private func loadDocument(target: FilesTarget, git: GitCLI, generation: Int) async throws {
        switch pane {
        case .none:
            return

        case let .file(entry):
            diffBase = target.base
            diffFailure = nil
            if let argument = target.base.gitArgument {
                let command = entry.kind == .untracked
                    ? GitCommand.diffUntracked(path: entry.path)
                    : GitCommand.diffTracked(base: argument, path: entry.path)
                let output = try await git.run(command, in: target.path)
                guard generation == self.generation else { return }
                // La forme `--no-index` implique `--exit-code` : 1 veut dire « il y a
                // des différences », et c'est un succès (S-4).
                try requireSuccess(output, command: "diff", accepted: entry.kind == .untracked ? [0, 1] : [0])
                publish(diff: FilesDiff.parse(output.stdout))
            } else {
                publish(diff: nil)
            }
            publish(content: FilesReader.read(path: joinPath(target.path, entry.path), fileManager: fileManager))

        case .contract:
            diffBase = nil
            diffFailure = nil
            publish(diff: nil)
            publish(content: FilesReader.read(
                path: joinPath(target.path, Self.contractRelativePath),
                fileManager: fileManager
            ))

        case .projectDocument:
            diffBase = nil
            diffFailure = nil
            publish(diff: nil)
            publish(content: FilesReader.read(
                path: joinPath(target.path, Self.projectDocumentRelativePath),
                fileManager: fileManager
            ))
        }
    }

    // MARK: - Gestes

    /// Change de cible : l'arbre et le document sont rechargés pour la nouvelle.
    func select(target newTarget: FilesTarget) {
        guard newTarget.path != target?.path else { return }
        target = newTarget
        expanded = []
        stopWatching()
        generation += 1
        Task { [weak self] in await self?.reloadCurrentTarget() }
    }

    /// Ouvre un fichier de l'arbre en lecture seule (S-3, S-4, S-5).
    func select(file entry: FilesEntry) {
        pane = .file(entry)
        highlight = entry.path
        generation += 1
        Task { [weak self] in await self?.reloadCurrentDocument() }
    }

    /// La sélection telle que la `List` l'écrit : un chemin, résolu en entrée.
    func select(path: String) {
        guard let entry = tree?.entries.first(where: { $0.path == path }) else { return }
        select(file: entry)
    }

    /// Active l'accès dédié au contrat de la cible active (S-6).
    func openContract() {
        openDedicated(.contract)
    }

    /// Active l'accès dédié à `PROJECT.md` de la cible active (S-6).
    func openProjectDocument() {
        openDedicated(.projectDocument)
    }

    private func openDedicated(_ pane: Pane) {
        self.pane = pane
        highlight = nil
        generation += 1
        Task { [weak self] in await self?.reloadCurrentDocument() }
    }

    /// Replie ou déplie un répertoire. Le `DisclosureGroup` écrit la NOUVELLE valeur
    /// dans son `Binding` ; comme le getter lit l'état courant, inverser ici produit
    /// exactement cette valeur.
    func toggle(directory path: String) {
        if expanded.contains(path) {
            expanded.remove(path)
        } else {
            expanded.insert(path)
        }
    }

    /// Libère la veille quand la vue disparaît (S-7) : l'état, lui, reste.
    func suspend() {
        stopWatching()
    }

    private func reloadCurrentTarget() async {
        guard let git, let target else { return }
        isLoading = true
        let generation = self.generation
        defer { if generation == self.generation { isLoading = false } }
        do {
            try await load(target: target, git: git, generation: generation)
        } catch {
            guard generation == self.generation else { return }
            // La liste des cibles reste affichée : c'est elle qui permet d'en
            // choisir une autre quand celle-ci a disparu.
            errorMessage = FilesError.message(for: error)
            publish(tree: nil)
            resetDocument()
            stopWatching()
        }
    }

    private func reloadCurrentDocument() async {
        guard let git, let target else { return }
        isLoading = true
        let generation = self.generation
        defer { if generation == self.generation { isLoading = false } }
        do {
            try await loadDocument(target: target, git: git, generation: generation)
        } catch {
            guard generation == self.generation else { return }
            publish(diff: nil)
            diffFailure = FilesError.message(for: error)
        }
    }

    // MARK: - Publication (uniquement si l'instantané a changé)

    private func publish(tree fresh: FilesTree?) {
        guard tree != fresh else { return }
        tree = fresh
        if let fresh {
            var directories: Set<String> = []
            for node in fresh.nodes { collectDirectories(node, into: &directories) }
            expanded.formIntersection(directories)
        }
    }

    private func publish(diff fresh: FilesDiff?) {
        guard diff != fresh else { return }
        diff = fresh
    }

    private func publish(content fresh: FilesContent?) {
        guard content != fresh else { return }
        content = fresh
    }

    private func collectDirectories(_ node: FilesNode, into directories: inout Set<String>) {
        guard node.isDirectory else { return }
        directories.insert(node.path)
        for child in node.children { collectDirectories(child, into: &directories) }
    }

    private func resetDocument() {
        pane = .none
        highlight = nil
        diff = nil
        diffBase = nil
        content = nil
        diffFailure = nil
    }

    private func requireSuccess(_ output: GitOutput, command: String, accepted: Set<Int32> = [0]) throws {
        guard accepted.contains(output.code) else {
            throw FilesError.commandFailed(
                command: command,
                code: output.code,
                detail: FilesError.lastLine(output.stderr)
            )
        }
    }

    // MARK: - Veille de la cible active

    /// Arme la veille sur la racine de la cible — jamais deux fois sur la même. Un
    /// échec d'armement est DIT (S-7), sinon la vue laisserait croire que la cible
    /// est surveillée.
    private func armWatch(target: FilesTarget) {
        guard watchedPath != target.path else { return }
        stopWatching()
        let watcher = TreeWatcher(watch: target.path)
        self.watcher = watcher
        watchedPath = target.path
        notice = watcher.isArmed ? nil : FilesError.watchFailed(path: target.path).userMessage
        watchTask = Task { [weak self] in
            for await _ in watcher.changes() {
                guard let self else { return }
                self.scheduleWatchReload()
            }
        }
    }

    private func stopWatching() {
        debounceTask?.cancel()
        debounceTask = nil
        watchTask?.cancel()
        watchTask = nil
        watcher?.stop()
        watcher = nil
        watchedPath = nil
    }

    /// Un lot d'événements : un rechargement après 300 ms d'accalmie, jamais un par
    /// fichier. `refresh()` relit le catalogue, l'arbre ET le document (S-7), et
    /// `publish` ne pousse que ce qui a changé.
    private func scheduleWatchReload() {
        debounceTask?.cancel()
        debounceTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(Self.watchDebounceMilliseconds))
            guard !Task.isCancelled, let self else { return }
            await self.refresh()
        }
    }
}

extension FilesModel.Pane {
    /// Le chemin relatif du document affiché, d'où se déduit sa langue.
    var documentPath: String? {
        switch self {
        case .none: nil
        case let .file(entry): entry.path
        case .contract: FilesModel.contractRelativePath
        case .projectDocument: FilesModel.projectDocumentRelativePath
        }
    }
}

/// Les vues d'un document (S-18 R5). `content` est le RENDU d'un Markdown et la
/// visionneuse de code de tout autre fichier ; `source` n'existe que pour un
/// Markdown ; `diff` que pour un fichier de l'arbre (les documents dédiés n'ont
/// pas de diff).
enum FilesDocumentMode: Hashable, Sendable {
    case content
    case source
    case diff

    static func available(isMarkdown: Bool, hasDiff: Bool) -> [FilesDocumentMode] {
        var modes: [FilesDocumentMode] = [.content]
        if isMarkdown { modes.append(.source) }
        if hasDiff { modes.append(.diff) }
        return modes
    }

    /// Le mode réellement montré : le choix s'il est offert, sinon le contenu.
    func effective(in available: [FilesDocumentMode]) -> FilesDocumentMode {
        available.contains(self) ? self : .content
    }
}
