// Modèles typés du magasin d'état (S-2 … S-7), en parité champ par champ avec le
// lecteur TypeScript de omp-mem0-req (`asRunningEntry`, `asHistoryEntry`, `asLot`,
// `asLotFeature`, `asProject`, `asProjectFeature`, `asDelivery`, `readAuditRelay`).
//
// Trois règles, les mêmes que dans le dépôt :
//  1. un fichier au schéma incomplet est REJETÉ — jamais rendu partiel ;
//  2. un champ optionnel absent (ou mal typé quand le dépôt le tolère) vaut `nil` ;
//  3. un champ JSON inconnu est ignoré (le lecteur ne lit que ses clés).
// Les commentaires nomment la fonction TypeScript reproduite, pour que la
// relecture se fasse par comparaison et non par confiance.
//
// Les validateurs vivent dans des EXTENSIONS (`init?(json:)`) : une initialisation
// écrite dans le corps d'une structure supprimerait son initialiseur d'ensemble,
// dont les validateurs se servent.

import Darwin
import Foundation

// --- vocabulaire (`PIPELINE_PHASES`, `LOT_FEATURE_STATES`, `LOT_WAIT_KINDS`, …) ---

public enum PipelinePhase: String, CaseIterable, Sendable, Codable {
    case req, specs, impl, review, release
}

public enum PipelineRunState: String, Sendable, Codable {
    case running, waiting
}

public enum PipelineFinalState: String, Sendable, Codable {
    case done, failed
}

public enum LotStatus: String, Sendable, Codable {
    case draft, running
}

public enum LotFeatureState: String, Sendable, Codable {
    case pending, running, waiting, blocked, failed, done, cancelled
}

public enum LotWaitKind: String, Sendable, Codable {
    case answer, specs, review
}

public enum LotOrigin: String, Sendable, Codable {
    case session, panneau
}

public enum HeldLaunchKind: String, Sendable, Codable {
    case collecte, phase, relaunch, answer
}

/// Le verdict de revue publié dans le lot ; hors vocabulaire ⇒ `nil`, jamais un rejet.
public enum ReviewVerdict: String, Sendable, Codable {
    case blockers, clean, unreadable
}

/// `LotFeature.relayKind` : la seule valeur que le dépôt écrit.
public enum ProjectRelayKind: String, Sendable, Codable {
    case project
}

public enum ProjectStatus: String, Sendable, Codable {
    case running, stopped, done
}

public enum ProjectFeatureStatus: String, Sendable, Codable {
    case planned, launched, pr, merged, failed, removed
}

public enum ProjectFailureKind: String, Sendable, Codable {
    case lot, launch, pr
}

/// Bornes reprises du dépôt (`LOT_EDITOR_MAX`, `LOT_PENDING_MAX`, lot.ts:1035-1038)
/// et `PIPELINE_SLOTS_DEFAULT` / `PIPELINE_SLOTS_MAX` (lot.ts:1064-1070).
private let lotEditorMax = 4000
private let lotPendingMax = 9
private let pipelineSlotsDefault = 4
private let pipelineSlotsMax = 32

// --- accès typés au JSON -----------------------------------------------------

/// `typeof value === "string"` : la chaîne VIDE passe.
public func asString(_ value: JSONValue?) -> String? {
    guard case .string(let text)? = value else { return nil }
    return text
}

/// `asStringOrNull` (store.ts:207) : une chaîne non vide seulement.
public func asStringOrNull(_ value: JSONValue?) -> String? {
    guard let text = asString(value), !text.isEmpty else { return nil }
    return text
}

/// `typeof value === "number" && Number.isFinite(value)`. Un JSON ne peut porter
/// ni NaN ni ∞ ; `1e400` y devient ∞ et est donc lu comme non numérique —
/// divergence assumée, sans effet sur un fichier écrit par le dépôt.
public func asNumber(_ value: JSONValue?) -> Double? {
    guard case .number(let number)? = value, number.isFinite else { return nil }
    return number
}

public func asBool(_ value: JSONValue?) -> Bool? {
    guard case .bool(let flag)? = value else { return nil }
    return flag
}

public func asObject(_ value: JSONValue?) -> [String: JSONValue]? {
    guard case .object(let object)? = value else { return nil }
    return object
}

public func asArray(_ value: JSONValue?) -> [JSONValue]? {
    guard case .array(let list)? = value else { return nil }
    return list
}

/// `version !== 1` : le marqueur de schéma, accepté dans sa seule forme numérique.
public func isVersion1(_ value: JSONValue?) -> Bool {
    asNumber(value) == 1
}

/// `Number.isInteger` : `1.0` est entier, `1.5` non.
public func asInteger(_ number: Double) -> Int? {
    guard number.rounded(.towardZero) == number else { return nil }
    return clampedInt(number)
}

/// `Math.trunc` sans dépassement : une valeur hors du domaine d'`Int` sature au
/// lieu de piéger le process (un fichier falsifié ne doit jamais tuer la lecture).
public func clampedInt(_ number: Double) -> Int {
    let truncated = number.rounded(.towardZero)
    if truncated >= Double(Int.max) { return Int.max }
    if truncated <= Double(Int.min) { return Int.min }
    return Int(truncated)
}

/// `max(0, Math.trunc(num(value, 0)))` : un compteur jamais négatif.
public func asCount(_ value: JSONValue?) -> Int {
    guard let number = asNumber(value) else { return 0 }
    return max(0, clampedInt(number))
}

/// Les RUNS : le schéma exige un pid numérique, sans exiger qu'il soit entier —
/// un pid non entier vaut `nil`, donc « propriétaire mort », jamais un rejet
/// (parité `Number.isInteger` dans `pidAlive`, store.ts:187-195).
public func asPid(_ value: JSONValue?) -> Int? {
    guard let number = asNumber(value) else { return nil }
    return asInteger(number)
}

// --- péremption (S-7) --------------------------------------------------------

