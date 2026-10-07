// Le plan d'un projet, réduit à ce que la vue affiche (S-8, BR-2) : des fonctions
// PURES, testables sans UI.
//
// Aucune règle du pilote n'est réimplémentée : l'état d'un segment se déduit de sa
// position par rapport à `current`, l'état d'une feature est le vocabulaire du
// pilote, et rien d'autre.
//
// Cible PARTAGÉE macOS/iOS : ce découpage est consommé tel quel par l'app iOS
// (S-1), donc aucune règle du plan n'est recalculée côté app.

import Foundation

/// Une feature prête à afficher : son libellé d'état, sa PR, ses modèles.
public struct ProjectPlanRow: Equatable, Sendable {
    public let slug: String
    public let stateLabel: String
    public let prUrl: String?
    /// La forme canonique des deux modèles : `req+specs <A> · impl+review <B>`,
    /// ou `nil` quand la feature n'en porte aucun.
    public let models: String?
    public let intention: String
    /// Le motif d'une feature retirée (S-8 : « listées à part avec leur motif »).
    public let removedReason: String?

    init(slug: String, stateLabel: String, prUrl: String?, models: String?, intention: String, removedReason: String?) {
        self.slug = slug
        self.stateLabel = stateLabel
        self.prUrl = prUrl
        self.models = models
        self.intention = intention
        self.removedReason = removedReason
    }
}

/// L'état d'un segment, déduit de `Project.current`.
public enum ProjectSegmentState: Equatable, Sendable {
    case merged
    case current
    case upcoming

    public var label: String {
        switch self {
        case .merged: ProjectViewText.segmentMerged
        case .current: ProjectViewText.segmentCurrent
        case .upcoming: ProjectViewText.segmentUpcoming
        }
    }
}

/// Un segment prêt à afficher : ses features vivantes, ses features retirées.
public struct ProjectPlanSection: Equatable, Sendable {
    public let index: Int
    public let name: String
    public let state: ProjectSegmentState
    public let features: [ProjectPlanRow]
    public let removed: [ProjectPlanRow]

    init(index: Int, name: String, state: ProjectSegmentState, features: [ProjectPlanRow], removed: [ProjectPlanRow]) {
        self.index = index
        self.name = name
        self.state = state
        self.features = features
        self.removed = removed
    }
}

/// Le libellé d'état d'une feature, dans le vocabulaire commun de l'app (S-8).
public func featureStateLabel(_ status: ProjectFeatureStatus, failure: ProjectFailure?) -> String {
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

/// L'en-tête d'état : « Terminé », sinon « <En cours|Arrêté> — segment i sur N · nom ».
public func projectStatusLine(of project: Project) -> String {
    if project.status == .done { return ProjectViewText.statusDone }
    let word = project.status == .running ? ProjectViewText.statusRunning : ProjectViewText.statusStopped
    let name = project.segments[project.current].name
    return "\(word) — segment \(project.current + 1) sur \(project.segments.count) · \(name)"
}

/// « m features fusionnées sur n » : `m` = features fusionnées, `n` = features non
/// retirées.
public func projectProgressLine(of project: Project) -> String {
    let counts = projectProgressCounts(of: project)
    return ProjectViewText.progress(merged: counts.merged, total: counts.total)
}

/// Le couple (fusionnées, non retirées), pour la bannière de fin (S-10).
public func projectProgressCounts(of project: Project) -> (merged: Int, total: Int) {
    let all = project.segments.flatMap(\.features)
    return (all.filter { $0.status == .merged }.count, all.filter { $0.status != .removed }.count)
}

/// Les sections du plan, dans l'ordre du plan.
public func projectPlanSections(of project: Project) -> [ProjectPlanSection] {
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
        models: ModelSlots.resolve(
            legacy: feature.model,
            reqSpecs: feature.modelReqSpecs,
            implReview: feature.modelImplReview
        ).map(KanbanText.modelsLine),
        intention: feature.intention,
        removedReason: feature.removedReason
    )
}
