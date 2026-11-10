// Le contrat de la TOUR DE CONTRÔLE avec le serveur de pipelines : la consigne et le
// budget d'une feature, la file d'admission, la vigie, les planifications,
// l'administration (clients, dépôts, rechargement, erreurs des clients) et les issues.
//
// Chaque type tolère un serveur qui n'envoie pas un champ facultatif : la valeur qui
// dit « rien ». Les champs que le serveur envoie toujours sont requis, et la garde
// `test/console/tour-de-controle.test.ts` confronte chacun au JSON réel du serveur.

import ConsoleCore
import Foundation

extension KeyedDecodingContainer {
    /// Une liste absente ou `null` : vide.
    fileprivate func items<T: Decodable>(_ type: [T].Type, _ key: Key) throws -> [T] {
        try decodeIfPresent(type, forKey: key) ?? []
    }
}

// MARK: - Consigne et budget d'une feature

/// Où est partie une consigne : dans la session vivante du run (au prochain tour), ou
/// gardée pour sa prochaine étape.
public enum HarnessInstructionsDelivery: String, Sendable {
    case session
    case pending
}

/// `POST /v1/runs/{id}/instructions` : le run et le sort de la consigne.
struct HarnessInstructionsReply: Decodable {
    var delivered: String
}

/// `POST /v1/runs/{id}/budget` : le run et son budget désormais.
struct HarnessBudgetReply: Decodable {
    var budget: HarnessBudget
}

// MARK: - File d'admission

/// Une cause qui retient des features en file, et son texte.
public struct HarnessQueueWait: Codable, Equatable, Sendable {
    public var cause: String
    public var text: String

    public init(cause: String, text: String) {
        self.cause = cause
        self.text = text
    }
}

/// `GET /v1/status` → `queue` : les features dues retenues, par cause, et la plus fréquente.
public struct HarnessQueueStatus: Codable, Equatable, Sendable {
    public var held: Int
    public var byCause: [String: Int]
    public var dominant: HarnessQueueWait?

    public init(held: Int = 0, byCause: [String: Int] = [:], dominant: HarnessQueueWait? = nil) {
        self.held = held
        self.byCause = byCause
        self.dominant = dominant
    }
}

// MARK: - Vigie

/// Les modes de la vigie, du plus discret au plus actif.
public enum VigieMode: String, CaseIterable, Sendable, Identifiable {
    /// Coupée : rien n'est consigné.
    case off
    /// Tout est consigné en incidents, rien ne sort.
    case shadow
    /// Publie les issues.
    case report
    /// Publie et corrige.
    case fix

    public var id: String { rawValue }
}

/// Les réglages de la vigie (`PUT /v1/vigie`, admin).
public struct VigieSettings: Codable, Equatable, Sendable {
    public var mode: String
    public var maxIssuesPerDay: Int
    public var maxLiveRuns: Int
    public var dailyBudgetUsd: Double
    /// Les dépôts déclarés où elle publie et corrige ; vide : nulle part.
    public var repos: [String]

    public init(mode: String = "shadow", maxIssuesPerDay: Int = 5, maxLiveRuns: Int = 2, dailyBudgetUsd: Double = 10, repos: [String] = []) {
        self.mode = mode
        self.maxIssuesPerDay = maxIssuesPerDay
        self.maxLiveRuns = maxLiveRuns
        self.dailyBudgetUsd = dailyBudgetUsd
        self.repos = repos
    }

    /// Le mode connu, ou `nil` pour un mode apparu après cette version.
    public var phase: VigieMode? { VigieMode(rawValue: mode) }
}

/// Le dernier battement de cœur de la vigie.
public struct VigieHeartbeat: Codable, Equatable, Sendable {
    public var at: Double
    public var version: String?
    public var client: String
    /// Plus de 5 minutes sans battement : la vigie est muette.
    public var silent: Bool
    /// L'instant où le serveur l'a déclarée muette (`vigie_silent`) ; `nil` sinon.
    public var silentSince: Double?

    public init(at: Double, version: String? = nil, client: String, silent: Bool = false, silentSince: Double? = nil) {
        self.at = at
        self.version = version
        self.client = client
        self.silent = silent
        self.silentSince = silentSince
    }
}

/// L'état du jour (UTC) de la vigie, face à ses plafonds.
public struct VigieToday: Codable, Equatable, Sendable {
    public var since: Double
    public var issues: Int
    public var liveRuns: Int
    public var spentUsd: Double