/// Le pid vit-il (doc §7) ? Seul `ESRCH` veut dire « mort » : `EPERM` (processus
/// d'un autre utilisateur) est VIVANT, sinon on enterrerait des pipelines bien
/// vivantes. Aucun seuil de fraîcheur ici — c'est `isStale` qui le porte.
public func pidAlive(_ pid: Int) -> Bool {
    guard pid > 0 else { return false }
    // Hors du domaine de `pid_t`, `process.kill` de Node refuse la valeur (code
    // d'erreur ≠ ESRCH), donc la même règle dit « vivant ». La borne évite surtout
    // un dépassement de conversion, qui piégerait ce process-ci.
    guard pid <= Int(Int32.max) else { return true }
    if kill(pid_t(pid), 0) == 0 { return true }
    return errno != ESRCH
}

/// `!pidAlive(owner.pid) || now - updatedAt > LOT_OWNER_STALE_MS`.
///
/// Fait du dépôt à connaître : `publishRunning` n'écrit RIEN quand seule la valeur
/// d'`updatedAt` changerait (`samePublished` exclut ce champ, publish.ts:241-275).
/// Un run VIVANT au repos garde donc un `updatedAt` figé : une entrée marquée
/// périmée alors que son pid vit est un cas ATTENDU, pas une anomalie — le
/// marquage est un badge d'affichage.
public func runningIsStale(_ entry: RunningEntry, nowMs: Double) -> Bool {
    guard let pid = entry.ownerPid, pidAlive(pid) else { return true }
    return nowMs - entry.updatedAt > lotOwnerStaleMs
}

/// `lotOwnerAlive` (lot.ts:236-244) : un lot SANS battement (écrit par une version
/// antérieure) garde le pid pour seule autorité, il se lit et se reprend comme avant.
public func lotIsStale(_ lot: Lot, nowMs: Double) -> Bool {
    guard let pid = lot.owner.pid, pidAlive(pid) else { return true }
    guard let beat = lot.owner.heartbeatAt else { return false }
    return nowMs - beat > lotOwnerStaleMs
}

/// Même seuil qu'un propriétaire de lot (`AUDIT_RELAY_STALE_MS`, lot.ts:997).
public func auditRelayIsStale(_ relay: AuditRelay, nowMs: Double) -> Bool {
    guard pidAlive(relay.pid) else { return true }
    return nowMs - relay.heartbeatAt > lotOwnerStaleMs
}

// --- `running/` et `history/` (S-2) ------------------------------------------

/// Une option d'une question `ask` (`PanelAskOption`, store.ts:31).
public struct PanelAskOption: Sendable, Equatable, Codable {
    public var label: String
    /// Optionnelle : une description vide n'est pas rendue (parité `asPendingAsk`).
    public var description: String?

    public init(label: String, description: String?) {
        self.label = label
        self.description = description
    }
}

/// La question `ask` EN VOL d'un run (`PanelPendingAsk`, store.ts:35).
public struct PanelPendingAsk: Sendable, Equatable, Codable {
    public var toolCallId: String
    public var id: String
    public var question: String
    public var options: [PanelAskOption]

    public init(toolCallId: String, id: String, question: String, options: [PanelAskOption]) {
        self.toolCallId = toolCallId
        self.id = id
        self.question = question
        self.options = options
    }
}

/// Entrée `running/<16 hex>.json` (`RunningEntry`, store.ts:40) : une pipeline en
/// cours, écrite par son propriétaire.
public struct RunningEntry: Sendable, Equatable, Codable {
    public var id: String
    public var cwd: String
    public var label: String
    public var phase: PipelinePhase
    public var state: PipelineRunState
    public var phaseStartedAt: Double
    public var updatedAt: Double
    public var sessionFile: String?
    public var sessionId: String?
    /// `owner.pid` aplati. `nil` quand le pid n'est PAS entier : l'entrée n'est pas
    /// rejetée pour autant, elle est périmée (parité `pidAlive`).
    public var ownerPid: Int?
    /// Le chemin de la boîte du run : c'est lui qui dit qu'un run vivant accepte
    /// une écriture. Absent d'un run d'une version antérieure ⇒ `nil`.
    public var inbox: String?
    public var pendingAsk: PanelPendingAsk?
    /// Marquage calculé à la LECTURE : jamais un retrait, jamais une écriture (S-7).
    public var isStale: Bool

    public init(id: String, cwd: String, label: String, phase: PipelinePhase, state: PipelineRunState, phaseStartedAt: Double, updatedAt: Double, sessionFile: String?, sessionId: String?, ownerPid: Int?, inbox: String?, pendingAsk: PanelPendingAsk?, isStale: Bool) {
        self.id = id
        self.cwd = cwd
        self.label = label
        self.phase = phase
        self.state = state
        self.phaseStartedAt = phaseStartedAt
        self.updatedAt = updatedAt
        self.sessionFile = sessionFile
        self.sessionId = sessionId
        self.ownerPid = ownerPid
        self.inbox = inbox
        self.pendingAsk = pendingAsk
        self.isStale = isStale
    }
}

