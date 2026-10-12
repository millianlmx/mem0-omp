// La racine privée de l'app (S-1, BR-1) : TOUT ce que l'app possède vit dessous —
// composant téléchargé (omp), service mémoire mem0-rs et sa base, état de la
// pile mémoire, et les restes de l'ancien moteur podman (configuration XDG et
// données de sa VM) que la migration lit et que le nettoyage confirmé supprime.
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

    /// La racine est-elle DÉPLACÉE (S-2) ? Vrai quand `OMP_CONSOLE_SUPPORT_ROOT`
    /// est posée et non vide, et pour tout `AppPaths` construit directement sur une
    /// racine (cas des tests) : une telle racine isole le label et le dossier du
    /// plist de l'agent mem0-rs, sans jamais toucher `~/Library/LaunchAgents`.
    var isOverridden: Bool

    init(supportRoot: URL, isOverridden: Bool = true) {
        self.supportRoot = supportRoot
        self.isOverridden = isOverridden
    }

    /// La variable qui déplace toute la racine (posée et non vide ⇒ elle gagne).
    static let supportRootEnvironmentKey = "OMP_CONSOLE_SUPPORT_ROOT"

    /// Racine par défaut : `~/Library/Application Support/com.omp.console`, ou la
    /// valeur non vide de `OMP_CONSOLE_SUPPORT_ROOT`.
    static func standard(
        home: String = NSHomeDirectory(),
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> AppPaths {
        if let override = environment[supportRootEnvironmentKey], !override.isEmpty {
            return AppPaths(supportRoot: URL(fileURLWithPath: override, isDirectory: true), isOverridden: true)
        }
        let root = URL(fileURLWithPath: home, isDirectory: true)
            .appendingPathComponent("Library/Application Support/com.omp.console", isDirectory: true)
        return AppPaths(supportRoot: root, isOverridden: false)
    }

    /// `<racine>/mem0-rs` : le dossier de travail de l'agent mem0-rs (0700).
    var mem0Root: URL {
        supportRoot.appendingPathComponent("mem0-rs", isDirectory: true)
    }

    /// `<racine>/mem0-rs/mem0-rs.db` : la base SQLite servie par l'agent.
    var mem0Database: URL {
        mem0Root.appendingPathComponent("mem0-rs.db")
    }

    /// `<racine>/mem0-rs/mem0-rs.log` : stdout et stderr de l'agent.
    var mem0Log: URL {
        mem0Root.appendingPathComponent("mem0-rs.log")
    }

    /// Le dossier des plists d'agent : `~/Library/LaunchAgents` pour la racine
    /// réelle, `<racine>/LaunchAgents` pour une racine déplacée — dont le job ne
    /// survit donc pas à la session.
    var launchAgentsDir: URL {
        if isOverridden {
            return supportRoot.appendingPathComponent("LaunchAgents", isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents", isDirectory: true)
    }

    /// `<launchAgentsDir>/<label>.plist`.
    func launchAgentPlist(label: String) -> URL {
        launchAgentsDir.appendingPathComponent("\(label).plist")
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

    /// `<racine>/config` : le `XDG_CONFIG_HOME` de la machine podman de l'app.
    var configDir: URL {
        supportRoot.appendingPathComponent("config", isDirectory: true)
    }

    /// `<racine>/tmp` : le `TMPDIR` de CHAQUE invocation podman (S-1). podman
    /// dérive de `TMPDIR` tous les artefacts runtime d'une `machine` qui ne vivent
    /// pas sous les XDG (`gvproxy.pid`, `gvproxy.log`, sockets, journaux de VM) :
    /// sans ce dossier, l'app partagerait `$TMPDIR/podman/` avec le podman système
    /// (mesuré : les deux machines y écrivaient `gvproxy.pid` sous le même nom).
    var tmpDir: URL {
        supportRoot.appendingPathComponent("tmp", isDirectory: true)
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

    /// `<racine>/remote` : l'état du service d'API distante (le registre des
    /// appareils appairés ; les jetons, eux, vivent au trousseau).
    var remoteDir: URL {
        supportRoot.appendingPathComponent("remote", isDirectory: true)
    }

    /// `<racine>/remote/devices.json` : les appareils appairés, écrit en 0600.
    var devicesFile: URL {
        remoteDir.appendingPathComponent("devices.json")
    }

    /// `<stackRoot>/podman-migration` (0700) : les artefacts de la migration
    /// unique de la pile podman vers mem0-rs (S-4 d'omp-console-sans-podman).
    var podmanMigrationRoot: URL {
        stackRoot.appendingPathComponent("podman-migration", isDirectory: true)
    }

    /// La copie de `history.db` sortie du conteneur mem0-http par `podman cp`.
    var podmanHistoryCopy: URL {
        podmanMigrationRoot.appendingPathComponent("history.db")
    }

    /// Le stdout brut du dernier `mem0-rs import --json` terminé (codes 0 et 3).
    var podmanImportReport: URL {
        podmanMigrationRoot.appendingPathComponent("import-report.json")
    }

    /// `bascule.json` : le marqueur « une seule fois » de la migration (S-4),
    /// écrit seulement après l'arrêt réussi de la pile podman.
    var switchState: URL {
        podmanMigrationRoot.appendingPathComponent("bascule.json")
    }

    /// `<stackRoot>/installation-token` : le jeton d'installation de la pile
    /// (S-4), écrit en 0600 — voir `InstallationTokenStore`.
    var installationToken: URL {
        stackRoot.appendingPathComponent(InstallationTokenStore.fileName)
    }
}
