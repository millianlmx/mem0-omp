// Le contrat du POSTE DE TRAVAIL (routes `/v1/workstation*` d'omp-harness) : l'état
// de l'extension Chrome et de l'agent 24/24, la file d'actions qui EST le journal des
// décisions, le profil établi par l'observation et les réunions transcrites. Décodé
// tel que le serveur l'écrit (clés camelCase, instants en millisecondes epoch).
//
// Décodage tolérant, comme `HarnessWire` : les codes (sorte, état, origine, autonomie)
// restent des chaînes — un code apparu après cette version s'affiche tel quel au lieu
// de faire échouer la lecture —, les listes absentes ou `null` sont vides, les champs
// facultatifs absents valent `nil`, et les clés inconnues sont ignorées.
//
// Aucun texte ici : les écrans traduisent les codes avec `WorkstationText`.

import ConsoleCore
import Foundation

/// Les états d'une action de la file.
public enum WorkstationActionState: String, CaseIterable, Sendable {
    case queued
    case running
    case awaitingApproval = "awaiting_approval"
    case done
    case failed
    case refused
    case expired
}

/// Les réglages d'autonomie, dans l'ordre du sélecteur.
public enum WorkstationAutonomySetting: String, CaseIterable, Sendable, Identifiable {
    case auto
    case observe
    case propose
    case act

    public var id: String { rawValue }
}

extension KeyedDecodingContainer {
    /// Une liste absente ou `null` : vide.
    fileprivate func list<T: Decodable>(_ type: [T].Type, _ key: Key) throws -> [T] {
        try decodeIfPresent(type, forKey: key) ?? []
    }
}

// MARK: - File d'actions (le journal des décisions)

/// La demande d'approbation d'un envoi : ce que l'agent veut envoyer, à qui, et qui a tranché.
public struct WorkstationApproval: Codable, Equatable, Sendable {
    public var summary: String
    /// Les adresses ou pseudos extraits ; vide quand ils sont inconnus (l'approbation est alors exigée).
    public var recipients: [String]
    /// Le message tel qu'il partirait, montré EN ENTIER à l'humain.
    public var preview: String
    /// L'empreinte de l'envoi calculée par l'extension (destination, destinataires, texte
    /// complet) ; `nil` pour une action proposée par l'agent 24/24, qui n'autorise aucun
    /// envoi. Jamais affichée : l'extension la compare au moment du geste.
    public var fingerprint: String?
    public var decidedBy: String?
    public var decidedAt: Double?
    /// La raison d'un refus.
    public var reason: String?

    public init(
        summary: String, recipients: [String] = [], preview: String = "", fingerprint: String? = nil,
        decidedBy: String? = nil, decidedAt: Double? = nil, reason: String? = nil
    ) {
        self.summary = summary
        self.recipients = recipients
        self.preview = preview
        self.fingerprint = fingerprint
        self.decidedBy = decidedBy
        self.decidedAt = decidedAt
        self.reason = reason
    }

    private enum CodingKeys: String, CodingKey {
        case summary, recipients, preview, fingerprint, decidedBy, decidedAt, reason
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        summary = try container.decodeIfPresent(String.self, forKey: .summary) ?? ""
        recipients = try container.list([String].self, .recipients)
        preview = try container.decodeIfPresent(String.self, forKey: .preview) ?? ""
        fingerprint = try container.decodeIfPresent(String.self, forKey: .fingerprint)
        decidedBy = try container.decodeIfPresent(String.self, forKey: .decidedBy)
        decidedAt = try container.decodeIfPresent(Double.self, forKey: .decidedAt)
        reason = try container.decodeIfPresent(String.self, forKey: .reason)
    }
}

/// Ce qu'une action a rendu : un texte, des données (jamais d'image).
public struct WorkstationActionResult: Codable, Equatable, Sendable {
    public var text: String?
    public var data: JSONValue?

    public init(text: String? = nil, data: JSONValue? = nil) {
        self.text = text
        self.data = data
    }
}

/// Une action de la file : un geste dans le navigateur, ou une décision journalisée seule.
/// Sa `rationale` (le POURQUOI) est ce que le journal des décisions montre.
public struct WorkstationAction: Codable, Equatable, Sendable, Identifiable {
    public var seq: Int
    public var createdAt: Double
    public var updatedAt: Double
    /// `session` (un outil OMP) ou `agent` (l'agent 24/24 du serveur).
    public var origin: String
    /// Le client HTTP qui l'a déposée, ou `agent`.
    public var by: String?
    public var kind: String
    public var params: [String: JSONValue]
    public var rationale: String
    public var state: String
    /// L'humain a approuvé l'envoi : l'extension l'exécute malgré la garde.
    public var approved: Bool
    public var approval: WorkstationApproval?
    public var result: WorkstationActionResult?
    public var error: String?

