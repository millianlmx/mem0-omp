// Le badge d'état des composants embarqués (S-2, BR-2) : ancré au pied de la
// barre latérale, à son bord gauche — le coin inférieur gauche de la fenêtre.
// Le mot porte le sens, la couleur le double.
//
// Deux formes (S-3 de mac-omp-manquant-non-bloquant) :
// - « Tout est installé » (`open == nil`) : un simple `StatusBadge`, sans
//   interaction ni focus, hors de l'ordre de tabulation.
// - Un composant manque : un `Button` `.plain` dont le libellé est le même
//   `StatusBadge`. Clic, ou Espace/↩ au focus (navigation clavier complète du
//   système), appelle `open` — `SetupModel.reopen()`, qui rouvre la feuille de
//   préparation, bloquante si OMP manque. Aucun survol ajouté, curseur standard.
//
// Il vit dans la barre latérale, la couche fonctionnelle du système : aucun
// `glassEffect`, aucun fond maison — la surface de la barre latérale suffit.
//
// PAS de `.fixedSize` vertical : mesuré (piège du `safeAreaInset` de barre
// latérale, omp-console-redesign) qu'un `Text` figé verticalement a fait
// calculer au `NavigationSplitView` ~1 958 pt de haut, hors écran. Le texte se
// replie donc au besoin, sans jamais être tronqué (AC-2 exige les noms).

import ConsoleCore
import SwiftUI

struct ComponentBadge: View {
    let status: ConsoleStatus
    /// Rouvre la feuille de préparation ; `nil` quand tout est installé.
    let open: (@MainActor () -> Void)?

    var body: some View {
        badge
            .accessibilityIdentifier("components.badge")
            // Le coin inférieur gauche de la fenêtre : ~14 pt du bord gauche,
            // ~9 pt du bas.
            .padding(.leading, 14)
            .padding(.bottom, 9)
    }

    @ViewBuilder
    private var badge: some View {
        if let open {
            Button(action: open) {
                StatusBadge(status: status)
            }
            .buttonStyle(.plain)
            .help(SetupText.componentsBadgeHelp)
            .accessibilityLabel(status.text)
        } else {
            StatusBadge(status: status)
        }
    }
}
