// Les couleurs des DONNÉES de la coque iOS (ios-statistiques-et-graphe-accessibles,
// S-4, BR-1) : les barres des graphiques de Statistiques et les teintes des portées
// du graphe de la Mémoire.
//
// Pourquoi des couleurs système et jamais `Color(hue:saturation:brightness:)` : une
// couleur système UIKit est DYNAMIQUE — elle porte une variante en clair, une en
// sombre, et une de plus pour chacune en contraste accru (réglage Accessibilité
// « Augmenter le contraste »). Une teinte HSB fixe reste la même partout, donc
// pâlit sur fond sombre et ignore le contraste accru.
//
// Déclarées en `UIColor`, converties par `Color(uiColor:)` au point d'usage :
// `EnvironmentValues.colorSchemeContrast` est en lecture seule, si bien qu'une
// `Color` SwiftUI ne se résout pas en contraste accru dans un test, alors qu'une
// `UIColor` se résout par `resolvedColor(with:)` sur n'importe quelle combinaison de
// traits (IOSDataPaletteTests).

import UIKit

enum IOSDataPalette {
    /// La barre « Temps passé » du graphique « Durée par feature ».
    static let duration: UIColor = .systemIndigo
    /// La série « Tokens envoyés » du graphique « Tokens par feature ».
    static let sentTokens: UIColor = .systemBlue
    /// La série « Tokens reçus » du graphique « Tokens par feature ».
    static let receivedTokens: UIColor = .systemGreen

    /// Les teintes des portées du graphe, dans cet ordre. Chacune diffère entre
    /// clair et sombre, et entre contraste normal et accru dans les deux
    /// apparences (vérifié par `paletteAdaptsToAppearanceAndContrast` sur le SDK
    /// iOS 27.0 : aucune n'a dû être retirée).
    static let scopes: [UIColor] = [.systemBlue, .systemGreen, .systemOrange, .systemPink, .systemPurple,
                                    .systemTeal, .systemIndigo, .systemRed, .systemBrown]

    /// La teinte d'une portée : `hue` ∈ [0, 1) vient de `MemoryGraphStyle.hue(for:)`
    /// (FNV-1a, déterministe), et chaque tranche de 1/9 du cercle prend une couleur
    /// de `scopes`. L'index est borné : `hue` ≥ 1 donne la dernière, `hue` < 0 et
    /// NaN la première (`Int(_:)` planterait sur NaN ou l'infini).
    static func scope(hue: Double) -> UIColor {
        let slot = (hue * Double(scopes.count)).rounded(.down)
        let index = slot.isNaN ? 0 : Int(min(Double(scopes.count - 1), max(0, slot)))
        return scopes[index]
    }
}
