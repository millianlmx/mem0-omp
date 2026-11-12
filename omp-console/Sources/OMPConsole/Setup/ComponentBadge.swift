// Le badge d'état des composants embarqués (S-2, BR-2), au pied de la liste des fils —
// le coin inférieur gauche de la fenêtre. Il n'apparaît que lorsqu'un composant manque :
// tout installé, rien ne s'affiche. Le mot porte le sens, la couleur le double.
//
// C'est un `Button` `.plain` dont le libellé est le `ConsoleStatusChip` (S-3 de
// mac-omp-manquant-non-bloquant) : clic, ou Espace/↩ au focus, appelle
// `SetupModel.reopen()`, qui rouvre la feuille de préparation, bloquante si OMP manque.
//
// Il vit dans la barre latérale, la couche fonctionnelle du système : aucun
// `glassEffect`, aucun fond maison. PAS de `.fixedSize` vertical : mesuré (piège du
// `safeAreaInset` de barre latérale) qu'un `Text` figé verticalement a fait calculer au
// `NavigationSplitView` ~1 958 pt de haut, hors écran.

import ConsoleCore
import ConsoleUI
import SwiftUI

struct ComponentBadge: View {
    @ObservedObject var components: ComponentPresenceModel
    let setup: SetupModel

    var body: some View {
        if !components.presence.allInstalled {
            Button {
                setup.reopen()
            } label: {
                ConsoleStatusChip(status: components.presence.status)
            }
            .buttonStyle(.plain)
            .help(SetupText.componentsBadgeHelp)
            .accessibilityLabel(components.presence.status.text)
            .accessibilityIdentifier("components.badge")
            .padding(.leading, 14)
            .padding(.bottom, 9)
        }
    }
}
