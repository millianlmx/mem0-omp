// Les audits lancés depuis la section Audit (audit-panel-in-omp-console S-5) :
// l'enregistrement `<stateDir>/audits/<id>.json` écrit par le service OMP, et les
// décisions de l'arbitre relues du journal `<stateDir>/journal/<repoKey>.jsonl`.
//
// Mêmes noms et mêmes champs que les formes TypeScript du service
// (`omp-mem0-req/auditRecord.ts`, `omp-mem0-req/context.ts`). Le décodage depuis
// le disque est TOLÉRANT au sens du dépôt : un enregistrement d'une autre version
// ou dont un champ obligatoire est invalide se lit comme absent (`asAudit`,
// auditRecord.ts:133-181) — c'est le lecteur qui le range dans
// `discardedEntries`. `Codable` synthétisé sert au transport (trame `store`).
//
// VIT DANS `ConsoleCore` : la coque macOS et l'app iOS lisent les mêmes types.

import Foundation

/// L'état d'un audit (`AuditStatus`). Transitions permises côté service :
/// analysing → proposed | failed | stopped ; proposed → launched | stopped ;
/// launched → stopped ; failed → stopped.
public enum AuditStatus: String, CaseIterable, Sendable, Codable {
    case analysing, proposed, launched, stopped, failed
}

/// La sorte d'une proposition : une faiblesse relevée ou une feature proposée.
public enum AuditProposalKind: String, Sendable, Codable {
    case weakness, feature
}

/// Une proposition de l'analyse (`AuditProposalElement`).
public struct AuditProposalElement: Sendable, Equatable, Codable {
    public var kind: AuditProposalKind
    public var slug: String
    public var intention: String
    public var deps: [String]

    public init(kind: AuditProposalKind, slug: String, intention: String, deps: [String]) {
        self.kind = kind
        self.slug = slug
        self.intention = intention
        self.deps = deps
    }

    /// `asProposalElement` (auditRecord.ts:105-112).
    public init?(json: JSONValue) {
        guard let e = asObject(json) else { return nil }
        guard let kind = AuditProposalKind(rawValue: asString(e["kind"]) ?? "") else { return nil }
        guard let slug = asString(e["slug"]), !slug.isEmpty, let intention = asString(e["intention"]) else { return nil }
        guard let deps = auditStrings(e["deps"]) else { return nil }
        self.init(kind: kind, slug: slug, intention: intention, deps: deps)
    }
}

/// Les propositions enregistrées par `audit_report` et le brief à relire.
public struct AuditProposal: Sendable, Equatable, Codable {
    public var elements: [AuditProposalElement]
    public var briefDraft: String

    public init(elements: [AuditProposalElement], briefDraft: String) {
        self.elements = elements
        self.briefDraft = briefDraft
    }
}

/// L'issue du lancement d'UNE proposition cochée (`AuditLaunchOutcome`), puis
/// son dernier état connu, recopié par le suivi du service.
public struct AuditLaunchOutcome: Sendable, Equatable, Codable {
    public var slug: String
    public var launched: Bool
    /// Le motif quand `launched == false`.
    public var reason: String?
    public var state: LotFeatureState?
    public var phase: PipelinePhase?
    public var prUrl: String?

    public init(slug: String, launched: Bool, reason: String?, state: LotFeatureState?, phase: PipelinePhase?, prUrl: String?) {
        self.slug = slug
        self.launched = launched
        self.reason = reason
        self.state = state
        self.phase = phase
        self.prUrl = prUrl
    }

