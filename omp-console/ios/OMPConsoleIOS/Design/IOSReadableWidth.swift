// La colonne de lecture de la coque iOS (S-1 de ipad-clavier-et-largeur-de-lecture) :
// sur une fenêtre large (iPad, iPhone Pro Max en paysage), le contenu d'un écran
// de liste ou de texte est plafonné à `IOSMetrics.readableWidth` et centré ; le
// reste de la fenêtre forme deux marges égales qui montrent le fond de l'écran.
//
// La règle est « par la largeur, pas par l'appareil » : quand la place est
// inférieure au plafond (iPhone en portrait, iPad barre latérale visible en
// portrait), la colonne prend toute la place et rien ne change. Le plafond suit
// Dynamic Type (`@ScaledMetric`), comme les rembourrages des surfaces.
//
// Le modificateur n'ajoute aucun élément d'accessibilité : l'ordre de lecture
// VoiceOver est inchangé. Posé DANS une `ScrollView`, il plafonne le contenu
// sans réduire le défilement, qui garde toute la largeur de la fenêtre.

import SwiftUI

extension View {
    /// Plafonne la largeur du contenu à la colonne de lecture et la centre.
    func iosReadableWidth() -> some View {
        modifier(IOSReadableWidth())
    }
}

struct IOSReadableWidth: ViewModifier {
    @ScaledMetric(relativeTo: .body) private var width = IOSMetrics.readableWidth

    func body(content: Content) -> some View {
        content
            .frame(maxWidth: width)
            .frame(maxWidth: .infinity)
    }
}