    public var id: Int { seq }

    public init(
        seq: Int, createdAt: Double = 0, updatedAt: Double = 0, origin: String = "agent", by: String? = nil,
        kind: String, params: [String: JSONValue] = [:], rationale: String, state: String, approved: Bool = false,
        approval: WorkstationApproval? = nil, result: WorkstationActionResult? = nil, error: String? = nil
    ) {
        self.seq = seq
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.origin = origin
        self.by = by
        self.kind = kind
        self.params = params
        self.rationale = rationale
        self.state = state
        self.approved = approved
        self.approval = approval
        self.result = result
        self.error = error
    }

    private enum CodingKeys: String, CodingKey {
        case seq, createdAt, updatedAt, origin, by, kind, params, rationale, state, approved, approval, result, error
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        seq = try container.decode(Int.self, forKey: .seq)
        createdAt = try container.decodeIfPresent(Double.self, forKey: .createdAt) ?? 0
        updatedAt = try container.decodeIfPresent(Double.self, forKey: .updatedAt) ?? createdAt
        origin = try container.decodeIfPresent(String.self, forKey: .origin) ?? ""
        by = try container.decodeIfPresent(String.self, forKey: .by)
        kind = try container.decode(String.self, forKey: .kind)
        params = try container.decodeIfPresent([String: JSONValue].self, forKey: .params) ?? [:]
        rationale = try container.decodeIfPresent(String.self, forKey: .rationale) ?? ""
        state = try container.decode(String.self, forKey: .state)
        approved = try container.decodeIfPresent(Bool.self, forKey: .approved) ?? false
        approval = try container.decodeIfPresent(WorkstationApproval.self, forKey: .approval)
        result = try container.decodeIfPresent(WorkstationActionResult.self, forKey: .result)
        error = try container.decodeIfPresent(String.self, forKey: .error)
    }

    /// L'état connu de cette version, ou `nil` pour un état apparu après elle.
    public var phase: WorkstationActionState? { WorkstationActionState(rawValue: state) }

    /// L'envoi attend l'approbation de l'humain.
    public var awaitsApproval: Bool { phase == .awaitingApproval }

    /// Une action PROPOSÉE par l'agent 24/24 (autonomie « Proposer ») : un geste dans le
    /// navigateur, pas un envoi de message. L'extension n'a calculé aucune empreinte, si
    /// bien que son approbation n'autorise aucun envoi : un envoi qui en découlerait
    /// redemanderait sa propre approbation.
    public var isProposal: Bool {
        guard let approval else { return false }
        return origin == "agent" && approval.fingerprint == nil
    }

    /// La valeur d'`If-Match` qui lie un geste à l'action telle que l'humain l'a vue :
    /// son `updatedAt` (millisecondes entières), entre guillemets.
    public var revisionTag: String { "\"\(Int64(updatedAt))\"" }

    /// Ce que l'humain a tranché, quand il a tranché : approuvé (l'action est repartie)
    /// ou refusé (avec sa raison). `nil` tant que personne n'a tranché.
    public var decision: (approved: Bool, by: String)? {
        guard let by = approval?.decidedBy, !by.isEmpty else { return nil }
        return (phase != .refused, by)
    }

    /// Le résultat en une ligne courte (texte rendu par l'extension), ou `nil`.
    public var shortResult: String? {
        guard let text = result?.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        let line = text.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? text
        return line.count > Self.shortLimit ? String(line.prefix(Self.shortLimit)) + "…" : line
    }

    /// La longueur d'une ligne de résultat dans le journal.
    public static let shortLimit = 160
}

/// `GET /v1/workstation/actions` : récent d'abord.
public struct WorkstationActionList: Decodable, Equatable, Sendable {
    public var actions: [WorkstationAction]

    private enum CodingKeys: String, CodingKey { case actions }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        actions = try container.list([WorkstationAction].self, .actions)
    }
}

/// La réponse d'un geste sur une action (`approve`, `refuse`).
struct WorkstationActionReply: Decodable {
    var action: WorkstationAction
}

// MARK: - État du poste

