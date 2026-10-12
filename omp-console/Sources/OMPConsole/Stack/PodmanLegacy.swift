// La migration UNIQUE de la pile podman d'omp-console vers mem0-rs (S-4
// d'omp-console-sans-podman ; AC-6, AC-7, AC-8, AC-9). C'est le SEUL code podman
// restant, avec les `argv` réduits de `PodmanCommand`.
//
// Ordre figé : démarrer la machine et Qdrant s'il le faut, copier `history.db`
// hors du conteneur mem0-http, `mem0-rs import --json`, et SEULEMENT après un
// import en code 0 (ou un choix explicite après des rejets) arrêter les
// conteneurs, puis écrire `bascule.json` — le marqueur « une seule fois ». Toute
// erreur avant ce marqueur laisse tout rejouable : l'import est tout ou rien et
// idempotent (« la cible gagne », DOC-4), et aucun `stop`, `rm` ni `machine stop`
// n'a eu lieu.
//
// Invariant de la source (B-3) : rien n'est jamais écrit, supprimé ni renommé sous
// `stack/qdrant_storage` ni dans les conteneurs ; seuls `podman cp` (lecture) et
// l'import (lecture HTTP de Qdrant) y touchent.
//
// Ce que ce fichier ne connaît PAS : la feuille de préparation et ses textes,
// l'agent launchd. Toute commande passe par `CommandRunner`, avec l'environnement
// podman ISOLÉ (`PodmanCommand.environment`, DOC-3) ; la sonde `/readyz` est
// injectée : aucun test non gaté ne touche podman ni le port 6333.

import Foundation

/// L'étape en cours de la migration (S-4), pour la feuille de préparation.
enum MigrationStep: Equatable, Sendable {
    case start
    case importing
    case stop
}

/// Ce qu'a donné `migrate` (S-4).
enum PodmanMigrationOutcome: Equatable, Sendable {
    /// `bascule.json` existe : la migration a déjà eu lieu, rien n'est touché.
    case alreadyDone
    /// Aucune collection Qdrant à reprendre : bascule « source none » écrite.
    case notNeeded
    /// Import complet, conteneurs arrêtés, bascule écrite.
    case switched
    /// Import terminé avec rejets (code 3) : RIEN n'est arrêté, l'utilisateur choisit.
    case rejected(ImportReport)
}

/// Les échecs de la migration (S-4). Les détails sont bornés à 300 caractères.
enum PodmanMigrationError: Error, Equatable, Sendable {
    case podmanMissing(path: String)
    case machineFailed(detail: String)
    case qdrantUnreachable(detail: String)
    case historyCopyFailed(detail: String)
    case importFailed(code: Int32, detail: String)
    case stopFailed(detail: String)
    case stateWriteFailed(path: String, detail: String)
}

/// Un élément laissé de côté par l'import (DOC-4).
struct ImportReject: Decodable, Equatable, Sendable {
    var element: String
    var id: String
    var raison: String
    var detail: String
}

/// Le rapport `mem0-rs import --json` (DOC-4) : les rejets aplatis dans l'ordre du
/// rapport, leur total, et le stdout tel quel.
struct ImportReport: Decodable, Equatable, Sendable {
    var rejects: [ImportReject]
    /// `totaux.rejetes`.
    var totalRejected: Int
    /// Le stdout brut de l'import (vide quand le rapport ne vient pas de `parse`).
    var raw: String

    init(rejects: [ImportReject], totalRejected: Int, raw: String = "") {
        self.rejects = rejects
        self.totalRejected = totalRejected
        self.raw = raw
    }

    private enum CodingKeys: String, CodingKey {
        case agents
        case totaux
    }

    /// Un agent du rapport : toutes les clés sont exigées, pour qu'un rapport d'une
    /// autre forme soit refusé plutôt que lu à moitié.
    private struct Agent: Decodable {
        var agent_id: String?
        var importes: Int
        var deja_presents: Int
        var rejetes: [ImportReject]
        var revisions: Int
        var messages: Int
    }

