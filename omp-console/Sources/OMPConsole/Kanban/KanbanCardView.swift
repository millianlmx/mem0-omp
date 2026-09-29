// Une carte du tableau (BR-4) : le dépôt et le titre, l'état et le maillon, le
// modèle, l'URL de PR, la durée et les marques. Elle est cliquable (sélection) et
// accessible (identifiant + libellé).
//
// La DURÉE vit sous un `TimelineView(.periodic(from: .now, by: 1))` (Doc-1) : elle
// est RECALCULÉE depuis `context.date`, jamais accumulée d'un cran à l'autre — le
// système peut employer une cadence plus lente que l'intervalle demandé.

import SwiftUI

struct KanbanCardView: View {
    let card: KanbanCard
    let selected: Bool
    let onTap: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(card.repo) · \(card.title)")
                .font(.callout)
                .bold()
            Text("\(card.state) · \(card.phaseText)")
                .font(.callout)
                .foregroundStyle(.secondary)
            Text(card.modelText)
                .font(.callout)
                .foregroundStyle(.secondary)
            Text(card.prText)
                .font(.callout)
                .foregroundStyle(.secondary)
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text(card.elapsedText(nowMs: context.date.timeIntervalSince1970 * 1000))
                    .font(.callout)
                    .monospacedDigit()
            }
            if let marks = card.marksText {
                Text("marques : \(marks)")
                    .font(.callout)
                    .foregroundStyle(.red)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(selected ? Color.accentColor.opacity(0.25) : Color.clear)
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(selected ? Color.accentColor : Color.secondary.opacity(0.3))
        )
        // Le contenu EST la forme cliquable : sans elle, seuls les textes le sont.
        .contentShape(Rectangle())
        .onTapGesture { onTap() }
        .accessibilityIdentifier("kanban.card.\(card.id)")
        .accessibilityLabel("\(card.title), \(card.state)")
    }
}