extension RunningEntry {
    /// `asRunningEntry` (store.ts:242-274).
    public init?(json: JSONValue, nowMs: Double) {
        guard case .object(let e) = json, isVersion1(e["version"]) else { return nil }
        guard let id = asString(e["id"]), let cwd = asString(e["cwd"]), let label = asString(e["label"]) else {
            return nil
        }
        guard let phase = PipelinePhase(rawValue: asString(e["phase"]) ?? "") else { return nil }
        guard let state = PipelineRunState(rawValue: asString(e["state"]) ?? "") else { return nil }
        guard let phaseStartedAt = asNumber(e["phaseStartedAt"]), let updatedAt = asNumber(e["updatedAt"]) else {
            return nil
        }
        guard let owner = asObject(e["owner"]), asNumber(owner["pid"]) != nil else { return nil }
        let pendingAsk: PanelPendingAsk?
        switch asPendingAskDecode(e["pendingAsk"]) {
        case .absent: pendingAsk = nil
        case .value(let ask): pendingAsk = ask
        case .invalid: return nil
        }
        // `inbox` : absent ou nul ⇒ nil ; chaîne vide ⇒ nil ; TOUT AUTRE TYPE ⇒ rejet.
        if let raw = e["inbox"], raw != .null, asString(raw) == nil { return nil }
        self.init(
            id: id,
            cwd: cwd,
            label: label,
            phase: phase,
            state: state,
            phaseStartedAt: phaseStartedAt,
            updatedAt: updatedAt,
            sessionFile: asStringOrNull(e["sessionFile"]),
            sessionId: asStringOrNull(e["sessionId"]),
            ownerPid: asPid(owner["pid"]),
            inbox: asStringOrNull(e["inbox"]),
            pendingAsk: pendingAsk,
            isStale: false
        )
        isStale = runningIsStale(self, nowMs: nowMs)
    }
}

/// Entrée `history/<16 hex>.json` (`HistoryEntry`, store.ts:62) : une pipeline
/// close, écrite une seule fois. Jamais marquée périmée : elle est terminée.
public struct HistoryEntry: Sendable, Equatable, Codable {
    public var id: String
    public var cwd: String
    public var label: String
    public var phase: PipelinePhase
    public var finalState: PipelineFinalState
    public var sessionFile: String?
    public var sessionId: String?
    public var phaseStartedAt: Double
    public var endedAt: Double

    public init(id: String, cwd: String, label: String, phase: PipelinePhase, finalState: PipelineFinalState, sessionFile: String?, sessionId: String?, phaseStartedAt: Double, endedAt: Double) {
        self.id = id
        self.cwd = cwd
        self.label = label
        self.phase = phase
        self.finalState = finalState
        self.sessionFile = sessionFile
        self.sessionId = sessionId
        self.phaseStartedAt = phaseStartedAt
        self.endedAt = endedAt
    }
}

extension HistoryEntry {
    /// `asHistoryEntry` (store.ts:276-296).
    public init?(json: JSONValue) {
        guard case .object(let e) = json, isVersion1(e["version"]) else { return nil }
        guard let id = asString(e["id"]), let cwd = asString(e["cwd"]), let label = asString(e["label"]) else {
            return nil
        }
        guard let phase = PipelinePhase(rawValue: asString(e["phase"]) ?? "") else { return nil }
        guard let finalState = PipelineFinalState(rawValue: asString(e["finalState"]) ?? "") else { return nil }
        guard let phaseStartedAt = asNumber(e["phaseStartedAt"]), let endedAt = asNumber(e["endedAt"]) else {
            return nil
        }
        self.init(
            id: id,
            cwd: cwd,
            label: label,
            phase: phase,
            finalState: finalState,
            sessionFile: asStringOrNull(e["sessionFile"]),
            sessionId: asStringOrNull(e["sessionId"]),
            phaseStartedAt: phaseStartedAt,
            endedAt: endedAt
        )
    }
}

/// `asPendingAsk` rend trois choses distinctes (store.ts:217-239) : absent,
/// valide, ou MAL TYPÉ — et le mal typé fait rejeter l'entrée entière.
public enum PendingAskDecode {
    case absent
    case value(PanelPendingAsk)
    case invalid
}

public func asPendingAskDecode(_ raw: JSONValue?) -> PendingAskDecode {
    guard let raw, raw != .null else { return .absent }
    guard case .object(let q) = raw else { return .invalid }
    guard let toolCallId = asString(q["toolCallId"]), !toolCallId.isEmpty else { return .invalid }
    guard let id = asString(q["id"]), let question = asString(q["question"]) else { return .invalid }
    guard let rawOptions = asArray(q["options"]) else { return .invalid }
    var options: [PanelAskOption] = []
    for rawOption in rawOptions {
        guard case .object(let option) = rawOption else { return .invalid }
        guard let label = asString(option["label"]), !label.isEmpty else { return .invalid }
        if let rawDescription = option["description"] {
            // Présente et non textuelle ⇒ rejet (une description `null` aussi).
            guard let description = asString(rawDescription) else { return .invalid }
            options.append(PanelAskOption(label: label, description: description.isEmpty ? nil : description))
        } else {
            options.append(PanelAskOption(label: label, description: nil))
        }
    }
    guard !options.isEmpty else { return .invalid }
    return .value(PanelPendingAsk(toolCallId: toolCallId, id: id, question: question, options: options))
}

// --- `lots/` (S-3) -----------------------------------------------------------

/// Un lancement retenu (`asHeldLaunch`, lot.ts:620-640) : lu TOLÉRAMMENT — absent
/// ou incomplet vaut « absent », jamais un rejet de la feature.
public struct HeldLaunch: Sendable, Equatable, Codable {
    public var phase: PipelinePhase
    public var fix: Bool
    public var kind: HeldLaunchKind
    public var resume: Bool
    public var text: String?

    public init(phase: PipelinePhase, fix: Bool, kind: HeldLaunchKind, resume: Bool, text: String?) {
        self.phase = phase
        self.fix = fix
        self.kind = kind
        self.resume = resume
        self.text = text
    }
}

public func asHeldLaunch(_ raw: JSONValue?) -> HeldLaunch? {
    guard let raw, raw != .null, case .object(let h) = raw else { return nil }
    guard let phase = PipelinePhase(rawValue: asString(h["phase"]) ?? "") else { return nil }
    guard let fix = asBool(h["fix"]), let resume = asBool(h["resume"]) else { return nil }
    guard let kind = HeldLaunchKind(rawValue: asString(h["kind"]) ?? "") else { return nil }
    var text: String?
    if let rawText = h["text"] {
        // Absente, ou chaîne : toute autre valeur rend le lancement inexploitable.
        guard let value = asString(rawText) else { return nil }
        // Rogné à la borne de l'éditeur, comme à l'écriture. `prefix` compte des
        // graphes là où `slice` compte des unités UTF-16 : l'écart ne porte que
        // sur la frontière d'un texte contenant des caractères hors BMP.
        text = String(value.prefix(lotEditorMax))
    }
    return HeldLaunch(phase: phase, fix: fix, kind: kind, resume: resume, text: text)
}