/// L'autonomie : le réglage posé depuis une app, et celle qui s'applique.
public struct WorkstationAutonomy: Codable, Equatable, Sendable {
    /// `auto`, `observe`, `propose` ou `act`.
    public var setting: String
    /// `observe`, `propose` ou `act` (`auto` se résout selon les heures observées).
    public var effective: String

    public init(setting: String, effective: String) {
        self.setting = setting
        self.effective = effective
    }
}

/// Le dernier passage de l'agent 24/24.
public struct WorkstationShift: Codable, Equatable, Sendable {
    public var at: Double
    public var outcome: String
    public var actions: Int

    public init(at: Double, outcome: String, actions: Int) {
        self.at = at
        self.outcome = outcome
        self.actions = actions
    }
}

/// `GET /v1/workstation` (et la réponse de `PUT /v1/workstation/settings`).
public struct WorkstationStatus: Codable, Equatable, Sendable {
    /// Le dernier contact de l'extension date de moins de 60 s.
    public var online: Bool
    public var lastSeenAt: Double?
    public var extensionVersion: String?
    public var observedSeconds: Double
    public var thresholdHours: Double
    public var autonomy: WorkstationAutonomy
    /// Pause posée depuis une app : aucune action ne part, l'observation est refusée.
    public var paused: Bool
    /// Les adresses et pseudos de l'utilisateur : un message à soi ne demande pas d'approbation.
    public var selfIdentities: [String]
    /// Les actions en `awaiting_approval`.
    public var pending: Int
    public var profileUpdatedAt: Double?
    public var lastShift: WorkstationShift?
    public var nextShiftAt: Double?

    public init(
        online: Bool = false, lastSeenAt: Double? = nil, extensionVersion: String? = nil, observedSeconds: Double = 0,
        thresholdHours: Double = 8, autonomy: WorkstationAutonomy = WorkstationAutonomy(setting: "auto", effective: "observe"),
        paused: Bool = false, selfIdentities: [String] = [], pending: Int = 0, profileUpdatedAt: Double? = nil,
        lastShift: WorkstationShift? = nil, nextShiftAt: Double? = nil
    ) {
        self.online = online
        self.lastSeenAt = lastSeenAt
        self.extensionVersion = extensionVersion
        self.observedSeconds = observedSeconds
        self.thresholdHours = thresholdHours
        self.autonomy = autonomy
        self.paused = paused
        self.selfIdentities = selfIdentities
        self.pending = pending
        self.profileUpdatedAt = profileUpdatedAt
        self.lastShift = lastShift
        self.nextShiftAt = nextShiftAt
    }

    private enum CodingKeys: String, CodingKey {
        case online, lastSeenAt, extensionVersion, observedSeconds, thresholdHours, autonomy, paused
        case selfIdentities, pending, profileUpdatedAt, lastShift, nextShiftAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        online = try container.decodeIfPresent(Bool.self, forKey: .online) ?? false
        lastSeenAt = try container.decodeIfPresent(Double.self, forKey: .lastSeenAt)
        extensionVersion = try container.decodeIfPresent(String.self, forKey: .extensionVersion)
        observedSeconds = try container.decodeIfPresent(Double.self, forKey: .observedSeconds) ?? 0
        thresholdHours = try container.decodeIfPresent(Double.self, forKey: .thresholdHours) ?? 8
        autonomy = try container.decode(WorkstationAutonomy.self, forKey: .autonomy)
        paused = try container.decodeIfPresent(Bool.self, forKey: .paused) ?? false
        selfIdentities = try container.list([String].self, .selfIdentities)
        pending = try container.decodeIfPresent(Int.self, forKey: .pending) ?? 0
        profileUpdatedAt = try container.decodeIfPresent(Double.self, forKey: .profileUpdatedAt)
        lastShift = try container.decodeIfPresent(WorkstationShift.self, forKey: .lastShift)
        nextShiftAt = try container.decodeIfPresent(Double.self, forKey: .nextShiftAt)
    }

    /// La part du seuil d'observation atteinte, de 0 à 1.
    public var observedProgress: Double {
        guard thresholdHours > 0 else { return 1 }
        return min(1, max(0, observedSeconds / (thresholdHours * 3600)))
    }

    /// Le réglage d'autonomie connu, ou `nil` pour un réglage apparu après cette version.
    public var autonomySetting: WorkstationAutonomySetting? { WorkstationAutonomySetting(rawValue: autonomy.setting) }
}

// MARK: - Profil

