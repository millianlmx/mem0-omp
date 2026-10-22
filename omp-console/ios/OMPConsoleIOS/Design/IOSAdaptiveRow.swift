// Le conteneur des rangées et en-têtes « titre | puce | bouton » de la coque iOS
// (ios-dynamic-type-ax-residuel, S-3) : la PREMIÈRE sous-vue est le bloc titre,
// les suivantes sont les contrôles, dans l'ordre (l'ordre de lecture VoiceOver
// suit celui du `ViewBuilder`).
//
// Il mesure les largeurs IDÉALES (`sizeThatFits(.unspecified)` : un `Text` sur une
// seule ligne, sans repli) et applique la règle pure
// `IOSRowAxis.of(title:controls:available:spacing:)` : la rangée
// s'empile parce que son contenu ne tient pas, jamais parce que la taille de
// texte a franchi un seuil. Aucun plafond de taille de texte n'est nécessaire :
// un titre long passe sur sa ligne au lieu d'être coupé au milieu d'un mot.
//
// `ViewThatFits` est écarté : sa variante « titre, puis contrôles » a pour largeur
// idéale celle du titre non replié, et échouerait pour tout titre long.

import SwiftUI

struct IOSAdaptiveRow: Layout {
    /// L'espacement horizontal entre le titre et les contrôles, et entre contrôles.
    var spacing: CGFloat
    /// L'écart vertical entre deux lignes, quand la rangée se replie.
    var lineSpacing: CGFloat = 8
    /// Sur une ligne, les contrôles sont collés à droite (la rangée prend toute la
    /// largeur proposée) ; sinon ils suivent le titre.
    var pinsControlsTrailing: Bool = true

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrangement(proposal: proposal, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let plan = arrangement(proposal: proposal, subviews: subviews)
        for (index, slot) in plan.slots.enumerated() {
            let x = pinsControlsTrailing && slot.pinned
                ? bounds.maxX - slot.offsetFromTrailing
                : bounds.minX + slot.origin.x
            subviews[index].place(
                at: CGPoint(x: x, y: bounds.minY + slot.origin.y),
                anchor: .topLeading,
                proposal: ProposedViewSize(width: slot.size.width, height: slot.size.height)
            )
        }
    }

    // MARK: - Mise en ligne

    /// La place d'une sous-vue : son origine dans le conteneur, sa taille, et,
    /// pour un contrôle collé à droite, sa distance au bord droit.
    private struct Slot {
        var origin: CGPoint
        var size: CGSize
        var pinned = false
        var offsetFromTrailing: CGFloat = 0
    }

    private struct Arrangement {
        var size: CGSize
        var slots: [Slot]
    }

    /// La décision et le placement, calculés une fois pour `sizeThatFits` et pour
    /// `placeSubviews` sur la MÊME proposition : la largeur proposée décide de
    /// l'axe, jamais la largeur finalement accordée.
    private func arrangement(proposal: ProposedViewSize, subviews: Subviews) -> Arrangement {
        guard let titleView = subviews.first else { return Arrangement(size: .zero, slots: []) }
        let controls = Array(subviews.dropFirst())
        let available = proposal.width.flatMap { $0.isFinite ? $0 : nil }
        let titleIdeal = titleView.sizeThatFits(.unspecified)
        let controlSizes = controls.map { $0.sizeThatFits(.unspecified) }
        let controlsWidth = controlSizes.isEmpty
            ? 0
            : controlSizes.reduce(0) { $0 + $1.width } + spacing * CGFloat(controlSizes.count - 1)
        let axis = IOSRowAxis.of(
            title: titleIdeal.width,
            controls: controlSizes.map(\.width),
            available: available,
            spacing: spacing
        )
        switch axis {
        case .horizontal:
            return horizontal(titleView, controlSizes: controlSizes, controlsWidth: controlsWidth, available: available, titleIdeal: titleIdeal)
        case .twoLine:
            return twoLine(titleView, controlSizes: controlSizes, controlsWidth: controlsWidth, available: available ?? titleIdeal.width)
        case .stacked:
            return stacked(subviews, available: max(available ?? 0, 0))
        }
    }

