// COMPRENDRE, vu du client (omp-harness brief.ts et scoreboard.ts, capacités `brief` et
// `scoreboard`) : le BRIEF « pendant votre absence » (`GET /v1/brief`, marqué vu par
// `POST /v1/brief/seen`) et les CHIFFRES — les trois indicateurs de la boucle
// (`GET /v1/scoreboard`) : part des features livrées sans geste humain, délai médian
// d'une décision, part du travail lancé sans l'humain.
//
// Un serveur antérieur ne sert pas ces routes (404) : `availability == .absent`, rien ne
// s'affiche. Aucun texte ici : la phrase d'en-tête du brief est celle du serveur.

import Combine
import Foundation

// MARK: - Brief

/// Une feature livrée (fusionnée) dans la fenêtre.
public struct HarnessBriefDelivered: Codable, Equatable, Sendable, Identifiable {
    public var runId: String
    public var repo: String
    public var title: String
    public var prUrl: String?
    public var at: Double
    public var cost: Double?
    /// Livrée sans aucun geste humain.
    public var alone: Bool

    public var id: String { runId }

    public init(runId: String, repo: String, title: String, prUrl: String? = nil, at: Double = 0, cost: Double? = nil, alone: Bool = false) {
        self.runId = runId
        self.repo = repo
        self.title = title
        self.prUrl = prUrl
        self.at = at
        self.cost = cost
        self.alone = alone
    }
}

/// Une feature qui attend l'humain.
public struct HarnessBriefWaiting: Codable, Equatable, Sendable, Identifiable {
    public var runId: String
    public var repo: String
    public var title: String
    /// `questions`, `specs`, `verdict`, `irreversible`, `arbitration`, `budget` ou `failure`.
    public var wait: String
    public var since: Double

    public var id: String { runId }

    public init(runId: String, repo: String, title: String, wait: String, since: Double = 0) {
        self.runId = runId
        self.repo = repo
        self.title = title
        self.wait = wait
        self.since = since
    }
}

/// Une feature en échec.
public struct HarnessBriefFailed: Codable, Equatable, Sendable, Identifiable {
    public var runId: String
    public var repo: String
    public var title: String
    public var reason: String?
    public var at: Double

    public var id: String { runId }

    public init(runId: String, repo: String, title: String, reason: String? = nil, at: Double = 0) {
        self.runId = runId
        self.repo = repo
        self.title = title
        self.reason = reason
        self.at = at
    }
}

/// Une feature annulée, avec son motif s'il a été donné.
public struct HarnessBriefStopped: Codable, Equatable, Sendable, Identifiable {
    public var runId: String
    public var repo: String
    public var title: String
    public var cause: String?
    public var at: Double

    public var id: String { runId }

    public init(runId: String, repo: String, title: String, cause: String? = nil, at: Double = 0) {
        self.runId = runId
        self.repo = repo
        self.title = title
        self.cause = cause
        self.at = at
    }

    /// Le motif connu, ou `nil` (aucun, ou apparu après cette version de l'app).
    public var reason: HarnessCancelCause? { cause.flatMap(HarnessCancelCause.init(rawValue:)) }
}

/// Une décision prise seule, à relire.
public struct HarnessBriefDecided: Codable, Equatable, Sendable, Identifiable {
    public var runId: String
    public var repo: String
    public var title: String
    public var seq: Int
    public var question: String
    public var chosen: String
    public var status: String

    public var id: String { "\(runId)/\(seq)" }

    public init(runId: String, repo: String, title: String, seq: Int, question: String, chosen: String, status: String = "auto") {
        self.runId = runId
        self.repo = repo
        self.title = title
        self.seq = seq
        self.question = question
        self.chosen = chosen
        self.status = status
    }
}

/// Une feature retenue en file, et ce qui la retient.
public struct HarnessBriefBlocked: Codable, Equatable, Sendable, Identifiable {
    public var runId: String
    public var repo: String
    public var title: String
    /// La cause de l'admission (`slots`, `modules`, `parent`, `backoff`, `paused`, `space_budget`…).
    public var cause: String
    public var text: String