    /// `asLaunchOutcome` (auditRecord.ts:115-126) : chaque champ facultatif doit
    /// être PRÉSENT, `null` ou du bon type — une clé manquante rejette l'issue.
    public init?(json: JSONValue) {
        guard let o = asObject(json) else { return nil }
        guard let slug = asString(o["slug"]), !slug.isEmpty, let launched = asBool(o["launched"]) else { return nil }
        guard let reason = auditNullable(o["reason"], asString) else { return nil }
        guard let prUrl = auditNullable(o["prUrl"], asString) else { return nil }
        guard let state = auditNullable(o["state"], { LotFeatureState(rawValue: asString($0) ?? "") }) else { return nil }
        guard let phase = auditNullable(o["phase"], { PipelinePhase(rawValue: asString($0) ?? "") }) else { return nil }
        self.init(slug: slug, launched: launched, reason: reason, state: state, phase: phase, prUrl: prUrl)
    }
}

/// Un audit (`AuditRecord`). `version` n'est pas rendu : c'est un marqueur de
/// schéma, pas un champ du modèle.
public struct AuditRecord: Sendable, Equatable, Codable, Identifiable {
    /// 16 hexadécimaux : c'est aussi le nom du fichier.
    public var id: String
    public var repoRoot: String
    /// `lotRepoKey(repoRoot)` : le nom du journal du dépôt.
    public var repoKey: String
    /// `<stateDir>/audits/<id>` : la clé de contexte que portent les features
    /// lancées (`LotFeature.auditSession`) et les décisions (`context`).
    public var key: String
    public var orientation: String
    public var status: AuditStatus
    public var createdAt: Double
    public var updatedAt: Double
    public var proposal: AuditProposal?
    public var launches: [AuditLaunchOutcome]
    /// Texte brut, seulement pour `status == .failed`.
    public var failure: String?

    public init(id: String, repoRoot: String, repoKey: String, key: String, orientation: String, status: AuditStatus, createdAt: Double, updatedAt: Double, proposal: AuditProposal?, launches: [AuditLaunchOutcome], failure: String?) {
        self.id = id
        self.repoRoot = repoRoot
        self.repoKey = repoKey
        self.key = key
        self.orientation = orientation
        self.status = status
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.proposal = proposal
        self.launches = launches
        self.failure = failure
    }

    /// `asAudit` (auditRecord.ts:133-181) : une proposition ou une issue
    /// invalide rejette l'audit entier, comme côté service.
    public init?(json: JSONValue) {
        guard let a = asObject(json), isVersion1(a["version"]) else { return nil }
        guard let id = asString(a["id"]), isAuditId(id) else { return nil }
        guard let repoRoot = asString(a["repoRoot"]), !repoRoot.isEmpty else { return nil }
        guard let repoKey = asString(a["repoKey"]), !repoKey.isEmpty else { return nil }
        guard let key = asAbsolutePath(a["key"]) else { return nil }
        guard let orientation = asString(a["orientation"]) else { return nil }
        guard let status = AuditStatus(rawValue: asString(a["status"]) ?? "") else { return nil }
        guard let createdAt = asNumber(a["createdAt"]), let updatedAt = asNumber(a["updatedAt"]) else { return nil }
        var proposal: AuditProposal?
        if a["proposal"] != .null {
            guard let p = asObject(a["proposal"]), let rawElements = asArray(p["elements"]),
                  let briefDraft = asString(p["briefDraft"]) else { return nil }
            var elements: [AuditProposalElement] = []
            for rawElement in rawElements {
                guard let element = AuditProposalElement(json: rawElement) else { return nil }
                elements.append(element)
            }
            proposal = AuditProposal(elements: elements, briefDraft: briefDraft)
        }
        guard let rawLaunches = asArray(a["launches"]) else { return nil }
        var launches: [AuditLaunchOutcome] = []
        for rawLaunch in rawLaunches {
            guard let launch = AuditLaunchOutcome(json: rawLaunch) else { return nil }
            launches.append(launch)
        }
        guard let failure = auditNullable(a["failure"], asString) else { return nil }
        self.init(id: id, repoRoot: repoRoot, repoKey: repoKey, key: key, orientation: orientation, status: status, createdAt: createdAt, updatedAt: updatedAt, proposal: proposal, launches: launches, failure: failure)
    }
}

