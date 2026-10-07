// Les surfaces de la couche de CONTENU de la coque iOS (S-1, BR-2) : le panneau
// d'un écran, la carte d'un état vide, le bandeau d'un état.
//
// Équivalents iOS de `omp-console/Sources/OMPConsole/Design/ConsoleSurface.swift`,
// dont ils reprennent les rôles : aucun verre dans le contenu (HIG D-4/Layout :
// Liquid Glass est réservé à la couche que le système dessine — barre latérale,
// barre de navigation, feuilles), fonds opaques, filet du système, ombre légère.
// Les rayons sont ceux du tactile (12 pt), les marges celles d'IOSMetrics.
//
// Les rembourrages passent par `@ScaledMetric` : à Dynamic Type maximum, la carte
// grandit au lieu de comprimer son texte (S-7).

import ConsoleCore
import SwiftUI
import UIKit

enum IOSSurface {
    static let panelRadius: CGFloat = 12
    static let cardRadius: CGFloat = 12
    static let bannerRadius: CGFloat = 12
}

extension View {
    /// Le panneau d'un écran : fond opaque, marges de la taille de classe, filet
    /// du système. Chaque écran des sept sections y pose son contenu.
    func iosPanel() -> some View {
        modifier(IOSPanelSurface())
    }

    /// La carte d'un état vide : fond opaque, rayon 12, filet, ombre légère.
    func iosCard() -> some View {
        modifier(IOSCardSurface())
    }

    /// Le bandeau d'un état : teinte du ton à 12 % d'opacité, rayon 12. Le mot
    /// porté par le contenu dit le sens ; la teinte ne fait que le doubler.
    func iosBanner(tone: ConsoleTone) -> some View {
        modifier(IOSBannerSurface(tone: tone))
    }
}

private struct IOSPanelSurface: ViewModifier {
    @Environment(\.horizontalSizeClass) private var sizeClass
    /// Le facteur de Dynamic Type : 1 à la taille par défaut, davantage aux
    /// tailles d'accessibilité — les marges grandissent avec le texte (S-7).
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

    func body(content: Content) -> some View {
        content
            .padding(IOSMetrics.margin(sizeClass) * scale)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                Color(uiColor: .secondarySystemBackground),
                in: .rect(cornerRadius: IOSSurface.panelRadius)
            )
            .overlay {
                RoundedRectangle(cornerRadius: IOSSurface.panelRadius)
                    .strokeBorder(Color(uiColor: .separator), lineWidth: 0.5)
            }
    }
}

private struct IOSCardSurface: ViewModifier {
    @ScaledMetric(relativeTo: .body) private var padding: CGFloat = 12

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                Color(uiColor: .secondarySystemBackground),
                in: .rect(cornerRadius: IOSSurface.cardRadius)
            )
            .overlay {
                RoundedRectangle(cornerRadius: IOSSurface.cardRadius)
                    .strokeBorder(Color(uiColor: .separator), lineWidth: 0.5)
            }
            .shadow(color: .black.opacity(0.06), radius: 2, y: 1)
    }
}

private struct IOSBannerSurface: ViewModifier {
    let tone: ConsoleTone
    @ScaledMetric(relativeTo: .body) private var horizontal: CGFloat = 12
    @ScaledMetric(relativeTo: .body) private var vertical: CGFloat = 8

    func body(content: Content) -> some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, horizontal)
            .padding(.vertical, vertical)
            .background(tone.tint.opacity(0.12), in: .rect(cornerRadius: IOSSurface.bannerRadius))
            .accessibilityElement(children: .combine)
    }
}