    /// Tout sur une ligne, centré verticalement ; le titre reçoit la largeur que
    /// les contrôles lui laissent.
    private func horizontal(
        _ titleView: LayoutSubview,
        controlSizes: [CGSize],
        controlsWidth: CGFloat,
        available: CGFloat?,
        titleIdeal: CGSize
    ) -> Arrangement {
        let gap = controlSizes.isEmpty ? 0 : spacing + controlsWidth
        let titleSize = available.map { titleView.sizeThatFits(ProposedViewSize(width: max($0 - gap, 0), height: nil)) } ?? titleIdeal
        let height = max(titleSize.height, controlSizes.map(\.height).max() ?? 0)
        let width = pinsControlsTrailing ? (available ?? titleSize.width + gap) : titleSize.width + gap
        var slots = [Slot(origin: CGPoint(x: 0, y: (height - titleSize.height) / 2), size: titleSize)]
        var x = titleSize.width + (controlSizes.isEmpty ? 0 : spacing)
        var fromTrailing = controlsWidth
        for size in controlSizes {
            slots.append(Slot(
                origin: CGPoint(x: x, y: (height - size.height) / 2),
                size: size,
                pinned: true,
                offsetFromTrailing: fromTrailing
            ))
            x += size.width + spacing
            fromTrailing -= size.width + spacing
        }
        return Arrangement(size: CGSize(width: width, height: height), slots: slots)
    }

    /// Le titre sur sa ligne, puis les contrôles côte à côte, à gauche, centrés
    /// entre eux.
    private func twoLine(
        _ titleView: LayoutSubview,
        controlSizes: [CGSize],
        controlsWidth: CGFloat,
        available: CGFloat
    ) -> Arrangement {
        let titleSize = titleView.sizeThatFits(ProposedViewSize(width: available, height: nil))
        let lineHeight = controlSizes.map(\.height).max() ?? 0
        let top = titleSize.height + lineSpacing
        var slots = [Slot(origin: .zero, size: titleSize)]
        var x: CGFloat = 0
        for size in controlSizes {
            slots.append(Slot(origin: CGPoint(x: x, y: top + (lineHeight - size.height) / 2), size: size))
            x += size.width + spacing
        }
        let width = pinsControlsTrailing ? available : max(titleSize.width, controlsWidth)
        return Arrangement(size: CGSize(width: width, height: top + lineHeight), slots: slots)
    }

    /// Chaque sous-vue sur sa ligne, alignée à gauche, repliée sur la largeur.
    private func stacked(_ subviews: Subviews, available: CGFloat) -> Arrangement {
        var slots: [Slot] = []
        var y: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(ProposedViewSize(width: available, height: nil))
            if !slots.isEmpty { y += lineSpacing }
            slots.append(Slot(origin: CGPoint(x: 0, y: y), size: size))
            y += size.height
            widest = max(widest, size.width)
        }
        let width = pinsControlsTrailing ? available : min(widest, available)
        return Arrangement(size: CGSize(width: width, height: y), slots: slots)
    }
}

/// La disposition d'une rangée « titre | puce | bouton » : une ligne, deux lignes
/// (titre, puis les contrôles côte à côte), ou empilée (chacun sur sa ligne).
enum IOSRowAxis: Equatable {
    case horizontal, twoLine, stacked

    /// L'axe d'une rangée selon son CONTENU seul (ios-dynamic-type-ax-residuel,
    /// S-3), jamais selon la taille de texte ni la classe de largeur : tout sur une
    /// ligne si tout y tient ; sinon le titre sur sa ligne et les contrôles ensemble
    /// sur la suivante s'ils y tiennent ; sinon chacun sur sa ligne.
    ///
    /// `title` : largeur IDÉALE (sur une ligne) du bloc titre ; `controls` : largeurs
    /// idéales des contrôles (pastille, bouton…) dans l'ordre ; `available` : largeur
    /// proposée (`nil` = idéale demandée) ; `spacing` : espacement horizontal. Une
    /// égalité exacte tient.
    static func of(title: CGFloat, controls: [CGFloat], available: CGFloat?, spacing: CGFloat) -> IOSRowAxis {
        guard let available else { return .horizontal }
        guard available > 0 else { return .stacked }
        let together = controls.isEmpty ? 0 : controls.reduce(0, +) + spacing * CGFloat(controls.count - 1)
        if title + (controls.isEmpty ? 0 : spacing + together) <= available { return .horizontal }
        if !controls.isEmpty, together <= available { return .twoLine }
        return .stacked
    }
}
