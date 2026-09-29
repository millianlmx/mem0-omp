// Le panneau de détail (S-5) : les lignes EXACTES de la carte sélectionnée, ou le
// message « Aucune carte sélectionnée » quand rien ne l'est.
//
// Les lignes viennent de `KanbanDetail.lines(for:nowMs:)` — une fonction PURE du
// modèle, donc vérifiable sans rendre de vue. La durée du panneau suit la même
// horloge d'affichage que les cartes (`TimelineView`, Doc-1).

import SwiftUI

struct KanbanDetailView: View {
    @ObservedObject var model: KanbanModel

    var body: some View {
        if let card = model.selectedCard {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(
                        Array(KanbanDetail.lines(
                            for: card,
                            nowMs: context.date.timeIntervalSince1970 * 1000
                        ).enumerated()),
                        id: \.offset
                    ) { _, line in
                        Text(line)
                            .font(.callout)
                            .textSelection(.enabled)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding()
                .accessibilityIdentifier("kanban.detail")
            }
        } else {
            Text(KanbanBoardState.emptySelectionText)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("kanban.detail.empty")
        }
    }
}
