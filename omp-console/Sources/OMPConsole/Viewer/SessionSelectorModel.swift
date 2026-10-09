// Le sélecteur de runs : la liste des sessions qu'on peut afficher, construite
// depuis le magasin d'état (S-4 de la feature `visionneuse-de-session`).
//
// Le sélecteur ne dépend PAS du kanban : il consomme la même lecture du magasin
// (`StoreHub`) et la même enveloppe que lui, donc aucun second lecteur à tenir
// synchronisé.
//
// La DÉRIVATION (choix, magasin absent, entrées écartées) vit désormais dans le
// noyau partagé (`SessionList.make(of:)`, `Viewer/SessionChoices.swift`) : la
// coque iOS la consomme telle quelle. Ce fichier ne garde que l'`ObservableObject`
// macOS et son abonnement au magasin.

import Combine
import ConsoleCore
import Foundation

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

    /// Le run d'une session, ou `nil` s'il n'est pas dans le magasin.
    func run(forFile file: String) -> RunChoice? {
        choices.first { $0.sessionFile == file }
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
        let list = SessionList.make(of: snapshot)
        choices = list.choices
        storeAbsent = list.storeAbsent
        discarded = list.discarded
    }
}
