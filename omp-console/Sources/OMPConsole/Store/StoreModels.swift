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

enum PipelinePhase: String, CaseIterable, Sendable {
    case req, specs, impl, review, release
}

enum PipelineRunState: String, Sendable {
    case running, waiting
}

enum PipelineFinalState: String, Sendable {
    case done, failed
}

enum LotStatus: String, Sendable {
    case draft, running
}

enum LotFeatureState: String, Sendable {
    case pending, running, waiting, blocked, failed, done, cancelled
}

enum LotWaitKind: String, Sendable {
    case answer, specs, review
}

enum LotOrigin: String, Sendable {
    case session, panneau
}

enum HeldLaunchKind: String, Sendable {
    case collecte, phase, relaunch, answer
}

/// Le verdict de revue publié dans le lot ; hors vocabulaire ⇒ `nil`, jamais un rejet.
enum ReviewVerdict: String, Sendable {
    case blockers, clean, unreadable
}

/// `LotFeature.relayKind` : la seule valeur que le dépôt écrit.
enum ProjectRelayKind: String, Sendable {
    case project
}

enum ProjectStatus: String, Sendable {
    case running, stopped, done
}

enum ProjectFeatureStatus: String, Sendable {
    case planned, launched, pr, merged, failed, removed
}

enum ProjectFailureKind: String, Sendable {
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
func asString(_ value: JSONValue?) -> String? {
    guard case .string(let text)? = value else { return nil }
    return text
}

/// `asStringOrNull` (store.ts:207) : une chaîne non vide seulement.
func asStringOrNull(_ value: JSONValue?) -> String? {
    guard let text = asString(value), !text.isEmpty else { return nil }
    return text
}

/// `typeof value === "number" && Number.isFinite(value)`. Un JSON ne peut porter
/// ni NaN ni ∞ ; `1e400` y devient ∞ et est donc lu comme non numérique —
/// divergence assumée, sans effet sur un fichier écrit par le dépôt.
func asNumber(_ value: JSONValue?) -> Double? {
    guard case .number(let number)? = value, number.isFinite else { return nil }
    return number
}

func asBool(_ value: JSONValue?) -> Bool? {
    guard case .bool(let flag)? = value else { return nil }
    return flag
}

func asObject(_ value: JSONValue?) -> [String: JSONValue]? {
    guard case .object(let object)? = value else { return nil }
    return object
}

func asArray(_ value: JSONValue?) -> [JSONValue]? {
    guard case .array(let list)? = value else { return nil }
    return list
}

/// `version !== 1` : le marqueur de schéma, accepté dans sa seule forme numérique.
func isVersion1(_ value: JSONValue?) -> Bool {
    asNumber(value) == 1
}

/// `Number.isInteger` : `1.0` est entier, `1.5` non.
func asInteger(_ number: Double) -> Int? {
    guard number.rounded(.towardZero) == number else { return nil }
    return clampedInt(number)
}

/// `Math.trunc` sans dépassement : une valeur hors du domaine d'`Int` sature au
/// lieu de piéger le process (un fichier falsifié ne doit jamais tuer la lecture).
func clampedInt(_ number: Double) -> Int {
    let truncated = number.rounded(.towardZero)
    if truncated >= Double(Int.max) { return Int.max }
    if truncated <= Double(Int.min) { return Int.min }
    return Int(truncated)
}

/// `max(0, Math.trunc(num(value, 0)))` : un compteur jamais négatif.
func asCount(_ value: JSONValue?) -> Int {
    guard let number = asNumber(value) else { return 0 }
    return max(0, clampedInt(number))
}

/// Les RUNS : le schéma exige un pid numérique, sans exiger qu'il soit entier —
/// un pid non entier vaut `nil`, donc « propriétaire mort », jamais un rejet
/// (parité `Number.isInteger` dans `pidAlive`, store.ts:187-195).
func asPid(_ value: JSONValue?) -> Int? {
    guard let number = asNumber(value) else { return nil }
    return asInteger(number)
}

// --- péremption (S-7) --------------------------------------------------------

/// Le pid vit-il (doc §7) ? Seul `ESRCH` veut dire « mort » : `EPERM` (processus
/// d'un autre utilisateur) est VIVANT, sinon on enterrerait des pipelines bien
/// vivantes. Aucun seuil de fraîcheur ici — c'est `isStale` qui le porte.
func pidAlive(_ pid: Int) -> Bool {
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
func runningIsStale(_ entry: RunningEntry, nowMs: Double) -> Bool {
    guard let pid = entry.ownerPid, pidAlive(pid) else { return true }
    return nowMs - entry.updatedAt > lotOwnerStaleMs
}

/// `lotOwnerAlive` (lot.ts:236-244) : un lot SANS battement (écrit par une version
/// antérieure) garde le pid pour seule autorité, il se lit et se reprend comme avant.
func lotIsStale(_ lot: Lot, nowMs: Double) -> Bool {
    guard let pid = lot.owner.pid, pidAlive(pid) else { return true }
    guard let beat = lot.owner.heartbeatAt else { return false }
    return nowMs - beat > lotOwnerStaleMs
}

/// Même seuil qu'un propriétaire de lot (`AUDIT_RELAY_STALE_MS`, lot.ts:997).
func auditRelayIsStale(_ relay: AuditRelay, nowMs: Double) -> Bool {
    guard pidAlive(relay.pid) else { return true }
    return nowMs - relay.heartbeatAt > lotOwnerStaleMs
}

// --- `running/` et `history/` (S-2) ------------------------------------------

/// Une option d'une question `ask` (`PanelAskOption`, store.ts:31).
struct PanelAskOption: Sendable, Equatable {
    var label: String
    /// Optionnelle : une description vide n'est pas rendue (parité `asPendingAsk`).
    var description: String?
}

/// La question `ask` EN VOL d'un run (`PanelPendingAsk`, store.ts:35).
struct PanelPendingAsk: Sendable, Equatable {
    var toolCallId: String
    var id: String
    var question: String
    var options: [PanelAskOption]
}

/// Entrée `running/<16 hex>.json` (`RunningEntry`, store.ts:40) : une pipeline en
/// cours, écrite par son propriétaire.
struct RunningEntry: Sendable, Equatable {
    var id: String
    var cwd: String
    var label: String
    var phase: PipelinePhase
    var state: PipelineRunState
    var phaseStartedAt: Double
    var updatedAt: Double
    var sessionFile: String?
    var sessionId: String?
    /// `owner.pid` aplati. `nil` quand le pid n'est PAS entier : l'entrée n'est pas
    /// rejetée pour autant, elle est périmée (parité `pidAlive`).
    var ownerPid: Int?
    /// Le chemin de la boîte du run : c'est lui qui dit qu'un run vivant accepte
    /// une écriture. Absent d'un run d'une version antérieure ⇒ `nil`.
    var inbox: String?
    var pendingAsk: PanelPendingAsk?
    /// Marquage calculé à la LECTURE : jamais un retrait, jamais une écriture (S-7).
    var isStale: Bool
}

extension RunningEntry {
    /// `asRunningEntry` (store.ts:242-274).
    init?(json: JSONValue, nowMs: Double) {
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
struct HistoryEntry: Sendable, Equatable {
    var id: String
    var cwd: String
    var label: String
    var phase: PipelinePhase
    var finalState: PipelineFinalState
    var sessionFile: String?
    var sessionId: String?
    var phaseStartedAt: Double
    var endedAt: Double
}

extension HistoryEntry {
    /// `asHistoryEntry` (store.ts:276-296).
    init?(json: JSONValue) {
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
enum PendingAskDecode {
    case absent
    case value(PanelPendingAsk)
    case invalid
}

func asPendingAskDecode(_ raw: JSONValue?) -> PendingAskDecode {
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
struct HeldLaunch: Sendable, Equatable {
    var phase: PipelinePhase
    var fix: Bool
    var kind: HeldLaunchKind
    var resume: Bool
    var text: String?
}

func asHeldLaunch(_ raw: JSONValue?) -> HeldLaunch? {
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
struct LotOwner: Sendable, Equatable {
    var pid: Int?
    var sessionFile: String?
    var sessionId: String?
    var heartbeatAt: Double?
}

/// Une feature d'un lot (`asLotFeature`, lot.ts:653-740).
struct LotFeature: Sendable, Equatable {
    var slug: String
    var name: String
    var branch: String
    var worktree: String
    var deps: [String]
    var origin: LotOrigin
    var state: LotFeatureState
    var phase: PipelinePhase
    var waitKind: LotWaitKind?
    var waitPrompt: String?
    var sessionFile: String?
    var pendingTexts: [String]
    var prUrl: String?
    var stopReason: String?
    var fixes: Int
    var reviewRuns: Int
    var unreadableRuns: Int
    var reviewHash: String?
    var lastVerdict: ReviewVerdict?
    var lastBlockers: Int
    var lastRunSessionFile: String?
    /// Écrite seulement quand elle vaut `false` : un lot qui ne la porte pas se
    /// relit à l'identique et le garde `!= false` la traite comme lancée.
    var launched: Bool?
    /// Écrite seulement quand elle porte un chemin ABSOLU.
    var auditSession: String?
    var relayKind: ProjectRelayKind?
    var base: String?
    var model: String?
    var held: HeldLaunch?
    var contractHash: String?
    var addedAt: Double
    var sinceAt: Double
    var updatedAt: Double
    var endedAt: Double?
}

extension LotFeature {
    init?(json: JSONValue) {
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
            held: asHeldLaunch(f["held"]),
            contractHash: asStringOrNull(f["contractHash"]),
            addedAt: asNumber(f["addedAt"]) ?? 0,
            sinceAt: asNumber(f["sinceAt"]) ?? 0,
            updatedAt: asNumber(f["updatedAt"]) ?? 0,
            endedAt: asNumber(f["endedAt"])
        )
    }
}

/// Un lot (`asLot`, lot.ts:742-795). `version` n'est pas rendu : c'est un marqueur
/// de schéma, pas un champ du modèle.
struct Lot: Sendable, Equatable {
    var id: String
    var repoRoot: String
    var status: LotStatus
    var reviewCap: Int
    var slotCap: Int
    var recapAt: Double?
    var owner: LotOwner
    var createdAt: Double
    var launchedAt: Double?
    var features: [LotFeature]
    var isStale: Bool
}

extension Lot {
    init?(json: JSONValue, nowMs: Double) {
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
struct ProjectBase: Sendable, Equatable {
    var segment: Int
    var sha: String
}

/// L'échec d'une feature de projet (`ProjectFailure`, project.ts:32).
struct ProjectFailure: Sendable, Equatable {
    var kind: ProjectFailureKind
    var reason: String
    var at: Double
}

/// Une feature d'un projet (`asProjectFeature`, project.ts:110-160).
struct ProjectFeature: Sendable, Equatable {
    var slug: String
    var intention: String
    var model: String?
    var status: ProjectFeatureStatus
    var prUrl: String?
    var failure: ProjectFailure?
    var removedReason: String?
    var updatedAt: Double
}

extension ProjectFeature {
    init?(json: JSONValue) {
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
            status: status,
            prUrl: asString(rawPrUrl),
            failure: failure,
            removedReason: asString(rawRemoved),
            updatedAt: updatedAt
        )
    }
}

/// Un segment du plan (`ProjectSegment`).
struct ProjectSegment: Sendable, Equatable {
    var name: String
    var features: [ProjectFeature]
}

/// Un projet (`asProject`, project.ts:166-217). `version` n'est pas rendu.
struct Project: Sendable, Equatable {
    var repoKey: String
    var repoRoot: String
    var relayKey: String
    var purpose: String
    var function: String
    var status: ProjectStatus
    var segments: [ProjectSegment]
    var current: Int
    var base: ProjectBase?
    var hostSession: String?
    var createdAt: Double
    var updatedAt: Double
}

extension Project {
    init?(json: JSONValue) {
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
enum PanelDeliveryAnswer: Sendable, Equatable {
    case selected(String)
    case custom(String)
}

/// Une livraison déposée dans la boîte d'un run (`PanelDelivery`, store.ts:337).
///
/// `sentAt` n'est pas porté : il n'est jamais un critère de forme (le dépôt le
/// ramène à 0 quand il est illisible), et l'ordre chronologique vient du NOM du
/// fichier, pas de ce champ.
enum PanelDelivery: Sendable, Equatable {
    case text(String)
    case askAnswer(toolCallId: String, answer: PanelDeliveryAnswer)
}

/// `asDelivery` (store.ts:439-465). `nil` = fichier illisible ou de forme
/// inconnue : l'entrée est CONSERVÉE par l'appelant, jamais devinée.
func asDelivery(_ raw: JSONValue?) -> PanelDelivery? {
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
struct InboxDelivery: Sendable, Equatable {
    /// Chemin ABSOLU du fichier (parité `readDeliveries`, store.ts:467-482).
    var file: String
    var payload: PanelDelivery?
}

/// La boîte d'un run (`inbox/<runId>-<n>/`), ses livraisons dans l'ordre
/// chronologique des noms de fichiers.
struct InboxBox: Sendable, Equatable {
    var name: String
    var path: String
    var deliveries: [InboxDelivery]
}

// --- `audit/` (S-6) ----------------------------------------------------------

/// Le battement d'une session de relais armée (`AuditRelayRecord`, store.ts:394).
///
/// Écart assumé avec `readAuditRelay` : celle-ci compare en plus le chemin résolu
/// de `sessionFile` à la session DEMANDÉE (garde d'appel par session). Sur un
/// balayage de répertoire il n'y a pas de session demandée : la clé d'identité est
/// le NOM du fichier (`sha1(sessionFile)[:16]`, store.ts:404), et les autres règles
/// champ par champ sont reproduites telles quelles.
struct AuditRelay: Sendable, Equatable {
    /// Le nom du fichier sans `.json`.
    var id: String
    var sessionFile: String
    var pid: Int
    var heartbeatAt: Double
    var isStale: Bool
}

extension AuditRelay {
    /// `readAuditRelay` (store.ts:411-420).
    init?(json: JSONValue, id: String, nowMs: Double) {
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
func isSlug(_ text: String) -> Bool {
    guard let first = text.first, first.isASCII, first.isNumber || first.isLowercase else { return false }
    for character in text.dropFirst() {
        if character == "-" { continue }
        guard character.isASCII, character.isNumber || character.isLowercase else { return false }
    }
    return true
}

/// `isLotBaseSha` (lot.ts:647-649) : 40 hexadécimaux minuscules (SHA-1) ou 64
/// (SHA-256) — la seule forme que le lot écrit et relit.
func asLotBaseSha(_ value: JSONValue?) -> String? {
    guard let text = asString(value), text.count == 40 || text.count == 64 else { return nil }
    for character in text where !isLowerHex(character) { return nil }
    return text
}

/// Une chaîne non blanche : `typeof v === "string" && v.trim() !== ""`.
func asNonBlankString(_ value: JSONValue?) -> String? {
    guard let text = asString(value) else { return nil }
    return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : text
}

/// Un chemin absolu : `path.isAbsolute`.
func asAbsolutePath(_ value: JSONValue?) -> String? {
    guard let text = asString(value), text.hasPrefix("/") else { return nil }
    return text
}

func isLowerHex(_ character: Character) -> Bool {
    (character >= "0" && character <= "9") || (character >= "a" && character <= "f")
}
