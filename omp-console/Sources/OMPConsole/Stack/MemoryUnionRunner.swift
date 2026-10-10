// L'orchestration de l'union des souvenirs (S-8, BR-5 ; AC-9) : découvrir la base
// de l'ancienne pile, la recopier sur un staging, la servir par un conteneur
// LECTEUR temporaire, unir vers la base de l'app, nettoyer — et ne jamais faire
// échouer la préparation (l'union rend un état, jamais une exception).
//
// L'étape est SAUTÉE (`.nothingToDo`) quand la source est absente, quand l'ancienne
// pile TOURNE (le conflit de ports est le cas de S-6), ou quand l'empreinte de la
// source n'a pas changé depuis la dernière union réussie. Les données de l'ancienne
// pile ne sont JAMAIS montées par un autre moteur ni écrites : le conteneur lecteur
// ne voit qu'une COPIE de staging. Un échec rend `.incomplete` — la préparation
// continue, l'empreinte n'est pas enregistrée, la tentative repart au passage
// suivant.
//
// Le marqueur `stack/union.json` (`{"version":1,"source":…,"fingerprint":…,
// "copied":N,"date":…}`, clés triées, atomique, 0600) n'est écrit QUE pour
// `.nothingCopied`/`.caughtUp`.

import CryptoKit
import Foundation

@MainActor
final class MemoryUnionRunner {
    /// Le conteneur lecteur TEMPORAIRE (S-8) : `--rm`, sur une copie de staging.
    nonisolated static let unionContainer = "omp-console-union"
    /// Le port hôte du conteneur lecteur : dédié, jamais confondu avec la cible.
    nonisolated static let readerHostPort = 6335

    private let paths: AppPaths
    private let manifest: ComponentManifest
    private let environment: [String: String]
    private let run: CommandRunner
    private let session: URLSession
    private let fileManager = FileManager.default

    /// Budget d'attente de `GET /readyz` du conteneur lecteur — 90 s en production.
    var readyBudget: Double = 90
    /// Intervalle entre deux sondes — 2 s en production.
    var pollInterval: Double = 2
    /// Délai maximal d'UNE sonde HTTP.
    var probeTimeout: Double = 5
    /// Délai maximal d'UNE invocation podman.
    var commandTimeout: Double = 3600

    init(
        paths: AppPaths,
        manifest: ComponentManifest,
        environment: [String: String],
        run: CommandRunner,
        session: URLSession = .shared
    ) {
        self.paths = paths
        self.manifest = manifest
        self.environment = environment
        self.run = run
        self.session = session
    }

    /// Le binaire podman de l'app — jamais celui du système (B-3, S-1).
    private var podman: URL {
        paths.podmanDir(manifest.podmanVersion).appendingPathComponent("bin/podman")
    }

    private var podmanEnvironment: [String: String] {
        PodmanCommand.environment(base: environment, paths: paths)
    }

    /// Une passe d'union (S-8). Ne lève JAMAIS : rend un état.
    func run() async -> MemoryUnionOutcome {
        // 1. La source : la base de l'ancienne pile, par socket puis repli disque.
        guard let source = await LegacyStack.locatedStorage(environment: environment, run: run) else {
            return .nothingToDo
        }

        // 2. L'ancienne pile tourne : on ne la touche pas (conflit de ports, S-6).
        let runningLegacy = await LegacyStack.running(environment: environment, run: run)
        guard runningLegacy.isEmpty else { return .nothingToDo }

        // 3. L'empreinte de la source, comparée à celle du dernier succès.
        let fingerprint = Self.sourceFingerprint(of: source)
        if let recorded = recordedFingerprint(), recorded == fingerprint {
            return .nothingToDo
        }

        // 4. La copie de staging (jamais la source elle-même, jamais écrite).
        let staging = paths.unionStagingRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let stagedStorage = staging.appendingPathComponent("qdrant_storage", isDirectory: true)
        do {
            try fileManager.createDirectory(at: staging, withIntermediateDirectories: true)
            try fileManager.copyItem(at: source, to: stagedStorage)
        } catch {
            try? fileManager.removeItem(at: staging)
            return .incomplete(copied: 0, reason: "copie de staging impossible : \(bounded(error.localizedDescription))")
        }

        let outcome = await performUnion(source: source, fingerprint: fingerprint, stagedStorage: stagedStorage)

        // 8. Dans TOUS les chemins : le conteneur lecteur est retiré, la copie de
        // staging est supprimée.
        _ = await invoke(PodmanCommand.containerRemove(Self.unionContainer))
        try? fileManager.removeItem(at: staging)

        // Le marqueur n'est écrit QUE pour un succès.
        switch outcome {
        case .nothingCopied, .caughtUp:
            writeUnionState(source: source, fingerprint: fingerprint, copied: copiedCount(of: outcome))
        default:
            break
        }
        return outcome
    }

    // MARK: - Étapes 5 à 7