    private struct Totals: Decodable {
        var importes: Int
        var deja_presents: Int
        var rejetes: Int
        var revisions: Int
        var messages: Int
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let agents = try container.decode([Agent].self, forKey: .agents)
        let totals = try container.decode(Totals.self, forKey: .totaux)
        self.init(rejects: agents.flatMap(\.rejetes), totalRejected: totals.rejetes)
    }

    /// Décode le stdout de l'import et le garde tel quel dans `raw`.
    static func parse(_ stdout: String) throws -> ImportReport {
        var report = try JSONDecoder().decode(ImportReport.self, from: Data(stdout.utf8))
        report.raw = stdout
        return report
    }
}

/// `stack/podman-migration/bascule.json` (S-4) : le marqueur « une seule fois ».
struct SwitchState: Codable, Equatable, Sendable {
    var version: Int = 1
    /// ISO 8601.
    var switchedAt: String
    /// `podman` (la pile a été migrée) ou `none` (aucune pile à reprendre).
    var source: String
    var rejected: Int
    var forced: Bool
}

/// Les échecs du nettoyage confirmé de l'ancien moteur (S-6). Les détails sont
/// bornés à 300 caractères.
enum PodmanCleanupError: Error, Equatable, Sendable {
    /// `machine rm -f omp-console` a échoué : rien n'a été supprimé.
    case machineRemoveFailed(detail: String)
    /// Un dossier n'a pas pu être supprimé ; ceux qui le précèdent le sont déjà.
    case deleteFailed(path: String, detail: String)
}

/// L'état décodé d'une machine, tolérant aux formes de `machine inspect`.
struct MachineState: Equatable, Sendable {
    var running: Bool
    var image: String?
}

/// L'état décodé d'un conteneur, tolérant aux formes de `container inspect`.
struct ContainerState: Equatable, Sendable {
    var running: Bool
    var image: String?
    /// L'environnement du conteneur (`Config.Env`, `KEY=VALUE`), vide si absent.
    var env: [String] = []
}

@MainActor
final class PodmanLegacy {
    nonisolated static let podmanVersion = "6.1.3"
    nonisolated static let machineName = "omp-console"
    nonisolated static let qdrantContainer = "omp-console-qdrant"
    nonisolated static let mem0Container = "omp-console-mem0-http"
    /// `history.db` vit DANS le conteneur mem0-http (aucun volume, DOC-3).
    nonisolated static let historyPath = "/home/mem0/.mem0/history.db"
    nonisolated static let qdrantURL = URL(string: "http://127.0.0.1:6333")!
    nonisolated static let collection = "omp_memory"

    /// La sonde réelle de `GET <qdrantURL>/readyz` : le statut HTTP, ou nil sans
    /// réponse. L'en-tête `api-key` n'est posé que si la clé est non vide.
    nonisolated static func liveReadyProbe(_ url: URL, _ apiKey: String) async -> Int? {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 5
        if !apiKey.isEmpty { request.setValue(apiKey, forHTTPHeaderField: "api-key") }
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse
        else { return nil }
        return http.statusCode
    }

    let paths: AppPaths
    /// Le mem0-rs embarqué, qui exécute l'import.
    let executable: URL

    // MARK: - Réglages internes (les tests les raccourcissent)

    /// Budget d'attente de `/readyz` — 90 s en production.
    var readyBudget: Double = 90
    /// Intervalle entre deux sondes `/readyz`.
    var pollInterval: Double = 2
    /// Délai maximal de `mem0-rs import`.
    var importTimeout: Double = 600
    /// Délai maximal d'UNE commande podman.
    var commandTimeout: Double = 120

    private let environment: [String: String]
    private let run: CommandRunner
    private let readyProbe: @Sendable (_ url: URL, _ apiKey: String) async -> Int?
    private let fileManager = FileManager.default

    init(
        paths: AppPaths = .standard(),
        executable: URL = MemoryAgent.embeddedBinary(),
        environment: [String: String] = ProcessInfo.processInfo.environment,
        run: CommandRunner = .live,
        readyProbe: @escaping @Sendable (_ url: URL, _ apiKey: String) async -> Int? = PodmanLegacy.liveReadyProbe
    ) {
        self.paths = paths
        self.executable = executable
        self.environment = environment
        self.run = run
        self.readyProbe = readyProbe
    }

