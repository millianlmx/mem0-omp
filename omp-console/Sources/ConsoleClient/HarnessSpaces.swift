// Les ESPACES (un client : ses dépôts, son budget du jour, son autonomie ; omp-harness
// spaces.ts, capacité `spaces`) : `GET /v1/spaces` avec leurs chiffres, `POST`, `PUT`
// (`If-Match`), `DELETE /v1/spaces/{id}` (admin), le rapport d'un espace
// (`GET /v1/spaces/{id}/report`), événement `space`.
//
// Un serveur antérieur ne sert pas la route (404) : `availability == .absent`, et rien ne
// se range par espace. Aucun texte ici.

import Combine
import Foundation

/// Les chiffres d'un espace : ses fils vivants, sa semaine, ses coûts.
public struct HarnessSpaceStats: Codable, Equatable, Sendable {
    public var working: Int
    /// Ce qui attend l'humain.
    public var yours: Int
    public var queued: Int
    public var mergedWeek: Int
    public var failedWeek: Int
    public var cancelledWeek: Int
    public var costToday: Double
    public var costWeek: Double
    /// Ce qu'il reste du budget du jour, en dollars ; `nil` sans budget.
    public var budgetLeftToday: Double?

    public init(
        working: Int = 0, yours: Int = 0, queued: Int = 0, mergedWeek: Int = 0, failedWeek: Int = 0, cancelledWeek: Int = 0,
        costToday: Double = 0, costWeek: Double = 0, budgetLeftToday: Double? = nil
    ) {
        self.working = working
        self.yours = yours
        self.queued = queued
        self.mergedWeek = mergedWeek
        self.failedWeek = failedWeek
        self.cancelledWeek = cancelledWeek
        self.costToday = costToday
        self.costWeek = costWeek
        self.budgetLeftToday = budgetLeftToday
    }
}

/// Un espace tel que `/v1/spaces` le rend (`SpaceView` du serveur).
public struct HarnessSpace: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    /// Ses dépôts : un dépôt appartient à un espace au plus.
    public var repos: [String]
    /// Le poste de travail (extension Chrome, agent 24/24) travaille pour cet espace.
    public var poste: Bool
    public var jiraProjects: [String]
    /// Le plafond de dépense du jour, en dollars ; `nil` : aucun.
    public var dailyBudgetUsd: Double?
    /// L'autonomie par défaut des features de ses dépôts ; `nil` : les règles de chaque dépôt.
    public var autonomy: HarnessRunAutonomy?
    public var by: String?
    public var createdAt: Double
    public var updatedAt: Double
    /// La révision de l'espace : renvoyée en `If-Match` avec une modification.
    public var rev: Int
    /// Les portées de mémoire de ses dépôts, en lecture seule (vides hors de la liste).
    public var memoryScopes: [String] = []
    /// Ses chiffres (à zéro hors de la liste).
    public var stats: HarnessSpaceStats = HarnessSpaceStats()

    public init(
        id: String, name: String, repos: [String] = [], poste: Bool = false, jiraProjects: [String] = [], dailyBudgetUsd: Double? = nil,
        autonomy: HarnessRunAutonomy? = nil, by: String? = nil, createdAt: Double = 0, updatedAt: Double = 0, rev: Int = 0,
        memoryScopes: [String] = [], stats: HarnessSpaceStats = HarnessSpaceStats()
    ) {
        self.id = id
        self.name = name
        self.repos = repos
        self.poste = poste
        self.jiraProjects = jiraProjects
        self.dailyBudgetUsd = dailyBudgetUsd
        self.autonomy = autonomy
        self.by = by
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.rev = rev
        self.memoryScopes = memoryScopes
        self.stats = stats
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, repos, poste, jiraProjects, dailyBudgetUsd, autonomy, by, createdAt, updatedAt, rev, memoryScopes, stats
    }

    /// L'espace rendu par une écriture (`{space}`) peut ne porter ni portées ni chiffres ; un
    /// niveau d'autonomie inconnu de cette version se lit comme « les règles du dépôt ».
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        repos = try container.decode([String].self, forKey: .repos)
        poste = try container.decode(Bool.self, forKey: .poste)
        jiraProjects = try container.decode([String].self, forKey: .jiraProjects)
        dailyBudgetUsd = try container.decodeIfPresent(Double.self, forKey: .dailyBudgetUsd)
        autonomy = try container.decodeIfPresent(String.self, forKey: .autonomy).flatMap(HarnessRunAutonomy.init(rawValue:))
        by = try container.decodeIfPresent(String.self, forKey: .by)
        createdAt = try container.decode(Double.self, forKey: .createdAt)
        updatedAt = try container.decode(Double.self, forKey: .updatedAt)
        rev = try container.decode(Int.self, forKey: .rev)
        memoryScopes = try container.decodeIfPresent([String].self, forKey: .memoryScopes) ?? []
        stats = try container.decodeIfPresent(HarnessSpaceStats.self, forKey: .stats) ?? HarnessSpaceStats()
    }
}

