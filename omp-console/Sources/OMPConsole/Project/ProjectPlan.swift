// Le plan d'un projet, réduit à ce que la vue affiche (S-8, BR-2) : des fonctions
// PURES, testables sans UI.
//
// Aucune règle du pilote n'est réimplémentée : l'état d'un segment se déduit de sa
// position par rapport à `current`, l'état d'une feature est le vocabulaire du
// pilote, et rien d'autre.

import Foundation

/// Une feature prête à afficher : son libellé d'état, sa PR, son modèle.
struct ProjectPlanRow: Equatable, Sendable {
    let slug: String
    let stateLabel: String
    let prUrl: String?
    let model: String?
    let intention: String
    /// Le motif d'une feature retirée (S-8 : « listées à part avec leur motif »).
    let removedReason: String?
}

/// L'état d'un segment, déduit de `Project.current`.
enum ProjectSegmentState: Equatable, Sendable {
    case merged
    case current
    case upcoming

    var label: String {
        switch self {
        case .merged: ProjectViewText.segmentMerged
        case .current: ProjectViewText.segmentCurrent
        case .upcoming: ProjectViewText.segmentUpcoming
        }
    }
}

/// Un segment prêt à afficher : ses features vivantes, ses features retirées.
struct ProjectPlanSection: Equatable, Sendable {
    let index: Int
    let name: String
    let state: ProjectSegmentState
    let features: [ProjectPlanRow]
    let removed: [ProjectPlanRow]
}

/// Le libellé d'état d'une feature, vocabulaire EXACT du pilote (S-8).
func featureStateLabel(_ status: ProjectFeatureStatus, failure: ProjectFailure?) -> String {
    if status == .failed {
        guard let reason = failure?.reason, !reason.isEmpty else { return ProjectViewText.featureFailed }
        return "\(ProjectViewText.featureFailed) — \(reason)"
    }
    return switch status {
    case .planned: ProjectViewText.featurePlanned
    case .launched: ProjectViewText.featureLaunched
    case .pr: ProjectViewText.featurePR
    case .merged: ProjectViewText.featureMerged
    case .removed: ProjectViewText.featureRemoved
    case .failed: ProjectViewText.featureFailed
    }
}

/// L'en-tête d'état : « terminé », sinon « <en cours|arrêté> — segment i/N « nom » ».
func projectStatusLine(of project: Project) -> String {
    if project.status == .done { return ProjectViewText.statusDone }
    let word = project.status == .running ? ProjectViewText.statusRunning : ProjectViewText.statusStopped
    let index = project.current + 1
    let name = project.segments[project.current].name
    return "\(word) — segment \(index)/\(project.segments.count) « \(name) »"
}

/// « m/n feature(s) fusionnée(s) » : `m` = features fusionnées, `n` = features non
/// retirées.
func projectProgressLine(of project: Project) -> String {
    let all = project.segments.flatMap(\.features)
    let merged = all.filter { $0.status == .merged }.count
    let live = all.filter { $0.status != .removed }.count
    return "\(merged)/\(live) feature(s) fusionnée(s)"
}

/// Le couple (fusionnées, non retirées), pour la bannière de fin (S-10).
func projectProgressCounts(of project: Project) -> (merged: Int, total: Int) {
    let all = project.segments.flatMap(\.features)
    return (all.filter { $0.status == .merged }.count, all.filter { $0.status != .removed }.count)
}

/// Les sections du plan, dans l'ordre du plan.
func projectPlanSections(of project: Project) -> [ProjectPlanSection] {
    project.segments.enumerated().map { index, segment in
        let state: ProjectSegmentState = index < project.current
            ? .merged
            : (index == project.current ? .current : .upcoming)
        let live = segment.features.filter { $0.status != .removed }
        let removed = segment.features.filter { $0.status == .removed }
        return ProjectPlanSection(
            index: index,
            name: segment.name,
            state: state,
            features: live.map { row(for: $0) },
            removed: removed.map { row(for: $0) }
        )
    }
}

private func row(for feature: ProjectFeature) -> ProjectPlanRow {
    ProjectPlanRow(
        slug: feature.slug,
        stateLabel: featureStateLabel(feature.status, failure: feature.failure),
        prUrl: feature.prUrl,
        model: feature.model,
        intention: feature.intention,
        removedReason: feature.removedReason
    )
}