    /// `<components>/podman` : le composant podman que les versions précédentes
    /// de l'app installaient — l'app ne l'installe plus, la migration le lit et le
    /// nettoyage confirmé le supprime.
    nonisolated static func podmanRoot(_ paths: AppPaths) -> URL {
        paths.componentsRoot.appendingPathComponent("podman", isDirectory: true)
    }

    /// `<components>/podman/6.1.3` : contient `bin`, `lib`, `share`.
    var podmanDir: URL {
        Self.podmanRoot(paths).appendingPathComponent(Self.podmanVersion, isDirectory: true)
    }

    /// `<components>/podman/6.1.3/bin/podman` : le podman installé par l'app,
    /// jamais celui du système.
    var podmanBinary: URL {
        podmanDir.appendingPathComponent("bin/podman")
    }

    // MARK: - La migration

    /// La migration unique (algorithme figé de S-4).
    func migrate(progress: @escaping @MainActor (MigrationStep) -> Void) async throws -> PodmanMigrationOutcome {
        // 1. Déjà basculé : aucune commande, aucun fichier touché (AC-7).
        if fileManager.fileExists(atPath: paths.switchState.path) {
            return .alreadyDone
        }

        // 2. Rien à reprendre : pas de collection Qdrant de l'app.
        let collectionDir = paths.qdrantStorage
            .appendingPathComponent("collections", isDirectory: true)
            .appendingPathComponent(Self.collection, isDirectory: true)
        guard isDirectory(collectionDir) else {
            try writeSwitchState(SwitchState(switchedAt: Self.timestamp(), source: "none", rejected: 0, forced: false))
            return .notNeeded
        }

        // 3. Les binaires, puis la configuration podman isolée.
        progress(.start)
        guard fileManager.isExecutableFile(atPath: podmanBinary.path) else {
            throw PodmanMigrationError.podmanMissing(path: podmanBinary.path)
        }
        guard fileManager.isExecutableFile(atPath: executable.path) else {
            throw MemoryAgentError.binaryMissing(path: executable.path)
        }
        try prepareSupportDirectories()

        // 4-5. La machine, puis Qdrant prêt.
        try await ensureMachine()
        let config = StackEnvStore.load(at: paths.stackEnv) ?? .defaults
        try await ensureQdrant(apiKey: config.qdrantApiKey)

        // 6. L'historique, copié hors du conteneur mem0-http.
        try await copyHistory()

        // 7. L'import.
        progress(.importing)
        let result = try await runImport(config: config)
        switch result.code {
        case 0:
            try writeReport(result.stdout)
            try await switchOver(forced: false, report: try? ImportReport.parse(result.stdout), progress: progress)
            return .switched
        case 3:
            let report: ImportReport
            do {
                report = try ImportReport.parse(result.stdout)
            } catch {
                throw PodmanMigrationError.importFailed(
                    code: 3,
                    detail: MemoryAgent.bounded("rapport illisible : \(error.localizedDescription)")
                )
            }
            try writeReport(result.stdout)
            return .rejected(report)
        default:
            throw PodmanMigrationError.importFailed(code: result.code, detail: Self.detail(of: result))
        }
    }

    /// L'arrêt de la pile podman puis le marqueur (S-4) : après un import en code
    /// 0, ou sur « Basculer quand même » (`forced`) après des rejets.
    func switchOver(
        forced: Bool,
        report: ImportReport?,
        progress: @escaping @MainActor (MigrationStep) -> Void
    ) async throws {
        progress(.stop)
        let stop: ProcessRun
        do {
            stop = try await podman(PodmanCommand.containerStop([Self.mem0Container, Self.qdrantContainer]))
        } catch {
            throw PodmanMigrationError.stopFailed(detail: MemoryAgent.bounded(error.localizedDescription))
        }
        guard stop.code == 0 else {
            throw PodmanMigrationError.stopFailed(detail: Self.detail(of: stop))
        }
        // L'arrêt de la VM est un confort : son échec n'empêche pas la bascule.
        _ = try? await podman(PodmanCommand.machineStop(Self.machineName))
        try writeSwitchState(SwitchState(
            switchedAt: Self.timestamp(),
            source: "podman",
            rejected: report?.totalRejected ?? 0,
            forced: forced
        ))
    }

