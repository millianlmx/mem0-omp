// Le modèle de la préparation au premier lancement (omp-console-sans-podman S-5) :
// il enchaîne les machines de l'app — composants (OMP), migration unique de
// l'ancienne mémoire podman (`PodmanLegacy`), agent launchd mem0-rs
// (`MemoryAgent`), sonde oMLX — et publie UN état à la fois.
//
// La chaîne est INJECTÉE (clôtures, comme `HomeModel.Resolver`) : les tests
// remplacent chaque étape sans réseau ni binaire, et la production câble les
// objets réels dans `standard`. Le modèle vit à l'échelle de l'app : il survit à
// la fermeture de la feuille, et `onReady` s'exécute même sans fenêtre ouverte.
//
// Chaque étape est idempotente (composants déjà installés, migration déjà faite,
// agent déjà à jour) : « Réessayer » relance la chaîne entière, sans nettoyage
// préalable. Un import qui laisse des éléments de côté ARRÊTE la chaîne sur
// `.awaitingSwitch` : l'agent ne démarre que sur « Basculer quand même ».
//
// L'absence d'OMP n'est PAS un état du modèle : la seule source est
// `HomeModel.omp`, que le modèle relit par `refreshOmp` (posé par `OMPConsoleApp`)
// au clic de « Réessayer », au clic du badge, et pendant la chaîne quand
// l'installateur change d'étape. OMP absent au lancement : aucune préparation
// d'office (`autoPrepare: false`), la feuille bloquante attend « Installer ».

import Combine
import Foundation

/// Une étape observable de la préparation, de la première à la dernière.
enum SetupStep: Equatable, Sendable {
    case omp(downloaded: Int64, total: Int64)
    case ompInstall
    case migrationStart
    case migrationImport
    case migrationStop
    case agent
    case health
    case prerequisites
}

/// La cause d'un échec : l'une des machines, dans son vocabulaire à elle.
enum SetupFailure: Equatable, Sendable {
    case components(ComponentInstallError)
    case migration(PodmanMigrationError)
    case agent(MemoryAgentError)
}

enum SetupState: Equatable, Sendable {
    case idle
    case preparing(SetupStep)
    case ready
    case failed(SetupFailure)
    /// L'import a laissé des éléments de côté : l'ancienne mémoire reste en
    /// service tant que l'utilisateur n'a pas choisi (« Basculer quand même » ou
    /// « Réessayer »).
    case awaitingSwitch(ImportReport)
}

extension SetupStep {
    init(_ step: ComponentInstallStep) {
        switch step {
        case .omp(let downloaded, let total): self = .omp(downloaded: downloaded, total: total)
        case .ompInstall: self = .ompInstall
        }
    }

    init(_ step: MigrationStep) {
        switch step {
        case .start: self = .migrationStart
        case .importing: self = .migrationImport
        case .stop: self = .migrationStop
        }
    }

    init(_ step: AgentStep) {
        switch step {
        case .agent: self = .agent
        case .health: self = .health
        }
    }
}

@MainActor
final class SetupModel: ObservableObject {
    typealias Install = @MainActor (_ progress: @escaping @MainActor (ComponentInstallStep) -> Void) async throws -> Void
    typealias Migrate = @MainActor (_ progress: @escaping @MainActor (MigrationStep) -> Void) async throws -> PodmanMigrationOutcome
    typealias SwitchOver = @MainActor (_ report: ImportReport, _ progress: @escaping @MainActor (MigrationStep) -> Void) async throws -> Void
    typealias EnsureAgent = @MainActor (_ progress: @escaping @MainActor (AgentStep) -> Void) async throws -> Void

    @Published private(set) var state: SetupState = .idle
    /// La feuille a été fermée par « Fermer » : l'Accueil montre le bandeau.
    @Published private(set) var dismissed = false
    /// Le dernier état d'oMLX sondé (non bloquant).
    @Published private(set) var omlx: OMLXStatus = .unknown

    /// « Réessayer » a relu la présence d'OMP et ne l'a pas trouvé : la feuille
    /// bloquante le dit sous son corps.
    @Published private(set) var retryMissed = false

