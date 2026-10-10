// Le modèle de la préparation au premier lancement (S-5, BR-5) : il enchaîne les
// quatre machines de l'app — composants (S-1), migration (S-3), pile mémoire (S-2),
// sonde oMLX (S-6) — et publie UN état à la fois.
//
// La chaîne est INJECTÉE (cloutes, comme `HomeModel.Resolver`) : les tests
// remplacent chaque étape sans réseau ni binaire, et la production câble les
// objets réels dans `standard`. Le modèle vit à l'échelle de l'app : il survit à
// la fermeture de la feuille, et `onReady` s'exécute même sans fenêtre ouverte.
//
// Chaque étape est idempotente (composants déjà installés, pile déjà montée) :
// « Réessayer » relance la chaîne entière, sans nettoyage préalable.

import Combine
import Foundation

/// Une étape observable de la préparation, de la première à la dernière.
enum SetupStep: Equatable, Sendable {
    case omp(downloaded: Int64, total: Int64)
    case ompInstall
    case podman(downloaded: Int64, total: Int64)
    case podmanInstall
    case legacyStop
    case migrationCopy
    case machine
    case images
    case containers
    case health
    /// Le rattrapage des souvenirs manquants (S-8), sur la ligne « Pile mémoire ».
    case union
    case prerequisites
}

/// La cause d'un échec : l'une des machines, dans son vocabulaire à elle.
enum SetupFailure: Equatable, Sendable {
    case components(ComponentInstallError)
    case migration(StackMigrationError)
    case stack(MemoryStackError)
    /// L'ancienne pile n'a pas pu être arrêtée sur ordre de l'utilisateur (S-6).
    case legacy(LegacyStackError)
}

enum SetupState: Equatable, Sendable {
    case idle
    case preparing(SetupStep)
    case ready
    case failed(SetupFailure)
}

extension SetupStep {
    init(_ step: ComponentInstallStep) {
        switch step {
        case .omp(let downloaded, let total): self = .omp(downloaded: downloaded, total: total)
        case .ompInstall: self = .ompInstall
        case .podman(let downloaded, let total): self = .podman(downloaded: downloaded, total: total)
        case .podmanInstall: self = .podmanInstall
        }
    }

    init(_ step: StackStep) {
        switch step {
        case .machine: self = .machine
        case .images: self = .images
        case .containers: self = .containers
        case .health: self = .health
        case .union: self = .union
        }
    }

    init(_ step: MigrationStep) {
        switch step {
        case .copy: self = .migrationCopy
        }
    }
}

/// Le contexte de build de la pile embarqué dans le bundle (S-1, S-5).
enum StackBuildContext {
    /// `<bundle>/Contents/Resources/Stack/mem0-http`, ou `nil` hors bundle (binaire
    /// nu, tests) : c'est là que `scripts/swift-app.sh` copie les quatre fichiers
    /// de `mem0-stack/mem0-http/`.
    static func resolve(bundle: Bundle = .main) -> URL? {
        let url = bundle.bundleURL
            .appendingPathComponent("Contents", isDirectory: true)
            .appendingPathComponent("Resources", isDirectory: true)
            .appendingPathComponent("Stack", isDirectory: true)
            .appendingPathComponent("mem0-http", isDirectory: true)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }
}

@MainActor
final class SetupModel: ObservableObject {
    @Published private(set) var state: SetupState = .idle
    /// La feuille a été fermée par « Fermer » : l'Accueil montre le bandeau.
    @Published private(set) var dismissed = false
    /// Le dernier état d'oMLX sondé (non bloquant).
    @Published private(set) var omlx: OMLXStatus = .unknown

    /// Appelé quand la préparation atteint `.ready` : l'app revérifie la
    /// disponibilité d'OMP (qui vient d'être installé). Posé par `OMPConsoleApp`.
    var onReady: (@MainActor () -> Void)?

    private let install: @MainActor (_ progress: @escaping @MainActor (ComponentInstallStep) -> Void) async throws -> Void
    private let migrate: @MainActor (_ progress: @escaping @MainActor (MigrationStep) -> Void) async throws -> Void
    private let ensureStack: @MainActor (_ progress: @escaping @MainActor (StackStep) -> Void) async throws -> Void
    private let probeOMLX: @MainActor () async -> OMLXStatus
    /// L'arrêt de l'ancienne pile — SEULEMENT sur action explicite (S-6).
    private let takeover: @MainActor () async throws -> Void
    /// Une seule préparation à la fois : « Réessayer » pendant une préparation est
    /// sans effet (le bouton est désactivé, la garde est ici aussi).
    private var preparing = false