/// `Lot["owner"]` : `pid` numérique exigé (rejet sinon), les deux autres champs
/// par la règle « chaîne ou rien », le battement seulement s'il est fini.
public struct LotOwner: Sendable, Equatable, Codable {
    public var pid: Int?
    public var sessionFile: String?
    public var sessionId: String?
    public var heartbeatAt: Double?

    public init(pid: Int?, sessionFile: String?, sessionId: String?, heartbeatAt: Double?) {
        self.pid = pid
        self.sessionFile = sessionFile
        self.sessionId = sessionId
        self.heartbeatAt = heartbeatAt
    }
}

/// Une feature d'un lot (`asLotFeature`, lot.ts:653-740).
public struct LotFeature: Sendable, Equatable, Codable {
    public var slug: String
    public var name: String
    public var branch: String
    public var worktree: String
    public var deps: [String]
    public var origin: LotOrigin
    public var state: LotFeatureState
    public var phase: PipelinePhase
    public var waitKind: LotWaitKind?
    public var waitPrompt: String?
    public var sessionFile: String?
    public var pendingTexts: [String]
    public var prUrl: String?
    public var stopReason: String?
    public var fixes: Int
    public var reviewRuns: Int
    public var unreadableRuns: Int
    public var reviewHash: String?
    public var lastVerdict: ReviewVerdict?
    public var lastBlockers: Int
    public var lastRunSessionFile: String?
    /// Écrite seulement quand elle vaut `false` : un lot qui ne la porte pas se
    /// relit à l'identique et le garde `!= false` la traite comme lancée.
    public var launched: Bool?
    /// Écrite seulement quand elle porte un chemin ABSOLU.
    public var auditSession: String?
    public var relayKind: ProjectRelayKind?
    public var base: String?
    /// ANCIEN modèle unique, conservé en LECTURE seule (il remplit les deux
    /// groupes tant qu'il existe).
    public var model: String?
    /// Le sélecteur exact du groupe req+specs (`modelReqSpecs` du lot).
    public var modelReqSpecs: String?
    /// Le sélecteur exact du groupe impl+review+release (`modelImplReview`).
    public var modelImplReview: String?
    public var held: HeldLaunch?
    public var contractHash: String?
    public var addedAt: Double
    public var sinceAt: Double
    public var updatedAt: Double
    public var endedAt: Double?

    public init(slug: String, name: String, branch: String, worktree: String, deps: [String], origin: LotOrigin, state: LotFeatureState, phase: PipelinePhase, waitKind: LotWaitKind?, waitPrompt: String?, sessionFile: String?, pendingTexts: [String], prUrl: String?, stopReason: String?, fixes: Int, reviewRuns: Int, unreadableRuns: Int, reviewHash: String?, lastVerdict: ReviewVerdict?, lastBlockers: Int, lastRunSessionFile: String?, launched: Bool?, auditSession: String?, relayKind: ProjectRelayKind?, base: String?, model: String?, modelReqSpecs: String?, modelImplReview: String?, held: HeldLaunch?, contractHash: String?, addedAt: Double, sinceAt: Double, updatedAt: Double, endedAt: Double?) {
        self.slug = slug
        self.name = name
        self.branch = branch
        self.worktree = worktree
        self.deps = deps
        self.origin = origin
        self.state = state
        self.phase = phase
        self.waitKind = waitKind
        self.waitPrompt = waitPrompt
        self.sessionFile = sessionFile
        self.pendingTexts = pendingTexts
        self.prUrl = prUrl
        self.stopReason = stopReason
        self.fixes = fixes
        self.reviewRuns = reviewRuns
        self.unreadableRuns = unreadableRuns
        self.reviewHash = reviewHash
        self.lastVerdict = lastVerdict
        self.lastBlockers = lastBlockers
        self.lastRunSessionFile = lastRunSessionFile
        self.launched = launched
        self.auditSession = auditSession
        self.relayKind = relayKind
        self.base = base
        self.model = model
        self.modelReqSpecs = modelReqSpecs
        self.modelImplReview = modelImplReview
        self.held = held
        self.contractHash = contractHash
        self.addedAt = addedAt
        self.sinceAt = sinceAt
        self.updatedAt = updatedAt
        self.endedAt = endedAt
    }
}

