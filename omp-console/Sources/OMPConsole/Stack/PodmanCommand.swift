// Les `argv` de la pile mémoire (S-2, BR-2) — des générateurs PURS, jamais de
// lancement : `MemoryStack` est le seul à exécuter, et les tests figent ici chaque
// commande au caractère près, comme `GitCommand` (Files/GitCLI.swift) le fait pour
// git.
//
// Les valeurs de la pile sont celles de la Documentation du contrat (mesures du
// 2026-10-04) et de S-2 :
//   - machine dédiée `omp-console`, réseau `omp-console-stack`, conteneurs
//     `omp-console-qdrant` / `omp-console-mem0-http` (la dénomination des
//     conteneurs ne peut PAS heurter l'ancienne pile `mem0-qdrant`/`mem0-http`) ;
//   - publication de port `-p` sur `127.0.0.1` UNIQUEMENT (la machine podman est
//     isolée par XDG ; exposer sur 0.0.0.0 ouvrirait la mémoire au réseau) ;
//   - le conteneur qdrant monte `<stackRoot>/qdrant_storage` sur `/qdrant/storage`
//     (même point de montage que `mem0-stack/docker-compose.yml`, mesuré).
//
// `environment(base:paths:)` et `containersConf(helperBinariesDir:)` portent
// l'ISOLATION : sans `XDG_CONFIG_HOME`/`XDG_DATA_HOME` app-privés, podman
// retrouverait la machine du système (mesuré : `machine list` ne voit alors
// aucune machine système) ; sans `helper_binaries_dir` app-privé, `machine start`
// échoue « could not find "gvproxy" » (mesuré).

import Foundation

enum PodmanCommand {
    /// Les ports publiés sur l'hôte par le conteneur qdrant (S-2).
    static let qdrantHostPorts = [6333, 6334]
    /// Le port publié sur l'hôte par le conteneur mem0-http (S-2).
    static let mem0HostPort = 8321
    /// Le port interne de Qdrant dans le réseau de la pile (variable du conteneur).
    static let qdrantNetworkPort = 6333

    // MARK: - Machine

    /// Sans `--format` : le défaut de `machine inspect` EST le JSON. `--format` y est
    /// un TEMPLATE Go, pas la valeur spéciale « json » des autres commandes —
    /// `--format json` imprime littéralement « json » (mesuré sur podman 6.1.3 le
    /// 2026-10-05) et rend la machine indécodable, donc jugée absente.
    static func machineInspect(_ name: String) -> [String] {
        ["machine", "inspect", name]
    }

    static func machineInit(
        _ name: String,
        image: String,
        cpus: Int = 4,
        memory: Int = 4096,
        diskSize: Int = 50
    ) -> [String] {
        [
            "machine", "init", name,
            "--image", image,
            "--cpus", String(cpus),
            "--memory", String(memory),
            "--disk-size", String(diskSize),
        ]
    }

    static func machineStart(_ name: String) -> [String] {
        ["machine", "start", name]
    }

    /// `rm -f` : le `-f` évite l'invite interactive quand la machine tourne encore.
    static func machineRemove(_ name: String) -> [String] {
        ["machine", "rm", "-f", name]
    }

    // MARK: - Réseau

    static func networkInspect(_ name: String) -> [String] {
        ["network", "inspect", name]
    }

    static func networkCreate(_ name: String) -> [String] {
        ["network", "create", name]
    }

    // MARK: - Images

    static func imageExists(_ reference: String) -> [String] {
        ["image", "exists", reference]
    }

    static func imagePull(_ reference: String) -> [String] {
        ["image", "pull", reference]
    }

    static func imageBuild(tag: String, context: URL) -> [String] {
        ["image", "build", "-t", tag, context.path]
    }

    // MARK: - Conteneurs

    static func containerInspect(_ name: String) -> [String] {
        ["container", "inspect", name, "--format", "json"]
    }

    static func containerRemove(_ name: String) -> [String] {
        ["container", "rm", "-f", name]
    }

    static func containerStart(_ name: String) -> [String] {
        ["container", "start", name]
    }

    /// Le `run` du conteneur Qdrant, exactement la forme de S-2 : l'image épinglée
    /// du manifeste, les deux ports de l'API et des métriques, le volume de
    /// données et la clé d'API du service.
    static func qdrantRun(
        name: String,
        image: String,
        network: String,
        storage: URL,
        apiKey: String
    ) -> [String] {
        var arguments = [
            "run", "-d",
            "--name", name,
            "--restart", "unless-stopped",
            "--network", network,
        ]
        for port in qdrantHostPorts {
            arguments += ["-p", "127.0.0.1:\(port):\(port)"]
        }
        arguments += [
            "-v", "\(storage.path):/qdrant/storage",
            "-e", "QDRANT__SERVICE__API_KEY=\(apiKey)",
            image,
        ]
        return arguments
    }