    public init(since: Double = 0, issues: Int = 0, liveRuns: Int = 0, spentUsd: Double = 0) {
        self.since = since
        self.issues = issues
        self.liveRuns = liveRuns
        self.spentUsd = spentUsd
    }
}

/// `GET /v1/vigie` : réglages, battement, état du jour et incidents comptés par statut.
public struct VigieView: Codable, Equatable, Sendable {
    public var settings: VigieSettings
    public var heartbeat: VigieHeartbeat?
    public var today: VigieToday
    public var incidents: [String: Int]

    public init(settings: VigieSettings = VigieSettings(), heartbeat: VigieHeartbeat? = nil, today: VigieToday = VigieToday(), incidents: [String: Int] = [:]) {
        self.settings = settings
        self.heartbeat = heartbeat
        self.today = today
        self.incidents = incidents
    }

    /// La vigie ne bat plus (ou n'a jamais battu) alors qu'elle n'est pas coupée.
    public var isSilent: Bool {
        guard settings.phase != .off else { return false }
        return heartbeat?.silent ?? false
    }
}

/// Le tri d'un incident par la vigie : bruit, ou bug avec ce qu'en dirait l'issue.
public struct VigieTriage: Codable, Equatable, Sendable {
    public var verdict: String
    public var title: String
    public var symptom: String
    public var hypothesis: String
    public var criteria: [String]

    public init(verdict: String, title: String = "", symptom: String = "", hypothesis: String = "", criteria: [String] = []) {
        self.verdict = verdict
        self.title = title
        self.symptom = symptom
        self.hypothesis = hypothesis
        self.criteria = criteria
    }

    private enum CodingKeys: String, CodingKey { case verdict, title, symptom, hypothesis, criteria }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        verdict = try container.decodeIfPresent(String.self, forKey: .verdict) ?? ""
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? ""
        symptom = try container.decodeIfPresent(String.self, forKey: .symptom) ?? ""
        hypothesis = try container.decodeIfPresent(String.self, forKey: .hypothesis) ?? ""
        criteria = try container.items([String].self, .criteria)
    }
}

/// Les statuts d'un incident, dans l'ordre de sa vie.
public enum VigieIncidentStatus: String, CaseIterable, Sendable, Identifiable {
    case new
    case noise
    case bug
    case reported
    case fixing
    case watching
    case resolved
    case deferred

    public var id: String { rawValue }
}

/// Un incident de la vigie : une empreinte, ses occurrences, son tri, l'issue publiée et
/// le run de correction.
public struct VigieIncident: Codable, Equatable, Sendable, Identifiable {
    public var fingerprint: String
    public var source: String
    public var location: String
    public var message: String
    public var repo: String?
    public var runId: String?
    public var status: String
    public var count: Int
    public var firstAt: Double
    public var lastAt: Double
    public var triage: VigieTriage?
    public var issueNumber: Int?
    public var issueUrl: String?
    public var fixRunId: String?
    public var note: String?
    public var updatedAt: Double

    public var id: String { fingerprint }

    public init(
        fingerprint: String, source: String = "", location: String = "", message: String = "", repo: String? = nil,
        runId: String? = nil, status: String = "new", count: Int = 1, firstAt: Double = 0, lastAt: Double = 0,
        triage: VigieTriage? = nil, issueNumber: Int? = nil, issueUrl: String? = nil, fixRunId: String? = nil,
        note: String? = nil, updatedAt: Double = 0
    ) {
        self.fingerprint = fingerprint
        self.source = source
        self.location = location
        self.message = message
        self.repo = repo
        self.runId = runId
        self.status = status
        self.count = count
        self.firstAt = firstAt
        self.lastAt = lastAt
        self.triage = triage
        self.issueNumber = issueNumber
        self.issueUrl = issueUrl
        self.fixRunId = fixRunId
        self.note = note
        self.updatedAt = updatedAt
    }

    /// Le statut connu, ou `nil` pour un statut apparu après cette version.
    public var phase: VigieIncidentStatus? { VigieIncidentStatus(rawValue: status) }

    /// L'empreinte abrégée (les 12 premiers caractères), pour l'œil.
    public var shortFingerprint: String { String(fingerprint.prefix(12)) }
}

/// `GET /v1/vigie/incidents`.
struct VigieIncidentList: Decodable {
    var incidents: [VigieIncident]
}

/// `PUT /v1/vigie` : les réglages retenus.
struct VigieSettingsReply: Decodable {
    var settings: VigieSettings
}

// MARK: - Planifications