/// D'où vient une décision d'audit : déjà tranchée par le contexte (brief,
/// journal) ou tranchée par l'arbitre. Les décisions de l'utilisateur
/// (`utilisateur`) ne sont pas des décisions de l'arbitre : le lecteur les écarte.
public enum AuditDecisionSource: String, Sendable, Codable {
    case contexte, arbitrage
}

/// La sorte d'une entrée de journal (`JournalKind`, context.ts:14).
public enum AuditDecisionKind: String, Sendable, Codable {
    case question, jalon, quota
}

/// Une décision prise par l'arbitre au nom de l'utilisateur, dans le contexte
/// d'UN audit (une ligne du journal du dépôt dont `context` est la clé de cet
/// audit).
public struct AuditDecision: Sendable, Equatable, Codable {
    public var auditId: String
    public var slug: String
    public var phase: PipelinePhase
    public var kind: AuditDecisionKind
    public var question: String
    public var answer: String
    public var source: AuditDecisionSource
    public var at: Double

    public init(auditId: String, slug: String, phase: PipelinePhase, kind: AuditDecisionKind, question: String, answer: String, source: AuditDecisionSource, at: Double) {
        self.auditId = auditId
        self.slug = slug
        self.phase = phase
        self.kind = kind
        self.question = question
        self.answer = answer
        self.source = source
        self.at = at
    }

    /// Une ligne de journal (`asEntry`, context.ts:277-296) rendue en décision de
    /// l'audit dont la clé est `context` : `nil` pour une ligne invalide, une
    /// ligne d'un autre contexte, ou une décision de l'utilisateur.
    /// `auditIdByKey` : clé de contexte → id d'audit.
    public init?(journalLine json: JSONValue, auditIdByKey: [String: String]) {
        guard let r = asObject(json), isVersion1(r["version"]) else { return nil }
        guard let at = asNumber(r["at"]), let slug = asString(r["slug"]) else { return nil }
        guard let phase = PipelinePhase(rawValue: asString(r["phase"]) ?? "") else { return nil }
        guard let kind = AuditDecisionKind(rawValue: asString(r["kind"]) ?? "") else { return nil }
        guard let question = asString(r["question"]), let answer = asString(r["answer"]) else { return nil }
        guard let source = AuditDecisionSource(rawValue: asString(r["source"]) ?? "") else { return nil }
        guard let context = asString(r["context"]), let auditId = auditIdByKey[context] else { return nil }
        self.init(auditId: auditId, slug: slug, phase: phase, kind: kind, question: question, answer: answer, source: source, at: at)
    }
}

/// La décision d'un jalon escaladé (specs ou revue) : valider ou abandonner.
public enum AuditMilestoneDecision: String, Sendable, Codable {
    case approve, abandon
}

/// `^[0-9a-f]{16}$` : un identifiant d'audit, et un `repoKey` (`lotRepoKey`).
public func isAuditId(_ text: String) -> Bool {
    text.count == 16 && text.allSatisfy(isLowerHex)
}

/// Une liste de chaînes, tout ou rien (`Array.isArray && every(string)`).
private func auditStrings(_ value: JSONValue?) -> [String]? {
    guard let list = asArray(value) else { return nil }
    var out: [String] = []
    for item in list {
        guard let text = asString(item) else { return nil }
        out.append(text)
    }
    return out
}

/// Un champ PRÉSENT qui vaut `null` ou une valeur décodable : `.some(nil)` pour
/// `null`, `.some(valeur)` sinon ; `nil` (rejet) pour une clé absente ou une valeur
/// mal typée — la règle `x !== null && typeof x !== …` du service.
private func auditNullable<T>(_ value: JSONValue?, _ decode: (JSONValue?) -> T?) -> T?? {
    guard let value else { return nil }
    if value == .null { return .some(nil) }
    guard let decoded = decode(value) else { return nil }
    return .some(decoded)
}
