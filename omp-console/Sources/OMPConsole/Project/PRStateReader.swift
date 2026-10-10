// La lecture de l'état GitHub d'une PR pour l'ardoise (S-1 de
// pipelines-livrees-statut-pr-faux-et-doub) : `gh pr view --json
// state,mergedAt,closedAt -- <url>`, une invocation par URL.
//
// Un fait n'est JAMAIS inventé : toute lecture qui n'aboutit pas à un `state`
// connu lève une `GhError`, et l'appelant n'en retient rien (état « inconnu »,
// libellé « PR créée »). Seule une date absente ou illisible est tolérée : le fait
// reste valable, sans date de clôture.

import ConsoleCore
import Foundation

/// Le contrat employé par le registre des faits : lire l'état d'une PR.
protocol PullRequestStateReading: Sendable {
    func state(prUrl: String) async throws -> PullRequestFact
}

struct GhPullRequestStateReader: PullRequestStateReading {
    let cli: GhCLI

    init(cli: GhCLI) {
        self.cli = cli
    }

    /// Lit et forme dates ISO 8601 AVEC ou SANS fraction de seconde (Doc-3) ;
    /// une `struct` `Sendable`, donc légale en `static let`.
    private static let dateStyle = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

    /// L'URL est VALIDÉE d'abord (S-3 de chemins-du-magasin-non-confines) : une
    /// adresse refusée lève `invalidPRURL` et AUCUN processus n'est créé. Le
    /// répertoire de travail est le dossier de l'utilisateur : l'URL complète
    /// désigne seule le dépôt (Doc-1).
    func state(prUrl: String) async throws -> PullRequestFact {
        guard let url = validatedPRURL(prUrl) else { throw GhError.invalidPRURL(url: prUrl) }
        let output = try await cli.run(GhCommand.prState(url: url), in: NSHomeDirectory())
        guard output.code == 0 else {
            throw GhError.commandFailed(
                command: "pr view",
                code: output.code,
                detail: FilesError.lastLine(output.stderr)
            )
        }
        return try Self.parse(output.stdout, url: prUrl)
    }

    /// Le fait d'une sortie `gh` : un objet JSON dont `state` est l'une des trois
    /// valeurs de GitHub (Doc-2). `url` est l'adresse EXACTE du magasin, clé de
    /// jointure avec la carte.
    static func parse(_ stdout: String, url: String) throws -> PullRequestFact {
        guard let object = try? JSONSerialization.jsonObject(with: Data(stdout.utf8)) as? [String: Any] else {
            throw GhError.unreadableOutput(command: "pr view", detail: "sortie non JSON")
        }
        guard let raw = object["state"] as? String, let state = PullRequestState(rawValue: raw) else {
            throw GhError.unreadableOutput(command: "pr view", detail: "état de PR inconnu")
        }
        let closedAtMs: Double?
        switch state {
        case .open:
            closedAtMs = nil
        case .merged:
            closedAtMs = milliseconds(object["mergedAt"]) ?? milliseconds(object["closedAt"])
        case .closed:
            closedAtMs = milliseconds(object["closedAt"])
        }
        return PullRequestFact(url: url, state: state, closedAtMs: closedAtMs)
    }

    /// Une date GitHub en ms epoch ; `nil` pour `null`, une valeur absente ou
    /// illisible.
    private static func milliseconds(_ value: Any?) -> Double? {
        guard let text = value as? String, let date = try? dateStyle.parse(text) else { return nil }
        return date.timeIntervalSince1970 * 1000
    }
}
