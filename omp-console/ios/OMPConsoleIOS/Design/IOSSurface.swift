// Les surfaces de la couche de CONTENU de la coque iOS (S-1, BR-2) : la liste
// groupée d'un écran, la rangée nue, le panneau, la carte, le bandeau d'un état.
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

    /// Le fond d'une carte. `raised` (cartes « À vous » et kanban iPad) :
    /// `secondarySystemGroupedBackground`, distinct du fond groupé
    /// (`systemGroupedBackground`) en clair comme en sombre ; sinon le fond du
    /// panneau, `secondarySystemBackground`.
    static func cardFill(raised: Bool) -> UIColor {
        raised ? .secondarySystemGroupedBackground : .secondarySystemBackground
    }
}

extension View {
    /// La liste d'un écran (ios-listes-groupees-natives, S-2), posée sur une
    /// `List` : style `.insetGrouped` (fond groupé, rangées, séparateurs et
    /// en-têtes du système), colonne de lecture centrée, et toute la largeur hors
    /// colonne peinte du même fond groupé, sans couture avec celui de la List.
    func iosGroupedList() -> some View {
        modifier(IOSGroupedListSurface())
    }

    /// La rangée dont le contenu porte sa propre surface (bandeau, état de
    /// connexion, carte élevée) : sans fond ni séparateur du système, sans marge
    /// latérale, 8 pt entre deux rangées nues consécutives.
    func iosBareListRow() -> some View {
        modifier(IOSBareListRow())
    }

    /// Le panneau d'un écran : fond opaque, filet du système, rembourrage
    /// intérieur qui suit Dynamic Type, et marge extérieure de la taille de
    /// classe (fixe) — aucun panneau ne touche un bord de l'écran, aucun appelant
    /// n'ajoute la sienne. Réservé aux surfaces hors liste : Session OMP, mode
    /// Graphe de la Mémoire, feuilles Contrat et Bienvenue, écran générique.
    func iosPanel() -> some View {
        modifier(IOSPanelSurface())
    }

    /// La carte d'un état vide : fond opaque, rayon 12, filet, ombre légère.
    /// `raised` (cartes « À vous » et kanban iPad) ne change que le fond, à
    /// `secondarySystemGroupedBackground` : la carte se détache du fond groupé de
    /// l'écran dans les deux apparences.
    func iosCard(raised: Bool = false) -> some View {
        modifier(IOSCardSurface(raised: raised))
    }

    /// Le bandeau d'un état : teinte du ton à 12 % d'opacité, rayon 12. Le mot
    /// porté par le contenu dit le sens ; la teinte ne fait que le doubler.
    func iosBanner(tone: ConsoleTone) -> some View {
        modifier(IOSBannerSurface(tone: tone))
    }

    /// Le survol natif d'iPad (ios-gestes-et-retours-natifs, S-7) d'une carte ou
    /// d'une rangée touchable : plateau `.highlight` derrière l'élément, à la
    /// forme d'une carte. Posé en dernier modificateur de l'élément ; sans effet
    /// sur iPhone, et le système ne le montre pas sur un élément désactivé.
    func iosHoverEffect() -> some View {
        contentShape(.hoverEffect, .rect(cornerRadius: IOSSurface.cardRadius))
            .hoverEffect(.highlight)
    }
}

private struct IOSGroupedListSurface: ViewModifier {
    func body(content: Content) -> some View {
        content
            .listStyle(.insetGrouped)
            .iosReadableWidth()
            .background(Color(uiColor: .systemGroupedBackground))
    }
}

private struct IOSBareListRow: ViewModifier {
    func body(content: Content) -> some View {
        content
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            .listRowSeparator(.hidden)
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
            .padding(IOSMetrics.margin(sizeClass))
    }
}

private struct IOSCardSurface: ViewModifier {
    let raised: Bool
    @ScaledMetric(relativeTo: .body) private var padding: CGFloat = 12

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                Color(uiColor: IOSSurface.cardFill(raised: raised)),
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