    // MARK: - Le nettoyage confirmé (S-6, AC-10)

    /// Supprime la machine podman de l'app puis ce que l'ancien moteur occupe :
    /// `components/podman`, `config`, `data`, `tmp`, dans cet ordre. Appelé
    /// SEULEMENT après la confirmation de l'utilisateur. Une machine qui résiste
    /// arrête tout avant la moindre suppression ; un dossier qui résiste laisse
    /// supprimés ceux qui le précèdent, et un nouvel appel reprend (le podman
    /// déjà effacé, la machine n'est plus demandée).
    ///
    /// Ne touche JAMAIS `stack/` (`qdrant_storage`, `env`, `installation-token`,
    /// `podman-migration/`), `mem0-rs/`, `remote/`, `components/omp`, le plist
    /// ni l'agent : aucun appel launchctl.
    func removeLeftovers() async throws {
        if fileManager.isExecutableFile(atPath: podmanBinary.path) {
            let remove: ProcessRun
            do {
                remove = try await podman(PodmanCommand.machineRemove(Self.machineName))
            } catch {
                throw PodmanCleanupError.machineRemoveFailed(detail: MemoryAgent.bounded(error.localizedDescription))
            }
            // Une machine déjà absente est un succès : il ne reste qu'à effacer.
            let output = "\(remove.stdout)\n\(remove.stderr)".lowercased()
            if remove.timedOut || (remove.code != 0 && !output.contains("does not exist")) {
                throw PodmanCleanupError.machineRemoveFailed(
                    detail: remove.timedOut ? "délai dépassé (\(Self.seconds(commandTimeout)) s)" : Self.detail(of: remove)
                )
            }
        }
        for directory in [Self.podmanRoot(paths), paths.configDir, paths.dataDir, paths.tmpDir]
        where fileManager.fileExists(atPath: directory.path) {
            do {
                try fileManager.removeItem(at: directory)
            } catch {
                throw PodmanCleanupError.deleteFailed(
                    path: directory.path,
                    detail: MemoryAgent.bounded(error.localizedDescription)
                )
            }
        }
    }

    /// Reste-t-il quelque chose de l'ancien moteur (S-6) : `components/podman`,
    /// `config` ou `data` ? `tmp` seul ne justifie pas le bandeau.
    nonisolated static func hasLeftovers(paths: AppPaths) -> Bool {
        [podmanRoot(paths), paths.configDir, paths.dataDir].contains {
            FileManager.default.fileExists(atPath: $0.path)
        }
    }

    // MARK: - Étapes

