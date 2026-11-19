// L'agent launchd du service mémoire (S-2 d'omp-console-sans-podman ; AC-2, AC-3,
// AC-4, AC-5) : le `memory-rs` embarqué dans le bundle, servi sur
// 127.0.0.1:<port> par un job `gui/<uid>/<label>` qui survit au Quitter de l'app
// (`KeepAlive`), est relancé par launchd s'il meurt, et exécute toujours le
// binaire de l'app installée.
//
// État VOULU = le plist sur disque. Aucun autre fichier d'état : le plist attendu
// est recalculé à chaque préparation (chemin et SHA-256 du binaire, `stack/env`,
// jeton d'installation) et comparé — en DICTIONNAIRE, pas en octets — à celui du
// disque. Égal et chargé ⇒ on attend la santé ; sinon garde de port, écriture
// atomique 0600, `bootout` attendu par `print`, puis `bootstrap` repris (DOC-2 :
// `bootout` rend 0 avant que launchd n'ait déchargé, un `bootstrap` immédiat
// échoue en EIO et ne laisse AUCUN job).
//
// Identité : `/health` doit rendre `ok == true` ET `installation ==` le jeton
// d'installation (`isOurMemory`) ; un port tenu par un autre programme que le job est
// un `portConflict` nommé, et le job chargé est alors DÉCHARGÉ plutôt que laissé
// boucler sur un bind impossible.
//
// L'agent d'AVANT le renommage (`com.omp.console.mem0-rs`, même variante hexadécimale
// pour une racine déplacée) tient le port avec l'ancien binaire, que la garde de port
// classerait « étranger » : `ensureRunning` et `ensureStopped` le déchargent d'abord
// (`bootout` attendu par `print`) et retirent son plist, AVANT toute sonde de port. Le
// dossier de données de l'app et sa base ne sont jamais touchés.
//
// Ce que ce fichier ne connaît PAS : la feuille de préparation et ses textes, la
// migration podman. Toute commande passe par `CommandRunner` (binaires ABSOLUS),
// la sonde HTTP est injectée : aucun test non gaté ne touche launchd ni un port.

import ConsoleCore
import CryptoKit
import Foundation

/// L'étape en cours de `ensureRunning` (S-2).
enum AgentStep: Equatable, Sendable {
    case agent
    case health
}

/// Les échecs de l'agent (S-2). Les détails sont bornés à 300 caractères.
enum MemoryAgentError: Error, Equatable {
    case binaryMissing(path: String)
    case installationFailed(detail: String)
    case plistWriteFailed(path: String, detail: String)
    case launchctlFailed(command: String, detail: String)
    case portConflict(port: Int, owner: MemoryPortOwnership)
    /// `log` = au plus les 20 dernières lignes de `memory-rs.log`, bornées à 300
    /// caractères ; vide si le journal est illisible.
    case healthTimeout(seconds: Int, log: String)
}

@MainActor
final class MemoryAgent {
    nonisolated static let defaultLabel = "com.omp.console.memory-rs"
    /// Le label d'avant le renommage : un agent chargé sous ce nom est déchargé, son
    /// plist retiré (S-33).
    nonisolated static let legacyDefaultLabel = "com.omp.console.mem0-rs"
    nonisolated static let defaultPort = 8321
    /// Réglage de recette (non documenté pour l'utilisateur final).
    nonisolated static let portEnvironmentKey = "OMP_CONSOLE_MEMORY_PORT"
    /// Son nom d'avant le renommage, lu quand le nouveau est absent ou vide (S-7).
    nonisolated static let legacyPortEnvironmentKey = "OMP_CONSOLE_MEM0_PORT"
    nonisolated static let launchctl = URL(fileURLWithPath: "/bin/launchctl")
    /// Budget d'UNE invocation `launchctl`.
    nonisolated static let commandTimeout: Double = 10

    /// Le port servi : `OMP_CONSOLE_MEMORY_PORT` (sinon `OMP_CONSOLE_MEM0_PORT`) si entier
    /// décimal 1–65535, sinon 8321.
    nonisolated static func port(environment: [String: String]) -> Int {
        guard let raw = RenamedEnvironment.value(environment, portEnvironmentKey, legacy: legacyPortEnvironmentKey),
              raw.allSatisfy({ $0.isASCII && $0.isNumber }),
              let value = Int(raw),
              (1...65535).contains(value)
        else { return defaultPort }
        return value
    }

