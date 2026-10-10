// L'ancienne pile mémoire (mem0-qdrant / mem0-http sous la machine podman
// système) : la SEULE autorité sur sa découverte et son arrêt (S-6, BR-7 ; AC-6).
//
// Règle de la feature : la préparation automatique n'arrête JAMAIS un conteneur de
// l'ancienne pile — l'arrêt n'a lieu que sur ordre explicite de l'utilisateur. Ce
// fichier ne fait donc que DEUX choses : dire ce qui tourne et où vit sa base
// (`running`, `locatedStorage`), et l'arrêter quand on le lui demande (`stop`).
//
// Découverte (déplacée telle quelle depuis `StackMigration`) : le PREMIER socket
// Docker qui répond fait foi (`DockerSocket.candidates`), ses conteneurs legacy
// sont inspectés pour retrouver le montage `/qdrant/storage` ; quand AUCUN socket
// ne répond, le repli disque consulte `StackMigration.diskCandidates` et retient le
// premier dossier dont `qdrant_storage/collections` est non vide. Les conteneurs de
// l'app ne sont jamais visés ; aucun `container rm`, aucune écriture.

import Foundation

/// Le seul échec que l'arrêt sait nommer : un conteneur refuse de s'arrêter et ses
/// ports resteraient tenus. Le texte destiné à l'utilisateur vit dans `SetupText`.
enum LegacyStackError: Error, Equatable, Sendable {
    case stopFailed(container: String, detail: String)
}

/// L'ancienne pile, vue par l'API Docker (transport `DockerSocket`, jamais de
/// shell). Les conteneurs visés sont les SEULS noms de `containerNames`.
enum LegacyStack {
    /// Les conteneurs de l'ancienne pile, dans l'ordre où ils sont inspectés et
    /// arrêtés (déterministe). Déplacé tel quel depuis `StackMigration`.
    static let containerNames = ["mem0-qdrant", "mem0-http"]

    /// Le dossier monté sur `/qdrant/storage` dans l'inspect (S-3/S-6).
    static let storageDestination = "/qdrant/storage"

    /// Les noms des conteneurs de l'ancienne pile qui TOURNENT, dans l'ordre de
    /// `containerNames`. Vide quand aucun socket ne répond (le repli disque ne
    /// « tourne » pas) ou quand aucun conteneur legacy n'existe.
    static func running(environment: [String: String], run: CommandRunner) async -> [String] {
        await discover(environment: environment, run: run).running
    }

    /// Le dossier de données de la base de l'ancienne pile, par socket puis par
    /// repli disque ; `nil` quand ni la pile ni le disque n'en portent.
    static func locatedStorage(environment: [String: String], run: CommandRunner) async -> URL? {
        await discover(environment: environment, run: run).storage
    }

    /// Arrête les conteneurs de l'ancienne pile qui TOURNENT, dans l'ordre de
    /// `containerNames`, par le premier socket Docker qui répond.
    ///
    /// 204 (arrêté) et 304 (déjà arrêté) sont consignés, 404 (absent) est toléré ;
    /// tout autre code lève `LegacyStackError.stopFailed(container:detail:)`. Aucun
    /// socket ne répond ⇒ rien à arrêter, `[]` (jamais d'erreur).
    static func stop(environment: [String: String], run: CommandRunner) async throws -> [String] {
        let home = environment["HOME"] ?? NSHomeDirectory()
        for socket in DockerSocket.candidates(home: home) {
            guard let containers = await DockerSocket.containers(socket: socket, run: run) else { continue }
            // Le PREMIER socket qui répond fait foi, qu'il porte ou non la pile.
            let legacy = containers.filter { containerNames.contains($0.name) }
            var stopped: [String] = []
            for name in containerNames {
                guard let summary = legacy.first(where: { $0.name == name }), summary.running else { continue }
                switch await DockerSocket.stop(socket: socket, name: name, run: run) {
                case .stopped, .alreadyStopped:
                    stopped.append(name)
                case .absent:
                    continue
                case let .failed(detail):
                    throw LegacyStackError.stopFailed(container: name, detail: detail)
                }
            }
            return stopped
        }
        return []
    }

    // MARK: - La découverte

    /// Le résultat d'une passe de découverte : ce qui tourne et où vit la base.
    private struct Discovery {
        var running: [String]
        var storage: URL?
    }

    /// La découverte figée de S-6 : premier socket qui répond → conteneurs legacy
    /// → `inspect` → montage `/qdrant/storage` ; sinon repli disque.
    private static func discover(environment: [String: String], run: CommandRunner) async -> Discovery {
        let home = environment["HOME"] ?? NSHomeDirectory()
        for socket in DockerSocket.candidates(home: home) {
            guard let containers = await DockerSocket.containers(socket: socket, run: run) else { continue }
            let legacy = containers.filter { containerNames.contains($0.name) }
            guard !legacy.isEmpty else { return Discovery(running: [], storage: nil) }

            var storage: URL?
            for name in containerNames where legacy.contains(where: { $0.name == name }) {
                if storage == nil,
                   let detail = await DockerSocket.inspect(socket: socket, name: name, run: run),
                   let mount = detail.mounts.first(where: { $0.destination == storageDestination }) {
                    storage = URL(fileURLWithPath: mount.source, isDirectory: true)
                }
            }
            let running = containerNames.filter { name in
                legacy.contains { $0.name == name && $0.running }
            }
            return Discovery(running: running, storage: storage)
        }

        // Repli disque quand AUCUN socket n'a répondu : premier candidat dont la
        // base a des `collections`.
        for candidate in StackMigration.diskCandidates(home: home) {
            let storage = candidate.appendingPathComponent("qdrant_storage", isDirectory: true)
            if hasCollections(at: storage) {
                return Discovery(running: [], storage: storage)
            }
        }
        return Discovery(running: [], storage: nil)
    }

    /// Un dossier `collections` PRÉSENT et NON VIDE — même définition que
    /// `StackMigration` (mesuré : `qdrant_storage` contient `collections/`,
    /// `aliases/`, `raft_state.json`).
    private static func hasCollections(at storage: URL) -> Bool {
        let collections = storage.appendingPathComponent("collections", isDirectory: true)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: collections.path, isDirectory: &isDirectory),
              isDirectory.boolValue
        else { return false }
        return !((try? FileManager.default.contentsOfDirectory(atPath: collections.path)) ?? []).isEmpty
    }
}