    private func performUnion(source: URL, fingerprint: String, stagedStorage: URL) async -> MemoryUnionOutcome {
        // 5. Le conteneur lecteur : `rm -f` TOLÉRANT, puis la sonde de port (S-2),
        // puis le `run` sur la copie de staging.
        _ = await invoke(PodmanCommand.containerRemove(Self.unionContainer))

        let ownership = await StackOwnership.holder(
            ofPort: Self.readerHostPort,
            paths: paths,
            environment: podmanEnvironment,
            run: run
        )
        switch ownership {
        case .free, .unknown:
            break
        default:
            return .incomplete(
                copied: 0,
                reason: "port \(Self.readerHostPort) tenu par \(ownership.userDescription)"
            )
        }

        let config = StackEnvStore.load(at: paths.stackEnv) ?? .defaults
        let arguments = PodmanCommand.readerRun(
            name: Self.unionContainer,
            image: manifest.qdrantImage,
            network: MemoryStack.networkName,
            storage: stagedStorage,
            hostPort: Self.readerHostPort,
            apiKey: config.qdrantApiKey
        )
        let reader = await invoke(arguments)
        guard let reader, reader.code == 0 else {
            let detail = resultDetail(reader).isEmpty ? "démarrage impossible" : resultDetail(reader)
            return .incomplete(copied: 0, reason: "conteneur lecteur : \(detail)")
        }

        // 6. La disponibilité du lecteur.
        guard await waitForReader() else {
            return .incomplete(copied: 0, reason: "conteneur lecteur injoignable (/readyz)")
        }

        // 7. L'union : source = lecteur (6335), cible = base vivante de l'app (6333).
        guard let readerURL = URL(string: "http://127.0.0.1:\(Self.readerHostPort)"),
              let targetURL = URL(string: "http://127.0.0.1:\(PodmanCommand.qdrantHostPorts[0])")
        else {
            return .incomplete(copied: 0, reason: "adresse locale invalide")
        }
        let sourceBase = HTTPMemoryBase(
            endpoint: QdrantEndpoint(baseURL: readerURL, apiKey: config.qdrantApiKey),
            session: session
        )
        let targetBase = HTTPMemoryBase(
            endpoint: QdrantEndpoint(baseURL: targetURL, apiKey: config.qdrantApiKey),
            session: session
        )
        let outcome = await MemoryUnion.run(source: sourceBase, target: targetBase)
        switch outcome {
        case .nothingCopied:
            return .nothingCopied(source: source.path, fingerprint: fingerprint)
        case .caughtUp(let copied, _, _):
            return .caughtUp(copied: copied, source: source.path, fingerprint: fingerprint)
        default:
            return outcome
        }
    }

    /// Sonde `GET http://127.0.0.1:6335/readyz` jusqu'au budget.
    private func waitForReader() async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(Self.readerHostPort)/readyz") else { return false }
        let deadline = Date().addingTimeInterval(readyBudget)
        while Date() < deadline {
            var request = URLRequest(url: url)
            request.timeoutInterval = probeTimeout
            if let (_, response) = try? await session.data(for: request),
               (response as? HTTPURLResponse)?.statusCode == 200
            {
                return true
            }
            if pollInterval > 0 {
                try? await Task.sleep(nanoseconds: UInt64(pollInterval * 1_000_000_000))
            }
        }
        return false
    }

    // MARK: - L'empreinte de la source

    /// L'empreinte d'un répertoire (S-8) : pour chaque entrée, une ligne
    /// `"<chemin relatif>\n<taille>\n<mtime en ms>\n"`, l'ensemble TRIÉ, puis
    /// SHA-256 (CryptoKit). Fonction pure — exposée pour être figée par test.
    nonisolated static func sourceFingerprint(of directory: URL, fileManager: FileManager = .default) -> String {
        var entries: [String] = []
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey, .isDirectoryKey]
        let base = directory.standardizedFileURL.path
        if let enumerator = fileManager.enumerator(at: directory, includingPropertiesForKeys: keys) {
            for case let url as URL in enumerator {
                let values = try? url.resourceValues(forKeys: Set(keys))
                var relative = url.standardizedFileURL.path
                if relative.hasPrefix(base) {
                    relative = String(relative.dropFirst(base.count))
                    if relative.hasPrefix("/") { relative = String(relative.dropFirst()) }
                }
                let size = values?.fileSize ?? 0
                let milliseconds = Int(((values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000).rounded())
                entries.append("\(relative)\n\(size)\n\(milliseconds)\n")
            }
        }
        entries.sort()
        let digest = SHA256.hash(data: Data(entries.joined().utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    /// L'empreinte enregistrée par la dernière union réussie ; `nil` si le
    /// marqueur est absent ou illisible.
    private func recordedFingerprint() -> String? {
        guard let data = try? Data(contentsOf: paths.unionState),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return object["fingerprint"] as? String
    }

    private func writeUnionState(source: URL, fingerprint: String, copied: Int) {
        let object: [String: Any] = [
            "version": 1,
            "source": source.path,
            "fingerprint": fingerprint,
            "copied": copied,
            "date": Self.timestamp(),
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
            try fileManager.createDirectory(at: paths.stackRoot, withIntermediateDirectories: true)
            try data.write(to: paths.unionState, options: [.atomic])
            try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: paths.unionState.path)
        } catch {
            // Un marqueur non inscriptible ne fait pas échouer la préparation : la
            // tentative repartira simplement au passage suivant.
        }
    }

    // MARK: - Outils

    @discardableResult
    private func invoke(_ arguments: [String]) async -> ProcessRun? {
        try? await run(podman, arguments, podmanEnvironment, commandTimeout)
    }

    private func resultDetail(_ result: ProcessRun?) -> String {
        guard let result else { return "" }
        let text = result.stderr.isEmpty ? result.stdout : result.stderr
        return bounded(text)
    }

    private func copiedCount(of outcome: MemoryUnionOutcome) -> Int {
        if case .caughtUp(let copied, _, _) = outcome { return copied }
        return 0
    }

    private func bounded(_ text: String, limit: Int = 300) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.count <= limit ? trimmed : String(trimmed.prefix(limit))
    }

    private static func timestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: Date())
    }
}