    /// Appelé quand la préparation atteint `.ready` : l'app revérifie la
    /// disponibilité d'OMP (qui vient d'être installé). Posé par `OMPConsoleApp`.
    var onReady: (@MainActor () -> Void)?
    /// Relit `HomeModel.omp` et rend vrai si OMP est présent. Posé par
    /// `OMPConsoleApp` ; sans clôture, OMP est réputé présent.
    var refreshOmp: (@MainActor () -> Bool)?

    private let install: Install
    private let migrate: Migrate
    /// L'arrêt de l'ancienne mémoire APRÈS des rejets — seulement sur « Basculer
    /// quand même ».
    private let switchOver: SwitchOver
    private let ensureAgent: EnsureAgent
    private let probeOMLX: @MainActor () async -> OMLXStatus
    /// Une seule préparation à la fois : « Réessayer » pendant une préparation est
    /// sans effet (le bouton est désactivé, la garde est ici aussi).
    private var preparing = false

    init(
        install: @escaping Install,
        migrate: @escaping Migrate,
        switchOver: @escaping SwitchOver,
        ensureAgent: @escaping EnsureAgent,
        probeOMLX: @escaping @MainActor () async -> OMLXStatus,
        onReady: (@MainActor () -> Void)? = nil,
        autoPrepare: Bool = true
    ) {
        self.install = install
        self.migrate = migrate
        self.switchOver = switchOver
        self.ensureAgent = ensureAgent
        self.probeOMLX = probeOMLX
        self.onReady = onReady
        if autoPrepare {
            Task { [weak self] in await self?.prepare() }
        }
    }

    /// La chaîne réelle : OMP, migration unique, agent mem0-rs embarqué, sonde
    /// oMLX. `autoPrepare` vaut `home.canLaunch` : sans OMP au lancement, rien ne
    /// se télécharge avant « Installer ».
    static func standard(
        paths: AppPaths = .standard(),
        bundle: Bundle = .main,
        session: URLSession = .shared,
        autoPrepare: Bool
    ) -> SetupModel {
        let environment = ProcessInfo.processInfo.environment
        let executable = MemoryAgent.embeddedBinary(bundle: bundle)
        let installer = ComponentInstaller(paths: paths, session: session)
        let legacy = PodmanLegacy(paths: paths, executable: executable, environment: environment)
        let agent = MemoryAgent(
            paths: paths,
            executable: executable,
            port: MemoryAgent.port(environment: environment),
            environment: environment
        )
        return SetupModel(
            install: { progress in try await installer.install(progress: progress) },
            migrate: { progress in try await legacy.migrate(progress: progress) },
            switchOver: { report, progress in
                try await legacy.switchOver(forced: true, report: report, progress: progress)
            },
            ensureAgent: ensureAgentStep(agent: agent, hosted: {
                MemoryServiceConfig.hosted(environment: ProcessInfo.processInfo.environment) != nil
            }),
            probeOMLX: {
                let config = StackEnvStore.load(at: paths.stackEnv) ?? .defaults
                return await OMLXProbe.status(config: config, session: session)
            },
            autoPrepare: autoPrepare
        )
    }

    /// L'étape « mémoire » de la préparation : l'agent mem0-rs local, ou — quand
    /// `mem0-remote.json` place la mémoire sur le VPS (S-7 de orchestrator-living-in-a-vps)
    /// — AUCUN démarrage et le déchargement de l'agent local, absent toléré. Lue à
    /// chaque préparation : le fichier peut apparaître entre deux lancements.
    static func ensureAgentStep(agent: MemoryAgent, hosted: @escaping @Sendable () -> Bool) -> EnsureAgent {
        { progress in
            if hosted() {
                try await agent.unloadIfLoaded()
            } else {
                try await agent.ensureRunning(progress: progress)
            }
        }
    }

