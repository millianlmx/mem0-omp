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
    var phase: PipelinePhase
    var state: RunChoiceState
    var isStale: Bool
    var sessionTag: String
    var target: ViewerTarget
}

@MainActor
final class SessionSelectorModel: ObservableObject {
    @Published private(set) var choices: [RunChoice] = []
    /// Vrai quand `running/` ET `history/` sont absents : « magasin absent » et
    /// « magasin vide » restent deux états distincts.
    @Published private(set) var storeAbsent = false
    /// Le nombre cumulé d'entrées écartées à la lecture (schéma invalide).
    @Published private(set) var discarded = 0

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
        var built: [RunChoice] = []
        var seen: Set<String> = []

        func append(_ sessionFile: String?, _ label: String, _ phase: PipelinePhase, _ state: RunChoiceState, _ isStale: Bool) {
            guard let sessionFile, !sessionFile.isEmpty, !seen.contains(sessionFile) else { return }
            seen.insert(sessionFile)
            let tag = sessionTag(forSessionFile: sessionFile)
            built.append(
                RunChoice(
                    id: sessionFile,
                    sessionFile: sessionFile,
                    label: label,
                    phase: phase,
                    state: state,
                    isStale: isStale,
                    sessionTag: tag,
                    target: ViewerTarget(sessionFile: sessionFile, title: "\(label) — \(tag)")
                )
            )
        }

        // L'ordre EST celui de l'enveloppe, à commencer par les runs vivants.
        for entry in snapshot.running.entries {
            append(entry.sessionFile, entry.label, entry.phase, .live(entry.state), entry.isStale)
        }
        for entry in snapshot.history.entries {
            // Une pipeline close n'est jamais périmée : elle est terminée.
            append(entry.sessionFile, entry.label, entry.phase, .ended(entry.finalState), false)
        }

        choices = built
        storeAbsent =
            snapshot.running.availability == .absent && snapshot.history.availability == .absent
        discarded = snapshot.running.discarded + snapshot.history.discarded
    }
}