/// `GET /v1/spaces`.
public struct HarnessSpaceList: Codable, Equatable, Sendable {
    public var spaces: [HarnessSpace]
}

/// `POST /v1/spaces`, `PUT /v1/spaces/{id}`.
struct HarnessSpaceReply: Decodable {
    var space: HarnessSpace
}

/// Le rapport d'un espace (`GET /v1/spaces/{id}/report`) : le texte du serveur (Markdown),
/// ses compteurs et le coût de la fenêtre.
public struct HarnessSpaceReport: Decodable, Equatable, Sendable {
    public var since: Double
    public var until: Double
    public var text: String
    public var counts: HarnessDigestCounts
    public var cost: Double

    public init(since: Double, until: Double, text: String, counts: HarnessDigestCounts = HarnessDigestCounts(), cost: Double = 0) {
        self.since = since
        self.until = until
        self.text = text
        self.counts = counts
        self.cost = cost
    }
}

/// Un espace en cours de saisie : ce que `POST` et `PUT /v1/spaces` acceptent.
public struct HarnessSpaceDraft: Equatable, Sendable {
    public enum Problem: Equatable, Sendable {
        /// Le nom est vide ou dépasse 60 caractères.
        case name
        /// Le budget du jour n'est pas un montant positif.
        case budget
    }

    /// La longueur que le serveur accepte pour un nom.
    public static let maxNameLength = 60

    public var name: String
    public var repos: [String]
    public var poste: Bool
    public var jiraProjects: [String]
    public var dailyBudgetUsd: Double?
    public var autonomy: HarnessRunAutonomy?

    public init(
        name: String = "", repos: [String] = [], poste: Bool = false, jiraProjects: [String] = [], dailyBudgetUsd: Double? = nil,
        autonomy: HarnessRunAutonomy? = nil
    ) {
        self.name = name
        self.repos = repos
        self.poste = poste
        self.jiraProjects = jiraProjects
        self.dailyBudgetUsd = dailyBudgetUsd
        self.autonomy = autonomy
    }

    /// La saisie d'un espace existant, à modifier.
    public init(_ space: HarnessSpace) {
        self.init(
            name: space.name, repos: space.repos, poste: space.poste, jiraProjects: space.jiraProjects,
            dailyBudgetUsd: space.dailyBudgetUsd, autonomy: space.autonomy
        )
    }

    /// Le premier défaut de la saisie, ou `nil` si elle peut partir.
    public var problem: Problem? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed.count > Self.maxNameLength { return .name }
        if let dailyBudgetUsd, !(dailyBudgetUsd.isFinite && dailyBudgetUsd > 0) { return .budget }
        return nil
    }
}

/// Le corps d'une écriture : `dailyBudgetUsd` et `autonomy` partent en `null` quand ils sont
/// vides (une modification les efface), les listes rognées et sans doublon.
private struct SpaceBody: Encodable {
    var draft: HarnessSpaceDraft

    private enum CodingKeys: String, CodingKey { case name, repos, poste, jiraProjects, dailyBudgetUsd, autonomy }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(draft.name.trimmingCharacters(in: .whitespacesAndNewlines), forKey: .name)
        try container.encode(Self.cleaned(draft.repos), forKey: .repos)
        try container.encode(draft.poste, forKey: .poste)
        try container.encode(Self.cleaned(draft.jiraProjects), forKey: .jiraProjects)
        try container.encode(draft.dailyBudgetUsd, forKey: .dailyBudgetUsd)
        try container.encode(draft.autonomy?.rawValue, forKey: .autonomy)
    }

    private static func cleaned(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty && seen.insert($0).inserted }
    }
}

