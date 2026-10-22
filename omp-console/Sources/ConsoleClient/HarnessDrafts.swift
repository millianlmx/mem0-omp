// Les brouillons des écrans du serveur de pipelines, partagés par la coque Mac (qui
// n'emploie pas `@State`) et l'app iOS : la saisie de configuration, les réponses
// aux escalades, le refus d'un verdict, le renversement d'une décision, l'arrêt
// d'une feature. Aucun réseau ici : les gestes passent par `HarnessModel`.

import Combine
import Foundation

/// Une feature d'un projet en cours de saisie.
public struct HarnessFeatureDraft: Equatable, Sendable, Identifiable {
    public var id: UUID
    public var title: String
    public var request: String
    /// Les chemins du dépôt que la feature touchera, séparés par des virgules ou des
    /// espaces (`src/api, docs`) : ce sont eux qui décident du parallélisme. Vide : le
    /// serveur les cherche dans la mémoire du projet.
    public var modules: String

    public init(id: UUID = UUID(), title: String = "", request: String = "", modules: String = "") {
        self.id = id
        self.title = title
        self.request = request
        self.modules = modules
    }

    /// Les modules saisis, un par chemin, sans doublon ; vide si rien n'est saisi.
    public var moduleList: [String] {
        var seen = Set<String>()
        return modules
            .split(whereSeparator: { $0 == "," || $0 == " " || $0 == "\n" })
            .map { String($0).trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    /// Titre et demande saisis : la feature peut partir.
    public var isComplete: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !request.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

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
    /// La feuille de configuration du serveur est ouverte.
    @Published public var serverSheetShown = false
    /// Le dépôt visé par les lancements (feature, projet, audit).
    @Published public var repo = ""
    /// Une feature à lancer.
    @Published public var runTitle = ""
    @Published public var runRequest = ""
    /// Un projet à lancer, feature par feature.
    @Published public var projectTitle = ""
    @Published public var features: [HarnessFeatureDraft] = [HarnessFeatureDraft()]
    /// Un audit à lancer : son périmètre (vide : le dépôt entier).
    @Published public var auditFocus = ""
    /// Les propositions cochées, par audit.
    @Published public var picks: [String: Set<Int>] = [:]
    /// Les specs relues (run → contenu de `specs.md`) et le refus en cours.
    @Published public var specs: [String: String] = [:]

    public init() {}

    /// Le dépôt des lancements : celui choisi, sinon le premier déclaré.
    public func launchRepo(in repos: [HarnessRepo]) -> String? {
        if repos.contains(where: { $0.name == repo }) { return repo }
        return repos.first?.name
    }

    public var canLaunchRun: Bool {
        !runTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !runRequest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public var canLaunchProject: Bool {
        !projectTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !features.isEmpty && features.allSatisfy(\.isComplete)
    }

    /// Après un lancement réussi, la saisie est remise à zéro.
    public func clearRun() {
        runTitle = ""
        runRequest = ""
    }

    public func clearProject() {
        projectTitle = ""
        features = [HarnessFeatureDraft()]
    }

    public func addFeature() { features.append(HarnessFeatureDraft()) }

    public func removeFeature(_ id: UUID) {
        features.removeAll { $0.id == id }
        if features.isEmpty { features = [HarnessFeatureDraft()] }
    }

    /// Coche ou décoche une proposition d'audit.
    public func togglePick(_ audit: HarnessAudit, _ index: Int) {
        var set = picks[audit.id] ?? []
        if set.contains(index) { set.remove(index) } else { set.insert(index) }
        picks[audit.id] = set
    }

    public func isPicked(_ audit: HarnessAudit, _ index: Int) -> Bool { picks[audit.id]?.contains(index) ?? false }

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
