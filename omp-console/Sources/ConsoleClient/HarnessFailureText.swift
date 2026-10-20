// La phrase d'un échec du serveur de pipelines, et le nom d'une étape : les mots viennent du noyau partagé
// (`PipelineServerText`), la correspondance vit ici, une seule fois pour les deux apps.

import ConsoleCore

extension HarnessFailure {
    /// La cause, puis le remède, au vouvoiement.
    public var message: String {
        switch self {
        case .invalidAddress: PipelineServerText.invalidAddress
        case .unauthorized: PipelineServerText.unauthorized
        case .unreachable: PipelineServerText.unreachable
        case .timedOut: PipelineServerText.timedOut
        case .rejected(let motive): PipelineServerText.rejected(motive)
        case .unreadable: PipelineServerText.unreadable
        }
    }
}

extension HarnessRun {
    /// L'état, puis l'étape s'il y en a une : « En cours · /review ».
    public var statusLine: String {
        guard let step = stepLabel else { return PipelineServerText.state(state) }
        return PipelineServerText.state(state) + " · " + step
    }

    /// L'étape en cours, sous son nom de commande, ou `nil` hors étape.
    public var stepLabel: String? { step.map(Self.label(forStep:)) }

    /// Les étapes du serveur, dans l'ordre du chemin nominal (statistiques).
    public static let stepKinds = ["req", "specs", "impl", "review", "fix"]

    /// Une étape du serveur sous son nom de commande ; la valeur brute si elle est inconnue.
    public static func label(forStep kind: String) -> String {
        switch kind {
        case "req": PipelineServerText.stepReq
        case "specs": PipelineServerText.stepSpecs
        case "impl": PipelineServerText.stepImpl
        case "review": PipelineServerText.stepReview
        case "fix": PipelineServerText.stepFix
        default: kind
        }
    }
}
