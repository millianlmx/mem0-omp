// Une question de la boîte, SITUÉE : l'humain pilote plusieurs projets à la fois et
// lit chaque question (escalade ou décision prise seule) hors de la session de
// l'agent. Avant la question elle-même, il doit savoir de quel dépôt elle vient, de
// quelle feature, à quelle étape, et ce que cette feature devait livrer.
//
// Fonction PURE du contrat (`HarnessRun`, `HarnessEscalation`, `HarnessDecision`) :
// les deux apps posent la même tête au-dessus de chaque question.

import Foundation

/// Où se situe une question : le dépôt, la feature, l'étape qui l'a posée et la
/// demande d'origine de la feature.
public struct HarnessQuestion: Equatable, Sendable {
    /// Le dépôt de la feature ; `nil` quand la boîte ne porte pas le run.
    public var repo: String?
    /// Le titre de la feature, ou son identifiant quand la boîte ne porte pas le run.
    public var feature: String
    /// L'étape qui a posé la question, sous son nom de commande (« /impl »).
    public var step: String?
    /// Ce que la feature doit livrer, tel que l'humain l'a demandé.
    public var request: String?
    /// Les chemins que la feature touche.
    public var modules: [String]

    public init(repo: String?, feature: String, step: String? = nil, request: String? = nil, modules: [String] = []) {
        self.repo = repo
        self.feature = feature
        self.step = step
        self.request = request
        self.modules = modules
    }

    /// La place d'une question posée par le run `runId` (décrit par `run` s'il est
    /// connu) à l'étape `step` ; sans étape dite, celle où le run se trouve.
    public init(run: HarnessRun?, runId: String, step: String?) {
        let kind = Self.shown(step) ?? run?.step
        self.init(
            repo: run.map(\.repo),
            feature: run?.title ?? runId,
            step: kind.map(HarnessRun.label(forStep:)),
            request: Self.shown(run?.request),
            modules: run?.modules ?? []
        )
    }

    /// Le fil d'Ariane, du plus large au plus précis : dépôt, feature, étape.
    public var trail: [String] {
        [repo, feature, step].compactMap { $0 }
    }

    /// Un texte de l'agent, s'il dit quelque chose (ni absent, ni blanc).
    static func shown(_ text: String?) -> String? {
        guard let text else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

extension HarnessInbox {
    /// La place d'une question d'un lot d'escalades.
    public func question(_ item: HarnessEscalation, in batch: HarnessEscalationBatch) -> HarnessQuestion {
        HarnessQuestion(run: batch.run ?? run(item.runId), runId: item.runId, step: item.step)
    }

    /// La place d'une décision prise seule.
    public func question(_ decision: HarnessDecision) -> HarnessQuestion {
        HarnessQuestion(run: run(decision.runId), runId: decision.runId, step: decision.step)
    }

    /// La place d'un run qui attend une validation (specs ou verdict).
    public func question(_ run: HarnessRun) -> HarnessQuestion {
        HarnessQuestion(run: run, runId: run.id, step: run.step)
    }
}
