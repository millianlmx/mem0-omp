// Le plan d'un projet conduit, rendu dans la liste groupée de la section Projet
// (S-1, BR-4 ; ios-listes-groupees-natives, S-6) : une section par segment, dans
// l'ordre du plan, dont la rangée dépliable porte le titre et l'état en mots ;
// dépliée, ses features vivantes (slug, libellé d'état, modèles, intention, lien
// de PR ouvrable) puis, à part, ses features retirées avec leur motif. Les
// séparateurs sont ceux du système.
//
// Aucune règle du plan n'est recalculée : `IOSProjectModel` projette par
// `projectPlanSections(of:)` (ConsoleCore), et cette vue ne fait que rendre.

import ConsoleCore
import SwiftUI

struct IOSProjectPlanView: View {
    let sections: [ProjectPlanSection]
    let expanded: Set<Int>
    let onToggle: (Int) -> Void

    var body: some View {
        ForEach(sections, id: \.index) { section in
            Section {
                DisclosureGroup(isExpanded: expansion(section.index)) {
                    ForEach(section.features, id: \.slug) { row in
                        feature(row)
                    }
                    if !section.removed.isEmpty {
                        Text(ProjectViewText.removedTitle)
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(.secondary)
                        ForEach(section.removed, id: \.slug) { row in
                            feature(row)
                        }
                    }
                } label: {
                    // L'identifiant du segment est sur son libellé, combiné en un
                    // seul élément : posé sur le `DisclosureGroup`, il remplacerait
                    // celui de chaque rangée dépliée ; posé sur la pile seule, le
                    // bouton du système le recevait deux fois (MESURÉ).
                    HStack(spacing: 8) {
                        Text(ProjectViewText.segmentTitle(
                            index: section.index + 1,
                            count: sections.count,
                            name: section.name
                        ))
                            .font(.headline)
                        Spacer(minLength: 8)
                        IOSStatusChip(status: status(section.state))
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier(ProjectAccessibility.segment(section.index))
                }
            }
        }
    }

    private func expansion(_ index: Int) -> Binding<Bool> {
        Binding(
            get: { expanded.contains(index) },
            set: { _ in onToggle(index) }
        )
    }

    /// Une rangée de feature. Le lien de PR n'est qu'une des cibles possibles de
    /// la rangée : le style `.borderless` borne chaque cible à son libellé (D-4).
    private func feature(_ row: ProjectPlanRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(row.slug)
                    .font(.headline)
                Spacer(minLength: 8)
                Text(row.stateLabel)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            if let models = row.models, !models.isEmpty {
                Text(models)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if !row.intention.isEmpty {
                Text(row.intention)
                    .font(.callout)
            }
            if let url = row.prUrl, let link = ProjectViewText.prLinkURL(url) {
                Link(destination: link) {
                    Text(ProjectViewText.prOpen)
                        .font(.callout)
                        .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget)
                        .contentShape(Rectangle())
                }
            }
            if let reason = row.removedReason, !reason.isEmpty {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .buttonStyle(.borderless)
        .accessibilityIdentifier(
            row.removedReason == nil
                ? ProjectAccessibility.feature(row.slug)
                : ProjectAccessibility.removedFeature(row.slug)
        )
    }

    private func status(_ state: ProjectSegmentState) -> ConsoleStatus {
        switch state {
        case .merged: return ConsoleStatus(text: state.label, tone: .success)
        case .current: return ConsoleStatus(text: state.label, tone: .info)
        case .upcoming: return ConsoleStatus(text: state.label, tone: .neutral)
        }
    }
}
