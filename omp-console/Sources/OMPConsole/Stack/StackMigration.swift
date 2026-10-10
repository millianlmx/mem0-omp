// La migration automatique de l'ancienne base mémoire vers la pile de l'app
// (S-3, BR-3 ; AC-4).
//
// L'intention : mes souvenirs actuels se retrouvent dans l'app sans export/import
// ni geste de ma part. Le pipeline, dans l'ORDRE figé du contrat :
//
//  1. découvrir l'ancienne pile par `LegacyStack` (premier socket qui répond fait
//     foi, sinon repli disque) — sans JAMAIS l'arrêter ;
//  2. copier la base dans un dossier temporaire frère puis renommer (atomique) —
//     UNIQUEMENT si aucun conteneur legacy ne TOURNE et que la base de l'app n'a
//     pas encore de `collections` ; la source n'est JAMAIS supprimée et une base
//     déjà présente n'est JAMAIS recouverte ;
//  3. importer le `.env` de l'ancienne pile (0600) si l'app n'en a pas encore ;
//  4. écrire le marqueur informatif `stack/migration.json` (version 2).
//
// L'ARRÊT des conteneurs legacy a quitté la migration (S-6) : il n'a lieu que sur
// ordre explicite de l'utilisateur (`LegacyStack.stop`). On ne copie donc pas une
// base RocksDB vivante.
//
// Les gardes réelles sont les vérifications du système de fichiers (collections
// non vides, `stack/env` absent) : REJOUER la migration est sans effet. Aucun
// socket ne répond et aucun candidat disque n'a de base ⇒ résultat vide, PAS
// d'erreur : l'app démarre sur une base nouvelle.

import Foundation

/// L'avancement de la migration, pour la feuille de préparation (S-5, BR-5).
/// ADDITIF au contrat : `run()` reste la forme figée, `run(progress:)` l'enrichit.
enum MigrationStep: Equatable, Sendable {
    case copy
}

/// Ce que la migration a fait, en une valeur : la source trouvée (si une ancienne
/// pile existe), la copie effectuée et l'import du `.env`.
struct MigrationOutcome: Equatable, Sendable {
    var legacyStorage: URL?
    var copied: Bool
    var configImported: Bool
}

/// L'échec que la migration sait nommer (S-3) : une copie ratée ne doit jamais
/// passer pour une base migrée.
enum StackMigrationError: Error, Equatable, Sendable {
    case copyFailed(detail: String)
}

/// La migration, une fois par racine de support. `@MainActor` comme le reste de la
/// préparation : elle tourne pendant l'installation, jamais pendant une session.
@MainActor
final class StackMigration {
    private let paths: AppPaths
    private let environment: [String: String]
    private let runner: CommandRunner
    private let fileManager: FileManager

    init(
        paths: AppPaths,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        run: CommandRunner = .live,
        fileManager: FileManager = .default
    ) {
        self.paths = paths
        self.environment = environment
        self.runner = run
        self.fileManager = fileManager
    }

    /// La forme figée du contrat : aucune remontée d'avancement.
    func run() async throws -> MigrationOutcome {
        try await run(progress: { _ in })
    }

    /// Le pipeline complet. `progress` est appelé sur le MainActor avant la copie,
    /// pour la feuille « Préparation ».
    func run(progress: @escaping @MainActor (MigrationStep) -> Void) async throws -> MigrationOutcome {
        // 1. Découverte par `LegacyStack` : SANS arrêt. Ce qui TOURNE interdit la
        // copie (on ne copie pas une base RocksDB vivante) ; la source disque reste
        // connue pour l'import du `.env` et pour l'arrêt explicite ultérieur.
        let running = await LegacyStack.running(environment: environment, run: runner)
        let source = await LegacyStack.locatedStorage(environment: environment, run: runner)

        // 2. Copie gardée — jamais de recouvrement, jamais de suppression source —
        // et UNIQUEMENT si aucun conteneur legacy ne tourne.
        var copied = false
        if running.isEmpty, let source, !hasCollections(at: paths.qdrantStorage), hasCollections(at: source) {
            progress(.copy)
            do {
                try copyStorage(from: source, to: paths.qdrantStorage)
                copied = true
            } catch {
                throw StackMigrationError.copyFailed(detail: bounded("\(error)"))
            }
        }

        // 3. Import du `.env` de l'ancienne pile (défauts pour les clés absentes).
        // Le dossier est le parent de `qdrant_storage` (l'ancienne pile compose y
        // range son `.env`).
        let configImported = importConfig(source: source)

        // 4. Marqueur informatif — écrit à CHAQUE passage (S-3, étape 5,
        // inconditionnelle) : c'est le relevé de la dernière migration, jamais une
        // garde. Une écriture ratée ne fait pas échouer la migration.
        try? writeMarker(source: source, copied: copied)

        return MigrationOutcome(
            legacyStorage: source,
            copied: copied,
            configImported: configImported
        )
    }