    public var id: String { runId }

    public init(runId: String, repo: String, title: String, cause: String, text: String = "") {
        self.runId = runId
        self.repo = repo
        self.title = title
        self.cause = cause
        self.text = text
    }
}

/// Le brief « pendant votre absence » (`GET /v1/brief`).
public struct HarnessBrief: Codable, Equatable, Sendable {
    public var since: Double
    public var until: Double
    /// Le dernier « vu » de ce client, en millisecondes ; `nil` : jamais.
    public var seenAt: Double?
    /// Une phrase du serveur : « 3 livrées, 1 vous attend, 2 propositions — 4,20 $ ».
    public var headline: String
    public var delivered: [HarnessBriefDelivered]
    public var waiting: [HarnessBriefWaiting]
    public var failed: [HarnessBriefFailed]
    public var stopped: [HarnessBriefStopped]
    public var decided: [HarnessBriefDecided]
    public var blocked: [HarnessBriefBlocked]
    /// Les propositions ouvertes.
    public var proposals: Int
    /// Le coût de la fenêtre, en dollars.
    public var cost: Double

    public init(
        since: Double = 0, until: Double = 0, seenAt: Double? = nil, headline: String = "", delivered: [HarnessBriefDelivered] = [],
        waiting: [HarnessBriefWaiting] = [], failed: [HarnessBriefFailed] = [], stopped: [HarnessBriefStopped] = [],
        decided: [HarnessBriefDecided] = [], blocked: [HarnessBriefBlocked] = [], proposals: Int = 0, cost: Double = 0
    ) {
        self.since = since
        self.until = until
        self.seenAt = seenAt
        self.headline = headline
        self.delivered = delivered
        self.waiting = waiting
        self.failed = failed
        self.stopped = stopped
        self.decided = decided
        self.blocked = blocked
        self.proposals = proposals
        self.cost = cost
    }

    /// Rien de neuf dans la fenêtre.
    public var isEmpty: Bool {
        delivered.isEmpty && waiting.isEmpty && failed.isEmpty && stopped.isEmpty && decided.isEmpty && blocked.isEmpty && proposals == 0
    }

    /// Les features livrées sans aucun geste humain.
    public var deliveredAlone: Int { delivered.filter(\.alone).count }
}

/// `GET /v1/brief`.
struct HarnessBriefReply: Decodable {
    var brief: HarnessBrief
}

/// `POST /v1/brief/seen`.
struct HarnessBriefSeenReply: Decodable {
    var seenAt: Double
}

private struct NoBriefBody: Encodable {}

@MainActor
public final class HarnessBriefModel: ObservableObject {
    /// Les événements qui changent le brief : un état de feature, une fusion, une décision
    /// prise seule, l'ensemble des propositions.
    static let events: Set<String> = ["run_state", "merged", "decision", "decision_auto_timeout", "proposals"]

    @Published public private(set) var availability: HarnessFeatureAvailability = .unknown
    @Published public private(set) var brief: HarnessBrief?
    @Published public private(set) var failure: HarnessFailure?
    @Published public private(set) var isLoading = false

    private unowned let harness: HarnessModel
    private let reloader: HarnessReloader
    /// La fenêtre demandée en dernier (`since`) : une relecture la garde.
    private var window: Double?

    init(harness: HarnessModel, reloadDelay: Duration) {
        self.harness = harness
        reloader = HarnessReloader(delay: reloadDelay)
    }

    /// Le serveur relié sert le brief (inconnu compris : rien ne clignote).
    public var isServed: Bool { availability != .absent }

    /// Le chemin du brief ; sans `since`, le serveur repart du dernier « vu » de ce client (sinon 24 h).
    public nonisolated static func path(since: Double?) -> String {
        since.map { "/v1/brief?since=\(Int($0))" } ?? "/v1/brief"
    }

