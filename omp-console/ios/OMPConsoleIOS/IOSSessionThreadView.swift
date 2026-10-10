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
//   — la pile des lignes est une `VStack`, PAS une `LazyVStack` : une pile
//     paresseuse n'a qu'une hauteur ESTIMÉE pour ses lignes non matérialisées,
//     et l'offset de départ calculé dessus partait au-delà du contenu (zone
//     vide sous l'en-tête, MESURÉ sur iOS 27 avec l'ancre initiale comme avec
//     `scrollTo(edge:)`). Le prix accepté : toutes les lignes sont mises en
//     page à l'ouverture ;
//   — l'OUVERTURE est confiée à l'ancre initiale
//     `defaultScrollAnchor(.bottom, for: .initialOffset)`. La forme sans rôle
//     est INTERDITE : elle régirait aussi `.sizeChanges` et collerait le fil au
//     bas à chaque ajout, même remonté par l'utilisateur ; `.alignment` reste
//     en haut, un fil court n'est jamais poussé vers le bas ;
//   — le SUIVI en direct reste à `scrollRequest`, qui fait défiler par
//     `ScrollPosition.scrollTo(edge: .bottom)` jusqu'au bord RÉEL du contenu.
//
// Aucun littéral alphabétique : les mots viennent d'`IOSSessionText` ou du noyau.

import ConsoleCore
import SwiftUI

struct IOSSessionThreadView: View {
    @ObservedObject var model: IOSSessionThreadModel
    @State private var position = ScrollPosition(idType: String.self)

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
                Button { model.retry() } label: {
                    Label(ConnectionText.retry, systemImage: "arrow.clockwise")
                        .frame(minHeight: IOSMetrics.minimumTarget)
                        .contentShape(Rectangle())
                }
                .accessibilityIdentifier(IOSSessionsAccessibility.retry)
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
                HStack(spacing: 8) {
                    ProgressView()
                    Text(IOSSessionText.threadLoading).font(.callout)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier(IOSSessionsAccessibility.threadLoading)
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
        ScrollView(.vertical) {
            // Une pile NON paresseuse : l'offset de départ se calcule sur la
            // hauteur RÉELLE des lignes (voir l'en-tête).
            VStack(alignment: .leading, spacing: 14) {
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
                }
            }
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollPosition($position)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
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
        .onChange(of: model.scrollRequest) { _, _ in
            scroll()
        }
    }

    private func scroll() {
        guard !model.rows.isEmpty else { return }
        position.scrollTo(edge: .bottom)
    }
}
