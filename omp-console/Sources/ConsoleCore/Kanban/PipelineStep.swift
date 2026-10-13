// Une étape d'avancement (S-14 de omp-console-redesign) : son titre et son état —
// fait, en cours, à venir ou en échec. Le Kanban du Mac en rend cinq par carte
// (`PipelineProgress`), la section Audit quatre par audit et cinq par feature
// lancée (`AuditPresentation`, audit-ui-redesign S-1).
//
// VIT DANS `ConsoleCore` : la coque macOS et l'app iOS rendent les mêmes étapes.

/// L'état d'une étape de l'avancement.
public enum PipelineStepState: Sendable, Equatable {
    case done, current, upcoming, failed
}

/// Une étape de l'avancement : son titre et son état.
public struct PipelineStep: Sendable, Equatable {
    public var title: String
    public var state: PipelineStepState

    public init(title: String, state: PipelineStepState) {
        self.title = title
        self.state = state
    }
}