extension LotFeature {
    public init?(json: JSONValue) {
        guard case .object(let f) = json else { return nil }
        // Le FORMAT du slug compte autant que son type : il nomme un répertoire de
        // worktree et sort de la base d'archive, puis sert de `cwd` aux runs.
        guard let slug = asString(f["slug"]), isSlug(slug) else { return nil }
        guard let name = asString(f["name"]), let branch = asString(f["branch"]) else { return nil }
        guard let worktree = asString(f["worktree"]) else { return nil }
        guard let state = LotFeatureState(rawValue: asString(f["state"]) ?? "") else { return nil }
        guard let phase = PipelinePhase(rawValue: asString(f["phase"]) ?? "") else { return nil }
        guard let origin = LotOrigin(rawValue: asString(f["origin"]) ?? "") else { return nil }
        // `waitKind` : la CLÉ doit être là. `null` est valide ; absente ou hors
        // vocabulaire ⇒ rejet (lot.ts:667-673).
        guard let rawWaitKind = f["waitKind"] else { return nil }
        let waitKind: LotWaitKind?
        if rawWaitKind == .null {
            waitKind = nil
        } else if let kind = LotWaitKind(rawValue: asString(rawWaitKind) ?? "") {
            waitKind = kind
        } else {
            return nil
        }
        let deps = asArray(f["deps"])?.compactMap { asString($0) } ?? []
        // La file suit la convention de `deps` : absente ou non tableau vaut `[]`.
        // Les textes vides tombent, l'ordre est conservé, puis la borne et le
        // rognage s'appliquent DANS CET ORDRE (lot.ts:684-690).
        let pendingTexts = asArray(f["pendingTexts"])?
            .compactMap { asString($0) }
            .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .prefix(lotPendingMax)
            .map { String($0.prefix(lotEditorMax)) } ?? []
        self.init(
            slug: slug,
            name: name,
            branch: branch,
            worktree: worktree,
            deps: deps,
            origin: origin,
            state: state,
            phase: phase,
            waitKind: waitKind,
            waitPrompt: asStringOrNull(f["waitPrompt"]),
            sessionFile: asStringOrNull(f["sessionFile"]),
            pendingTexts: pendingTexts,
            prUrl: asStringOrNull(f["prUrl"]),
            stopReason: asStringOrNull(f["stopReason"]),
            fixes: asCount(f["fixes"]),
            reviewRuns: asCount(f["reviewRuns"]),
            unreadableRuns: asCount(f["unreadableRuns"]),
            reviewHash: asStringOrNull(f["reviewHash"]),
            // Un verdict hors vocabulaire est lu comme ABSENT : il ne sert qu'à
            // l'affichage, et un lot amputé ferait disparaître un pipeline entier.
            lastVerdict: ReviewVerdict(rawValue: asString(f["lastVerdict"]) ?? ""),
            lastBlockers: asCount(f["lastBlockers"]),
            lastRunSessionFile: asStringOrNull(f["lastRunSessionFile"]),
            launched: asBool(f["launched"]) == false ? false : nil,
            auditSession: asAbsolutePath(f["auditSession"]),
            relayKind: asString(f["relayKind"]) == ProjectRelayKind.project.rawValue ? .project : nil,
            base: asLotBaseSha(f["base"]),
            model: asNonBlankString(f["model"]),
            modelReqSpecs: asNonBlankString(f["modelReqSpecs"]),
            modelImplReview: asNonBlankString(f["modelImplReview"]),
            held: asHeldLaunch(f["held"]),
            contractHash: asStringOrNull(f["contractHash"]),
            addedAt: asNumber(f["addedAt"]) ?? 0,
            sinceAt: asNumber(f["sinceAt"]) ?? 0,
            updatedAt: asNumber(f["updatedAt"]) ?? 0,
            endedAt: asNumber(f["endedAt"])
        )
    }
}

/// Les deux modèles d'une feature, RÉSOLUS : le groupe req+specs et le groupe
/// impl+review (release comprise). Miroir console de `featureModelSlots`
/// (`omp-mem0-req/models.ts`).
///
/// `resolve` rend `nil` quand la feature ne porte AUCUNE des trois clés — auquel
/// cas l'affichage n'écrit aucune ligne de modèle (patron actuel). L'ancien
/// `model` unique remplit les DEUX groupes tant qu'il existe (AC-4).
public struct ModelSlots: Sendable, Equatable, Codable {
    public var reqSpecs: String?
    public var implReview: String?

    public init(reqSpecs: String?, implReview: String?) {
        self.reqSpecs = reqSpecs
        self.implReview = implReview
    }

    public static func resolve(legacy: String?, reqSpecs: String?, implReview: String?) -> ModelSlots? {
        let req = modelNonBlank(reqSpecs) ?? modelNonBlank(legacy)
        let impl = modelNonBlank(implReview) ?? modelNonBlank(legacy)
        guard req != nil || impl != nil else { return nil }
        return ModelSlots(reqSpecs: req, implReview: impl)
    }
}

/// Une chaîne non blanche, `nil` sinon — la garde de `modelSlotsField`
/// (`models.ts:140-142`), appliquée ici à une valeur déjà décodée.
private func modelNonBlank(_ value: String?) -> String? {
    guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    return value
}

/// Un lot (`asLot`, lot.ts:742-795). `version` n'est pas rendu : c'est un marqueur
/// de schéma, pas un champ du modèle.
public struct Lot: Sendable, Equatable, Codable {
    public var id: String
    public var repoRoot: String
    public var status: LotStatus
    public var reviewCap: Int
    public var slotCap: Int
    public var recapAt: Double?
    public var owner: LotOwner
    public var createdAt: Double
    public var launchedAt: Double?
    public var features: [LotFeature]
    public var isStale: Bool

    public init(id: String, repoRoot: String, status: LotStatus, reviewCap: Int, slotCap: Int, recapAt: Double?, owner: LotOwner, createdAt: Double, launchedAt: Double?, features: [LotFeature], isStale: Bool) {
        self.id = id
        self.repoRoot = repoRoot
        self.status = status
        self.reviewCap = reviewCap
        self.slotCap = slotCap
        self.recapAt = recapAt
        self.owner = owner
        self.createdAt = createdAt
        self.launchedAt = launchedAt
        self.features = features
        self.isStale = isStale
    }
}

