// La vérité des ports (S-3 d'omp-console-sans-podman ; AC-5) : qui tient
// `127.0.0.1:<port>`, prouvé par `lsof`, et jamais une accusation inventée.
//
// Transport figé (mesuré le 2026-10-06) :
// `/usr/sbin/lsof -nP -iTCP:<port> -sTCP:LISTEN -F pcn` (binaire ABSOLU, convention
// du dépôt) puis `/bin/ps -p <pid> -o command=` pour rattacher le processus au
// binaire mem0-rs embarqué. Aucun enregistrement ⇒ personne n'écoute (le code de
// sortie 1 de lsof n'est pas une erreur).
//
// Classification FIGÉE :
//   1. ligne de commande égale au chemin de `ourExecutable`, ou commençant par
//      `<chemin> ` (suivi d'arguments) ⇒ `.ours` ;
//   2. sinon `.foreign`.
// Plusieurs enregistrements lsof ⇒ le PREMIER fait foi. `lsof` absent ou sortie
// illisible ⇒ `.unknown(detail:)` : la préparation continue, aucune accusation.
//
// Ce que ce fichier ne connaît PAS : `MemoryAgent`, les messages d'échec de la
// préparation (`SetupText`) et la section Mémoire. La traduction en erreur de
// domaine appartient à l'appelant.

import Foundation

/// Qui tient un port, tel que la sonde le prouve (S-3).
enum MemoryPortOwnership: Equatable, Sendable {
    case free
    /// Le mem0-rs embarqué dans l'app : ligne de commande = son chemin.
    case ours(process: String, pid: Int32)
    case foreign(process: String, pid: Int32)
    /// `lsof` indisponible ou sortie illisible.
    case unknown(detail: String)

    /// Le texte du diagnostic (S-3).
    var userDescription: String {
        switch self {
        case .free:
            return "personne"
        case .ours:
            return "le service mémoire d'OMP Console"
        case .foreign(let process, let pid):
            return "un autre programme (\(process), pid \(pid))"
        case .unknown(let detail):
            return "indéterminé (\(detail))"
        }
    }

    /// Le geste du diagnostic : couper le programme qui tient le port.
    var gesture: String {
        "arrêtez le programme qui tient le port (lsof -nP -iTCP:<port> -sTCP:LISTEN)"
    }
}

/// La sonde de propriété d'un port (S-3). Fonction PURE vis-à-vis de l'app :
/// elle ne lit que `lsof` et `ps`, tous deux injectés par `run`.
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

    /// Qui tient `port` (S-3). Voir l'algorithme figé en tête de fichier.
    static func holder(
        ofPort port: Int,
        ourExecutable: URL,
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
        let commandRun = try? await run(ps, psArguments(pid: record.pid), environment, timeout)
        let commandLine = commandRun?.stdout.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if isCommandLine(commandLine, of: ourExecutable) {
            return .ours(process: process, pid: record.pid)
        }
        return .foreign(process: process, pid: record.pid)
    }

    /// La ligne de commande lance-t-elle `executable` ? Égalité stricte, ou chemin
    /// suivi d'une espace (arguments) : un autre mem0-rs, même homonyme, n'est
    /// jamais « le nôtre ».
    static func isCommandLine(_ commandLine: String, of executable: URL) -> Bool {
        let path = executable.path
        return commandLine == path || commandLine.hasPrefix(path + " ")
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

    /// Le détail d'une erreur est borné à 300 caractères (convention S-2).
    private static func bounded(_ text: String, limit: Int = 300) -> String {
        text.count <= limit ? text : String(text.prefix(limit)) + "…"
    }
}