/// Un site, dans le temps observé.
public struct WorkstationTopSite: Codable, Equatable, Sendable, Identifiable {
    public var host: String
    public var seconds: Double
    /// La part du temps observé, de 0 à 1.
    public var share: Double

    public var id: String { host }

    public init(host: String, seconds: Double, share: Double) {
        self.host = host
        self.seconds = seconds
        self.share = share
    }
}

/// Un enchaînement récurrent de pages (hôte + chemin normalisé).
public struct WorkstationSequence: Codable, Equatable, Sendable {
    public var steps: [String]
    public var count: Int

    public init(steps: [String], count: Int) {
        self.steps = steps
        self.count = count
    }
}

/// Les statistiques de l'observation, calculées par le serveur.
public struct WorkstationProfileStats: Codable, Equatable, Sendable {
    public var observedSeconds: Double
    public var since: Double?
    public var topSites: [WorkstationTopSite]
    /// 24 cases : les secondes actives par heure locale de la journée.
    public var activeHours: [Double]
    public var sequences: [WorkstationSequence]

    public init(observedSeconds: Double = 0, since: Double? = nil, topSites: [WorkstationTopSite] = [], activeHours: [Double] = [], sequences: [WorkstationSequence] = []) {
        self.observedSeconds = observedSeconds
        self.since = since
        self.topSites = topSites
        self.activeHours = activeHours
        self.sequences = sequences
    }

    private enum CodingKeys: String, CodingKey {
        case observedSeconds, since, topSites, activeHours, sequences
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        observedSeconds = try container.decodeIfPresent(Double.self, forKey: .observedSeconds) ?? 0
        since = try container.decodeIfPresent(Double.self, forKey: .since)
        topSites = try container.list([WorkstationTopSite].self, .topSites)
        activeHours = try container.list([Double].self, .activeHours)
        sequences = try container.list([WorkstationSequence].self, .sequences)
    }

    /// Les heures de la journée qui ont vu de l'activité, chacune avec ses secondes.
    public var activeHourBars: [WorkstationHourBar] {
        activeHours.prefix(24).enumerated().compactMap { $0.element > 0 ? WorkstationHourBar(hour: $0.offset, seconds: $0.element) : nil }
    }
}

/// Une heure active de la journée (0 à 23) et ses secondes observées.
public struct WorkstationHourBar: Equatable, Sendable, Identifiable {
    public var hour: Int
    public var seconds: Double

    public var id: Int { hour }
}

/// Un outil employé, et à quoi.
public struct WorkstationTool: Codable, Equatable, Sendable {
    public var name: String
    public var usage: String

    public init(name: String, usage: String) {
        self.name = name
        self.usage = usage
    }
}

/// Une tâche répétitive repérée par l'observation.
public struct WorkstationTask: Codable, Equatable, Sendable {
    public var title: String
    public var frequency: String
    public var steps: [String]
    public var automatable: Bool

    public init(title: String, frequency: String, steps: [String] = [], automatable: Bool = false) {
        self.title = title
        self.frequency = frequency
        self.steps = steps
        self.automatable = automatable
    }

    private enum CodingKeys: String, CodingKey { case title, frequency, steps, automatable }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        title = try container.decode(String.self, forKey: .title)
        frequency = try container.decodeIfPresent(String.self, forKey: .frequency) ?? ""
        steps = try container.list([String].self, .steps)
        automatable = try container.decodeIfPresent(Bool.self, forKey: .automatable) ?? false
    }
}

/// Un besoin de client, retenu d'une réunion ou de l'observation.
public struct WorkstationClientNeed: Codable, Equatable, Sendable {
    public var need: String
    public var who: String?
    public var meetingId: String?
    public var at: Double?

    public init(need: String, who: String? = nil, meetingId: String? = nil, at: Double? = nil) {
        self.need = need
        self.who = who
        self.meetingId = meetingId
        self.at = at
    }
}

/// Le profil établi : comment l'utilisateur travaille.
public struct WorkstationProfile: Codable, Equatable, Sendable {
    public var version: Int
    public var updatedAt: Double
    public var summary: String
    public var habits: [String]
    public var tools: [WorkstationTool]
    public var schedule: String
    public var repetitiveTasks: [WorkstationTask]
    public var clientNeeds: [WorkstationClientNeed]
    public var preferences: [String]