/// Les cibles d'une planification.
public enum HarnessScheduleKind: String, CaseIterable, Sendable, Identifiable {
    /// Un run, comme `POST /v1/runs`.
    case run
    /// Un audit, comme `POST /v1/audits`.
    case audit
    /// La relève des issues ouvertes d'un label.
    case issues

    public var id: String { rawValue }
}

/// Ce que lance une planification à chaque échéance.
public struct HarnessScheduleTarget: Codable, Equatable, Sendable {
    public var kind: String
    public var repo: String
    public var title: String?
    public var request: String?
    public var lane: String?
    public var priority: Int?
    public var budgetUsd: Double?
    public var focus: String?
    public var label: String?
    /// La cible `automation` : l'automatisation du poste lancée (sans dépôt, `repo` vide).
    public var automationId: String?

    public init(
        kind: String, repo: String, title: String? = nil, request: String? = nil, lane: String? = nil, priority: Int? = nil,
        budgetUsd: Double? = nil, focus: String? = nil, label: String? = nil, automationId: String? = nil
    ) {
        self.kind = kind
        self.repo = repo
        self.title = title
        self.request = request
        self.lane = lane
        self.priority = priority
        self.budgetUsd = budgetUsd
        self.focus = focus
        self.label = label
        self.automationId = automationId
    }

    private enum CodingKeys: String, CodingKey {
        case kind, repo, title, request, lane, priority, budgetUsd, focus, label, automationId
    }

    /// Une cible `automation` n'a pas de `repo` : il se lit vide.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(String.self, forKey: .kind)
        repo = try container.decodeIfPresent(String.self, forKey: .repo) ?? ""
        title = try container.decodeIfPresent(String.self, forKey: .title)
        request = try container.decodeIfPresent(String.self, forKey: .request)
        lane = try container.decodeIfPresent(String.self, forKey: .lane)
        priority = try container.decodeIfPresent(Int.self, forKey: .priority)
        budgetUsd = try container.decodeIfPresent(Double.self, forKey: .budgetUsd)
        focus = try container.decodeIfPresent(String.self, forKey: .focus)
        label = try container.decodeIfPresent(String.self, forKey: .label)
        automationId = try container.decodeIfPresent(String.self, forKey: .automationId)
    }
}

/// L'issue d'une échéance : `fired`, `busy`, `daily_budget`, `missed` ou `failed`.
public struct HarnessScheduleOutcome: Codable, Equatable, Sendable {
    public var status: String
    public var at: Double
    public var dueAt: Double?
    public var detail: String
    public var missed: Int
    public var runIds: [String]
    public var auditId: String?

    public init(status: String, at: Double = 0, dueAt: Double? = nil, detail: String = "", missed: Int = 0, runIds: [String] = [], auditId: String? = nil) {
        self.status = status
        self.at = at
        self.dueAt = dueAt
        self.detail = detail
        self.missed = missed
        self.runIds = runIds
        self.auditId = auditId
    }

    private enum CodingKeys: String, CodingKey { case status, at, dueAt, detail, missed, runIds, auditId }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = try container.decode(String.self, forKey: .status)
        at = try container.decodeIfPresent(Double.self, forKey: .at) ?? 0
        dueAt = try container.decodeIfPresent(Double.self, forKey: .dueAt)
        detail = try container.decodeIfPresent(String.self, forKey: .detail) ?? ""
        missed = try container.decodeIfPresent(Int.self, forKey: .missed) ?? 0
        runIds = try container.items([String].self, .runIds)
        auditId = try container.decodeIfPresent(String.self, forKey: .auditId)
    }
}

/// Une planification récurrente.
public struct HarnessSchedule: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var cron: String
    public var target: HarnessScheduleTarget
    public var repo: String
    public var enabled: Bool
    /// La prochaine échéance (ms) ; `nil` : désactivée.
    public var nextRunAt: Double?
    public var lastRunAt: Double?
    public var lastOutcome: HarnessScheduleOutcome?
    public var createdBy: String?
    /// La révision (+1 à chaque écriture), renvoyée en `If-Match`.
    public var rev: Int

    public init(
        id: String, name: String, cron: String, target: HarnessScheduleTarget, repo: String? = nil, enabled: Bool = true,
        nextRunAt: Double? = nil, lastRunAt: Double? = nil, lastOutcome: HarnessScheduleOutcome? = nil, createdBy: String? = nil,
        rev: Int = 1
    ) {
        self.id = id
        self.name = name
        self.cron = cron
        self.target = target
        self.repo = repo ?? target.repo
        self.enabled = enabled
        self.nextRunAt = nextRunAt
        self.lastRunAt = lastRunAt
        self.lastOutcome = lastOutcome
        self.createdBy = createdBy
        self.rev = rev
    }

    /// La cible connue, ou `nil` pour une cible apparue après cette version.
    public var kind: HarnessScheduleKind? { HarnessScheduleKind(rawValue: target.kind) }
}

