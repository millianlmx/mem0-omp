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
    /// La largeur de la colonne de l'icône d'étape d'une ligne Sessions, à la
    /// taille de référence `.body` : la largeur de la colonne macOS
    /// (`SessionSelectorView`, 28 pt), et ≥ à la largeur de LAYOUT du symbole
    /// d'étape le plus large (`hammer`, 25 pt à `.body`, mesuré par idb sur
    /// iPhone et iPad le 2026-10-09 : le glyphe seul fait 20,7 pt, mais son
    /// cadre de mise en page est plus large). Mise à l'échelle par
    /// `@ScaledMetric`, elle suit Dynamic Type avec le glyphe.
    static let phaseIconWidth: CGFloat = 28
    /// La largeur d'une voie de l'écran Pipelines en largeur régulière (iPad), à
    /// la taille de référence `.body` : la même pour toutes les voies, vides ou
    /// pleines, jamais tirée de leur contenu. Mise à l'échelle par
    /// `@ScaledMetric`, elle grandit avec Dynamic Type ; `PipelinesModel.laneWidth`
    /// la plafonne à la largeur visible.
    static let laneWidth: CGFloat = 280
    /// La marge verticale d'une rangée de liste (Sessions, Mémoire), à la
    /// taille de référence `.body` : aucun texte de la rangée ne touche le filet
    /// voisin. Mise à l'échelle par `@ScaledMetric`, elle grandit avec
    /// Dynamic Type.
    static let rowVerticalPadding: CGFloat = 8
    /// Le nombre maximal de lignes du texte d'un souvenir dans la liste de la
    /// Mémoire, sur une largeur compacte (iPhone) : au-delà, « … » en fin. La
    /// limite ne dépend pas de la taille de texte ; la feuille, elle, montre
    /// le texte intégral (rangees-sessions-memoire-serrees, S-5).
    static let compactMemoryRowLines = 3
    /// La même limite sur une largeur régulière (iPad) ou inconnue.
    static let regularMemoryRowLines = 4
    /// La hauteur d'un champ de saisie vertical (le besoin d'une feature), en
    /// LIGNES : 3 à vide, il grandit avec le texte jusqu'à 8, puis défile dans le
    /// champ. Aucun point : la hauteur suit la taille de police (Dynamic Type).
    static let needLines: ClosedRange<Int> = 3...8

    /// La marge horizontale d'un écran, selon la largeur disponible.
    static func margin(_ sizeClass: UserInterfaceSizeClass?) -> CGFloat {
        sizeClass == .compact ? compactMargin : regularMargin
    }

    /// Le plafond de lignes du texte d'un souvenir dans la liste, selon la
    /// largeur disponible : la même règle que `margin(_:)`.
    static func memoryRowLines(_ sizeClass: UserInterfaceSizeClass?) -> Int {
        sizeClass == .compact ? compactMemoryRowLines : regularMemoryRowLines
    }
}
