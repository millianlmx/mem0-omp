// Les métriques de la coque iOS (S-1, BR-2) : les marges par taille de classe et
// la cible tactile minimale.
//
// Une seule règle par grandeur : les trois surfaces (IOSSurface.swift) lisent la
// marge ici, aucune vue ne compose la sienne. La cible de 44 pt est celle de
// l'iOS HIG (D-4 : « iOS, iPadOS | 44x44 pt »).

import SwiftUI

enum IOSMetrics {
    /// La marge d'un écran compact (iPhone en portrait) : 16 pt.
    static let compactMargin: CGFloat = 16
    /// La marge d'un écran régulier (iPad, ou taille de classe inconnue) : 24 pt.
    static let regularMargin: CGFloat = 24
    /// La cible tactile minimale (HIG, D-4) : aucune cible de la coque ne
    /// descend sous 44 pt.
    static let minimumTarget: CGFloat = 44

    /// La marge horizontale d'un écran, selon la largeur disponible.
    static func margin(_ sizeClass: UserInterfaceSizeClass?) -> CGFloat {
        sizeClass == .compact ? compactMargin : regularMargin
    }
}