/// `GET /v1/schedules` : le fuseau des expressions cron et les planifications.
struct HarnessScheduleList: Decodable {
    var timezone: String
    var schedules: [HarnessSchedule]
}

/// Une écriture sur une planification (`POST`, `PUT`) : la planification à jour.
struct HarnessScheduleReply: Decodable {
    var schedule: HarnessSchedule
}

/// `POST /v1/schedules/{id}/run` : la planification et l'issue du déclenchement.
public struct HarnessScheduleFired: Decodable, Equatable, Sendable {
    public var schedule: HarnessSchedule
    public var outcome: HarnessScheduleOutcome
}

// MARK: - Administration

/// Un client du serveur (`GET /v1/clients`, admin) : jamais son jeton.
public struct HarnessManagedClient: Codable, Equatable, Sendable, Identifiable {
    public var name: String
    public var role: String
    /// Les dépôts permis ; `nil` : tous (`"*"` côté serveur).
    public var repos: [String]?
    public var createdAt: Double
    /// Le client approbateur du poste (créé en ligne de commande seulement).
    public var approver: Bool
    /// Un client pilote (la vigie) : les gestes réservés à l'humain lui sont refusés.
    public var pilot: Bool?
    /// Les espaces auxquels le client est borné (leurs identifiants) : `repos` porte alors leurs
    /// dépôts du moment. `nil` : il n'est borné à aucun espace (la clé est alors absente).
    public var spaces: [String]? = nil

    public var id: String { name }

    public init(
        name: String, role: String, repos: [String]? = nil, createdAt: Double = 0, approver: Bool = false, pilot: Bool? = nil,
        spaces: [String]? = nil
    ) {
        self.name = name
        self.role = role
        self.repos = repos
        self.createdAt = createdAt
        self.approver = approver
        self.pilot = pilot
        self.spaces = spaces
    }

    private enum CodingKeys: String, CodingKey { case name, role, repos, createdAt, approver, pilot, spaces }

    /// `repos` vaut `"*"` (tous) ou une liste.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        role = try container.decode(String.self, forKey: .role)
        repos = try? container.decodeIfPresent([String].self, forKey: .repos)
        createdAt = try container.decodeIfPresent(Double.self, forKey: .createdAt) ?? 0
        approver = try container.decodeIfPresent(Bool.self, forKey: .approver) ?? false
        pilot = try container.decodeIfPresent(Bool.self, forKey: .pilot)
        spaces = try? container.decodeIfPresent([String].self, forKey: .spaces)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(role, forKey: .role)
        if let repos { try container.encode(repos, forKey: .repos) } else { try container.encode("*", forKey: .repos) }
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(approver, forKey: .approver)
        try container.encodeIfPresent(pilot, forKey: .pilot)
        try container.encodeIfPresent(spaces, forKey: .spaces)
    }
}

/// `GET /v1/clients`.
struct HarnessClientList: Decodable {
    var clients: [HarnessManagedClient]
}

/// `POST /v1/clients` : le client créé et son jeton, montré UNE fois.
public struct HarnessClientCreated: Decodable, Equatable, Sendable {
    public var client: HarnessManagedClient
    public var token: String
}

/// La clé de déploiement à poser sur la forge pour qu'un dépôt se lise ou s'écrive.
public struct HarnessDeployKey: Codable, Equatable, Sendable {
    public var publicKey: String
    /// La page de la forge où la poser ; `nil` si le serveur ne la connaît pas.
    public var url: String?

    public init(publicKey: String, url: String? = nil) {
        self.publicKey = publicKey
        self.url = url
    }
}

/// La configuration relue : les dépôts servis, ajoutés, retirés et gardés.
public struct HarnessReloadSummary: Codable, Equatable, Sendable {
    public var repos: [String]
    public var added: [String]
    public var removed: [String]
    public var kept: [String]

    public init(repos: [String] = [], added: [String] = [], removed: [String] = [], kept: [String] = []) {
        self.repos = repos
        self.added = added
        self.removed = removed
        self.kept = kept
    }
}