extension Lot {
    public init?(json: JSONValue, nowMs: Double) {
        guard case .object(let l) = json, isVersion1(l["version"]) else { return nil }
        guard let id = asString(l["id"]), !id.isEmpty else { return nil }
        guard let repoRoot = asString(l["repoRoot"]), !repoRoot.isEmpty else { return nil }
        guard let status = LotStatus(rawValue: asString(l["status"]) ?? "") else { return nil }
        guard let rawFeatures = asArray(l["features"]) else { return nil }
        // Une feature invalide fait rejeter le lot ENTIER : un lot amputé en
        // silence ferait disparaître un pipeline du panneau et lancerait les runs
        // d'un état que personne n'a écrit (lot.ts:747-757).
        var features: [LotFeature] = []
        for rawFeature in rawFeatures {
            guard let feature = LotFeature(json: rawFeature) else { return nil }
            features.append(feature)
        }
        guard let owner = asObject(l["owner"]), asNumber(owner["pid"]) != nil else { return nil }
        // `reviewCap` : `max(1, trunc(valeur))`, valeur non numérique ⇒ 1.
        let reviewCap = asNumber(l["reviewCap"]).map { max(1, clampedInt($0)) } ?? 1
        // `slotCap` : lu par `envInt(String(valeur), 4, 1, 32)` — un entier borné.
        let slotCap = asNumber(l["slotCap"]).map { min(pipelineSlotsMax, max(1, clampedInt($0))) }
            ?? pipelineSlotsDefault
        self.init(
            id: id,
            repoRoot: repoRoot,
            status: status,
            reviewCap: reviewCap,
            slotCap: slotCap,
            recapAt: asNumber(l["recapAt"]),
            owner: LotOwner(
                pid: asPid(owner["pid"]),
                sessionFile: asStringOrNull(owner["sessionFile"]),
                sessionId: asStringOrNull(owner["sessionId"]),
                heartbeatAt: asNumber(owner["heartbeatAt"])
            ),
            createdAt: asNumber(l["createdAt"]) ?? 0,
            launchedAt: asNumber(l["launchedAt"]),
            features: features,
            isStale: false
        )
        isStale = lotIsStale(self, nowMs: nowMs)
    }
}

// --- `projects/` (S-4) -------------------------------------------------------

/// La base récupérée pour le segment courant (`Project["base"]`).
public struct ProjectBase: Sendable, Equatable, Codable {
    public var segment: Int
    public var sha: String

    public init(segment: Int, sha: String) {
        self.segment = segment
        self.sha = sha
    }
}

/// L'échec d'une feature de projet (`ProjectFailure`, project.ts:32).
public struct ProjectFailure: Sendable, Equatable, Codable {
    public var kind: ProjectFailureKind
    public var reason: String
    public var at: Double

    public init(kind: ProjectFailureKind, reason: String, at: Double) {
        self.kind = kind
        self.reason = reason
        self.at = at
    }
}

/// Une feature d'un projet (`asProjectFeature`, project.ts:110-160).
public struct ProjectFeature: Sendable, Equatable, Codable {
    public var slug: String
    public var intention: String
    /// ANCIEN modèle unique, conservé en LECTURE seule.
    public var model: String?
    /// Le sélecteur exact du groupe req+specs (`modelReqSpecs` du projet).
    public var modelReqSpecs: String? = nil
    /// Le sélecteur exact du groupe impl+review+release (`modelImplReview`).
    public var modelImplReview: String? = nil
    public var status: ProjectFeatureStatus
    public var prUrl: String?
    public var failure: ProjectFailure?
    public var removedReason: String?
    public var updatedAt: Double

    public init(slug: String, intention: String, model: String?, modelReqSpecs: String? = nil, modelImplReview: String? = nil, status: ProjectFeatureStatus, prUrl: String?, failure: ProjectFailure?, removedReason: String?, updatedAt: Double) {
        self.slug = slug
        self.intention = intention
        self.model = model
        self.modelReqSpecs = modelReqSpecs
        self.modelImplReview = modelImplReview
        self.status = status
        self.prUrl = prUrl
        self.failure = failure
        self.removedReason = removedReason
        self.updatedAt = updatedAt
    }
}

extension ProjectFeature {
    public init?(json: JSONValue) {
        guard case .object(let f) = json else { return nil }
        guard let slug = asString(f["slug"]), isSlug(slug) else { return nil }
        guard let intention = asString(f["intention"]) else { return nil }
        guard let status = ProjectFeatureStatus(rawValue: asString(f["status"]) ?? "") else { return nil }
        // `prUrl` : la CLÉ doit être présente et valoir `null` ou une chaîne (une
        // chaîne vide est une chaîne).
        guard let rawPrUrl = f["prUrl"], rawPrUrl == .null || asString(rawPrUrl) != nil else { return nil }
        guard let rawFailure = f["failure"] else { return nil }
        var failure: ProjectFailure?
        if rawFailure != .null {
            guard case .object(let r) = rawFailure else { return nil }
            guard let kind = ProjectFailureKind(rawValue: asString(r["kind"]) ?? "") else { return nil }
            guard let reason = asString(r["reason"]), let at = asNumber(r["at"]) else { return nil }
            failure = ProjectFailure(kind: kind, reason: reason, at: at)
        }
        guard let rawRemoved = f["removedReason"],
              rawRemoved == .null || asString(rawRemoved) != nil else { return nil }
        guard let updatedAt = asNumber(f["updatedAt"]) else { return nil }
        // Les invariants du modèle : un échec sans motif, ou un motif sans échec,
        // est un fichier que personne n'a écrit — il se lit comme absent.
        guard (status == .failed) == (failure != nil) else { return nil }
        guard (status == .removed) == (asString(rawRemoved) != nil) else { return nil }
        self.init(
            slug: slug,
            intention: intention,
            model: asNonBlankString(f["model"]),
            modelReqSpecs: asNonBlankString(f["modelReqSpecs"]),
            modelImplReview: asNonBlankString(f["modelImplReview"]),
            status: status,
            prUrl: asString(rawPrUrl),
            failure: failure,
            removedReason: asString(rawRemoved),
            updatedAt: updatedAt
        )
    }
}

/// Un segment du plan (`ProjectSegment`).
public struct ProjectSegment: Sendable, Equatable, Codable {
    public var name: String
    public var features: [ProjectFeature]

    public init(name: String, features: [ProjectFeature]) {
        self.name = name
        self.features = features
    }
}

/// Un projet (`asProject`, project.ts:166-217). `version` n'est pas rendu.
public struct Project: Sendable, Equatable, Codable {
    public var repoKey: String
    public var repoRoot: String
    public var relayKey: String
    public var purpose: String
    public var function: String
    public var status: ProjectStatus
    public var segments: [ProjectSegment]
    public var current: Int
    public var base: ProjectBase?
    public var hostSession: String?
    public var createdAt: Double
    public var updatedAt: Double

