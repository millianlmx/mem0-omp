// La racine privée de l'app (S-1, BR-1) : TOUT ce que l'app possède vit dessous —
// composants téléchargés (omp, podman), configuration XDG de sa machine podman,
// données de la VM, pile mémoire et son état.
//
// La variable `OMP_CONSOLE_SUPPORT_ROOT` déplace la racine entière (composants ET
// état) : c'est l'échappatoire de test qui permet de prouver une installation
// neuve sans toucher à l'installation réelle.
//
// Aucun chemin système n'est dérivé ici : la racine par défaut reprend la
// convention déjà en place pour le journal d'alertes (`AlertLedger.defaultPath`,
// Alerts/AlertLedger.swift:44).

import Foundation

struct AppPaths: Equatable, Sendable {
    var supportRoot: URL

    /// La variable qui déplace toute la racine (posée et non vide ⇒ elle gagne).
    static let supportRootEnvironmentKey = "OMP_CONSOLE_SUPPORT_ROOT"

    /// Racine par défaut : `~/Library/Application Support/com.omp.console`, ou la
    /// valeur non vide de `OMP_CONSOLE_SUPPORT_ROOT`.
    static func standard(
        home: String = NSHomeDirectory(),
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> AppPaths {
        if let override = environment[supportRootEnvironmentKey], !override.isEmpty {
            return AppPaths(supportRoot: URL(fileURLWithPath: override, isDirectory: true))
        }
        let root = URL(fileURLWithPath: home, isDirectory: true)
            .appendingPathComponent("Library/Application Support/com.omp.console", isDirectory: true)
        return AppPaths(supportRoot: root)
    }

    /// `<racine>/components` : les binaires et leur charge utile.
    var componentsRoot: URL {
        supportRoot.appendingPathComponent("components", isDirectory: true)
    }

    /// `<racine>/components/omp/<version>` : contient `omp`.
    func ompDir(_ version: String) -> URL {
        componentsRoot
            .appendingPathComponent("omp", isDirectory: true)
            .appendingPathComponent(version, isDirectory: true)
    }

    /// `<racine>/components/podman/<version>` : contient `bin`, `lib`, `share`.
    func podmanDir(_ version: String) -> URL {
        componentsRoot
            .appendingPathComponent("podman", isDirectory: true)
            .appendingPathComponent(version, isDirectory: true)
    }

    /// `<racine>/config` : le `XDG_CONFIG_HOME` de la machine podman de l'app.
    var configDir: URL {
        supportRoot.appendingPathComponent("config", isDirectory: true)
    }

    /// `<racine>/data` : le `XDG_DATA_HOME` de la machine podman de l'app.
    var dataDir: URL {
        supportRoot.appendingPathComponent("data", isDirectory: true)
    }

    /// `<racine>/stack` : la pile mémoire de l'app.
    var stackRoot: URL {
        supportRoot.appendingPathComponent("stack", isDirectory: true)
    }

    /// Le dossier de données Qdrant de l'app (monté sur `/qdrant/storage`).
    var qdrantStorage: URL {
        stackRoot.appendingPathComponent("qdrant_storage", isDirectory: true)
    }

    /// Le `.env` de la pile de l'app (mêmes clés que `mem0-stack/.env`).
    var stackEnv: URL {
        stackRoot.appendingPathComponent("env")
    }

    /// `<racine>/memory-links.json` : les liens MANUELS du graphe de la mémoire
    /// (S-11). C'est un artefact de la vue, pas une donnée mem0 — il vit donc sous
    /// la racine de l'app, comme le reste de son état.
    var memoryLinks: URL {
        supportRoot.appendingPathComponent(MemoryLinkStore.fileName)
    }

    /// L'image de machine retenue au dernier `machine init` de l'app.
    var machineState: URL {
        stackRoot.appendingPathComponent("machine.json")
    }

    /// Le marqueur informatif de la migration (S-3).
    var migrationState: URL {
        stackRoot.appendingPathComponent("migration.json")
    }
}
