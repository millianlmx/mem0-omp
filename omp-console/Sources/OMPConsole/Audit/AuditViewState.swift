// L'état de VUE de la section Audit (audit-ui-redesign S-6) : ce qui ne regarde
// que l'affichage et ne part jamais vers le service — l'orientation dépliée ou
// tronquée de chaque audit, le groupe « Décisions de l'arbitre » déplié. Possédé
// par `AuditView` en `@StateObject` (pas de `@State` sous les Command Line Tools),
// passé au détail ; `AuditConsoleModel` n'en sait rien.

import Combine
import SwiftUI

@MainActor
final class AuditViewState: ObservableObject {
    /// Les audits dont l'orientation est affichée en entier (« Afficher
    /// l'orientation complète »).
    @Published var expandedOrientations: Set<String> = []
    /// Les audits dont l'orientation ne tient pas sur ses deux lignes : seuls
    /// ceux-là offrent « Afficher l'orientation complète ».
    @Published var truncatedOrientations: Set<String> = []
    /// Les audits dont le groupe « Décisions de l'arbitre » est déplié (replié par
    /// défaut).
    @Published var expandedDecisions: Set<String> = []

    func isOrientationExpanded(_ id: String) -> Bool {
        expandedOrientations.contains(id)
    }

    func toggleOrientation(_ id: String) {
        if expandedOrientations.contains(id) {
            expandedOrientations.remove(id)
        } else {
            expandedOrientations.insert(id)
        }
    }

    /// Le bouton de dépliage n'apparaît que si le texte est tronqué, ou déjà déplié
    /// (pour le replier).
    func offersOrientationToggle(_ id: String) -> Bool {
        expandedOrientations.contains(id) || truncatedOrientations.contains(id)
    }

    /// Relevé par la mesure `ViewThatFits` de l'en-tête ; n'écrit que sur un
    /// changement, pour ne pas republier à chaque passe de mise en page.
    func setOrientationTruncated(_ id: String, _ truncated: Bool) {
        guard truncatedOrientations.contains(id) != truncated else { return }
        if truncated {
            truncatedOrientations.insert(id)
        } else {
            truncatedOrientations.remove(id)
        }
    }

    func decisionsExpanded(_ id: String) -> Binding<Bool> {
        Binding(
            get: { self.expandedDecisions.contains(id) },
            set: { open in
                if open {
                    self.expandedDecisions.insert(id)
                } else {
                    self.expandedDecisions.remove(id)
                }
            }
        )
    }
}
