// Les brouillons des écrans du serveur de pipelines, partagés par la coque Mac (qui
// n'emploie pas `@State`) et l'app iOS : la saisie de configuration, les réponses
// aux escalades, le refus d'un verdict, le renversement d'une décision, l'arrêt
// d'une feature. Aucun réseau ici : les gestes passent par `HarnessModel`.

import Combine
import Foundation

@MainActor
public final class HarnessDrafts: ObservableObject {
    @Published public var address = ""
    @Published public var token = ""
    /// Les réponses en cours, par identifiant d'escalade.
    @Published public var answers: [Int: String] = [:]
    /// Le run dont on refuse le verdict, et la raison du refus.
    @Published public var refusal: HarnessRun?
    @Published public var refusalReason = ""
    /// La décision qu'on renverse, l'option retenue à sa place et la raison.
    @Published public var reversal: HarnessDecision?
    @Published public var reversalOption = ""
    @Published public var reversalReason = ""
    /// La feature dont l'arrêt attend confirmation.
    @Published public var stopRequest: HarnessRun?
    @Published public var forgetAsked = false

    public init() {}

    /// Chaque escalade du lot a une réponse : le lot peut partir.
    public func canAnswer(_ batch: HarnessEscalationBatch) -> Bool {
        !batch.items.isEmpty && batch.items.allSatisfy { !(answers[$0.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    /// Les réponses d'un lot, prêtes à envoyer.
    public func answers(for batch: HarnessEscalationBatch) -> [Int: String] {
        var out: [Int: String] = [:]
        for item in batch.items { out[item.id] = (answers[item.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
        return out
    }

    /// Ouvre le renversement d'une décision, sur sa première autre option.
    public func beginReversal(_ decision: HarnessDecision) {
        reversal = decision
        reversalOption = decision.alternatives.first ?? ""
        reversalReason = ""
    }

    public var canReverse: Bool {
        !reversalOption.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !reversalReason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public func beginRefusal(_ run: HarnessRun) {
        refusal = run
        refusalReason = ""
    }

    public var canRefuse: Bool { !refusalReason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// Après un envoi réussi, les réponses du lot sont oubliées.
    public func clearAnswers(for batch: HarnessEscalationBatch) {
        for item in batch.items { answers[item.id] = nil }
    }
}
