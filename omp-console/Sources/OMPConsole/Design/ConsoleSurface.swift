// Les surfaces de la couche de CONTENU : cartes, bandeaux et boutons posés dans
// le contenu d'un écran.
//
// Aucun verre ici (HIG Materials : « Don't use Liquid Glass in the content
// layer ») : Liquid Glass est réservé à la couche fonctionnelle que le système
// dessine déjà — barre latérale, barres d'outils, feuilles. Le contenu emploie
// des fonds opaques, le séparateur du système et les boutons standard
// (`.bordered`, `.borderedProminent`), que macOS 26 dessine lui-même.

import SwiftUI

enum ConsoleSurface {
    static let cardRadius: CGFloat = 10
    static let bannerRadius: CGFloat = 10
}

extension View {
    /// Carte du contenu (tableau, attentes de l'Accueil) : fond de la fenêtre,
    /// filet du séparateur, ombre légère. La sélection ajoute un contour
    /// d'accent — jamais la couleur seule (la vue garde son contenu).
    func consoleCard(selected: Bool) -> some View {
        background(.background, in: .rect(cornerRadius: ConsoleSurface.cardRadius))
            .overlay {
                RoundedRectangle(cornerRadius: ConsoleSurface.cardRadius)
                    .strokeBorder(
                        selected ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.separator),
                        lineWidth: selected ? 2 : 0.5
                    )
            }
            .shadow(color: .black.opacity(0.06), radius: 2, y: 1)
    }

    /// Bandeau d'état teinté : la phrase du bandeau porte le sens, la teinte ne
    /// fait que le souligner.
    func consoleBanner(tint: Color) -> some View {
        padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(tint.opacity(0.12), in: .rect(cornerRadius: ConsoleSurface.bannerRadius))
    }

    /// Le bouton d'un geste posé dans le contenu : proéminent pour LE geste
    /// principal de l'écran (un seul, HIG Buttons), standard sinon.
    @ViewBuilder
    func consoleButtonProminence(_ prominent: Bool) -> some View {
        if prominent {
            buttonStyle(.borderedProminent)
        } else {
            buttonStyle(.bordered)
        }
    }
}
