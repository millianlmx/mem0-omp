// La liste des sessions qu'on peut afficher, telle que les DEUX coques la
// dérivent du magasin d'état (S-1 et S-2 de la feature `ios-sessions`).
//
// Le patron est `noyau-partage-console` : `RunChoice`/`RunChoiceState` ont
// DÉMÉNAGÉ de `Sources/OMPConsole/Viewer/SessionSelectorModel.swift`, dont il ne
// reste que l'`ObservableObject` macOS ; `SessionList.make(of:)` recopie la
// dérivation qui vivait dans son `apply(snapshot)` — elle devient leur unique
// appelant. La dérivation est PURE : c'est ce qui rend la parité vérifiable par
// un test, et non par la lecture de deux codes.
//
// Aucune E/S, aucun état : un instantané entre, des choix sortent.

import Foundation

/// L'état d'un run tel qu'il est montré dans la liste.
public enum RunChoiceState: Equatable, Sendable {
    case live(PipelineRunState)
    case ended(PipelineFinalState)
}

/// Une session choisissable. `id` est le `sessionFile` : c'est aussi l'identité de
/// la fenêtre qui l'affiche (S-4).
public struct RunChoice: Identifiable, Equatable, Sendable {
    public var id: String
    public var sessionFile: String
    public var label: String
    /// Le dépôt du run, tiré du label (ou du cwd) par `split(label:cwd:)`.
    public var repo: String
    /// Le titre de la feature, tiré du label par `split(label:cwd:)`.
    public var featureTitle: String
    /// Début du run : `phaseStartedAt` de l'entrée gagnante.
    public var startedAtMs: Double
    public var phase: PipelinePhase
    public var state: RunChoiceState
    public var isStale: Bool
    public var target: ViewerTarget

    public init(
        id: String,
        sessionFile: String,
        label: String,
        repo: String,
        featureTitle: String,
        startedAtMs: Double,
        phase: PipelinePhase,
        state: RunChoiceState,
        isStale: Bool,
        target: ViewerTarget
    ) {
        self.id = id
        self.sessionFile = sessionFile
        self.label = label
        self.repo = repo
        self.featureTitle = featureTitle
        self.startedAtMs = startedAtMs
        self.phase = phase
        self.state = state
        self.isStale = isStale
        self.target = target
    }

    /// Le dépôt et le titre d'un run : un label `<dépôt>/<feature>` se coupe au
    /// DERNIER `/` ; un label sans `/` est le titre, le dépôt est alors le dernier
    /// segment du `cwd`.
    public static func split(label: String, cwd: String) -> (repo: String, title: String) {
        if let slash = label.lastIndex(of: "/") {
            return (String(label[..<slash]), String(label[label.index(after: slash)...]))
        }
        return ((cwd as NSString).lastPathComponent, label)
    }

    /// La ligne qui situe un run : « <étape> · <dépôt> », dans la liste comme en
    /// sous-titre de sa fenêtre.
    public static func subtitle(phase: PipelinePhase, repo: String) -> String {
        "\(PhaseText.title(phase)) · \(repo)"
    }
}

/// La liste des sessions d'un instantané du magasin : les choix, et les deux
/// drapeaux d'état que la vue affiche (magasin absent, entrées écartées).
public struct SessionList: Equatable, Sendable {
    public var choices: [RunChoice]
    /// Vrai quand `running/` ET `history/` sont absents : « magasin absent » et
    /// « magasin vide » restent deux états distincts.
    public var storeAbsent: Bool
    /// Le nombre cumulé d'entrées écartées à la lecture (schéma invalide).
    public var discarded: Int

    public init(choices: [RunChoice], storeAbsent: Bool, discarded: Int) {
        self.choices = choices
        self.storeAbsent = storeAbsent
        self.discarded = discarded
    }

    /// La dérivation UNIQUE, recopiée TELLE QUELLE de
    /// `SessionSelectorModel.apply(snapshot)`. La règle d'appariement est celle de
    /// `storeRuns` (S-1) : elle a DÉMÉNAGÉ, elle n'est pas dupliquée. L'ordre et le
    /// dédoublonnage sont ceux du magasin.
    public static func make(of snapshot: StoreSnapshot) -> SessionList {
        let choices = storeRuns(of: snapshot).map { run in
            let state: RunChoiceState
            let isStale: Bool
            if let live = run.live {
                state = .live(live.state)
                isStale = live.isStale
            } else {
                // Une pipeline close n'est jamais périmée : elle est terminée.
                state = .ended(run.finalState ?? .done)
                isStale = false
            }
            let parts = RunChoice.split(label: run.label, cwd: run.cwd)
            return RunChoice(
                id: run.sessionFile,
                sessionFile: run.sessionFile,
                label: run.label,
                repo: parts.repo,
                featureTitle: parts.title,
                startedAtMs: run.phaseStartedAt,
                phase: run.phase,
                state: state,
                isStale: isStale,
                // La fenêtre se nomme par la feature, le sous-titre la situe :
                // aucun identifiant de session à l'écran (audit HIG 2026-10-01).
                target: ViewerTarget(
                    sessionFile: run.sessionFile,
                    title: parts.title,
                    subtitle: RunChoice.subtitle(phase: run.phase, repo: parts.repo)
                )
            )
        }
        return SessionList(
            choices: choices,
            storeAbsent: snapshot.running.availability == .absent && snapshot.history.availability == .absent,
            discarded: snapshot.running.discarded + snapshot.history.discarded
        )
    }
}

/// Le filtre par projet de la liste des sessions (S-2) : PUR, donc partagé — les
/// en-têtes de jour se recalculent après application.
public enum SessionFilter {
    /// Les projets DISTINCTS de la liste, dans l'ordre de PREMIÈRE apparition (le
    /// projet du run le plus récent d'abord) ; un dépôt vide n'est pas une option.
    public static func projects(of choices: [RunChoice]) -> [String] {
        var seen: Set<String> = []
        var projects: [String] = []
        for choice in choices where !choice.repo.isEmpty {
            if seen.insert(choice.repo).inserted { projects.append(choice.repo) }
        }
        return projects
    }

    /// Restreint la liste à un projet ; `nil` la rend entière.
    public static func apply(_ repo: String?, to choices: [RunChoice]) -> [RunChoice] {
        guard let repo else { return choices }
        return choices.filter { $0.repo == repo }
    }
}
