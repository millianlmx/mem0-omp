// La section « Sessions » : les runs des pipelines rangés par jour (S-16 de
// omp-console-redesign, sur le sélecteur de S-6 de `visionneuse-de-session`).
//
// Une liste macOS standard (audit HIG 2026-10-01) : un clic SÉLECTIONNE, un
// double-clic, la touche ↩ ou « Ouvrir » du menu contextuel OUVRE la session —
// poussée DANS la section (pile de `ConsoleModel.sessionsPath`), jamais dans une
// fenêtre annexe qui partirait dans son propre espace en plein écran. Pas de
// chevron de navigation, idiome iOS. Le titre de la section est celui de la
// barre de la fenêtre, la liste n'en répète pas un second.
//
// L'horloge de rendu est `TimelineView(.periodic)` : « Aujourd'hui » devient
// « Hier » au passage de minuit sans qu'un octet sur disque change. Aucun attribut
// macro SwiftUI dans ce dépôt (Documentation §3) : la sélection vit dans le modèle.

import ConsoleCore
import SwiftUI

// Les textes de la section vivent dans le noyau partagé
// (`ConsoleCore/Viewer/SessionSelectorText.swift`, S-4 de design-ios) : la vue les
// lit par l'import, elle n'en déclare aucun.

struct SessionSelectorView: View {
    @ObservedObject var selector: SessionSelectorModel
    /// Montre une session dans la section (visionneuse poussée sur la liste).
    let onOpen: (ViewerTarget) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if selector.storeAbsent {
                empty(SessionSelectorText.storeAbsent)
            } else if selector.choices.isEmpty {
                empty(SessionSelectorText.noRun)
            } else {
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    list(nowMs: context.date.timeIntervalSince1970 * 1000)
                }
            }
            if selector.discarded > 0 {
                Text(SessionSelectorText.discarded(selector.discarded))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 8)
                    .accessibilityIdentifier("viewer.selector.footer")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func empty(_ description: String) -> some View {
        ContentUnavailableView(
            SessionSelectorText.emptyTitle,
            systemImage: "bubble.left.and.text.bubble.right",
            description: Text(description)
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("viewer.selector.empty")
    }

    private func list(nowMs: Double) -> some View {
        List(selection: $selector.selection) {
            ForEach(SessionDays.group(selector.choices, nowMs: nowMs, calendar: .current)) { day in
                Section(day.title) {
                    ForEach(day.choices) { choice in
                        row(choice)
                    }
                }
                // L'en-tête de jour suffit à séparer : pas de trait plein largeur.
                .listSectionSeparator(.hidden)
            }
        }
        .listStyle(.inset)
        .contextMenu(forSelectionType: RunChoice.ID.self) { ids in
            Button(SessionSelectorText.open) { open(ids) }
                .disabled(ids.isEmpty)
        } primaryAction: { ids in
            // Double-clic ou ↩ sur la sélection.
            open(ids)
        }
        .accessibilityIdentifier("viewer.selector.list")
    }

    /// Ouvre la première session désignée, dans l'ordre de la liste : une seule
    /// visionneuse à la fois, dans la fenêtre principale.
    private func open(_ ids: Set<RunChoice.ID>) {
        if let choice = selector.choices.first(where: { ids.contains($0.id) }) {
            onOpen(choice.target)
        }
    }

    /// Une ligne : l'étape en symbole, le titre de la feature, « <étape> · <dépôt> »,
    /// l'heure de début et l'état en un mot.
    private func row(_ choice: RunChoice) -> some View {
        HStack(spacing: 12) {
            Image(systemName: PhaseText.symbol(choice.phase))
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(choice.featureTitle)
                    .font(.body.weight(.medium))
                Text(RunChoice.subtitle(phase: choice.phase, repo: choice.repo))
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Text(ConsoleFormat.time(ms: choice.startedAtMs))
                .font(.callout.monospacedDigit())
                .foregroundStyle(.secondary)
            StatusBadge(status: .of(run: choice))
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("viewer.selector.open.\(choice.sessionFile)")
    }
}
