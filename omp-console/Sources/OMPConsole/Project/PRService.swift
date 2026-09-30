// Le service de lecture et de fusion d'une PR (S-2, S-5, S-6) : un protocole pour
// être doublé dans les preuves, et l'implémentation `gh`.
//
// DEUX invocations `gh` par lecture, dans cet ordre ; une seule pour la fusion. Rien
// d'autre n'est écrit, aucune classification `bucket` n'est réimplémentée.

import Foundation

/// Le contrat employé par le modèle : lire l'état d'une PR, fusionner en squash.
protocol PRServicing: Sendable {
    func read(prUrl: String, in directory: String) async throws -> PRSnapshot
    func merge(prUrl: String, title: String, body: String, headOid: String, in directory: String) async throws
}

/// Le dépôt des résultats de lectures concurrentes : chaque tâche détachée y dépose
/// le sien, le modèle lit l'ensemble une fois toutes les tâches terminées. La tâche
/// ne REND donc pas sa valeur — sur ce toolchain, rendre une `String` depuis une
/// tâche détachée la corrompt aléatoirement sous `-O`.
final class PRReadCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Result<PRSnapshot, GhError>] = [:]

    func store(_ slug: String, _ result: Result<PRSnapshot, GhError>) {
        lock.lock()
        values[slug] = result
        lock.unlock()
    }

    var results: [String: Result<PRSnapshot, GhError>] {
        lock.lock()
        defer { lock.unlock() }
        return values
    }
}

struct GhPRService: PRServicing {
    let cli: GhCLI

    init(cli: GhCLI) {
        self.cli = cli
    }

    /// `gh pr view` puis `gh pr checks`, dans cet ordre, avec `cwd = directory`.
    /// L'adresse est VALIDÉE d'abord (S-3) : un `prUrl` non conforme lève
    /// `invalidPRURL` et AUCUN `Process` n'est créé.
    func read(prUrl: String, in directory: String) async throws -> PRSnapshot {
        guard let url = validatedPRURL(prUrl) else { throw GhError.invalidPRURL(url: prUrl) }
        let view = try await cli.run(GhCommand.prView(url: url), in: directory)
        try Self.requireSuccess(view, command: "pr view")
        let parsed = try Self.parse { try parsePRView(view.stdout) }

        let checks = try await cli.run(GhCommand.prChecks(url: url), in: directory)
        try Self.requireSuccess(checks, command: "pr checks")
        let readings = try Self.parse { try parseChecks(checks.stdout) }

        return PRSnapshot(
            title: parsed.title,
            headOid: parsed.headOid,
            body: parsed.body,
            checks: normalizedRequiredChecks(readings)
        )
    }

    /// La commande UNIQUE de S-6 : squash, sujet et corps de la PR, tête bornée. Un
    /// code non nul devient `commandFailed` avec la dernière ligne de `stderr` (le
    /// motif que GitHub a rendu).
    func merge(prUrl: String, title: String, body: String, headOid: String, in directory: String) async throws {
        guard let url = validatedPRURL(prUrl) else { throw GhError.invalidPRURL(url: prUrl) }
        let output = try await cli.run(
            GhCommand.prMerge(url: url, title: title, body: body, headOid: headOid),
            in: directory
        )
        try Self.requireSuccess(output, command: "pr merge")
    }

    /// Avec `--json`, un code 0 est garanti même pour des statuts rouges ou en attente
    /// (docs §3) : tout code non nul est donc un ÉCHEC de lecture.
    private static func requireSuccess(_ output: GhOutput, command: String) throws {
        guard output.code == 0 else {
            throw GhError.commandFailed(
                command: command,
                code: output.code,
                detail: FilesError.lastLine(output.stderr)
            )
        }
    }

    private static func parse<T>(_ body: () throws -> T) throws -> T {
        do {
            return try body()
        } catch let error as PRParseError {
            throw GhError.unreadableOutput(command: "pr view", detail: error.detail)
        } catch {
            throw GhError.unreadableOutput(command: "pr view", detail: error.localizedDescription)
        }
    }
}