    /// Le `run` du conteneur mem0-http : ses dix variables viennent de
    /// `StackConfig` — jamais de l'environnement de l'app seule (invariant S-2) —
    /// et son hôte Qdrant est le conteneur voisin, résolu par le DNS du réseau
    /// (`host.containers.internal` reste l'hôte du Mac, pour oMLX).
    static func mem0Run(
        name: String,
        image: String,
        network: String,
        qdrantHost: String,
        config: StackConfig
    ) -> [String] {
        [
            "run", "-d",
            "--name", name,
            "--restart", "unless-stopped",
            "--network", network,
            "-p", "127.0.0.1:\(mem0HostPort):\(mem0HostPort)",
            "-e", "QDRANT_HOST=\(qdrantHost)",
            "-e", "QDRANT_PORT=\(qdrantNetworkPort)",
            "-e", "QDRANT_API_KEY=\(config.qdrantApiKey)",
            "-e", "OMLX_BASE_URL=\(config.omlxBaseURL)",
            "-e", "OMLX_API_TOKEN=\(config.omlxApiToken)",
            "-e", "OMLX_LLM_MODEL=\(config.omlxLLMModel)",
            "-e", "OMLX_EMBED_MODEL=\(config.omlxEmbedModel)",
            "-e", "EMBEDDING_DIMS=\(config.embeddingDims)",
            "-e", "MEM0_HTTP_TOKEN=\(config.mem0HttpToken)",
            "-e", "PYTHONUNBUFFERED=1",
            image,
        ]
    }

    // MARK: - Environnement et configuration

    /// L'environnement de CHAQUE invocation podman : celui de l'app, plus les deux
    /// racines XDG privées. C'est l'invariant d'isolation de S-2 — aucune commande
    /// ne part sans elles.
    static func environment(base: [String: String], paths: AppPaths) -> [String: String] {
        var environment = base
        environment["XDG_CONFIG_HOME"] = paths.configDir.path
        environment["XDG_DATA_HOME"] = paths.dataDir.path
        return environment
    }

    /// Le contenu de `<configDir>/containers/containers.conf` (S-2), écrit AVANT
    /// toute commande machine : `[engine] helper_binaries_dir = ["<dir bin>"]`.
    /// C'est ce qui rend `gvproxy`/`krunkit` trouvables par `machine start` quand
    /// tout vit sous la racine privée de l'app.
    static func containersConf(helperBinariesDir: URL) -> String {
        "[engine]\nhelper_binaries_dir = [\"\(helperBinariesDir.path)\"]\n"
    }

    // MARK: - Lecture d'un argv

    /// Le libellé court d'une commande, pour `MemoryStackError.podmanFailed(command:)`.
    static func label(of arguments: [String]) -> String {
        guard let first = arguments.first else { return "podman" }
        let nouns = ["machine", "network", "image", "container"]
        if nouns.contains(first), arguments.count >= 2 {
            return "\(first) \(arguments[1])"
        }
        return first
    }

    /// Les ports HÔTE publiés par un `run` : le port de gauche de chaque `-p
    /// 127.0.0.1:<hôte>:<interne>` (forme `[adresse:]hôte:interne`). Sert à nommer
    /// le port occupé quand `run` échoue sur « address already in use ».
    static func publishedPorts(in arguments: [String]) -> [Int] {
        var ports: [Int] = []
        var index = 0
        while index < arguments.count {
            let argument = arguments[index]
            if argument == "-p" || argument == "--publish", index + 1 < arguments.count {
                if let port = hostPort(of: arguments[index + 1]) { ports.append(port) }
                index += 2
                continue
            }
            if argument.hasPrefix("--publish="), let port = hostPort(of: String(argument.dropFirst("--publish=".count))) {
                ports.append(port)
            }
            index += 1
        }
        return ports
    }

    /// Le port hôte d'une publication `[adresse:]hôte:interne` : l'avant-dernier
    /// composant (le dernier est le port interne).
    private static func hostPort(of publication: String) -> Int? {
        let parts = publication.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count >= 2 else { return nil }
        return Int(parts[parts.count - 2])
    }

    /// Deux références d'image désignent-elles la même ? On ignore le schéma
    /// (`docker://`) et un préfixe de registre local (`localhost/`) : podman
    /// réécrit une référence locale préfixée, et exiger l'égalité littérale
    /// ferait recréer un conteneur pourtant à jour.
    static func sameImage(_ lhs: String, _ rhs: String) -> Bool {
        normalize(lhs) == normalize(rhs)
    }

    private static func normalize(_ reference: String) -> String {
        var text = reference
        for prefix in ["docker://", "docker.io/", "localhost/"] where text.hasPrefix(prefix) {
            text.removeFirst(prefix.count)
        }
        return text
    }
}