    // MARK: - La copie

    /// Copie récursive vers un dossier temporaire FRÈRE puis renommage vers la
    /// destination (atomique à volume constant). La source n'est que lue. Si la
    /// destination existe déjà sans base (pas de `collections`), elle est remplacée ;
    /// l'appelant a déjà vérifié qu'elle ne contient PAS de base.
    private func copyStorage(from source: URL, to destination: URL) throws {
        let parent = destination.deletingLastPathComponent()
        try fileManager.createDirectory(at: parent, withIntermediateDirectories: true)
        let temporary = parent.appendingPathComponent(
            "\(destination.lastPathComponent).migration-\(UUID().uuidString)",
            isDirectory: true
        )
        do {
            try fileManager.copyItem(at: source, to: temporary)
            if fileManager.fileExists(atPath: destination.path) {
                try fileManager.removeItem(at: destination)
            }
            try fileManager.moveItem(at: temporary, to: destination)
        } catch {
            // Le dossier partiel est supprimé ; la source n'a jamais été touchée.
            try? fileManager.removeItem(at: temporary)
            throw error
        }
    }

    // MARK: - L'import de configuration

    /// Si `<stackEnv>` n'existe pas et qu'un `.env` vit à côté de la source (le
    /// parent de `qdrant_storage`), écrit la configuration en 0600. Un `.env`
    /// illisible ou vide rend les défauts de `StackConfig` — pas d'erreur, et jamais
    /// de réécriture d'un fichier déjà présent.
    private func importConfig(source: URL?) -> Bool {
        guard let source, !fileManager.fileExists(atPath: paths.stackEnv.path) else { return false }
        let envFile = source.deletingLastPathComponent().appendingPathComponent(".env")
        guard fileManager.fileExists(atPath: envFile.path) else { return false }
        // `load` rend `nil` seulement pour un fichier illisible ; un `.env` vide ou
        // sans clé connue rend déjà les défauts.
        let config = StackEnvStore.load(at: envFile, fileManager: fileManager) ?? .defaults
        do {
            try StackEnvStore.write(config, to: paths.stackEnv, fileManager: fileManager)
            return true
        } catch {
            // Aucune erreur de domaine pour l'import (S-3) : l'écriture ratée ne
            // bloque pas le démarrage, la configuration retombe sur les défauts.
            return false
        }
    }

    // MARK: - Le marqueur

    /// `{"version":2,"source":"<chemin>","copied":<bool>,"date":"<ISO8601>"}` —
    /// informatif : les gardes réelles sont les vérifications du système de fichiers.
    private func writeMarker(source: URL?, copied: Bool, date: Date = Date()) throws {
        try fileManager.createDirectory(at: paths.stackRoot, withIntermediateDirectories: true)
        let payload: [String: Any] = [
            "version": 2,
            "source": source?.path ?? "",
            "copied": copied,
            "date": ISO8601DateFormatter().string(from: date),
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys, .prettyPrinted])
        try data.write(to: paths.migrationState, options: [.atomic])
    }

    // MARK: - Les candidats disque de repli

    /// Quand aucun socket ne répond, le premier candidat dont `qdrant_storage`
    /// contient des `collections` gagne (S-3, ordre figé). Fonction PURE : sans
    /// acteur, pour que `LegacyStack` (non isolé) puisse l'appeler.
    nonisolated static func diskCandidates(home: String) -> [URL] {
        [
            "\(home)/Experiments/mem0-omp/mem0-stack",
            "\(home)/dev/mem0-omp/mem0-stack",
            "\(home)/src/mem0-omp/mem0-stack",
            "\(home)/Documents/mem0-omp/mem0-stack",
        ].map { URL(fileURLWithPath: $0, isDirectory: true) }
    }

    /// Un dossier `collections` PRÉSENT et NON VIDE — c'est la définition d'une base
    /// qdrant exploitable (mesuré : `qdrant_storage` contient `collections/`,
    /// `aliases/`, `raft_state.json`).
    private func hasCollections(at storage: URL) -> Bool {
        let collections = storage.appendingPathComponent("collections", isDirectory: true)
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: collections.path, isDirectory: &isDirectory),
              isDirectory.boolValue
        else { return false }
        return !((try? fileManager.contentsOfDirectory(atPath: collections.path)) ?? []).isEmpty
    }

    /// Le détail d'une erreur est borné à 300 caractères (convention S-2).
    private func bounded(_ text: String, limit: Int = 300) -> String {
        text.count <= limit ? text : String(text.prefix(limit)) + "…"
    }
}