    /// La chaîne complète, de `.idle` à `.ready`, `.failed` ou `.awaitingSwitch`.
    /// Sans effet si une préparation tourne déjà.
    func prepare() async {
        guard !preparing else { return }
        preparing = true
        defer { preparing = false }

        state = .preparing(.omp(downloaded: 0, total: 0))
        do {
            // OMP est relu à chaque changement d'étape de l'installateur (pas à
            // chaque rappel d'octets) et à son retour : dès que son binaire est
            // placé, la feuille bloquante devient fermable.
            var lastStage: ComponentInstallStage?
            try await install { [weak self] step in
                guard let self else { return }
                self.state = .preparing(SetupStep(step))
                let stage = ComponentInstallStage(step)
                if stage != lastStage {
                    lastStage = stage
                    _ = self.refreshOmp?()
                }
            }
            _ = refreshOmp?()
            let outcome = try await migrate { [weak self] step in self?.state = .preparing(SetupStep(step)) }
            if case .rejected(let report) = outcome {
                // Rien n'est arrêté, l'agent ne démarre pas : l'utilisateur
                // choisit, feuille visible.
                state = .awaitingSwitch(report)
                dismissed = false
                return
            }
            try await startAgent()
        } catch {
            state = .failed(Self.failure(of: error))
        }
    }

    /// « Basculer quand même » : seulement depuis `.awaitingSwitch` et hors
    /// préparation. Arrête l'ancienne mémoire (bascule forcée, rejets comptés),
    /// puis démarre l'agent comme `prepare` ; une erreur ⇒ `.failed`.
    func switchAnyway() async {
        guard !preparing, case .awaitingSwitch(let report) = state else { return }
        preparing = true
        defer { preparing = false }

        state = .preparing(.migrationStop)
        do {
            try await switchOver(report) { [weak self] step in self?.state = .preparing(SetupStep(step)) }
            try await startAgent()
        } catch {
            state = .failed(Self.failure(of: error))
        }
    }

    /// La fin commune : agent, prérequis, `.ready`, `onReady`.
    private func startAgent() async throws {
        try await ensureAgent { [weak self] step in self?.state = .preparing(SetupStep(step)) }
        state = .preparing(.prerequisites)
        omlx = await probeOMLX()
        state = .ready
        onReady?()
    }

    /// « Fermer » : la feuille disparaît, la préparation CONTINUE (ou, devant des
    /// rejets, l'ancienne mémoire reste en service).
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

    /// « Installer » (feuille bloquante) : la chaîne complète, téléchargement
    /// compris. Sans effet si une préparation tourne.
    func startInstall() {
        guard !preparing else { return }
        retryMissed = false
        dismissed = false
        Task { [weak self] in await self?.prepare() }
    }

    /// « Réessayer » : relit la présence d'OMP sans rien télécharger. Absent, la
    /// feuille reste bloquante et le dit ; présent, la chaîne repart — depuis un
    /// échec comme depuis des rejets, l'import est relancé. Sans effet si une
    /// préparation tourne.
    func retry() {
        guard !preparing else { return }
        if ompPresent() {
            retryMissed = false
            dismissed = false
            Task { [weak self] in await self?.prepare() }
        } else {
            retryMissed = true
            if state == .ready { state = .idle }
        }
    }

    /// Le clic du badge des composants : la feuille revient. Pendant une
    /// préparation, ou devant des rejets en attente d'un choix, elle montre l'état
    /// courant sans rien relancer ; sinon OMP est relu — présent, la chaîne
    /// repart pour installer ce qui manque ; absent, la feuille bloquante
    /// s'impose par la politique.
    func reopen() {
        dismissed = false
        guard !preparing else { return }
        if case .awaitingSwitch = state { return }
        if ompPresent() {
            Task { [weak self] in await self?.prepare() }
        } else if state == .ready {
            state = .idle
        }
    }

    private func ompPresent() -> Bool {
        refreshOmp?() ?? true
    }

    private static func failure(of error: Error) -> SetupFailure {
        if let error = error as? ComponentInstallError { return .components(error) }
        if let error = error as? PodmanMigrationError { return .migration(error) }
        if let error = error as? MemoryAgentError { return .agent(error) }
        // Une erreur inattendue (lancement d'un binaire, typage) est dite dans le
        // vocabulaire du service mémoire, dernier maillon de la chaîne.
        return .agent(.launchctlFailed(command: "préparation", detail: error.localizedDescription))
    }
}

/// Le cas d'un rappel de l'installateur, sans ses octets : deux rappels d'un même
/// téléchargement ont le même cas.
private enum ComponentInstallStage: Equatable {
    case omp, ompInstall

    init(_ step: ComponentInstallStep) {
        switch step {
        case .omp: self = .omp
        case .ompInstall: self = .ompInstall
        }
    }
}
