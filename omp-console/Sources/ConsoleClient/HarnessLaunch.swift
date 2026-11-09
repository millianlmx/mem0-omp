// Le lancement d'une feature AVEC ses options, tel que `POST /v1/runs` les accepte
// (omp-harness/input.ts `newRunInput`) : la priorité d'admission, la voie, les modules
// touchés, le cadrage `/req` déjà écrit, le budget propre à la feature (contrat C3,
// `budgetUsd`), le type de travail et les labels (autonomie par paliers, `kind` et
// `labels`). Chaque option vide reste HORS du corps : un serveur antérieur reçoit le
// même corps qu'avant.
//
// La saisie vit en texte dans `HarnessDrafts` ; `HarnessLaunchDraft.options` la lit et
// dit ce qui ne va pas (`HarnessLaunchProblem`) — les mots sont ceux de
// `PipelineServerText`, dans le noyau partagé.

import Foundation

/// La voie d'une feature : `auto` laisse le serveur choisir (la voie directe quand la
/// demande porte ses critères d'acceptation, `lanes.direct`), `full` impose la voie
/// complète (/req, /specs, /impl, /review).
public enum HarnessLane: String, CaseIterable, Sendable, Identifiable {
    case auto
    case full

    public var id: String { rawValue }
}

/// Les options d'un lancement ; `nil` ou vide : le serveur décide.
public struct HarnessLaunchOptions: Equatable, Sendable {
    /// La priorité d'admission (plus grand = plus tôt), de -1000 à 1000.
    public var priority: Int?
    public var lane: HarnessLane
    /// Les chemins touchés : deux features aux modules disjoints tournent en parallèle.
    public var modules: [String]
    /// Le cadrage déjà écrit (contenu de `req.md`) : l'étape /req est alors sautée.
    public var req: String?
    /// Le budget propre à la feature, en dollars (prioritaire sur `monitoring.runBudgetUsd`).
    public var budgetUsd: Double?
    /// Le type de travail : il choisit la règle d'autonomie du dépôt (`nil` : aucune).
    public var kind: HarnessWorkKind?
    /// Les labels, rognés et sans doublon, que `match.labels` d'une règle peut exiger.
    public var labels: [String]
    /// Le curseur d'autonomie de la feature : `ask` (tout demander), `deliver` (livrer et
    /// prévenir) ; `nil` : celui de l'espace du dépôt, sinon ses règles.
    public var autonomy: HarnessRunAutonomy?

    public init(
        priority: Int? = nil, lane: HarnessLane = .auto, modules: [String] = [], req: String? = nil, budgetUsd: Double? = nil,
        kind: HarnessWorkKind? = nil, labels: [String] = [], autonomy: HarnessRunAutonomy? = nil
    ) {
        self.priority = priority
        self.lane = lane
        self.modules = modules
        self.req = req
        self.budgetUsd = budgetUsd
        self.kind = kind
        self.labels = labels
        self.autonomy = autonomy
    }

    /// Les bornes de la priorité, celles du serveur (`setPriority`, admission).
    public static let priorityRange = -1000 ... 1000
    /// Les bornes des labels, celles du serveur (`newRunInput`) : 20 au plus, de 1 à 50 caractères.
    public static let maxLabels = 20
    public static let maxLabelLength = 50
}

public enum HarnessLaunchProblem: Error, Equatable, Sendable {
    /// La priorité n'est pas un entier de -1000 à 1000.
    case priority
    /// Le budget n'est pas un montant positif.
    case budget
    /// Plus de 20 labels, ou un label de plus de 50 caractères.
    case labels
}

/// La saisie des options, en texte, et sa lecture.
public struct HarnessLaunchDraft: Equatable, Sendable {
    public var priority = ""
    public var lane: HarnessLane = .auto
    public var modules = ""
    public var req = ""
    public var budget = ""
    public var kind: HarnessWorkKind?
    /// Les labels séparés par des virgules ou des retours à la ligne.
    public var labels = ""
    public var autonomy: HarnessRunAutonomy?

    public init(
        priority: String = "", lane: HarnessLane = .auto, modules: String = "", req: String = "", budget: String = "",
        kind: HarnessWorkKind? = nil, labels: String = "", autonomy: HarnessRunAutonomy? = nil
    ) {
        self.priority = priority
        self.lane = lane
        self.modules = modules
        self.req = req
        self.budget = budget
        self.kind = kind
        self.labels = labels
        self.autonomy = autonomy
    }

    /// Les labels saisis : rognés, sans vide ni doublon (le premier gardé), comme le serveur.
    public static func labels(of text: String) -> [String] {
        var seen = Set<String>()
        return text
            .split(whereSeparator: { $0 == "," || $0 == "\n" })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    /// Une option au moins est renseignée (le panneau des options s'ouvre déplié).
    public var isCustomized: Bool { self != HarnessLaunchDraft() }

    /// La première saisie illisible, ou `nil`.
    public var problem: HarnessLaunchProblem? {
        if case .failure(let problem) = read() { return problem }
        return nil
    }

    /// Les options lues, ou `nil` si une saisie est illisible.
    public var options: HarnessLaunchOptions? {
        if case .success(let options) = read() { return options }
        return nil
    }

    private func read() -> Result<HarnessLaunchOptions, HarnessLaunchProblem> {
        var options = HarnessLaunchOptions(lane: lane, modules: HarnessFeatureDraft.modules(of: modules))
        let rawPriority = priority.trimmingCharacters(in: .whitespacesAndNewlines)
        if !rawPriority.isEmpty {
            guard let value = Int(rawPriority), HarnessLaunchOptions.priorityRange.contains(value) else { return .failure(.priority) }
            options.priority = value
        }
        let rawBudget = budget.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: ".")
        if !rawBudget.isEmpty {
            guard let value = Double(rawBudget), value.isFinite, value > 0 else { return .failure(.budget) }
            options.budgetUsd = value
        }
        let rawReq = req.trimmingCharacters(in: .whitespacesAndNewlines)
        if !rawReq.isEmpty { options.req = rawReq }
        let labels = Self.labels(of: self.labels)
        guard labels.count <= HarnessLaunchOptions.maxLabels, labels.allSatisfy({ $0.count <= HarnessLaunchOptions.maxLabelLength }) else {
            return .failure(.labels)
        }
        options.kind = kind
        options.labels = labels
        options.autonomy = autonomy
        return .success(options)
    }
}
