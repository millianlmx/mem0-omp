// La vérité des ports (S-2, BR-2 ; AC-1) : qui tient `127.0.0.1:<port>`, prouvé
// par `lsof`, et jamais une accusation inventée.
//
// Transport figé par la Documentation du contrat (mesuré le 2026-10-06) :
// `/usr/sbin/lsof -nP -iTCP:<port> -sTCP:LISTEN -F pcn` (binaire ABSOLU, convention
// du dépôt) puis `/bin/ps -p <pid> -o command=` pour rattacher le processus à la
// racine de support de l'app. Aucun enregistrement ⇒ personne n'écoute (le code de
// sortie 1 de lof n'est pas une erreur).
//
// Ordre de classification FIGÉ (contrat) :
//   1. ligne de commande préfixée par `<supportRoot>/` ⇒ `.ours` ;
//   2. sinon un conteneur de l'ANCIENNE pile en marche publiant ce port ⇒ `.legacyStack` ;
//   3. sinon `.foreign`.
// Plusieurs enregistrements lsof ⇒ le PREMIER fait foi. `lsof` absent ou sortie
// illisible ⇒ `.unknown(detail:)` : la préparation continue, aucune accusation.
//
// Ce que ce fichier ne connaît PAS : `MemoryStack`, les messages d'échec de la
// préparation (`SetupText`) et la section Mémoire. La traduction en erreur de
// domaine appartient à l'appelant.

import Foundation

/// Qui tient un port, tel que la sonde le prouve (S-2).
enum MemoryPortOwnership: Equatable, Sendable {
    case free
    /// Le forwarder de la pile de l'app : ligne de commande sous `<supportRoot>/`.
    case ours(process: String, pid: Int32)
    /// Un conteneur de l'ancienne pile mémoire qui publie ce port.
    case legacyStack(container: String)
    case foreign(process: String, pid: Int32)
    /// `lsof` indisponible ou sortie illisible.
    case unknown(detail: String)

    /// Le texte montré à l'utilisateur (S-2).
    var userDescription: String {
        switch self {
        case .free:
            return "personne"
        case .ours:
            return "la pile d'OMP Console"
        case .legacyStack(let container):
            return "l'ancienne pile mémoire (conteneur \(container))"
        case .foreign(let process, let pid):
            return "un autre programme (\(process), pid \(pid))"
        case .unknown(let detail):
            return "indéterminé (\(detail))"
        }
    }

    /// Le geste EXACT de la Documentation (S-2) : arrêter les conteneurs de
    /// l'ancienne pile, ou couper le programme qui tient le port.
    var gesture: String {
        switch self {
        case .legacyStack:
            return "podman stop mem0-qdrant mem0-http"
        default:
            return "arrêtez le programme qui tient le port (lsof -nP -iTCP:<port> -sTCP:LISTEN)"
        }
    }

    /// Le conteneur de l'ancienne pile, non nil SEULEMENT pour `.legacyStack`.
    var legacyContainer: String? {
        if case .legacyStack(let container) = self { return container }
        return nil
    }
}

/// La sonde de propriété d'un port (S-2). Fonction PURE vis-à-vis de l'app :
/// elle ne lit que `lsof`, `ps` et l'API Docker, toutes injectées par `run`.
enum StackOwnership {
    /// Le binaire `lsof`, visé par chemin ABSOLU (jamais via `PATH`).
    static let lsof = URL(fileURLWithPath: "/usr/sbin/lsof")

    /// Le binaire `ps`, visé par chemin ABSOLU.
    static let ps = URL(fileURLWithPath: "/bin/ps")

    /// Le budget d'un appel de sonde : `lsof`/`ps` répondent en quelques dizaines
    /// de millisecondes, 10 s couvrent un poste chargé sans bloquer la préparation.
    static let timeout: Double = 10

    /// L'argv de `lsof` : sortie pour programmes, un enregistrement par descripteur.
    static func lsofArguments(port: Int) -> [String] {
        ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-F", "pcn"]
    }

    /// `ps` en mode ligne de commande COMPLÈTE : c'est `command` (et non `comm`) qui
    /// porte le chemin absolu, donc le rattachement à `<supportRoot>/`.
    static func psArguments(pid: Int32) -> [String] {
        ["-p", String(pid), "-o", "command="]
    }