    /// `config/containers/containers.conf` (avec `helper_binaries_dir`) et le
    /// `TMPDIR` privé en 0700, AVANT toute commande machine (DOC-3).
    private func prepareSupportDirectories() throws {
        do {
            let containersDir = paths.configDir.appendingPathComponent("containers", isDirectory: true)
            try fileManager.createDirectory(at: containersDir, withIntermediateDirectories: true)
            try fileManager.createDirectory(at: paths.tmpDir, withIntermediateDirectories: true)
            try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: paths.tmpDir.path)
            let helperBinariesDir = podmanDir.appendingPathComponent("bin", isDirectory: true)
            let content = PodmanCommand.containersConf(helperBinariesDir: helperBinariesDir)
            try Data(content.utf8).write(
                to: containersDir.appendingPathComponent("containers.conf"),
                options: [.atomic]
            )
        } catch {
            // Aucune commande podman n'est partie : sans configuration, la machine
            // ne peut pas démarrer.
            throw PodmanMigrationError.machineFailed(
                detail: MemoryAgent.bounded("configuration de podman non inscriptible : \(error.localizedDescription)")
            )
        }
    }

    private func ensureMachine() async throws {
        guard let inspect = try? await podman(PodmanCommand.machineInspect(Self.machineName)),
              inspect.code == 0,
              let machine = Self.decodeMachine(inspect.stdout)
        else {
            throw PodmanMigrationError.machineFailed(detail: "machine \(Self.machineName) absente")
        }
        if machine.running { return }
        let start: ProcessRun
        do {
            start = try await podman(PodmanCommand.machineStart(Self.machineName))
        } catch {
            throw PodmanMigrationError.machineFailed(detail: MemoryAgent.bounded(error.localizedDescription))
        }
        if start.code == 0 { return }
        let detail = Self.detail(of: start)
        if Self.isAlreadyRunning(detail) { return }
        throw PodmanMigrationError.machineFailed(detail: detail)
    }

    private func ensureQdrant(apiKey: String) async throws {
        guard let inspect = try? await podman(PodmanCommand.containerInspect(Self.qdrantContainer)),
              inspect.code == 0,
              let container = Self.decodeContainer(inspect.stdout)
        else {
            throw PodmanMigrationError.qdrantUnreachable(detail: "conteneur \(Self.qdrantContainer) absent")
        }
        if !container.running {
            let start: ProcessRun
            do {
                start = try await podman(PodmanCommand.containerStart(Self.qdrantContainer))
            } catch {
                throw PodmanMigrationError.qdrantUnreachable(detail: MemoryAgent.bounded(error.localizedDescription))
            }
            guard start.code == 0 else {
                throw PodmanMigrationError.qdrantUnreachable(detail: Self.detail(of: start))
            }
        }
        let url = Self.qdrantURL.appendingPathComponent("readyz")
        let deadline = Date().addingTimeInterval(readyBudget)
        while true {
            if await readyProbe(url, apiKey) == 200 { return }
            if Date() >= deadline { break }
            await pause()
        }
        throw PodmanMigrationError.qdrantUnreachable(detail: "readyz sans réponse en \(Self.seconds(readyBudget)) s")
    }

    private func copyHistory() async throws {
        do {
            try fileManager.createDirectory(at: paths.podmanMigrationRoot, withIntermediateDirectories: true)
            try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: paths.podmanMigrationRoot.path)
            if fileManager.fileExists(atPath: paths.podmanHistoryCopy.path) {
                try fileManager.removeItem(at: paths.podmanHistoryCopy)
            }
        } catch {
            throw PodmanMigrationError.historyCopyFailed(detail: MemoryAgent.bounded(error.localizedDescription))
        }
        let copy: ProcessRun
        do {
            copy = try await podman(PodmanCommand.copyOut(
                container: Self.mem0Container,
                path: Self.historyPath,
                to: paths.podmanHistoryCopy
            ))
        } catch {
            throw PodmanMigrationError.historyCopyFailed(detail: MemoryAgent.bounded(error.localizedDescription))
        }
        guard copy.code == 0 else {
            throw PodmanMigrationError.historyCopyFailed(detail: Self.detail(of: copy))
        }
    }

    /// `mem0-rs import --json` sur la base de l'agent : n'appelle jamais oMLX, lit
    /// Qdrant avec sa clé, écrit tout ou rien (DOC-4).
    private func runImport(config: StackConfig) async throws -> ProcessRun {
        var importEnvironment = environment
        importEnvironment["MEM0_DB_PATH"] = paths.mem0Database.path
        importEnvironment["EMBEDDING_DIMS"] = String(config.embeddingDims)
        importEnvironment["QDRANT_API_KEY"] = config.qdrantApiKey
        let arguments = [
            "import",
            "--history-db", paths.podmanHistoryCopy.path,
            "--qdrant-url", Self.qdrantURL.absoluteString,
            "--collection", Self.collection,
            "--json",
        ]
        let result: ProcessRun
        do {
            result = try await run(executable, arguments, importEnvironment, importTimeout)
        } catch {
            throw PodmanMigrationError.importFailed(code: -1, detail: MemoryAgent.bounded(error.localizedDescription))
        }
        if result.timedOut {
            throw PodmanMigrationError.importFailed(code: -1, detail: "délai dépassé (\(Self.seconds(importTimeout)) s)")
        }
        return result
    }

    // MARK: - Fichiers d'état

    private func writeReport(_ stdout: String) throws {
        do {
            try Data(stdout.utf8).write(to: paths.podmanImportReport, options: [.atomic])
        } catch {
            throw PodmanMigrationError.stateWriteFailed(
                path: paths.podmanImportReport.path,
                detail: MemoryAgent.bounded(error.localizedDescription)
            )
        }
    }

    private func writeSwitchState(_ state: SwitchState) throws {
        do {
            try fileManager.createDirectory(at: paths.podmanMigrationRoot, withIntermediateDirectories: true)
            try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: paths.podmanMigrationRoot.path)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(state).write(to: paths.switchState, options: [.atomic])
        } catch {
            throw PodmanMigrationError.stateWriteFailed(
                path: paths.switchState.path,
                detail: MemoryAgent.bounded(error.localizedDescription)
            )
        }
    }

    // MARK: - Exécution podman

    private func podman(_ arguments: [String]) async throws -> ProcessRun {
        try await run(podmanBinary, arguments, PodmanCommand.environment(base: environment, paths: paths), commandTimeout)
    }

    private func pause() async {
        guard pollInterval > 0 else { return }
        try? await Task.sleep(for: .seconds(pollInterval))
    }

    private func isDirectory(_ url: URL) -> Bool {
        var flag: ObjCBool = false
        return fileManager.fileExists(atPath: url.path, isDirectory: &flag) && flag.boolValue
    }

    // MARK: - Décodage tolérant et petits utilitaires

    /// Décode `machine inspect` : tableau (forme réelle) ou objet, champs `State`,
    /// `Running`, `Image` ; un tableau vide ou un objet vide = machine ABSENTE.
    nonisolated static func decodeMachine(_ text: String) -> MachineState? {
        guard let dictionary = firstObject(text) else { return nil }
        let running: Bool
        if let flag = dictionary["Running"] as? Bool {
            running = flag
        } else if let state = dictionary["State"] as? String {
            running = state.lowercased() == "running"
        } else {
            running = false
        }
        return MachineState(running: running, image: dictionary["Image"] as? String)
    }

    /// Décode `container inspect` : l'image peut vivre en `ImageName`,
    /// `Config.Image` ou `Image` selon la forme, l'état en `State.Running` ou
    /// `State.Status` (formes podman).
    nonisolated static func decodeContainer(_ text: String) -> ContainerState? {
        guard let dictionary = firstObject(text) else { return nil }
        let running: Bool
        if let state = dictionary["State"] as? [String: Any] {
            if let flag = state["Running"] as? Bool {
                running = flag
            } else if let status = state["Status"] as? String {
                running = status.lowercased() == "running"
            } else {
                running = false
            }
        } else if let status = dictionary["State"] as? String {
            running = status.lowercased() == "running"
        } else {
            running = false
        }
        let config = dictionary["Config"] as? [String: Any]
        let image = (dictionary["ImageName"] as? String)
            ?? (config?["Image"] as? String)
            ?? (dictionary["Image"] as? String)
        let env = (config?["Env"] as? [Any])?.compactMap { $0 as? String } ?? []
        return ContainerState(running: running, image: image, env: env)
    }

    /// Le premier objet d'un JSON qui peut être un tableau ou un objet ; `nil` si
    /// la forme est vide ou illisible.
    nonisolated private static func firstObject(_ text: String) -> [String: Any]? {
        guard let raw = try? JSONSerialization.jsonObject(
            with: Data(text.utf8),
            options: [.fragmentsAllowed]
        ) else { return nil }
        let dictionary: [String: Any]?
        if let array = raw as? [Any] {
            dictionary = array.first as? [String: Any]
        } else {
            dictionary = raw as? [String: Any]
        }
        guard let result = dictionary, !result.isEmpty else { return nil }
        return result
    }

    /// « already running » : `machine start` sur une machine qui tourne déjà.
    nonisolated static func isAlreadyRunning(_ detail: String) -> Bool {
        detail.lowercased().contains("already running")
    }

    /// stderr (ou stdout s'il est vide, ou « code N »), borné à 300 caractères.
    nonisolated private static func detail(of result: ProcessRun) -> String {
        let stderr = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = stderr.isEmpty ? result.stdout.trimmingCharacters(in: .whitespacesAndNewlines) : stderr
        return text.isEmpty ? "code \(result.code)" : MemoryAgent.bounded(text)
    }

    nonisolated private static func seconds(_ budget: Double) -> Int {
        Int(budget.rounded(.up))
    }

    nonisolated private static func timestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: Date())
    }
}
