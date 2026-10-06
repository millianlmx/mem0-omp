// L'appariement run ↔ `sessionFile` : la SOURCE UNIQUE (S-1), extraite de
// `SessionSelectorModel.apply` pour qu'il n'existe pas deux implémentations de la
// même règle.
//
// Deux règles portent tout le reste :
//   — `running/` puis `history/`, dans leur ordre de lecture ; un `sessionFile`
//     absent, vide, ou DÉJÀ VU est écarté — la PREMIÈRE occurrence gagne, donc un
//     run vivant l'emporte sur son jumeau réconcilié dans `history/` ;
//   — un run est VIVANT si son entrée gagnante est `running/` et que son pid est
//     vivant. Le badge `isStale` du magasin ne décide pas : `publishRunning`
//     n'écrit rien quand seul `updatedAt` change, donc un run vivant au repos est
//     marqué périmé — s'y fier gèlerait sa durée (fait mesuré).

import Foundation

/// Un run du magasin : une entrée `running/` ou `history/` portant un
/// `sessionFile`.
public struct StoreRun: Equatable, Sendable {
    /// Identité du run.
    public var sessionFile: String
    /// Label écrit par le dépôt.
    public var label: String
    /// cwd de l'entrée gagnante.
    public var cwd: String
    public var phase: PipelinePhase
    /// Début du run : `phaseStartedAt` de l'entrée gagnante.
    public var phaseStartedAt: Double
    /// Non nil ⇒ l'entrée gagnante est `running/`.
    public var live: RunningEntry?
    /// Non nil ⇒ l'entrée gagnante est `history/`.
    public var finalState: PipelineFinalState?

    public init(sessionFile: String, label: String, cwd: String, phase: PipelinePhase, phaseStartedAt: Double, live: RunningEntry?, finalState: PipelineFinalState?) {
        self.sessionFile = sessionFile
        self.label = label
        self.cwd = cwd
        self.phase = phase
        self.phaseStartedAt = phaseStartedAt
        self.live = live
        self.finalState = finalState
    }
}

/// Tous les runs du magasin, dans l'ordre de lecture des enveloppes et
/// dédoublonnés par `sessionFile` (première occurrence gagnante).
public func storeRuns(of snapshot: StoreSnapshot) -> [StoreRun] {
    var runs: [StoreRun] = []
    var seen: Set<String> = []

    func append(_ sessionFile: String?, _ build: (String) -> StoreRun) {
        guard let sessionFile, !sessionFile.isEmpty, !seen.contains(sessionFile) else { return }
        seen.insert(sessionFile)
        runs.append(build(sessionFile))
    }

    for entry in snapshot.running.entries {
        append(entry.sessionFile) { file in
            StoreRun(
                sessionFile: file,
                label: entry.label,
                cwd: entry.cwd,
                phase: entry.phase,
                phaseStartedAt: entry.phaseStartedAt,
                live: entry,
                finalState: nil
            )
        }
    }
    for entry in snapshot.history.entries {
        append(entry.sessionFile) { file in
            StoreRun(
                sessionFile: file,
                label: entry.label,
                cwd: entry.cwd,
                phase: entry.phase,
                phaseStartedAt: entry.phaseStartedAt,
                live: nil,
                finalState: entry.finalState
            )
        }
    }
    return runs
}

/// Les runs d'une feature : `storeRuns` filtrés sur
/// `realpathOr(run.cwd) == realpathOr(worktree)`, ordonnés par
/// `lastPathComponent` du `sessionFile` croissant (le nom commence par
/// l'horodatage ISO : l'ordre lexicographique est chronologique, Doc-1).
///
/// `worktree` vide ⇒ AUCUN run : une feature `pending` (worktree vide) n'absorbe
/// jamais les runs du dépôt principal (parité `KanbanBoard.build`).
public func statsRuns(of snapshot: StoreSnapshot, worktree: String) -> [StoreRun] {
    guard !worktree.isEmpty else { return [] }
    let target = realpathOr(worktree)
    return storeRuns(of: snapshot)
        .filter { realpathOr($0.cwd) == target }
        .sorted { left, right in
            let leftName = (left.sessionFile as NSString).lastPathComponent
            let rightName = (right.sessionFile as NSString).lastPathComponent
            if leftName != rightName { return leftName < rightName }
            return left.sessionFile < right.sessionFile
        }
}

/// Un run est VIVANT si, et seulement si, son entrée gagnante est une entrée
/// `running/` dont l'`ownerPid` est non nul et vivant.
public func storeRunIsLive(_ run: StoreRun) -> Bool {
    guard let live = run.live, let pid = live.ownerPid else { return false }
    return pidAlive(pid)
}