    /// Qui tient `port` (S-2). Voir l'algorithme figé en tête de fichier.
    static func holder(
        ofPort port: Int,
        paths: AppPaths,
        environment: [String: String],
        run: CommandRunner
    ) async -> MemoryPortOwnership {
        let lsofRun: ProcessRun
        do {
            lsofRun = try await run(lsof, lsofArguments(port: port), environment, timeout)
        } catch {
            return .unknown(detail: "lsof indisponible")
        }
        if lsofRun.timedOut {
            return .unknown(detail: "lsof n'a pas répondu")
        }
        // Code 0 (enregistrements) et code 1 (aucun) sont les deux issues normales ;
        // tout autre code est un échec de `lsof`.
        if lsofRun.code != 0, lsofRun.code != 1 {
            let detail = lsofRun.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            return .unknown(detail: detail.isEmpty ? "lsof a échoué (code \(lsofRun.code))" : bounded(detail))
        }
        guard let record = firstRecord(of: lsofRun.stdout) else {
            return .free
        }

        let process = record.command ?? "processus"

        // (1) Le processus appartient-il à la pile de l'app ?
        let commandRun = try? await run(ps, psArguments(pid: record.pid), environment, timeout)
        let commandLine = commandRun?.stdout.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !commandLine.isEmpty, commandLine.hasPrefix(supportPrefix(of: paths)) {
            return .ours(process: process, pid: record.pid)
        }

        // (2) Un conteneur de l'ancienne pile en marche publie-t-il ce port ?
        if let container = await legacyContainer(
            port: port,
            paths: paths,
            environment: environment,
            run: run
        ) {
            return .legacyStack(container: container)
        }

        // (3) Sinon : un autre programme.
        return .foreign(process: process, pid: record.pid)
    }

    // MARK: - L'ancienne pile, vue par l'API Docker

    /// Le nom du premier conteneur de l'ancienne pile EN MARCHE publiant `port`,
    /// cherché socket par socket dans l'ordre existant (`DockerSocket.candidates`).
    /// Le PREMIER socket qui répond décide : s'il n'offre pas le port, le port n'est
    /// pas celui de l'ancienne pile (on n'invente rien depuis un socket muet).
    private static func legacyContainer(
        port: Int,
        paths: AppPaths,
        environment: [String: String],
        run: CommandRunner
    ) async -> String? {
        let home = environment["HOME"] ?? NSHomeDirectory()
        for socket in DockerSocket.candidates(home: home) {
            guard let containers = await DockerSocket.containers(socket: socket, run: run) else { continue }
            for container in containers where container.running && container.publishedPorts.contains(port) {
                return container.name
            }
            return nil
        }
        return nil
    }

    // MARK: - Le décodage `-F pcn`

    /// Le PREMIER enregistrement de processus de la sortie `-F pcn` :
    /// `p<pid>` puis `c<comm>` (le nom de commande du noyau). `nil` si aucun `p`.
    static func firstRecord(of output: String) -> (pid: Int32, command: String?)? {
        var pid: Int32?
        var command: String?
        for rawLine in output.split(separator: "\n") {
            guard let tag = rawLine.first else { continue }
            let value = String(rawLine.dropFirst())
            switch tag {
            case "p":
                if pid != nil { return pid.map { ($0, command) } }  // deuxième enregistrement : on s'arrête
                pid = Int32(value)
            case "c":
                if pid != nil, command == nil { command = value }
            default:
                continue
            }
        }
        guard let found = pid else { return nil }
        return (found, command)
    }

    /// Le préfixe de rattachement à la pile, avec son séparateur (`<supportRoot>/`).
    private static func supportPrefix(of paths: AppPaths) -> String {
        let path = paths.supportRoot.path
        return path.hasSuffix("/") ? path : path + "/"
    }

    /// Le détail d'une erreur est borné à 300 caractères (convention S-2).
    private static func bounded(_ text: String, limit: Int = 300) -> String {
        text.count <= limit ? text : String(text.prefix(limit)) + "…"
    }
}
