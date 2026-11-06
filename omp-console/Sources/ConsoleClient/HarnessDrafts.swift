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
    /// Les réponses saisies, par identifiant d'escalade. Sans saisie, la réponse d'une
    /// escalade est l'option recommandée par l'agent (`answer(for:)`).
    @Published public var answers: [Int: String] = [:]
    /// La raison facultative de chaque réponse, par identifiant d'escalade.
    @Published public var reasons: [Int: String] = [:]
    /// Le run dont on refuse le verdict, et la raison du refus.
    @Published public var refusal: HarnessRun?
    @Published public var refusalReason = ""
    /// La décision qu'on renverse, l'option retenue à sa place et la raison.
    @Published public var reversal: HarnessDecision?
    @Published public var reversalOption = ""
    @Published public var reversalReason = ""
    /// La feature dont l'arrêt attend confirmation.
    @Published public var stopRequest: HarnessRun?
    /// La feature dont la relance attend confirmation (en échec, ou arrêtée sur une attente).
    @Published public var retryRequest: HarnessRun?
    /// La feature fusionnée dont l'annulation (commit inverse) attend confirmation.
    @Published public var revertRequest: HarnessRun?
    /// Le direct ouvert en feuille : celui d'une feature, ou de l'analyse d'un audit.
    @Published public var sessionRequest: HarnessSessionRequest?
    @Published public var forgetAsked = false
    /// La feuille de configuration du serveur est ouverte.
    @Published public var serverSheetShown = false
    /// La section de la boîte où une tuile du tableau de bord fait défiler l'Accueil ;
    /// remise à `nil` une fois le défilement fait.
    @Published public var homeAnchor: HarnessHomeAnchor?
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
    /// Le fournisseur en cours de saisie (sa feuille est ouverte), et celui dont le
    /// retrait attend confirmation (admin).
    @Published public var provider: HarnessProviderDraft?
    @Published public var providerRemoval: HarnessProvider?
    /// Les modèles par niveau en cours de saisie (`fournisseur/modèle, …`).
    @Published public var chains: [String: String] = [:]
    /// L'abonnement choisi pour une connexion, et son code (ou l'adresse de la page
    /// finale) en cours de saisie.
    @Published public var loginProvider = ""
    @Published public var loginCode = ""
    /// L'envoi du poste de travail dont on saisit le refus, et sa raison facultative.
    @Published public var workstationRefusal: WorkstationAction?
    @Published public var workstationRefusalReason = ""
    /// Les adresses et pseudos de l'utilisateur en cours de saisie (une par ligne) ;
    /// `nil` tant qu'il n'a rien touché : le champ montre alors celles du serveur.
    @Published public var workstationIdentities: String?

    /// Ouvre la saisie du refus d'un envoi, raison vide.
    public func beginWorkstationRefusal(_ action: WorkstationAction) {
        workstationRefusalReason = ""
        workstationRefusal = action
    }

    /// Les adresses saisies diffèrent de celles du serveur : « Enregistrer » est permis.
    public func identitiesChanged(from status: WorkstationStatus?) -> Bool {
        guard let text = workstationIdentities else { return false }
        return WorkstationModel.identities(from: text) != (status?.selfIdentities ?? [])
    }

    public init() {}

    /// Reprend dans la saisie les modèles par niveau que le serveur vient de rendre.
    public func loadChains(_ catalog: HarnessProviderCatalog) {
        chains = Dictionary(uniqueKeysWithValues: HarnessModelChains.tiers.map { ($0, HarnessModelChains.text(catalog.models[$0])) })
    }

    /// Les modèles par niveau saisis, ou `nil` si un maillon n'a pas la forme `fournisseur/modèle`.
    public var parsedChains: HarnessModelChains? {
        var out = HarnessModelChains()
        for tier in HarnessModelChains.tiers {
            guard let chain = HarnessModelChains.parse(chains[tier] ?? "") else { return nil }
            out[tier] = chain
        }
        return out
    }

    /// Ouvre la saisie d'un nouveau fournisseur, ou la modification d'un déclaré.
    public func beginProvider(_ existing: HarnessProvider? = nil) {
        provider = existing.map { HarnessProviderDraft(editing: $0) } ?? HarnessProviderDraft()
    }

    /// Les abonnements à connecter (disponibles, pas encore connectés), et le choisi :
    /// celui de la saisie s'il en fait partie, sinon le premier.
    public static func connectable(_ providers: [HarnessLoginProvider]) -> [HarnessLoginProvider] {
        providers.filter { $0.available && !$0.authenticated }
    }

    public func chosenLogin(in providers: [HarnessLoginProvider]) -> String? {
        let open = Self.connectable(providers)
        if open.contains(where: { $0.id == loginProvider }) { return loginProvider }
        return open.first?.id
    }

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

    /// La réponse courante d'une escalade : la saisie, sinon l'option recommandée par l'agent.
    public func answer(for item: HarnessEscalation) -> String {
        if let typed = answers[item.id] { return typed }
        return item.recommended ?? ""
    }

    /// La réponse d'une escalade est l'option recommandée, non modifiée.
    public func isRecommended(_ item: HarnessEscalation) -> Bool {
        guard let recommended = item.recommended else { return false }
        return answer(for: item) == recommended
    }

    /// Chaque escalade du lot a une réponse (saisie ou recommandée) : le lot peut partir.
    public func canAnswer(_ batch: HarnessEscalationBatch) -> Bool {
        !batch.items.isEmpty && batch.items.allSatisfy { !answer(for: $0).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    /// Les réponses d'un lot, prêtes à envoyer.
    public func answers(for batch: HarnessEscalationBatch) -> [Int: String] {
        var out: [Int: String] = [:]
        for item in batch.items { out[item.id] = answer(for: item).trimmingCharacters(in: .whitespacesAndNewlines) }
        return out
    }

    /// Les raisons données dans un lot (les vides n'y sont pas).
    public func reasons(for batch: HarnessEscalationBatch) -> [Int: String] {
        var out: [Int: String] = [:]
        for item in batch.items {
            let reason = (reasons[item.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !reason.isEmpty { out[item.id] = reason }
        }
        return out
    }

    /// Les recommandations de l'agent pour tout le lot, ou `nil` si une escalade n'en a pas :
    /// « Accepter les recommandations » répond tout d'un geste, sans tenir compte des saisies.
    public static func recommendedAnswers(for batch: HarnessEscalationBatch) -> [Int: String]? {
        guard !batch.items.isEmpty else { return nil }
        var out: [Int: String] = [:]
        for item in batch.items {
            guard let recommended = item.recommended, !recommended.isEmpty else { return nil }
            out[item.id] = recommended
        }
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

    /// Après un envoi réussi, les réponses et raisons du lot sont oubliées.
    public func clearAnswers(for batch: HarnessEscalationBatch) {
        for item in batch.items {
            answers[item.id] = nil
            reasons[item.id] = nil
        }
    }
}

/// L'ouverture d'un direct : sa cible et le titre de sa feuille.
public struct HarnessSessionRequest: Identifiable, Equatable, Sendable {
    public var target: HarnessSessionTarget
    public var title: String

    public init(target: HarnessSessionTarget, title: String) {
        self.target = target
        self.title = title
    }

    public init(run: HarnessRun) {
        self.init(target: .run(run.id), title: run.title)
    }

    public var id: HarnessSessionTarget { target }

    /// La feature suivie, si c'en est une (fichiers, tests et frise n'existent que pour elle).
    public var runId: String? {
        if case let .run(id) = target { return id }
        return nil
    }
}
