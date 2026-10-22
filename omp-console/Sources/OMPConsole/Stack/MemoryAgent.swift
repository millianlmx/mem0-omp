// L'agent launchd du service mémoire (S-2 d'omp-console-sans-podman ; AC-2, AC-3,
// AC-4, AC-5) : le `mem0-rs` embarqué dans le bundle, servi sur
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
// d'installation (`isOurMem0`) ; un port tenu par un autre programme que le job est
// un `portConflict` nommé, et le job chargé est alors DÉCHARGÉ plutôt que laissé
// boucler sur un bind impossible.
//
// Ce que ce fichier ne connaît PAS : la feuille de préparation et ses textes, la
// migration podman. Toute commande passe par `CommandRunner` (binaires ABSOLUS),
// la sonde HTTP est injectée : aucun test non gaté ne touche launchd ni un port.

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
    /// `log` = au plus les 20 dernières lignes de `mem0-rs.log`, bornées à 300
    /// caractères ; vide si le journal est illisible.
    case healthTimeout(seconds: Int, log: String)
}

@MainActor
final class MemoryAgent {
    nonisolated static let defaultLabel = "com.omp.console.mem0-rs"
    nonisolated static let defaultPort = 8321
    /// Réglage de recette (non documenté pour l'utilisateur final).
    nonisolated static let portEnvironmentKey = "OMP_CONSOLE_MEM0_PORT"
    nonisolated static let launchctl = URL(fileURLWithPath: "/bin/launchctl")
    /// Budget d'UNE invocation `launchctl`.
    nonisolated static let commandTimeout: Double = 10

    /// Le port servi : `OMP_CONSOLE_MEM0_PORT` si entier décimal 1–65535, sinon 8321.
    nonisolated static func port(environment: [String: String]) -> Int {
        guard let raw = environment[portEnvironmentKey],
              !raw.isEmpty,
              raw.allSatisfy({ $0.isASCII && $0.isNumber }),
              let value = Int(raw),
              (1...65535).contains(value)
        else { return defaultPort }
        return value
    }

