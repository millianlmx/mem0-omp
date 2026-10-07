// Le fil d'une session, montable depuis n'importe quelle section (S-10) : le
// bandeau d'illisibilité, l'attente, les états vides, les lignes, les notes, et
// le bouton « Revenir au direct ».
//
// La mécanique de défilement est celle que @Documentation décrit :
//   — `onScrollGeometryChange` est posé SUR le `ScrollView` du fil (aucun
//     `ScrollView` imbriqué : il n'obéit qu'au premier de la hiérarchie), et la
//     distance au bas est rapportée au modèle ;
//   — `onScrollPhaseChange` distingue le GESTE de l'utilisateur (`tracking`,
//     `interacting`, `decelerating`) du défilement PROGRAMMÉ (`animating`, qui
//     n'est jamais un geste) ;
//   — l'ancre de fin est un zéro de hauteur après tout le contenu, et
//     `scrollRequest` la fait viser par `ScrollViewReader` (le motif du dépôt).
//
// Aucun littéral alphabétique : les mots viennent d'`IOSSessionText` ou du noyau.

import ConsoleCore
import SwiftUI

struct IOSSessionThreadView: View {
    @ObservedObject var model: IOSSessionThreadModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let status = model.threadStatus {
                IOSStatusChip(status: status)
                    .accessibilityIdentifier(IOSSessionsAccessibility.threadStatus)
            }
            if let message = model.errorBanner {
                Text(message)
                    .font(.callout)
                    .iosBanner(tone: .danger)
                    .accessibilityIdentifier(IOSSessionsAccessibility.errorBanner)
            }
            if case .unreadable(let reason) = model.state {
                // L'erreur de lecture s'affiche MÊME quand des faits sont déjà là :
                // on n'efface jamais un fait lu (S-4).
                Text(ConversationText.unreadable(reason))
                    .font(.callout)
                    .iosBanner(tone: .danger)
                    .accessibilityIdentifier(IOSSessionsAccessibility.unreadable)
            }
            if model.isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if model.rows.isEmpty {
                placeholder
            } else {
                thread
            }
            notes
            backToLive
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Les états vides

    @ViewBuilder
    private var placeholder: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: model.state == .waiting ? IOSSessionText.waitingSymbol : IOSSessionText.emptySymbol)
                .font(.title3)
                .foregroundStyle(.secondary)
            Text(model.state == .waiting ? ConversationText.waitingTitle : ConversationText.emptyTitle)
                .font(.headline)
                .multilineTextAlignment(.leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .iosCard()
        .accessibilityIdentifier(IOSSessionsAccessibility.placeholder)
    }

    // MARK: - Les notes sous le fil

    @ViewBuilder
    private var notes: some View {
        if !model.notes.isEmpty {
            HStack(spacing: 12) {
                ForEach(Array(model.notes.enumerated()), id: \.offset) { _, note in
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityIdentifier(IOSSessionsAccessibility.notes)
        }
    }

    // MARK: - « Revenir au direct » (S-8)

    @ViewBuilder
    private var backToLive: some View {
        if !model.following {
            Button(ConversationText.backToLive) { model.returnToLive() }
                .frame(minHeight: IOSMetrics.minimumTarget)
                .accessibilityIdentifier(IOSSessionsAccessibility.backToLive)
        }
    }

    // MARK: - Le fil

    private var thread: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                VStack(spacing: 0) {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(model.rows) { row in
                            // Valeurs, pas le modèle : une publication ne réévalue
                            // que les lignes dont la valeur a changé.
                            IOSSessionRowView(
                                row: row,
                                isOpen: model.isExpanded(row.id),
                                isThinkingOpen: model.isExpanded(IOSSessionRowView.thinkingKey(of: row.id)),
                                onToggle: { key in model.toggleFold(key) }
                            )
                            .equatable()
                            .id(row.id)
                        }
                    }
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    // L'ancre de fin : un zéro de hauteur APRÈS tout le contenu.
                    Color.clear
                        .frame(height: 0)
                        .id(IOSSessionsAccessibility.threadEnd)
                }
            }
            .accessibilityIdentifier(IOSSessionsAccessibility.thread)
            .onScrollGeometryChange(for: ViewerScrollGeometry.self) { geometry in
                ViewerScrollGeometry(
                    gap: geometry.contentSize.height - geometry.visibleRect.maxY,
                    origin: geometry.contentOffset.y
                )
            } action: { _, geometry in
                model.reportBottomGap(geometry)
            }
            .onScrollPhaseChange { _, phase in
                // Seul un GESTE suspend le suivi : `animating` est notre propre
                // défilement, `idle` n'est rien.
                switch phase {
                case .tracking, .interacting, .decelerating:
                    model.reportUserScroll(deltaY: 1)
                default:
                    break
                }
            }
            .onAppear {
                // À l'ouverture, le fil se lit par la FIN : la demande de
                // défilement initiale est déjà posée quand la vue apparaît, et
                // `onChange` ne voit pas la valeur initiale.
                scroll(proxy)
            }
            .onChange(of: model.scrollRequest) { _, _ in
                scroll(proxy)
            }
        }
    }

    private func scroll(_ proxy: ScrollViewProxy) {
        guard let last = model.rows.last else { return }
        proxy.scrollTo(last.id, anchor: .bottom)
        proxy.scrollTo(IOSSessionsAccessibility.threadEnd, anchor: .bottom)
    }
}
