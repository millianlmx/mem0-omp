// Le FAIT de PR : l'état d'une PR tel que GitHub le rend (`gh pr view --json
// state,mergedAt,closedAt`), indexé par l'URL EXACTE écrite dans le magasin.
//
// L'ardoise (`KanbanBoard.build`) le reçoit en paramètre : la lecture vit dans la
// coque macOS, le transport vers iOS dans `ConsoleClient`. L'ABSENCE de fait est
// l'état « inconnu » (hors ligne, `gh` absent, échec de lecture) — jamais un fait
// par défaut.
//
// VIT DANS `ConsoleCore` : les deux coques dérivent la même ardoise.

import Foundation

/// L'état d'une PR (`PullRequestState` de GitHub) : `MERGED` est terminal,
/// `CLOSED` peut redevenir `OPEN`.
public enum PullRequestState: String, Codable, Sendable, Equatable {
    case open = "OPEN"
    case closed = "CLOSED"
    case merged = "MERGED"
}

/// L'état lu d'une PR. `closedAtMs` est l'instant de clôture en ms epoch :
/// fusion (à défaut fermeture) pour `merged`, fermeture pour `closed`, `nil`
/// pour `open` ou quand GitHub ne le date pas.
public struct PullRequestFact: Codable, Equatable, Sendable {
    /// L'URL EXACTE telle qu'écrite dans le magasin : clé de jointure avec
    /// `KanbanCard.prUrl`.
    public let url: String
    public let state: PullRequestState
    public let closedAtMs: Double?

    public init(url: String, state: PullRequestState, closedAtMs: Double?) {
        self.url = url
        self.state = state
        self.closedAtMs = closedAtMs
    }
}

public enum PullRequestFacts {
    /// Index par URL ; à URL égale, le dernier élément du tableau gagne.
    public static func index(_ facts: [PullRequestFact]) -> [String: PullRequestFact] {
        var indexed: [String: PullRequestFact] = [:]
        for fact in facts { indexed[fact.url] = fact }
        return indexed
    }

    /// Les URLs à suivre : chaque `prUrl` non vide d'une `LotFeature` `.done` et
    /// d'une `ProjectFeature` `.pr`/`.merged` du snapshot ; sans doublon, triées
    /// (ordre lexical).
    public static func urls(in snapshot: StoreSnapshot) -> [String] {
        var urls = Set<String>()
        for lot in snapshot.lots.lots {
            for feature in lot.features where feature.state == .done {
                if let url = feature.prUrl, !url.isEmpty { urls.insert(url) }
            }
        }
        for project in snapshot.projects.projects {
            for feature in project.segments.flatMap(\.features)
            where feature.status == .pr || feature.status == .merged {
                if let url = feature.prUrl, !url.isEmpty { urls.insert(url) }
            }
        }
        return urls.sorted()
    }
}
