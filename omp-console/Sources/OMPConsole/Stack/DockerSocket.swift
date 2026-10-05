// L'API Docker sur socket Unix (S-3, BR-3) : découvrir l'ancienne pile mémoire,
// l'inspecter et l'arrêter — sans jamais lancer de shell.
//
// Transport figé par la Documentation du contrat (mesuré le 2026-10-04) :
// `/usr/bin/curl --silent --show-error --max-time 10 --unix-socket <socket> <url>`,
// exactement comme `mem0-stack/doctor.sh` §5 pour ce socket. Le corps des réponses
// arrive sur stdout (JSON des routes GET, code HTTP du POST via
// `-o /dev/null -w "%{http_code}"`), le décodage est TOLÉRANT comme `MemoryJSON` :
// un champ absent ou d'un autre type ne fait pas tomber la lecture entière.
//
// Ce que ce fichier ne connaît PAS : `StackMigration`, `mem0-qdrant`, `mem0-http`
// et tout message destiné à l'utilisateur. Le choix de la pile à viser et la
// traduction d'un échec en erreur de domaine appartiennent à l'appelant.
//
// Un socket ILLISIBLE n'est pas une erreur : chaque fonction rend `nil` (ou
// `.failed`) et l'appelant passe au suivant (invariant de S-3).

import Foundation

/// Un conteneur tel que `GET /containers/json?all=true` le résume.
struct DockerContainerSummary: Equatable, Sendable {
    let name: String
    let id: String
    let running: Bool
}

/// Un montage tel que `GET /containers/{id}/json` le décrit (`Type`, `Source`,
/// `Destination`).
struct DockerMount: Equatable, Sendable {
    let type: String
    let source: String
    let destination: String
}

/// Le détail utile d'un conteneur : son identifiant, ses montages et le dossier
/// de compose (label `com.docker.compose.project.working_dir`, absent si non posé).
struct DockerContainerDetail: Equatable, Sendable {
    let id: String
    let mounts: [DockerMount]
    let composeWorkingDir: String?
}

/// L'issue d'un `POST /containers/{id}/stop` : arrêté (204), déjà arrêté (304,
/// accepté), absent (404) ou échec (autre code, socket injoignable).
enum DockerStopResult: Equatable, Sendable {
    case stopped
    case alreadyStopped
    case absent
    case failed(detail: String)
}

/// Les quatre appels dont la migration a besoin, chacun avec le runner injecté
/// (`CommandRunner`) et un budget de 10 s par appel.
enum DockerSocket {
    /// Le budget de chaque appel socket (S-3) : la VM peut être lente à répondre à
    /// froid, mais un socket muet au-delà de 10 s est traité comme injoignable.
    static let timeout: Double = 10

    /// Le binaire de transport, jamais cherché dans le `PATH`.
    static let curl = URL(fileURLWithPath: "/usr/bin/curl")

    /// Les sockets essayés DANS L'ORDRE (S-3, mesuré le 2026-10-04) :
    /// `~/.docker/run/docker.sock` (celui des machines podman récentes) puis
    /// `/var/run/docker.sock` (celui posé par `podman-mac-helper`, souvent un lien).
    static func candidates(home: String) -> [String] {
        ["\(home)/.docker/run/docker.sock", "/var/run/docker.sock"]
    }

    /// `GET /containers/json?all=true` : tous les conteneurs, `nil` si le socket ne
    /// répond pas ou si la charge n'est pas le tableau attendu.
    static func containers(socket: String, run: CommandRunner) async -> [DockerContainerSummary]? {
        let url = "http://localhost/containers/json?all=true"
        guard let result = await execute(socket: socket, method: nil, url: url, captureBody: true, run: run),
              let json = try? JSONSerialization.jsonObject(with: Data(result.stdout.utf8)),
              let array = json as? [Any]
        else { return nil }
        return array.map { summary(of: $0) }
    }

    /// `GET /containers/{name}/json` : le détail d'un conteneur, `nil` si le socket
    /// ne répond pas, si le conteneur est absent ou si la charge est illisible.
    static func inspect(socket: String, name: String, run: CommandRunner) async -> DockerContainerDetail? {
        let url = "http://localhost/containers/\(name)/json"
        guard let result = await execute(socket: socket, method: nil, url: url, captureBody: true, run: run),
              let json = try? JSONSerialization.jsonObject(with: Data(result.stdout.utf8)),
              let object = json as? [String: Any]
        else { return nil }
        return detail(of: object)
    }

