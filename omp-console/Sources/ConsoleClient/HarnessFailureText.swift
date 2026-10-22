// La phrase d'un échec du serveur de pipelines, et le nom d'une étape : les mots viennent du noyau partagé
// (`PipelineServerText`), la correspondance vit ici, une seule fois pour les deux apps.

import ConsoleCore
import Foundation

extension HarnessFailure {
    /// La cause, puis le remède, au vouvoiement.
    public var message: String {
        switch self {
        case .invalidAddress: PipelineServerText.invalidAddress
        case .unauthorized: PipelineServerText.unauthorized
        case .unreachable: PipelineServerText.unreachable
        case .timedOut: PipelineServerText.timedOut
        case .rejected(let motive): PipelineServerText.rejected(motive)
        case .forbidden(let motive): PipelineServerText.forbidden(motive)
        case .stale: PipelineServerText.stale
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

    /// Ce que les rangées disent sous l'état : la reprise différée d'un run en file
    /// (« Reprise à 14:05 »), la cause du dernier échec d'un run en échec ou arrêté ;
    /// `nil` sinon.
    public func detailLine(now: Date = Date()) -> String? {
        if phase == .queued, let notBefore, notBefore > now {
            return PipelineServerText.resumeAt(notBefore.formatted(date: .omitted, time: .shortened))
        }
        if canRetry, let lastFailCause {
            return PipelineServerText.lastFailure(PipelineServerText.failCause(lastFailCause))
        }
        return nil
    }

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

extension HarnessProviderDraft.Problem {
    /// Ce qui empêche le fournisseur de partir, et comment y remédier.
    public var message: String {
        switch self {
        case .name: PipelineServerText.providerNameProblem
        case .reservedName: PipelineServerText.providerReservedProblem
        case .address: PipelineServerText.providerAddressProblem
        case .models: PipelineServerText.providerModelsProblem
        case .key: PipelineServerText.providerKeyProblem
        case .limit: PipelineServerText.providerLimitProblem
        }
    }
}