@MainActor
public final class HarnessSpacesModel: ObservableObject {
    @Published public private(set) var availability: HarnessFeatureAvailability = .unknown
    /// Les espaces visibles, par nom.
    @Published public private(set) var spaces: [HarnessSpace] = []
    @Published public private(set) var failure: HarnessFailure?
    @Published public private(set) var isLoading = false
    /// Les espaces dont un geste attend la réponse du serveur.
    @Published public private(set) var busy: Set<String> = []
    /// Une création attend la réponse du serveur.
    @Published public private(set) var isSaving = false

    private unowned let harness: HarnessModel
    private let reloader: HarnessReloader

    init(harness: HarnessModel, reloadDelay: Duration) {
        self.harness = harness
        reloader = HarnessReloader(delay: reloadDelay)
    }

    /// Le serveur relié sert les espaces (inconnu compris : rien ne clignote).
    public var isServed: Bool { availability != .absent }

    /// L'espace d'un dépôt, ou `nil` (dépôt hors de tout espace).
    public func space(ofRepo repo: String?) -> HarnessSpace? {
        OSThreads.space(ofRepo: repo, spaces: spaces)
    }

    /// Relit les espaces et leurs chiffres ; un serveur antérieur (404) n'en a pas, sans échec.
    public func refresh() async {
        guard harness.isConfigured else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            guard let list: HarnessSpaceList = try await harness.readBound("/v1/spaces") else {
                availability = .absent
                spaces = []
                failure = nil
                return
            }
            spaces = list.spaces.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            availability = .available
            failure = nil
        } catch {
            availability = HarnessControlFailure.availability(after: error, current: availability)
            failure = HarnessModel.failure(of: error)
        }
    }

    /// Crée un espace (admin) ; rend celui que le serveur a gardé.
    @discardableResult
    public func create(_ draft: HarnessSpaceDraft) async -> HarnessSpace? {
        guard draft.problem == nil else {
            failure = .rejected("")
            return nil
        }
        isSaving = true
        defer { isSaving = false }
        do {
            let reply: HarnessSpaceReply = try await harness.write("POST", "/v1/spaces", body: SpaceBody(draft: draft))
            failure = nil
            await refresh()
            return reply.space
        } catch {
            failure = HarnessModel.failure(of: error)
            return nil
        }
    }

    /// Modifie un espace (admin) à la révision lue : refusé (412) si un autre l'a changé depuis.
    @discardableResult
    public func update(_ space: HarnessSpace, _ draft: HarnessSpaceDraft) async -> Bool {
        guard draft.problem == nil else {
            failure = .rejected("")
            return false
        }
        let reply: HarnessSpaceReply? = await gesture(space, "PUT", body: SpaceBody(draft: draft), headers: ["If-Match": "\"\(space.rev)\""])
        return reply != nil
    }

    /// Supprime un espace (admin) : ses dépôts restent, hors de tout espace.
    @discardableResult
    public func delete(_ space: HarnessSpace) async -> Bool {
        let reply: HarnessAck? = await gesture(space, "DELETE", body: nil as SpaceBody?, headers: [:])
        return reply != nil
    }

    /// Le rapport d'un espace depuis `since` (millisecondes ; absent : 7 jours), ou `nil`
    /// (espace disparu, serveur antérieur) ; un échec reste dans `failure`.
    public func report(_ space: HarnessSpace, since: Double? = nil) async -> HarnessSpaceReport? {
        var path = "/v1/spaces/\(HarnessModel.pathComponent(space.id))/report"
        if let since { path += "?since=\(Int(since))" }
        do {
            let report: HarnessSpaceReport? = try await harness.readBound(path)
            failure = nil
            return report
        } catch {
            failure = HarnessModel.failure(of: error)
            return nil
        }
    }

    private func gesture<Body: Encodable, Reply: Decodable>(
        _ space: HarnessSpace, _ method: String, body: Body?, headers: [String: String]
    ) async -> Reply? {
        busy.insert(space.id)
        defer { busy.remove(space.id) }
        do {
            let reply: Reply = try await harness.write(method, "/v1/spaces/\(HarnessModel.pathComponent(space.id))", body: body, headers: headers)
            failure = nil
            await refresh()
            return reply
        } catch {
            let failed = HarnessModel.failure(of: error)
            if failed == .stale { await refresh() }
            failure = failed
            return nil
        }
    }

    /// L'événement `space` (un autre appareil admin) fait relire.
    func receive(_ names: [String]) {
        guard availability == .available, names.contains("space") else { return }
        reloader.schedule { [weak self] in await self?.refresh() }
    }

    func reset() {
        reloader.cancel()
        availability = .unknown
        spaces = []
        failure = nil
        busy = []
    }
}
