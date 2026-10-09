// La visionneuse d'une session (S-5, S-6 de la feature `visionneuse-de-session`,
// S-15 de omp-console-redesign) : le fil de conversation partagé
// (`ConversationThread`), poussé DANS la section Sessions de la fenêtre
// principale — jamais une fenêtre annexe, pour que l'app reste utilisable en
// plein écran (demande du 2026-10-02). Le bouton retour de la barre d'outils
// ramène à la liste.
//
// La barre d'outils porte l'état du fil en pilule Liquid Glass teintée
// (`StatusPill`) et, hors du direct, « Revenir au direct ». Le titre est celui
// de la feature, le sous-titre « étape · dépôt ».
//
// Aucun attribut macro SwiftUI (Documentation §3) : l'état vit dans
// `SessionViewerModel`, et `@StateObject` — une vraie property wrapper — l'alloue
// par session ouverte.

import ConsoleCore
import SwiftUI

/// Le contenu d'UNE session : son modèle vit ici, et nulle part ailleurs.
struct SessionViewerContent: View {
    @StateObject private var model: SessionViewerModel
    /// Le lecteur du magasin de la section (celui de la liste) : un run qui se
    /// termine pendant l'affichage fait tomber « En direct » sans réouverture.
    @ObservedObject var runs: SessionSelectorModel

    init(target: ViewerTarget, runs: SessionSelectorModel) {
        // Évalué UNE fois par session poussée : chaque visionneuse a son modèle.
        _model = StateObject(wrappedValue: SessionViewerModel(target: target))
        self.runs = runs
    }

    var body: some View {
        ConversationThread(model: model)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle(model.target.title)
            .navigationSubtitle(model.target.subtitle ?? "")
            .toolbar {
                if let status = ConversationText.status(
                    state: model.state,
                    following: model.following,
                    isEmpty: model.rows.isEmpty,
                    runEnded: RunChoice.hasEnded(runs.run(forFile: model.target.sessionFile))
                ) {
                    // La pilule est son propre verre : pas de second fond.
                    ToolbarItem(placement: .primaryAction) {
                        StatusPill(status: status)
                            .accessibilityIdentifier("viewer.status")
                    }
                    .sharedBackgroundVisibility(.hidden)
                }
                // Présent seulement quand le fil a quitté le direct : le bouton dit
                // l'état et l'action d'un même geste.
                if !model.following {
                    ToolbarItem(placement: .primaryAction) {
                        Button("Revenir au direct") { model.returnToLive() }
                            .buttonStyle(.borderedProminent)
                            .accessibilityIdentifier("viewer.returnToLive")
                    }
                }
            }
            .onDisappear { model.stop() }
    }
}