    init(
        install: @escaping @MainActor (_ progress: @escaping @MainActor (ComponentInstallStep) -> Void) async throws -> Void,
        migrate: @escaping @MainActor (_ progress: @escaping @MainActor (MigrationStep) -> Void) async throws -> Void,
        ensureStack: @escaping @MainActor (_ progress: @escaping @MainActor (StackStep) -> Void) async throws -> Void,
        probeOMLX: @escaping @MainActor () async -> OMLXStatus,
        takeover: @escaping @MainActor () async throws -> Void = {},
        onReady: (@MainActor () -> Void)? = nil,
        autoPrepare: Bool = true
    ) {
        self.install = install
        self.migrate = migrate
        self.ensureStack = ensureStack
        self.probeOMLX = probeOMLX
        self.takeover = takeover
        self.onReady = onReady
        if autoPrepare {
            Task { [weak self] in await self?.prepare() }
        }
    }

    /// La chaîne réelle : composants, migration, pile, sonde oMLX.
    static func standard(
        paths: AppPaths = .standard(),
        manifest: ComponentManifest = .current,
        buildContext: URL? = StackBuildContext.resolve(),
        session: URLSession = .shared
    ) -> SetupModel {
        let installer = ComponentInstaller(paths: paths, manifest: manifest, session: session)
        let migration = StackMigration(paths: paths)
        let stack = MemoryStack(
            paths: paths,
            manifest: manifest,
            buildContext: buildContext ?? URL(fileURLWithPath: "/nonexistent/omp-console-stack-context", isDirectory: true),
            session: session
        )
        return SetupModel(
            install: { progress in try await installer.install(progress: progress) },
            migrate: { progress in _ = try await migration.run(progress: progress) },
            ensureStack: { progress in try await stack.ensureRunning(progress: progress) },
            probeOMLX: {
                let config = StackEnvStore.load(at: paths.stackEnv) ?? .defaults
                return await OMLXProbe.status(config: config, session: session)
            },
            takeover: {
                // La SEULE autorité sur l'arrêt de l'ancienne pile (S-6) : le
                // socket Docker, jamais un conteneur de l'app.
                _ = try await LegacyStack.stop(
                    environment: ProcessInfo.processInfo.environment,
                    run: .live
                )
            }
        )
    }

    /// La chaîne complète, de `.idle` à `.ready` (ou `.failed`). Sans effet si une
    /// préparation tourne déjà.
    func prepare() async {
        guard !preparing else { return }
        preparing = true
        defer { preparing = false }

        state = .preparing(.omp(downloaded: 0, total: 0))
        do {
            try await install { [weak self] step in self?.state = .preparing(SetupStep(step)) }
            try await migrate { [weak self] step in self?.state = .preparing(SetupStep(step)) }
            try await ensureStack { [weak self] step in self?.state = .preparing(SetupStep(step)) }
            state = .preparing(.prerequisites)
            omlx = await probeOMLX()
            state = .ready
            onReady?()
        } catch {
            state = .failed(Self.failure(of: error))
        }
    }

    /// « Fermer » : la feuille disparaît, la préparation CONTINUE.
    func dismiss() {
        dismissed = true
    }

    /// « Reprendre… » : la feuille revient ; si la préparation avait échoué, elle
    /// repart entièrement (chaque étape est idempotente).
    func present() {
        dismissed = false
        if case .failed = state {
            Task { [weak self] in await self?.prepare() }
        }
    }

    /// La reprise de l'ancienne pile (S-6), déclenchée par l'utilisateur
    /// UNIQUEMENT (bouton de la feuille ou de la section Mémoire) : sans effet si
    /// une préparation tourne déjà ; publie `.preparing(.legacyStop)` ; arrête les
    /// conteneurs legacy par le socket Docker ; un arrêt raté ⇒
    /// `.failed(.legacy(error))` SANS relance ; un arrêt réussi ⇒ relance
    /// COMPLÈTE de la chaîne (même chemin que « Réessayer »).
    func takeOverLegacyStack() async {
        guard !preparing else { return }
        state = .preparing(.legacyStop)
        do {
            try await takeover()
        } catch {
            state = .failed(Self.failure(of: error))
            return
        }
        await prepare()
    }

    private static func failure(of error: Error) -> SetupFailure {
        if let error = error as? ComponentInstallError { return .components(error) }
        if let error = error as? StackMigrationError { return .migration(error) }
        if let error = error as? LegacyStackError { return .legacy(error) }
        if let error = error as? MemoryStackError { return .stack(error) }
        // Une erreur inattendue (lancement d'un binaire, typage) est dite dans le
        // vocabulaire de la pile : c'est elle qui tourne à ce moment-là.
        return .stack(.podmanFailed(command: "préparation", detail: error.localizedDescription))
    }
}
