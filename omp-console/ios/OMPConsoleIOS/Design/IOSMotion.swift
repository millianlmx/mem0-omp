// Les mouvements que l'app déclenche d'elle-même (ios-gestes-et-retours-natifs,
// S-8) : avec le réglage « Réduire les animations », un défilement automatique
// se fait d'un saut ; sans lui, il garde l'animation par défaut (HIG Motion,
// D-8). Les animations du système (feuilles, menus) restent gérées par iOS.

import SwiftUI

enum IOSMotion {
    /// L'animation d'un défilement automatique : aucune (`nil`, saut) quand
    /// Réduire les animations est actif, `.default` sinon. Se passe telle quelle
    /// à `withAnimation(_:_:)`.
    static func scrollAnimation(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .default
    }
}
