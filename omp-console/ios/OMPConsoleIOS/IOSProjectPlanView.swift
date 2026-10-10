// Le plan d'un projet conduit, rendu dans la section Projet de l'app (S-1, BR-4) :
// les segments dans l'ordre du plan, chacun avec son état en mots, ses features
// vivantes (slug, libellé d'état, modèles, intention, lien de PR ouvrable) et, à
// part, ses features retirées avec leur motif.
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
        VStack(alignment: .leading, spacing: 12) {
            ForEach(sections, id: \.index) { section in
                DisclosureGroup(isExpanded: expansion(section.index)) {
                    VStack(alignment: .leading, spacing: 10) {
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
                    }
                    .padding(.top, 8)
                } label: {
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
                }
                .accessibilityIdentifier(ProjectAccessibility.segment(section.index))
                Divider()
            }
        }
    }

    private func expansion(_ index: Int) -> Binding<Bool> {
        Binding(
            get: { expanded.contains(index) },
            set: { _ in onToggle(index) }
        )
    }

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
        .iosCard()
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
