// Les `argv` podman de la migration unique et du nettoyage confirmé de l'ancien
// moteur (S-4, S-6, S-7) — des générateurs PURS, jamais de lancement :
// `PodmanLegacy` est le seul à exécuter, et les tests figent ici chaque commande
// au caractère près, comme `GitCommand` (Files/GitCLI.swift) le fait pour git.
//
// La pile podman d'avant mem0-rs vivait dans la machine dédiée `omp-console`
// (conteneurs `omp-console-qdrant` / `omp-console-mem0-http`) ; l'app ne la
// crée plus, elle ne fait que la démarrer pour l'importer, l'arrêter, puis la
// supprimer sur confirmation.
//
// `environment(base:paths:)` et `containersConf(helperBinariesDir:)` portent
// l'ISOLATION : sans `XDG_CONFIG_HOME`/`XDG_DATA_HOME` app-privés, podman
// retrouverait la machine du système (mesuré : `machine list` ne voit alors
// aucune machine système) ; sans `helper_binaries_dir` app-privé, `machine start`
// échoue « could not find "gvproxy" » (mesuré).

import Foundation

enum PodmanCommand {
    // MARK: - Machine

    /// Sans `--format` : le défaut de `machine inspect` EST le JSON. `--format` y est
    /// un TEMPLATE Go, pas la valeur spéciale « json » des autres commandes —
    /// `--format json` imprime littéralement « json » (mesuré sur podman 6.1.3 le
    /// 2026-10-05) et rend la machine indécodable, donc jugée absente.
    static func machineInspect(_ name: String) -> [String] {
        ["machine", "inspect", name]
    }

    static func machineStart(_ name: String) -> [String] {
        ["machine", "start", name]
    }

    /// L'arrêt de la machine une fois ses conteneurs arrêtés (S-4).
    static func machineStop(_ name: String) -> [String] {
        ["machine", "stop", name]
    }

    /// `rm -f` : le `-f` évite l'invite interactive quand la machine tourne encore.
    static func machineRemove(_ name: String) -> [String] {
        ["machine", "rm", "-f", name]
    }

    // MARK: - Conteneurs

    static func containerInspect(_ name: String) -> [String] {
        ["container", "inspect", name, "--format", "json"]
    }

    static func containerStart(_ name: String) -> [String] {
        ["container", "start", name]
    }

    /// L'arrêt des conteneurs de la migration (S-4) : `--ignore` rend un conteneur
    /// absent du store sans erreur ; un conteneur déjà arrêté est un succès.
    static func containerStop(_ names: [String]) -> [String] {
        ["stop", "--ignore"] + names
    }

    /// `podman cp <conteneur>:<chemin> <fichier hôte>` : marche conteneur arrêté
    /// ou non ; le dossier parent de la destination doit exister (DOC-3).
    static func copyOut(container: String, path: String, to destination: URL) -> [String] {
        ["cp", "\(container):\(path)", destination.path]
    }

    // MARK: - Environnement et configuration

    /// L'environnement de CHAQUE invocation podman : celui de l'app, plus les deux
    /// racines XDG privées et le `TMPDIR` privé. C'est l'invariant d'isolation de
    /// S-1/S-2 — aucune commande ne part sans eux.
    ///
    /// `TMPDIR` est ÉCRASÉ (jamais conservé) : podman en dérive tous les artefacts
    /// runtime d'une `machine` qui ne vivent pas sous les XDG — `gvproxy.pid`,
    /// `gvproxy.log` (noms NON préfixés par la machine), sockets et journaux de VM
    /// — sous `$TMPDIR/podman/` (source `pkg/machine/env/dir_darwin.go`, et mesuré
    /// le 2026-10-06 : les artefacts des deux machines cohabitaient). Avec le
    /// `TMPDIR` privé de l'app, plus rien n'est partagé avec le podman système.
    static func environment(base: [String: String], paths: AppPaths) -> [String: String] {
        var environment = base
        environment["XDG_CONFIG_HOME"] = paths.configDir.path
        environment["XDG_DATA_HOME"] = paths.dataDir.path
        environment["TMPDIR"] = paths.tmpDir.path
        return environment
    }

    /// Le contenu de `<configDir>/containers/containers.conf` (S-2), écrit AVANT
    /// toute commande machine : `[engine] helper_binaries_dir = ["<dir bin>"]`.
    /// C'est ce qui rend `gvproxy`/`krunkit` trouvables par `machine start` quand
    /// tout vit sous la racine privée de l'app.
    static func containersConf(helperBinariesDir: URL) -> String {
        "[engine]\nhelper_binaries_dir = [\"\(helperBinariesDir.path)\"]\n"
    }
}
