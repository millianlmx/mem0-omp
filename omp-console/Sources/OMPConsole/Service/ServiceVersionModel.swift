// L'écart de version entre le service OMP en marche et le module omp-mem0-req
// installé (S-4 de service-version-drift-detection, BR-2) : l'Accueil avertit
// quand le service exécute une autre version que celle du module sur disque, ou
// n'en annonce aucune, et invite à lancer `/service install` dans OMP.
//
// Chaque contrôle relit DEUX faits, jamais mis en cache : la version du module
// installé (`~/.omp/plugins/node_modules/omp-mem0-req/package.json`) et
// l'endpoint publié dans `service.json`. Le seul réveil est la republication de
// `service.json` (`FileWatcher`, tmp+rename de `writeService`) : un service
// relancé à la bonne version efface l'avertissement sans relancer l'app. Le
// package.json installé n'est pas veillé (non-objectif) : il est relu au
// prochain réveil.
//
// Toute absence ou erreur (service arrêté, 401, injoignable, réponse malformée,
// module installé illisible) se tait : l'avertissement ne parle que d'un écart
// CONSTATÉ.

import Combine
import ConsoleCore
import Foundation

@MainActor
final class ServiceVersionModel: ObservableObject {
    /// Le texte du bandeau (`SetupText.serviceVersionDrift`), `nil` sans écart.
    @Published private(set) var warning: String?

    private let stateDir: String
    private let installedPackagePath: String
    private let makeClient: @Sendable (ServiceEndpoint) -> ServiceClient
    private var changes: AsyncStream<Void>?
    private var watcher: FileWatcher?
    private var watchTask: Task<Void, Never>?
    /// Seul le dernier contrôle lancé publie : un contrôle plus ancien qui finit
    /// après lui n'écrase pas sa réponse.
    private var generation = 0

    init(
        stateDir: String = ServiceLocator.stateDir(),
        installedPackagePath: String = ServiceVersionModel.installedPackagePath(home: NSHomeDirectory()),
        makeClient: @escaping @Sendable (ServiceEndpoint) -> ServiceClient = { ServiceClient(endpoint: $0) },
        changes: AsyncStream<Void>? = nil
    ) {
        self.stateDir = stateDir
        self.installedPackagePath = installedPackagePath
        self.makeClient = makeClient
        self.changes = changes
    }

    deinit {
        watchTask?.cancel()
    }

    /// Le package.json du module installé, au lien d'install d'OMP
    /// (`pluginsInstallRoot` de omp-mem0-req/runs.ts).
    nonisolated static func installedPackagePath(home: String) -> String {
        home + "/.omp/plugins/node_modules/omp-mem0-req/package.json"
    }

    /// Un premier contrôle, puis un contrôle à chaque republication de
    /// `service.json`. Idempotent : un second appel ne rouvre rien.
    func start() {
        guard watchTask == nil else { return }
        let stream: AsyncStream<Void>
        if let changes {
            stream = changes
        } else {
            let watcher = FileWatcher(path: ServiceLocator.filePath(stateDir: stateDir))
            self.watcher = watcher
            stream = watcher.changes
        }
        changes = nil
        watchTask = Task { [weak self] in
            await self?.check()
            for await _ in stream {
                guard let self else { return }
                await self.check()
            }
        }
    }

    /// Compare la version annoncée par le service vivant à celle du module
    /// installé, et ne publie que si l'avertissement change.
    func check() async {
        generation += 1
        let current = generation
        let fresh = await driftWarning()
        guard current == generation, fresh != warning else { return }
        warning = fresh
    }

    private func driftWarning() async -> String? {
        guard let installed = installedVersion(),
              let endpoint = ServiceLocator.endpoint(stateDir: stateDir) else { return nil }
        let running: String?
        do {
            running = try await makeClient(endpoint).pluginVersion()
        } catch {
            return nil
        }
        if running == installed { return nil }
        return SetupText.serviceVersionDrift(running: running, installed: installed)
    }

    /// Le champ `version` du package.json installé, `nil` s'il est illisible ou vide.
    private func installedVersion() -> String? {
        guard let data = FileManager.default.contents(atPath: installedPackagePath),
              let version = JSONValue.parse(data)?.objectValue?["version"]?.stringValue,
              !version.isEmpty else { return nil }
        return version
    }
}
