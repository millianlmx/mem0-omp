// Le badge d'état des composants embarqués (S-2, BR-2) : ancré au pied de la
// barre latérale, à son bord gauche — le coin inférieur gauche de la fenêtre.
// Il ne fait RIEN : aucune interaction, aucun survol, aucun focus, jamais dans
// l'ordre de tabulation ; le mot porte le sens, la couleur le double.
//
// Il vit dans la barre latérale, la couche fonctionnelle du système : aucun
// `glassEffect`, aucun fond maison — la surface de la barre latérale suffit.
//
// PAS de `.fixedSize` vertical : mesuré (piège du `safeAreaInset` de barre
// latérale, omp-console-redesign) qu'un `Text` figé verticalement a fait
// calculer au `NavigationSplitView` ~1 958 pt de haut, hors écran. Le texte se
// replie donc au besoin, sans jamais être tronqué (AC-2 exige les noms).

import SwiftUI

struct ComponentBadge: View {
    let status: ConsoleStatus

    var body: some View {
        StatusBadge(status: status)
            .accessibilityIdentifier("components.badge")
            // Le coin inférieur gauche de la fenêtre : ~14 pt du bord gauche,
            // ~9 pt du bas.
            .padding(.leading, 14)
            .padding(.bottom, 9)
    }
}