    /// Relit le brief depuis `since` (millisecondes), dans la portée courante (l'espace choisi,
    /// ou tous) ; un serveur antérieur (404) n'en a pas, sans échec.
    public func refresh(since: Double? = nil) async {
        window = since
        guard harness.isConfigured else { return }
        isLoading = true
        defer { isLoading = false }
        await reload()
    }

    /// La lecture sans rien en dire (le flux) ; rien n'est republié à l'identique.
    private func reload() async {
        guard harness.isConfigured else { return }
        do {
            let read: HarnessScopedRead<HarnessBriefReply> = try await harness.readScoped(Self.path(since: window))
            guard let reply = read.value else {
                update(\.availability, .absent)
                update(\.brief, nil)
                update(\.failure, nil)
                return
            }
            // Un serveur qui ne borne pas le brief à un espace : ses listes le sont ici, par dépôt.
            update(\.brief, OSSpaces.brief(reply.brief, in: read.filter))
            update(\.availability, .available)
            update(\.failure, nil)
        } catch {
            update(\.availability, HarnessControlFailure.availability(after: error, current: availability))
            update(\.failure, HarnessModel.failure(of: error))
        }
    }

    /// Marque le brief comme vu : le prochain repartira de maintenant. Le brief affiché reste.
    @discardableResult
    public func markSeen() async -> Bool {
        do {
            let reply: HarnessBriefSeenReply = try await harness.write("POST", "/v1/brief/seen", body: NoBriefBody())
            brief?.seenAt = reply.seenAt
            failure = nil
            return true
        } catch {
            failure = HarnessModel.failure(of: error)
            return false
        }
    }

    /// Un brief déjà lu se tient à jour : chaque événement qui le change le fait relire.
    func receive(_ names: [String]) {
        guard availability == .available, names.contains(where: Self.events.contains) else { return }
        reloader.schedule { [weak self] in await self?.reload() }
    }

    /// La portée a changé : le brief de l'ancienne ne reste pas à l'écran, celui de la nouvelle est lu.
    func rescope() {
        guard availability == .available else { return }
        brief = nil
        Task { [weak self] in await self?.reload() }
    }

    func reset() {
        reloader.cancel()
        availability = .unknown
        brief = nil
        failure = nil
        window = nil
    }
}

// MARK: - Chiffres

/// Les chiffres d'un dépôt, et le palier d'autonomie que le serveur suggère.
public struct HarnessScoreboardRepo: Codable, Equatable, Sendable, Identifiable {
    public var repo: String
    public var merged: Int
    public var mergedAlone: Int
    public var cancelled: Int
    public var failed: Int
    /// La part des features terminées qui ont été livrées ; `nil` sans feature terminée.
    public var successRate: Double?
    /// `raise` (monter l'autonomie), `lower` (la rendre à l'humain) ou `nil`.
    public var suggestion: String?

    public var id: String { repo }

    public init(
        repo: String, merged: Int = 0, mergedAlone: Int = 0, cancelled: Int = 0, failed: Int = 0, successRate: Double? = nil,
        suggestion: String? = nil
    ) {
        self.repo = repo
        self.merged = merged
        self.mergedAlone = mergedAlone
        self.cancelled = cancelled
        self.failed = failed
        self.successRate = successRate
        self.suggestion = suggestion
    }
}

/// Les trois indicateurs de la boucle sur une fenêtre (`GET /v1/scoreboard`).
public struct HarnessScoreboard: Codable, Equatable, Sendable {
    /// La clé des annulations sans motif dans `cancelCauses`.
    public static let noCause = "none"

    public var since: Double
    public var until: Double
    public var merged: Int
    /// Fusionnées sans aucun geste humain.
    public var mergedAlone: Int
    public var aloneRate: Double?
    /// Les attentes levées par un geste humain.
    public var decisions: Int
    /// Le délai médian entre la pose d'une attente et le geste qui la lève, en millisecondes.
    public var medianDecisionMs: Double?
    public var started: Int
    /// Lancées sans l'humain (planification, issue, vigie, pilote, audit, découpage, suite).
    public var startedAlone: Int
    public var startedAloneRate: Double?
    public var cancelled: Int
    /// Les annulations par motif ; `none` : sans motif.
    public var cancelCauses: [String: Int]
    public var repos: [HarnessScoreboardRepo]