    public init(repoKey: String, repoRoot: String, relayKey: String, purpose: String, function: String, status: ProjectStatus, segments: [ProjectSegment], current: Int, base: ProjectBase?, hostSession: String?, createdAt: Double, updatedAt: Double) {
        self.repoKey = repoKey
        self.repoRoot = repoRoot
        self.relayKey = relayKey
        self.purpose = purpose
        self.function = function
        self.status = status
        self.segments = segments
        self.current = current
        self.base = base
        self.hostSession = hostSession
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

extension Project {
    public init?(json: JSONValue) {
        guard case .object(let p) = json, isVersion1(p["version"]) else { return nil }
        guard let repoKey = asString(p["repoKey"]), !repoKey.isEmpty else { return nil }
        guard let repoRoot = asString(p["repoRoot"]), !repoRoot.isEmpty else { return nil }
        // `relayKey` est une CLÉ de relais : le dépôt la veut ABSOLUE.
        guard let relayKey = asString(p["relayKey"]), relayKey.hasPrefix("/") else { return nil }
        guard let purpose = asString(p["purpose"]), let function = asString(p["function"]) else { return nil }
        guard let status = ProjectStatus(rawValue: asString(p["status"]) ?? "") else { return nil }
        // Un projet à zéro segment est REJETÉ (parité), pas rendu vide.
        guard let rawSegments = asArray(p["segments"]), !rawSegments.isEmpty else { return nil }
        var segments: [ProjectSegment] = []
        for rawSegment in rawSegments {
            guard case .object(let s) = rawSegment else { return nil }
            guard let name = asString(s["name"]), let rawFeatures = asArray(s["features"]) else { return nil }
            var features: [ProjectFeature] = []
            for rawFeature in rawFeatures {
                guard let feature = ProjectFeature(json: rawFeature) else { return nil }
                features.append(feature)
            }
            segments.append(ProjectSegment(name: name, features: features))
        }
        guard let rawCurrent = asNumber(p["current"]), let current = asInteger(rawCurrent) else { return nil }
        guard current >= 0, current < segments.count else { return nil }
        // `base` : la clé doit être présente et valoir `null` ou un objet complet.
        guard let rawBase = p["base"] else { return nil }
        var base: ProjectBase?
        if rawBase != .null {
            guard case .object(let b) = rawBase else { return nil }
            guard let rawSegment = asNumber(b["segment"]), let segment = asInteger(rawSegment) else { return nil }
            guard let sha = asLotBaseSha(b["sha"]) else { return nil }
            base = ProjectBase(segment: segment, sha: sha)
        }
        // `hostSession` : la clé doit être présente et valoir `null` ou une chaîne.
        guard let rawHost = p["hostSession"], rawHost == .null || asString(rawHost) != nil else { return nil }
        guard let createdAt = asNumber(p["createdAt"]), let updatedAt = asNumber(p["updatedAt"]) else { return nil }
        self.init(
            repoKey: repoKey,
            repoRoot: repoRoot,
            relayKey: relayKey,
            purpose: purpose,
            function: function,
            status: status,
            segments: segments,
            current: current,
            base: base,
            hostSession: asString(rawHost),
            createdAt: createdAt,
            updatedAt: updatedAt
        )
    }
}

// --- `inbox/` (S-5) ----------------------------------------------------------

/// La réponse retenue d'une question `ask` : exactement l'un des deux champs.
public enum PanelDeliveryAnswer: Sendable, Equatable {
    case selected(String)
    case custom(String)
}

// `Codable` ÉCRIT À LA MAIN : ces deux énumérations portent des valeurs
// associées, que le compilateur ne synthétise pas. La forme retenue est celle du
// dépôt (`selected`/`custom`, `text`/`askAnswer`), pour que la charge utile de
// l'API distante reste lisible par un client qui n'est pas Swift.
extension PanelDeliveryAnswer: Codable {
    private enum Kind: String, CodingKey { case selected, custom }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Kind.self)
        if let value = try container.decodeIfPresent(String.self, forKey: .selected) {
            self = .selected(value)
            return
        }
        if let value = try container.decodeIfPresent(String.self, forKey: .custom) {
            self = .custom(value)
            return
        }
        throw DecodingError.dataCorrupted(
            .init(codingPath: decoder.codingPath, debugDescription: "réponse ni selected ni custom")
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Kind.self)
        switch self {
        case .selected(let value): try container.encode(value, forKey: .selected)
        case .custom(let value): try container.encode(value, forKey: .custom)
        }
    }
}

/// Une livraison déposée dans la boîte d'un run (`PanelDelivery`, store.ts:337).
///
/// `sentAt` n'est pas porté : il n'est jamais un critère de forme (le dépôt le
/// ramène à 0 quand il est illisible), et l'ordre chronologique vient du NOM du
/// fichier, pas de ce champ.
public enum PanelDelivery: Sendable, Equatable {
    case text(String)
    case askAnswer(toolCallId: String, answer: PanelDeliveryAnswer)
}

extension PanelDelivery: Codable {
    private enum Kind: String, CodingKey { case text, askAnswer }
    private enum AskKeys: String, CodingKey { case toolCallId, answer }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Kind.self)
        if let text = try container.decodeIfPresent(String.self, forKey: .text) {
            self = .text(text)
            return
        }
        if container.contains(.askAnswer) {
            let ask = try container.nestedContainer(keyedBy: AskKeys.self, forKey: .askAnswer)
            let toolCallId = try ask.decode(String.self, forKey: .toolCallId)
            let answer = try ask.decode(PanelDeliveryAnswer.self, forKey: .answer)
            self = .askAnswer(toolCallId: toolCallId, answer: answer)
            return
        }
        throw DecodingError.dataCorrupted(
            .init(codingPath: decoder.codingPath, debugDescription: "livraison ni text ni askAnswer")
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Kind.self)
        switch self {
        case .text(let value):
            try container.encode(value, forKey: .text)
        case .askAnswer(let toolCallId, let answer):
            var ask = container.nestedContainer(keyedBy: AskKeys.self, forKey: .askAnswer)
            try ask.encode(toolCallId, forKey: .toolCallId)
            try ask.encode(answer, forKey: .answer)
        }
    }
}

