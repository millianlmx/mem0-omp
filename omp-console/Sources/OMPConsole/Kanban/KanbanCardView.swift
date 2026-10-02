// Une carte du tableau (refonte du 2026-10-02) : le titre, le dépôt quand
// l'ardoise en mêle plusieurs, la nature de l'attente en badge quand la voie ne
// la dit pas déjà (« Question », « Specs à valider », « En pause », « PR
// ouverte »…), la question de l'agent en aperçu, puis — pour une feature
// vivante — son étape, sa barre d'avancement et sa durée. Un clic sélectionne, un
// double clic ouvre le détail ; elle est accessible (identifiant + libellé).
//
// Surface de CONTENU (HIG Materials) : carte opaque `.consoleCard`, jamais de
// verre. La DURÉE vit sous un `TimelineView(.periodic(from: .now, by: 30))` : à
// la minute, elle n'a pas besoin d'un rendu par seconde.

import SwiftUI

struct KanbanCardView: View {
    let card: KanbanCard
    let selected: Bool
    /// Le dépôt n'est écrit que si l'ardoise en mêle plusieurs.
    let showsRepo: Bool
    let onTap: () -> Void
    let onOpen: () -> Void

    var body: some View {
        let status = ConsoleStatus.of(card: card)
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(KanbanCardPresentation.title(card))
                    .font(.headline)
                    .lineLimit(2)
                Spacer(minLength: 4)
                if let badge = KanbanCardPresentation.badge(card) {
                    StatusBadge(status: badge)
                        .fixedSize()
                }
            }
            if showsRepo {
                Text(card.repo)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if let preview = KanbanCardPresentation.preview(card) {
                Text(preview)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
            if KanbanCardPresentation.showsProgress(card) {
                PipelineProgressBar(steps: PipelineProgress.steps(for: card))
            }
            footer
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .consoleCard(selected: selected)
        // Le contenu EST la forme cliquable : sans elle, seuls les textes le sont.
        .contentShape(.rect(cornerRadius: ConsoleSurface.cardRadius))
        .onTapGesture(count: 2) { onOpen() }
        // Simultané : le simple clic sélectionne sans attendre le délai du double.
        .simultaneousGesture(TapGesture().onEnded { onTap() })
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("kanban.card.\(card.id)")
        .accessibilityLabel("\(card.title), \(status.text)")
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
        .accessibilityAction(named: KanbanText.showDetails) { onOpen() }
    }

    /// L'étape à gauche, la durée à droite — chacune seulement si elle a un sens.
    @ViewBuilder
    private var footer: some View {
        let showsPhase = KanbanCardPresentation.showsProgress(card)
        let showsDuration = KanbanCardPresentation.showsDuration(card)
        if showsPhase || showsDuration {
            HStack(spacing: 6) {
                if showsPhase, let phase = card.phase {
                    Label(PhaseText.title(phase), systemImage: PhaseText.symbol(phase))
                        .labelStyle(.titleAndIcon)
                }
                Spacer(minLength: 4)
                if showsDuration {
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        Text(ConsoleFormat.duration(ms: card.elapsedMs(nowMs: context.date.timeIntervalSince1970 * 1000)))
                            .monospacedDigit()
                    }
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }
}