    public init(
        since: Double = 0, until: Double = 0, merged: Int = 0, mergedAlone: Int = 0, aloneRate: Double? = nil, decisions: Int = 0,
        medianDecisionMs: Double? = nil, started: Int = 0, startedAlone: Int = 0, startedAloneRate: Double? = nil, cancelled: Int = 0,
        cancelCauses: [String: Int] = [:], repos: [HarnessScoreboardRepo] = []
    ) {
        self.since = since
        self.until = until
        self.merged = merged
        self.mergedAlone = mergedAlone
        self.aloneRate = aloneRate
        self.decisions = decisions
        self.medianDecisionMs = medianDecisionMs
        self.started = started
        self.startedAlone = startedAlone
        self.startedAloneRate = startedAloneRate
        self.cancelled = cancelled
        self.cancelCauses = cancelCauses
        self.repos = repos
    }

    /// Les motifs d'annulation, du plus fréquent au plus rare (à égalité, par nom).
    public var rankedCancelCauses: [(cause: String, count: Int)] {
        cancelCauses.map { (cause: $0.key, count: $0.value) }.sorted { ($1.count, $0.cause) < ($0.count, $1.cause) }
    }
}

/// `GET /v1/scoreboard`.
struct HarnessScoreboardReply: Decodable {
    var scoreboard: HarnessScoreboard
}

@MainActor
public final class HarnessScoreboardModel: ObservableObject {
    /// Les bornes de la fenêtre, celles du serveur, et son défaut.
    public nonisolated static let daysRange = 1 ... 90
    public nonisolated static let defaultDays = 7

    @Published public private(set) var availability: HarnessFeatureAvailability = .unknown
    @Published public private(set) var scoreboard: HarnessScoreboard?
    /// La fenêtre lue en dernier, en jours.
    @Published public private(set) var days = HarnessScoreboardModel.defaultDays
    @Published public private(set) var failure: HarnessFailure?
    @Published public private(set) var isLoading = false

    private unowned let harness: HarnessModel

    init(harness: HarnessModel) {
        self.harness = harness
    }

    /// Le serveur relié sert les chiffres (inconnu compris : rien ne clignote).
    public var isServed: Bool { availability != .absent }

    /// Relit les chiffres sur `days` jours (bornés de 1 à 90 ; absent : la fenêtre en cours),
    /// dans la portée courante ; un serveur antérieur (404) n'en a pas, sans échec.
    public func refresh(days requested: Int? = nil) async {
        if let requested { days = min(max(requested, Self.daysRange.lowerBound), Self.daysRange.upperBound) }
        guard harness.isConfigured else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let read: HarnessScopedRead<HarnessScoreboardReply> = try await harness.readScoped("/v1/scoreboard?days=\(days)")
            guard let reply = read.value else {
                availability = .absent
                scoreboard = nil
                failure = nil
                return
            }
            // Un serveur qui ne borne pas les chiffres à un espace : ce qui se compte par dépôt l'est ici.
            scoreboard = OSSpaces.scoreboard(reply.scoreboard, in: read.filter)
            availability = .available
            failure = nil
        } catch {
            availability = HarnessControlFailure.availability(after: error, current: availability)
            failure = HarnessModel.failure(of: error)
        }
    }

    /// La portée a changé : les chiffres de l'ancienne ne restent pas à l'écran, ceux de la nouvelle sont lus.
    func rescope() {
        guard availability == .available else { return }
        scoreboard = nil
        Task { [weak self] in await self?.refresh() }
    }

    func reset() {
        availability = .unknown
        scoreboard = nil
        days = Self.defaultDays
        failure = nil
    }
}