/// `asDelivery` (store.ts:439-465). `nil` = fichier illisible ou de forme
/// inconnue : l'entrée est CONSERVÉE par l'appelant, jamais devinée.
public func asDelivery(_ raw: JSONValue?) -> PanelDelivery? {
    guard let raw, case .object(let d) = raw, isVersion1(d["version"]) else { return nil }
    if asString(d["kind"]) == "text" {
        guard let text = asString(d["text"]), !text.isEmpty else { return nil }
        return .text(text)
    }
    guard asString(d["kind"]) == "ask" else { return nil }
    guard let toolCallId = asString(d["toolCallId"]), !toolCallId.isEmpty else { return nil }
    let selected = asStringOrNull(d["selected"])
    let custom = asStringOrNull(d["custom"])
    // Exactement l'un des deux : un fichier qui porte les deux n'est pas une
    // réponse, c'est une forme inconnue — elle est ignorée, jamais devinée.
    switch (selected, custom) {
    case (.some(let value), nil): return .askAnswer(toolCallId: toolCallId, answer: .selected(value))
    case (nil, .some(let value)): return .askAnswer(toolCallId: toolCallId, answer: .custom(value))
    default: return nil
    }
}

/// Une livraison relue : `payload == nil` quand le fichier est illisible ou de
/// forme inconnue — l'entrée est rendue quand même, avec son nom de fichier.
public struct InboxDelivery: Sendable, Equatable, Codable {
    /// Chemin ABSOLU du fichier (parité `readDeliveries`, store.ts:467-482).
    public var file: String
    public var payload: PanelDelivery?

    public init(file: String, payload: PanelDelivery?) {
        self.file = file
        self.payload = payload
    }
}

/// La boîte d'un run (`inbox/<runId>-<n>/`), ses livraisons dans l'ordre
/// chronologique des noms de fichiers.
public struct InboxBox: Sendable, Equatable, Codable {
    public var name: String
    public var path: String
    public var deliveries: [InboxDelivery]

    public init(name: String, path: String, deliveries: [InboxDelivery]) {
        self.name = name
        self.path = path
        self.deliveries = deliveries
    }
}

// --- `audit/` (S-6) ----------------------------------------------------------

/// Le battement d'une session de relais armée (`AuditRelayRecord`, store.ts:394).
///
/// Écart assumé avec `readAuditRelay` : celle-ci compare en plus le chemin résolu
/// de `sessionFile` à la session DEMANDÉE (garde d'appel par session). Sur un
/// balayage de répertoire il n'y a pas de session demandée : la clé d'identité est
/// le NOM du fichier (`sha1(sessionFile)[:16]`, store.ts:404), et les autres règles
/// champ par champ sont reproduites telles quelles.
public struct AuditRelay: Sendable, Equatable, Codable {
    /// Le nom du fichier sans `.json`.
    public var id: String
    public var sessionFile: String
    public var pid: Int
    public var heartbeatAt: Double
    public var isStale: Bool

    public init(id: String, sessionFile: String, pid: Int, heartbeatAt: Double, isStale: Bool) {
        self.id = id
        self.sessionFile = sessionFile
        self.pid = pid
        self.heartbeatAt = heartbeatAt
        self.isStale = isStale
    }
}

extension AuditRelay {
    /// `readAuditRelay` (store.ts:411-420).
    public init?(json: JSONValue, id: String, nowMs: Double) {
        guard case .object(let r) = json, isVersion1(r["version"]) else { return nil }
        guard let sessionFile = asString(r["sessionFile"]), !sessionFile.isEmpty else { return nil }
        guard let rawPid = asNumber(r["pid"]), let pid = asInteger(rawPid), pid > 0 else { return nil }
        guard let heartbeatAt = asNumber(r["heartbeatAt"]) else { return nil }
        self.init(id: id, sessionFile: sessionFile, pid: pid, heartbeatAt: heartbeatAt, isStale: false)
        isStale = auditRelayIsStale(self, nowMs: nowMs)
    }
}

// --- petits prédicats de forme (parité avec les expressions régulières du dépôt)

/// `^[a-z0-9][a-z0-9-]*$` (lot.ts:658, project.ts:115).
public func isSlug(_ text: String) -> Bool {
    guard let first = text.first, first.isASCII, first.isNumber || first.isLowercase else { return false }
    for character in text.dropFirst() {
        if character == "-" { continue }
        guard character.isASCII, character.isNumber || character.isLowercase else { return false }
    }
    return true
}

/// `isLotBaseSha` (lot.ts:647-649) : 40 hexadécimaux minuscules (SHA-1) ou 64
/// (SHA-256) — la seule forme que le lot écrit et relit.
public func asLotBaseSha(_ value: JSONValue?) -> String? {
    guard let text = asString(value), text.count == 40 || text.count == 64 else { return nil }
    for character in text where !isLowerHex(character) { return nil }
    return text
}

/// Une chaîne non blanche : `typeof v === "string" && v.trim() !== ""`.
public func asNonBlankString(_ value: JSONValue?) -> String? {
    guard let text = asString(value) else { return nil }
    return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : text
}

/// Un chemin absolu : `path.isAbsolute`.
public func asAbsolutePath(_ value: JSONValue?) -> String? {
    guard let text = asString(value), text.hasPrefix("/") else { return nil }
    return text
}

public func isLowerHex(_ character: Character) -> Bool {
    (character >= "0" && character <= "9") || (character >= "a" && character <= "f")
}