    /// `defaultLabel` pour la racine réelle ; une racine déplacée a son propre
    /// label (12 premiers hex du SHA-256 de son chemin), donc son propre job.
    nonisolated static func label(paths: AppPaths) -> String {
        guard paths.isOverridden else { return defaultLabel }
        let digest = SHA256.hash(data: Data(paths.supportRoot.path.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return defaultLabel + "." + String(hex.prefix(12))
    }

    /// `<bundle>/Contents/Resources/mem0-rs` (copié par scripts/swift-app.sh).
    nonisolated static func embeddedBinary(bundle: Bundle = .main) -> URL {
        bundle.bundleURL.appendingPathComponent("Contents/Resources/mem0-rs")
    }

    /// Le prédicat d'ACCEPTATION de la sonde identitaire : 200, `ok == true` ET le
    /// champ `installation` égal au jeton de l'installation. Un `200` nu — autre
    /// service, pile manuelle sans variable — n'est JAMAIS accepté.
    nonisolated static func isOurMem0(_ result: (status: Int, body: Data), token: String) -> Bool {
        guard !token.isEmpty, result.status == 200, isMem0Healthy(result) else { return false }
        guard let raw = try? JSONSerialization.jsonObject(with: result.body, options: [.fragmentsAllowed]),
              let object = raw as? [String: Any]
        else { return false }
        return (object["installation"] as? String) == token
    }

    nonisolated static func isMem0Healthy(_ result: (status: Int, body: Data)) -> Bool {
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
        self.environment = environment
        self.run = run
        self.uid = uid
        self.healthProbe = healthProbe
    }

    /// `<launchAgentsDir>/<label>.plist`.
    var plistURL: URL { paths.launchAgentPlist(label: label) }

    /// `gui/<uid>` et `gui/<uid>/<label>`.
    var domain: String { "gui/\(uid)" }
    var serviceTarget: String { "\(domain)/\(label)" }

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

        // 2. Le jeton d'installation (jamais régénéré s'il existe).
        let token: String
        do {
            token = try InstallationTokenStore.loadOrCreate(at: paths.installationToken)
        } catch {
            throw MemoryAgentError.installationFailed(detail: Self.bounded("\(error.localizedDescription)"))
        }

        // 3. Le plist attendu et l'état du job.
        let expected = try expectedPlist(installationToken: token)
        let status = await printService()

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
            try await bootoutAndWait()
        }
        try await bootstrap()

        // 8. La santé.
        try await awaitHealth(token: token, jobPid: status.pid, progress: progress)
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
            "MEM0_DB_PATH": paths.mem0Database.path,
            "EMBEDDING_DIMS": String(config.embeddingDims),
            "OMLX_BASE_URL": StackConfig.nativeOMLXBaseURL(config.omlxBaseURL),
            "OMLX_API_TOKEN": config.omlxApiToken,
            "OMLX_LLM_MODEL": config.omlxLLMModel,
            "OMLX_EMBED_MODEL": config.omlxEmbedModel,
            "MEM0_HTTP_TOKEN": config.mem0HttpToken,
            "OMP_INSTALLATION_TOKEN": installationToken,
            "OMP_CONSOLE_MEM0_RS_SHA256": sha,
        ]
        return [
            "Label": label,
            "ProgramArguments": [executable.path, "--host", "127.0.0.1", "--port", String(port)],
            "WorkingDirectory": paths.mem0Root.path,
            "KeepAlive": true,
            "RunAtLoad": true,
            "ProcessType": "Interactive",
            "StandardOutPath": paths.mem0Log.path,
            "StandardErrorPath": paths.mem0Log.path,
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

    /// Écrit le plist (0600 : il porte des jetons), après avoir créé
    /// `launchAgentsDir` et `mem0Root` (0700).
    private func writePlist(_ plist: [String: Any]) throws {
        do {
            try fileManager.createDirectory(at: paths.launchAgentsDir, withIntermediateDirectories: true)
            try fileManager.createDirectory(at: paths.mem0Root, withIntermediateDirectories: true)
            try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: paths.mem0Root.path)
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
    private func printService() async -> (loaded: Bool, pid: Int32?) {
        guard let result = try? await launchctl(["print", serviceTarget]), result.code == 0 else {
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

    /// `bootout` puis `print` jusqu'à exit ≠ 0 dans `unloadBudget` (DOC-2).
    private func bootoutAndWait() async throws {
        do {
            _ = try await launchctl(["bootout", serviceTarget])
        } catch {
            throw MemoryAgentError.launchctlFailed(command: "bootout", detail: Self.bounded(error.localizedDescription))
        }
        let deadline = Date().addingTimeInterval(unloadBudget)
        while true {
            if await !printService().loaded { return }
            if Date() >= deadline {
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

    /// Le port est-il utilisable par le job ? Libre, tenu par le mem0-rs embarqué,
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
        let deadline = Date().addingTimeInterval(portFreeBudget)
        while true {
            let owner = await holder()
            if Self.portAllows(owner, jobPid: jobPid) { return }
            if Date() >= deadline {
                if loaded { try? await bootoutAndWait() }
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
        let deadline = Date().addingTimeInterval(healthBudget)
        while true {
            if let result = await healthProbe(healthURL), Self.isOurMem0(result, token: token) { return }
            if Date() >= deadline { break }
            await pause()
        }
        let owner = await holder()
        if case .foreign(_, let pid) = owner, pid != jobPid {
            try? await bootoutAndWait()
            throw MemoryAgentError.portConflict(port: port, owner: owner)
        }
        throw MemoryAgentError.healthTimeout(
            seconds: Int(healthBudget.rounded(.up)),
            log: Self.logTail(of: paths.mem0Log)
        )
    }

    private func pause() async {
        guard pollInterval > 0 else { return }
        try? await Task.sleep(for: .seconds(pollInterval))
    }

    // MARK: - Utilitaires

    /// Les 20 dernières lignes du journal, bornées à 300 caractères (la FIN est
    /// gardée : l'erreur qui fait sortir mem0-rs est la dernière ligne). Seuls les
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