/// `POST /v1/repos` : le dépôt déclaré, s'il sert désormais, et la clé à poser s'il le faut.
public struct HarnessRepoDeclared: Codable, Equatable, Sendable {
    public var repo: String
    public var added: Bool
    public var message: String
    public var deployKey: HarnessDeployKey?
    public var reload: HarnessReloadSummary?

    public init(repo: String, added: Bool, message: String = "", deployKey: HarnessDeployKey? = nil, reload: HarnessReloadSummary? = nil) {
        self.repo = repo
        self.added = added
        self.message = message
        self.deployKey = deployKey
        self.reload = reload
    }
}

/// `POST /v1/reload`.
struct HarnessReloadReply: Decodable {
    var reload: HarnessReloadSummary
}

/// Un dépôt servi (`GET /v1/repos`).
public struct HarnessServedRepo: Codable, Equatable, Sendable, Identifiable {
    public var name: String
    public var scope: String?
    public var mainBranch: String?
    public var merge: String?
    public var maxParallel: Int?

    public var id: String { name }

    public init(name: String, scope: String? = nil, mainBranch: String? = nil, merge: String? = nil, maxParallel: Int? = nil) {
        self.name = name
        self.scope = scope
        self.mainBranch = mainBranch
        self.merge = merge
        self.maxParallel = maxParallel
    }
}

/// `GET /v1/repos`.
struct HarnessServedRepoList: Decodable {
    var repos: [HarnessServedRepo]
}

/// Une erreur remontée par un client (`GET /v1/client-errors`).
public struct HarnessClientErrorRecord: Codable, Equatable, Sendable, Identifiable {
    public var id: Int
    public var at: Double
    /// Le client authentifié qui l'a remontée.
    public var client: String
    /// `mac`, `ios`, `chrome`, `omp` ou `vigie`.
    public var source: String
    public var version: String
    public var kind: String
    public var message: String

    public init(id: Int, at: Double = 0, client: String = "", source: String = "", version: String = "", kind: String = "", message: String = "") {
        self.id = id
        self.at = at
        self.client = client
        self.source = source
        self.version = version
        self.kind = kind
        self.message = message
    }
}

/// `GET /v1/client-errors`.
struct HarnessClientErrorList: Decodable {
    var errors: [HarnessClientErrorRecord]
}

// MARK: - Issues (MCP)

/// Le run qui porte une issue.
public struct HarnessIssueRun: Codable, Equatable, Sendable {
    public var id: String
    public var state: String
    public var slug: String

    public init(id: String, state: String, slug: String = "") {
        self.id = id
        self.state = state
        self.slug = slug
    }

    /// L'état connu du run, ou `nil`.
    public var phase: HarnessRunState? { HarnessRunState(rawValue: state) }
}

/// Une issue ouverte d'un dépôt, avec le run qui la corrige s'il y en a un.
public struct HarnessIssue: Codable, Equatable, Sendable, Identifiable {
    public var number: Int
    public var title: String
    public var url: String
    public var labels: [String]
    public var author: String?
    public var createdAt: String
    public var run: HarnessIssueRun?

    public var id: Int { number }

    public init(number: Int, title: String, url: String = "", labels: [String] = [], author: String? = nil, createdAt: String = "", run: HarnessIssueRun? = nil) {
        self.number = number
        self.title = title
        self.url = url
        self.labels = labels
        self.author = author
        self.createdAt = createdAt
        self.run = run
    }

    private enum CodingKeys: String, CodingKey { case number, title, url, labels, author, createdAt, run }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        number = try container.decode(Int.self, forKey: .number)
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? ""
        url = try container.decodeIfPresent(String.self, forKey: .url) ?? ""
        labels = try container.items([String].self, .labels)
        author = try container.decodeIfPresent(String.self, forKey: .author)
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        run = try container.decodeIfPresent(HarnessIssueRun.self, forKey: .run)
    }

    /// Un run vivant ou fusionné porte l'issue : « Corriger » n'en relancerait pas un autre.
    public var isCarried: Bool {
        guard let run else { return false }
        return run.phase != .failed && run.phase != .cancelled
    }
}

/// Le résultat de l'outil `issues_list`.
struct HarnessIssueListResult: Decodable {
    var repo: String
    var issues: [HarnessIssue]
}

/// Le résultat de l'outil `issue_fix` : le run lancé (ou celui qui la portait déjà).
public struct HarnessIssueFix: Decodable, Equatable, Sendable {
    public var repo: String
    public var issue: Int
    /// `launched` (un run part) ou `already` (un run vivant ou fusionné la porte déjà).
    public var status: String
    public var run: HarnessIssueRun
}