    /// `defaultLabel` pour la racine réelle ; une racine déplacée a son propre
    /// label (12 premiers hex du SHA-256 de son chemin), donc son propre job.
    nonisolated static func label(paths: AppPaths) -> String {
        variant(of: defaultLabel, paths: paths)
    }

    /// Le label d'avant le renommage de la même installation (même variante hexadécimale).
    nonisolated static func legacyLabel(paths: AppPaths) -> String {
        variant(of: legacyDefaultLabel, paths: paths)
    }

    nonisolated private static func variant(of base: String, paths: AppPaths) -> String {
        guard paths.isOverridden else { return base }
        let digest = SHA256.hash(data: Data(paths.supportRoot.path.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return base + "." + String(hex.prefix(12))
    }

    /// `<bundle>/Contents/Resources/memory-rs` (copié par scripts/swift-app.sh).
    nonisolated static func embeddedBinary(bundle: Bundle = .main) -> URL {
        bundle.bundleURL.appendingPathComponent("Contents/Resources/memory-rs")
    }

    /// Le prédicat d'ACCEPTATION de la sonde identitaire : 200, `ok == true` ET le
    /// champ `installation` égal au jeton de l'installation. Un `200` nu — autre
    /// service, pile manuelle sans variable — n'est JAMAIS accepté.
    nonisolated static func isOurMemory(_ result: (status: Int, body: Data), token: String) -> Bool {
        guard !token.isEmpty, result.status == 200, isMemoryHealthy(result) else { return false }
        guard let raw = try? JSONSerialization.jsonObject(with: result.body, options: [.fragmentsAllowed]),
              let object = raw as? [String: Any]
        else { return false }
        return (object["installation"] as? String) == token
    }

    nonisolated static func isMemoryHealthy(_ result: (status: Int, body: Data)) -> Bool {
        guard result.status == 200,
              let raw = try? JSONSerialization.jsonObject(with: result.body, options: [.fragmentsAllowed]),
              let object = raw as? [String: Any]
        else { return false }
        if let ok = object["ok"] as? Bool { return ok }
        if let ok = object["ok"] as? NSNumber { return ok.boolValue }
        return false
    }

    /// La sonde réelle : `GET`, délai 5 s.
    nonisolated static func liveHealthProbe(_ url: URL) async -> (status: Int, body: Data)? {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 5
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse
        else { return nil }
        return (http.statusCode, data)
    }

    let paths: AppPaths
    let executable: URL
    let port: Int
    let label: String
    /// Le label d'avant le renommage (S-33).
    let legacyLabel: String

    /// Budget d'attente de `/health` après (re)chargement — 30 s en production.
    var healthBudget: Double = 30
    /// Budget d'attente de la libération du port avant un (re)chargement.
    var portFreeBudget: Double = 10
    /// Budget d'attente du déchargement après `bootout`.
    var unloadBudget: Double = 10
    /// Intervalle entre deux sondes (`print`, port, `/health`, reprise de `bootstrap`).
    var pollInterval: Double = 0.5
    /// Nombre d'essais de `bootstrap` (EIO tant que l'ancien job se décharge).
    var bootstrapAttempts = 3

    private let environment: [String: String]
    private let run: CommandRunner
    private let uid: uid_t
    private let healthProbe: @Sendable (URL) async -> (status: Int, body: Data)?
    private let fileManager = FileManager.default

    init(
        paths: AppPaths = .standard(),
        executable: URL = MemoryAgent.embeddedBinary(),
        port: Int = MemoryAgent.port(environment: ProcessInfo.processInfo.environment),
        environment: [String: String] = ProcessInfo.processInfo.environment,
        run: CommandRunner = .live,
        uid: uid_t = getuid(),
        healthProbe: @escaping @Sendable (URL) async -> (status: Int, body: Data)? = MemoryAgent.liveHealthProbe
    ) {
        self.paths = paths
        self.executable = executable
        self.port = port
        self.label = Self.label(paths: paths)
        self.legacyLabel = Self.legacyLabel(paths: paths)
        self.environment = environment
        self.run = run
        self.uid = uid
        self.healthProbe = healthProbe
    }

    /// `<launchAgentsDir>/<label>.plist`.
    var plistURL: URL { paths.launchAgentPlist(label: label) }
    var legacyPlistURL: URL { paths.launchAgentPlist(label: legacyLabel) }

    /// `gui/<uid>` ; la cible d'un job est `gui/<uid>/<label>`.
    var domain: String { "gui/\(uid)" }

    /// `http://127.0.0.1:<port>/health`.
    var healthURL: URL {
        URL(string: "http://127.0.0.1:\(port)/health") ?? URL(fileURLWithPath: "/")
    }

    // MARK: - La préparation

    /// Rend l'agent chargé, à jour et sain (algorithme figé de S-2).
    func ensureRunning(progress: @escaping @MainActor (AgentStep) -> Void) async throws {
        // 1. Le binaire embarqué.
        progress(.agent)
        guard fileManager.isExecutableFile(atPath: executable.path) else {
            throw MemoryAgentError.binaryMissing(path: executable.path)
        }

        // 1 bis. L'agent d'avant le renommage : déchargé et son plist retiré AVANT toute
        // sonde de port, sans quoi son job (`KeepAlive`) tiendrait le port avec l'ancien
        // binaire et `guardPort` y verrait un programme étranger.
        try await retireLegacyAgent()

        // 2. Le jeton d'installation (jamais régénéré s'il existe).
        let token: String
        do {
            token = try InstallationTokenStore.loadOrCreate(at: paths.installationToken)
        } catch {
            throw MemoryAgentError.installationFailed(detail: Self.bounded("\(error.localizedDescription)"))
        }

        // 3. Le plist attendu et l'état du job.
        let expected = try expectedPlist(installationToken: token)
        let status = await printService(label: label)

        // 4-5. Chargé et identique : il ne reste qu'à attendre la santé.
        if status.loaded, plistOnDisk() == NSDictionary(dictionary: expected) {
            try await awaitHealth(token: token, jobPid: status.pid, progress: progress)
            return
        }

        // 6. La garde de port : personne d'autre que le job (ou le nôtre) ne tient le port.
        try await guardPort(loaded: status.loaded, jobPid: status.pid)

        // 7. Écriture atomique, déchargement attendu, chargement repris.
        try writePlist(expected)
        if status.loaded {
            try await bootoutAndWait(label: label)
        }
        try await bootstrap()

        // 8. La santé.
        try await awaitHealth(token: token, jobPid: status.pid, progress: progress)
    }

    // MARK: - L'arrêt

    /// Décharge l'agent d'avant le renommage s'il est chargé, puis le job s'il est
    /// chargé, puis retire leurs plists (memoire-du-serveur) :
    /// quand la mémoire est celle d'un serveur, l'agent de l'app n'a rien à servir,
    /// et un plist laissé sur le disque le ferait relancer par launchd à la session
    /// suivante (`RunAtLoad`). La base reste sur le disque : repasser à la mémoire
    /// de l'app la retrouve. Rend vrai si un job (ancien ou nouveau) était chargé.
    @discardableResult
    func ensureStopped() async throws -> Bool {
        let legacyWasLoaded = try await retireLegacyAgent()
        let status = await printService(label: label)
        if status.loaded {
            try await bootoutAndWait(label: label)
        }
        try removePlist(at: plistURL)
        return status.loaded || legacyWasLoaded
    }

    /// Décharge l'agent d'avant le renommage (`print` rend 0 ⇒ `bootout` attendu), puis
    /// retire son plist. Rend vrai s'il était chargé. Le dossier de données et sa base
    /// ne sont jamais touchés.
    @discardableResult
    private func retireLegacyAgent() async throws -> Bool {
        let wasLoaded = await printService(label: legacyLabel).loaded
        if wasLoaded {
            try await bootoutAndWait(label: legacyLabel)
        }
        try removePlist(at: legacyPlistURL)
        return wasLoaded
    }

    /// Retire le plist s'il existe.
    private func removePlist(at url: URL) throws {
        guard fileManager.fileExists(atPath: url.path) else { return }
        do {
            try fileManager.removeItem(at: url)
        } catch {
            throw MemoryAgentError.plistWriteFailed(
                path: url.path,
                detail: Self.bounded(error.localizedDescription)
            )
        }
    }

    // MARK: - Le plist

    /// Le dictionnaire EXACT du job (S-2) : toutes valeurs chaînes sauf booléens.
    func expectedPlist(installationToken: String) throws -> [String: Any] {
        let sha: String
        do {
            sha = try ComponentInstaller.sha256(of: executable)
        } catch {
            throw MemoryAgentError.binaryMissing(path: executable.path)
        }
        let config = StackEnvStore.load(at: paths.stackEnv) ?? .defaults
        let environmentVariables: [String: String] = [
            "MEMORY_DB_PATH": paths.memoryDatabase.path,
            "EMBEDDING_DIMS": String(config.embeddingDims),
            "OMLX_BASE_URL": StackConfig.nativeOMLXBaseURL(config.omlxBaseURL),
            "OMLX_API_TOKEN": config.omlxApiToken,
            "OMLX_LLM_MODEL": config.omlxLLMModel,
            "OMLX_EMBED_MODEL": config.omlxEmbedModel,
            "MEMORY_HTTP_TOKEN": config.memoryHttpToken,
            "OMP_INSTALLATION_TOKEN": installationToken,
            "OMP_CONSOLE_MEMORY_RS_SHA256": sha,
        ]
        return [
            "Label": label,
            "ProgramArguments": [executable.path, "--host", "127.0.0.1", "--port", String(port)],
            "WorkingDirectory": paths.memoryRoot.path,
            "KeepAlive": true,
            "RunAtLoad": true,
            "ProcessType": "Interactive",
            "StandardOutPath": paths.memoryLog.path,
            "StandardErrorPath": paths.memoryLog.path,
            "EnvironmentVariables": environmentVariables,
        ]
    }

    /// Le plist du disque, décodé ; `nil` s'il est absent ou illisible.
    private func plistOnDisk() -> NSDictionary? {
        guard let data = try? Data(contentsOf: plistURL),
              let decoded = try? PropertyListSerialization.propertyList(from: data, format: nil),
              let dictionary = decoded as? [String: Any]
        else { return nil }
        return NSDictionary(dictionary: dictionary)
    }

    /// Écrit le plist (0600 : il porte des jetons), après avoir créé `launchAgentsDir` et
    /// le SEUL dossier de données choisi (`memoryRoot`, 0700) : jamais un `memory-rs/` vide
    /// à côté d'un `mem0-rs/` d'avant le renommage.
    private func writePlist(_ plist: [String: Any]) throws {
        do {
            let root = paths.memoryRoot
            try fileManager.createDirectory(at: paths.launchAgentsDir, withIntermediateDirectories: true)
            try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
            try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
            let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            try data.write(to: plistURL, options: [.atomic])
            try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: plistURL.path)
        } catch {
            throw MemoryAgentError.plistWriteFailed(
                path: plistURL.path,
                detail: Self.bounded(error.localizedDescription)
            )
        }
    }

    // MARK: - launchctl

    /// `launchctl print gui/<uid>/<label>` : exit 0 ⇒ chargé ; le pid vient de la
    /// ligne `\tpid = <n>` (UNE tabulation), absent ⇒ nil.
    private func printService(label: String) async -> (loaded: Bool, pid: Int32?) {
        guard let result = try? await launchctl(["print", "\(domain)/\(label)"]), result.code == 0 else {
            return (false, nil)
        }
        return (true, Self.jobPid(in: result.stdout))
    }

    nonisolated static func jobPid(in output: String) -> Int32? {
        for line in output.split(separator: "\n", omittingEmptySubsequences: true) {
            let prefix = "\tpid = "
            guard line.hasPrefix(prefix), !line.hasPrefix("\t\t") else { continue }
            if let pid = Int32(line.dropFirst(prefix.count)) { return pid }
        }
        return nil
    }

    /// `bootout` du label puis `print` jusqu'à exit ≠ 0 dans `unloadBudget` (DOC-2).
    private func bootoutAndWait(label: String) async throws {
        do {
            _ = try await launchctl(["bootout", "\(domain)/\(label)"])
        } catch {
            throw MemoryAgentError.launchctlFailed(command: "bootout", detail: Self.bounded(error.localizedDescription))
        }
        let deadline = ContinuousClock.now + .seconds(unloadBudget)
        while true {
            if await !printService(label: label).loaded { return }
            if ContinuousClock.now >= deadline {
                throw MemoryAgentError.launchctlFailed(command: "bootout", detail: "le service est toujours chargé")
            }
            await pause()
        }
    }

    /// `bootstrap gui/<uid> <plist>`, repris jusqu'à `bootstrapAttempts` essais.
    private func bootstrap() async throws {
        var lastDetail = ""
        let attempts = max(1, bootstrapAttempts)
        for attempt in 1...attempts {
            do {
                let result = try await launchctl(["bootstrap", domain, plistURL.path])
                if result.code == 0 { return }
                let stderr = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                lastDetail = stderr.isEmpty ? "code \(result.code)" : Self.bounded(stderr)
            } catch {
                lastDetail = Self.bounded(error.localizedDescription)
            }
            if attempt < attempts { await pause() }
        }
        throw MemoryAgentError.launchctlFailed(command: "bootstrap", detail: lastDetail)
    }

    private func launchctl(_ arguments: [String]) async throws -> ProcessRun {
        try await run(Self.launchctl, arguments, environment, Self.commandTimeout)
    }

    // MARK: - Port et santé

    private func holder() async -> MemoryPortOwnership {
        await StackOwnership.holder(ofPort: port, ourExecutable: executable, environment: environment, run: run)
    }

    /// Le port est-il utilisable par le job ? Libre, tenu par le memory-rs embarqué,
    /// indéterminé (aucune accusation), ou tenu par le job lui-même.
    private static func portAllows(_ owner: MemoryPortOwnership, jobPid: Int32?) -> Bool {
        switch owner {
        case .free, .ours, .unknown:
            return true
        case .foreign(_, let pid):
            return jobPid != nil && pid == jobPid
        }
    }

    private func guardPort(loaded: Bool, jobPid: Int32?) async throws {
        let deadline = ContinuousClock.now + .seconds(portFreeBudget)
        while true {
            let owner = await holder()
            if Self.portAllows(owner, jobPid: jobPid) { return }
            if ContinuousClock.now >= deadline {
                if loaded { try? await bootoutAndWait(label: label) }
                throw MemoryAgentError.portConflict(port: port, owner: owner)
            }
            await pause()
        }
    }

    private func awaitHealth(
        token: String,
        jobPid: Int32?,
        progress: @escaping @MainActor (AgentStep) -> Void
    ) async throws {
        progress(.health)
        let deadline = ContinuousClock.now + .seconds(healthBudget)
        while true {
            if let result = await healthProbe(healthURL), Self.isOurMemory(result, token: token) { return }
            if ContinuousClock.now >= deadline { break }
            await pause()
        }
        let owner = await holder()
        if case .foreign(_, let pid) = owner, pid != jobPid {
            try? await bootoutAndWait(label: label)
            throw MemoryAgentError.portConflict(port: port, owner: owner)
        }
        throw MemoryAgentError.healthTimeout(
            seconds: Int(healthBudget.rounded(.up)),
            log: Self.logTail(of: paths.memoryLog)
        )
    }

    private func pause() async {
        guard pollInterval > 0 else { return }
        try? await Task.sleep(for: .seconds(pollInterval))
    }

    // MARK: - Utilitaires

    /// Les 20 dernières lignes du journal, bornées à 300 caractères (la FIN est
    /// gardée : l'erreur qui fait sortir memory-rs est la dernière ligne). Seuls les
    /// 64 derniers Kio sont lus — le journal n'est jamais tourné.
    nonisolated static func logTail(of url: URL) -> String {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return "" }
        defer { try? handle.close() }
        guard let size = try? handle.seekToEnd() else { return "" }
        let window: UInt64 = 64 * 1024
        try? handle.seek(toOffset: size > window ? size - window : 0)
        guard let data = try? handle.readToEnd(), let text = String(data: data, encoding: .utf8) else { return "" }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true).suffix(20)
        let tail = lines.joined(separator: "\n")
        return tail.count <= 300 ? tail : "…" + String(tail.suffix(300))
    }

    nonisolated static func bounded(_ text: String, limit: Int = 300) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.count <= limit ? trimmed : String(trimmed.prefix(limit)) + "…"
    }
}
