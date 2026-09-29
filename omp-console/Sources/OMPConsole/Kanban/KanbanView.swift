// La section Kanban : le bandeau d'anomalies, puis les ONZE colonnes de l'ardoise,
// puis le panneau de détail (S-1, S-5, S-11).
//
// Le clavier est porté par la RACINE du tableau (`.focusable()` +
// `.onKeyPress`, Doc-2) : la fermeture prend ZÉRO argument et rend `.handled` —
// la forme à un argument ne compile pas sous ce toolchain (piège mesuré).
//
// Aucun attribut macro SwiftUI (`@State`, `@Preview`) : sous les Command Line
// Tools seuls, ces macros n'existent pas. `@ObservedObject` est une vraie property
// wrapper, donc autorisée.

import SwiftUI

struct KanbanView: ConsoleSectionView {
    static let section = ConsoleSection.kanban

    @ObservedObject var model: KanbanModel

    var body: some View {
        Group {
            switch model.state {
            case .loading:
                message(KanbanBoardState.loadingText, identifier: "kanban.loading")
            case .storeAbsent(let dir):
                message(KanbanBoardState.absentText(dir: dir), identifier: "kanban.empty")
            case .storeEmpty(let dir):
                message(KanbanBoardState.emptyText(dir: dir), identifier: "kanban.empty")
            case .board(let board):
                boardView(board)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { model.start() }
        .onDisappear { model.stop() }
    }

    /// Un des deux messages d'état, ou celui du chargement : une ligne, au centre.
    private func message(_ text: String, identifier: String) -> some View {
        Text(text)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier(identifier)
    }

    /// L'ardoise : bandeau en haut (masqué s'il n'y a aucune anomalie), colonnes au
    /// centre, panneau de détail à droite. Les onze colonnes sont TOUJOURS là, même
    /// vides — un tableau muet ne dit pas quel état manque.
    private func boardView(_ board: KanbanBoard) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if !board.anomalies.isEmpty {
                KanbanBannerView(anomalies: board.anomalies)
            }
            HStack(alignment: .top, spacing: 0) {
                ScrollView(.horizontal) {
                    LazyHStack(alignment: .top, spacing: 12) {
                        ForEach(KanbanColumn.allCases, id: \.rawValue) { column in
                            KanbanColumnView(
                                column: column,
                                cards: board.cards.filter { $0.column == column },
                                model: model
                            )
                        }
                    }
                    .padding(12)
                }
                Divider()
                KanbanDetailView(model: model)
                    .frame(width: 320)
            }
        }
        .focusable()
        // La fermeture prend ZÉRO argument (Doc-2, piège mesuré) et rend `.handled` :
        // la frappe est consommée par le tableau, elle ne remonte pas à la fenêtre.
        .onKeyPress(.downArrow) { model.move(by: .next); return .handled }
        .onKeyPress(.upArrow) { model.move(by: .previous); return .handled }
        .onKeyPress(.rightArrow) { model.move(by: .nextColumn); return .handled }
        .onKeyPress(.leftArrow) { model.move(by: .previousColumn); return .handled }
        .accessibilityIdentifier("kanban.board")
    }
}

/// Une colonne : son en-tête `<libellé> (<n>)` puis ses cartes, dans l'ordre de
/// l'ardoise. Largeur fixe, défilement vertical — une colonne ne pousse pas ses
/// voisines.
private struct KanbanColumnView: View {
    let column: KanbanColumn
    let cards: [KanbanCard]
    @ObservedObject var model: KanbanModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("\(column.title) (\(cards.count))")
                .font(.headline)
            ScrollView(.vertical) {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(cards) { card in
                        KanbanCardView(
                            card: card,
                            selected: model.selectedCardID == card.id,
                            onTap: { model.select(card.id) }
                        )
                    }
                }
            }
            .contentShape(Rectangle())
        }
        .frame(width: 240, alignment: .leading)
        .accessibilityIdentifier("kanban.column.\(column.rawValue)")
    }
}

/// Le bandeau d'anomalies : une ligne par anomalie, nommée par son texte exact
/// (S-8, S-9, S-10). Masqué par l'appelant quand il n'y en a aucune.
private struct KanbanBannerView: View {
    let anomalies: [KanbanAnomaly]

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(anomalies.enumerated()), id: \.offset) { index, anomaly in
                Text(anomaly.text)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("kanban.anomaly.\(index)")
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.red.opacity(0.1))
        .accessibilityIdentifier("kanban.banner")
    }
}