    public init(
        version: Int, updatedAt: Double, summary: String, habits: [String] = [], tools: [WorkstationTool] = [], schedule: String = "",
        repetitiveTasks: [WorkstationTask] = [], clientNeeds: [WorkstationClientNeed] = [], preferences: [String] = []
    ) {
        self.version = version
        self.updatedAt = updatedAt
        self.summary = summary
        self.habits = habits
        self.tools = tools
        self.schedule = schedule
        self.repetitiveTasks = repetitiveTasks
        self.clientNeeds = clientNeeds
        self.preferences = preferences
    }

    private enum CodingKeys: String, CodingKey {
        case version, updatedAt, summary, habits, tools, schedule, repetitiveTasks, clientNeeds, preferences
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(Int.self, forKey: .version)
        updatedAt = try container.decodeIfPresent(Double.self, forKey: .updatedAt) ?? 0
        summary = try container.decodeIfPresent(String.self, forKey: .summary) ?? ""
        habits = try container.list([String].self, .habits)
        tools = try container.list([WorkstationTool].self, .tools)
        schedule = try container.decodeIfPresent(String.self, forKey: .schedule) ?? ""
        repetitiveTasks = try container.list([WorkstationTask].self, .repetitiveTasks)
        clientNeeds = try container.list([WorkstationClientNeed].self, .clientNeeds)
        preferences = try container.list([String].self, .preferences)
    }
}

/// `GET /v1/workstation/profile` : le profil (`nil` tant qu'aucun n'est établi) et les statistiques.
public struct WorkstationProfileReply: Codable, Equatable, Sendable {
    public var profile: WorkstationProfile?
    public var stats: WorkstationProfileStats

    public init(profile: WorkstationProfile? = nil, stats: WorkstationProfileStats = WorkstationProfileStats()) {
        self.profile = profile
        self.stats = stats
    }

    private enum CodingKeys: String, CodingKey { case profile, stats }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        profile = try container.decodeIfPresent(WorkstationProfile.self, forKey: .profile)
        stats = try container.decodeIfPresent(WorkstationProfileStats.self, forKey: .stats) ?? WorkstationProfileStats()
    }
}

// MARK: - Réunions

/// Un besoin retenu d'une réunion, avec la citation qui le porte.
public struct WorkstationMeetingNeed: Codable, Equatable, Sendable {
    public var need: String
    public var who: String?
    public var due: String?
    public var quote: String

    public init(need: String, who: String? = nil, due: String? = nil, quote: String = "") {
        self.need = need
        self.who = who
        self.due = due
        self.quote = quote
    }

    private enum CodingKeys: String, CodingKey { case need, who, due, quote }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        need = try container.decode(String.self, forKey: .need)
        who = try container.decodeIfPresent(String.self, forKey: .who)
        due = try container.decodeIfPresent(String.self, forKey: .due)
        quote = try container.decodeIfPresent(String.self, forKey: .quote) ?? ""
    }
}

/// Une réunion transcrite : `live` → `ended` → `digested` (ou `failed`).
public struct WorkstationMeeting: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var url: String
    public var startedAt: Double
    public var endedAt: Double?
    public var state: String
    public var summary: String?
    public var needs: [WorkstationMeetingNeed]
    /// Le nombre de segments transcrits.
    public var segments: Int

    public init(
        id: String, title: String, url: String = "", startedAt: Double, endedAt: Double? = nil, state: String,
        summary: String? = nil, needs: [WorkstationMeetingNeed] = [], segments: Int = 0
    ) {
        self.id = id
        self.title = title
        self.url = url
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.state = state
        self.summary = summary
        self.needs = needs
        self.segments = segments
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, url, startedAt, endedAt, state, summary, needs, segments
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? ""
        url = try container.decodeIfPresent(String.self, forKey: .url) ?? ""
        startedAt = try container.decodeIfPresent(Double.self, forKey: .startedAt) ?? 0
        endedAt = try container.decodeIfPresent(Double.self, forKey: .endedAt)
        state = try container.decodeIfPresent(String.self, forKey: .state) ?? ""
        summary = try container.decodeIfPresent(String.self, forKey: .summary)
        needs = try container.list([WorkstationMeetingNeed].self, .needs)
        segments = try container.decodeIfPresent(Int.self, forKey: .segments) ?? 0
    }
}

/// `GET /v1/workstation/meetings`.
public struct WorkstationMeetingList: Decodable, Equatable, Sendable {
    public var meetings: [WorkstationMeeting]

    private enum CodingKeys: String, CodingKey { case meetings }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        meetings = try container.list([WorkstationMeeting].self, .meetings)
    }
}