    /// `POST /containers/{name}/stop?t=10` : le code HTTP décide (`-o /dev/null
    /// -w "%{http_code}"`). Un socket injoignable ou un code inattendu rend
    /// `.failed` — la traduction en erreur de domaine appartient à l'appelant.
    static func stop(socket: String, name: String, run: CommandRunner) async -> DockerStopResult {
        let url = "http://localhost/containers/\(name)/stop?t=10"
        guard let result = await execute(socket: socket, method: "POST", url: url, captureBody: false, run: run) else {
            return .failed(detail: "socket \(socket) injoignable")
        }
        let body = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        if let code = Int(body) {
            switch code {
            case 204: return .stopped
            case 304: return .alreadyStopped
            case 404: return .absent
            default: return .failed(detail: "code HTTP \(code)")
            }
        }
        let stderr = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        return .failed(detail: stderr.isEmpty ? "réponse illisible (\(body))" : bounded(stderr))
    }

    // MARK: - L'exécution

    /// L'argv BRUT de `curl` : le tronc commun, puis `-o /dev/null -w "%{http_code}"`
    /// et `-X <method>` quand on ne veut que le code, et l'URL en dernier.
    private static func arguments(socket: String, method: String?, url: String, captureBody: Bool) -> [String] {
        var arguments = ["--silent", "--show-error", "--max-time", "10", "--unix-socket", socket]
        if !captureBody {
            arguments += ["-o", "/dev/null", "-w", "%{http_code}"]
            if let method { arguments += ["-X", method] }
        }
        arguments.append(url)
        return arguments
    }

    /// Lance un appel et rend le `ProcessRun` SEULEMENT s'il a réussi (code curl 0) ;
    /// un lancement impossible, un échec de curl ou un dépassement rendent `nil`.
    private static func execute(
        socket: String,
        method: String?,
        url: String,
        captureBody: Bool,
        run: CommandRunner
    ) async -> ProcessRun? {
        let argv = arguments(socket: socket, method: method, url: url, captureBody: captureBody)
        guard let result = try? await run(curl, argv, [:], timeout),
              result.code == 0,
              !result.timedOut
        else { return nil }
        return result
    }

    // MARK: - Le décodage tolérant

    private static func summary(of json: Any) -> DockerContainerSummary {
        let object = json as? [String: Any] ?? [:]
        return DockerContainerSummary(
            name: name(of: object),
            id: string(object["Id"]) ?? "",
            // Seul « running » vaut tourne (swagger : « created », « exited »,
            // « paused »… ne tournent pas).
            running: string(object["State"]) == "running"
        )
    }

    private static func detail(of json: [String: Any]) -> DockerContainerDetail {
        DockerContainerDetail(
            id: string(json["Id"]) ?? "",
            mounts: (json["Mounts"] as? [Any] ?? []).map { raw in
                let mount = raw as? [String: Any] ?? [:]
                return DockerMount(
                    type: string(mount["Type"]) ?? "",
                    source: string(mount["Source"]) ?? "",
                    destination: string(mount["Destination"]) ?? ""
                )
            },
            composeWorkingDir: label(of: json)
        )
    }

    /// `Names` est un tableau préfixé `/` (mesuré : `/mem0-qdrant`) ; on retire le
    /// préfixe. Un conteneur sans nom rend la chaîne vide et n'est jamais visé.
    private static func name(of object: [String: Any]) -> String {
        let raw = (object["Names"] as? [Any])?.first ?? object["Names"]
        guard let name = string(raw) else { return "" }
        return name.hasPrefix("/") ? String(name.dropFirst()) : name
    }

    /// `Config.Labels["com.docker.compose.project.working_dir"]`, `nil` si le label
    /// est absent, nul ou vide.
    private static func label(of object: [String: Any]) -> String? {
        guard let config = object["Config"] as? [String: Any],
              let labels = config["Labels"] as? [String: Any],
              let value = string(labels["com.docker.compose.project.working_dir"]),
              !value.isEmpty
        else { return nil }
        return value
    }

    /// Une valeur textuelle, `nil` si absente ou nulle (jamais de crash de type).
    private static func string(_ raw: Any?) -> String? {
        guard let raw, !(raw is NSNull) else { return nil }
        if let value = raw as? String { return value }
        if let value = raw as? NSNumber { return value.stringValue }
        return nil
    }

    /// Le détail d'une erreur est borné à 300 caractères (convention S-2).
    private static func bounded(_ text: String, limit: Int = 300) -> String {
        text.count <= limit ? text : String(text.prefix(limit)) + "…"
    }
}
