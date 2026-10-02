// Le sélecteur de runs : la liste des sessions qu'on peut afficher, construite
// depuis le magasin d'état (S-4 de la feature `visionneuse-de-session`).
//
// Le sélecteur ne dépend PAS du kanban : il consomme la même lecture du magasin
// (`StoreHub`) et la même enveloppe que lui, donc aucun second lecteur à tenir
// synchronisé.
//
// Deux règles de construction portent tout le reste :
//   — un run SANS `sessionFile` est absent de la liste (il n'y a rien à afficher) ;
//     l'instantané suivant le fera apparaître dès que le champ est publié ;
//   — le dédoublonnage se fait par `sessionFile`, la PREMIÈRE occurrence gagne :
//     un run vivant l'emporte donc sur son jumeau réconcilié dans `history/`.

import Combine
import Foundation

/// L'état d'un run tel qu'il est montré dans la liste.
enum RunChoiceState: Equatable, Sendable {
    case live(PipelineRunState)
    case ended(PipelineFinalState)
}

/// Une session choisissable. `id` est le `sessionFile` : c'est aussi l'identité de
/// la fenêtre qui l'affiche (S-4).
struct RunChoice: Identifiable, Equatable, Sendable {
    var id: String
    var sessionFile: String
    var label: String
    /// Le dépôt du run, tiré du label (ou du cwd) par `split(label:cwd:)`.
    var repo: String
    /// Le titre de la feature, tiré du label par `split(label:cwd:)`.
    var featureTitle: String
    /// Début du run : `phaseStartedAt` de l'entrée gagnante.
    var startedAtMs: Double
    var phase: PipelinePhase
    var state: RunChoiceState
    var isStale: Bool
    var target: ViewerTarget

    /// Le dépôt et le titre d'un run : un label `<dépôt>/<feature>` se coupe au
    /// DERNIER `/` ; un label sans `/` est le titre, le dépôt est alors le dernier
    /// segment du `cwd`.
    static func split(label: String, cwd: String) -> (repo: String, title: String) {
        if let slash = label.lastIndex(of: "/") {
            return (String(label[..<slash]), String(label[label.index(after: slash)...]))
        }
        return ((cwd as NSString).lastPathComponent, label)
    }

    /// La ligne qui situe un run : « <étape> · <dépôt> », dans la liste comme en
    /// sous-titre de sa fenêtre.
    static func subtitle(phase: PipelinePhase, repo: String) -> String {
        "\(PhaseText.title(phase)) · \(repo)"
    }
}

@MainActor
final class SessionSelectorModel: ObservableObject {
    @Published private(set) var choices: [RunChoice] = []
    /// Vrai quand `running/` ET `history/` sont absents : « magasin absent » et
    /// « magasin vide » restent deux états distincts.
    @Published private(set) var storeAbsent = false
    /// Le nombre cumulé d'entrées écartées à la lecture (schéma invalide).
    @Published private(set) var discarded = 0
    /// Les runs SÉLECTIONNÉS dans la liste (par `sessionFile`). Un clic
    /// sélectionne, un double-clic ou ↩ ouvre : la sélection vit ici car la vue
    /// n'a pas d'état propre (aucun attribut macro SwiftUI dans ce dépôt).
    @Published var selection: Set<RunChoice.ID> = []

    private let hub: StoreHub
    private var task: Task<Void, Never>?

    init(stateDir: String = PipelineStore.stateDir()) {
        let hub = StoreHub(stateDir: stateDir)
        self.hub = hub
        // L'agrégat COURANT est publié dès l'initialisation : pas d'état de
        // chargement artificiel, la liste est celle du disque à cet instant.
        apply(hub.current())
        let snapshots = hub.snapshots()
        task = Task { [weak self] in
            for await snapshot in snapshots {
                guard let self else { return }
                self.apply(snapshot)
            }
        }
    }

    /// Arrête l'abonnement et la veille du magasin. Idempotent.
    func stop() {
        task?.cancel()
        task = nil
        hub.stop()
    }

    deinit { task?.cancel() }

    private func apply(_ snapshot: StoreSnapshot) {
        // La règle d'appariement est celle de `storeRuns` (S-1) : elle a DÉMÉNAGÉ,
        // elle n'est pas dupliquée. L'ordre et le dédoublonnage sont ceux du magasin.
        choices = storeRuns(of: snapshot).map { run in
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
        storeAbsent =
            snapshot.running.availability == .absent && snapshot.history.availability == .absent
        discarded = snapshot.running.discarded + snapshot.history.discarded
    }
}
