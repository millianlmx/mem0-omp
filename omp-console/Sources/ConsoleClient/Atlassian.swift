// Atlassian (Jira, Confluence) côté client, partagé par la coque Mac et l'app iOS : la
// connexion OAuth du serveur au serveur Atlassian Rovo MCP, le plan du jour, la passe de
// savoir de la boîte, et les commentaires Jira que l'agent propose (routes `/v1/atlassian*`
// d'omp-harness, capacité `atlassian`).
//
// Comme tout le poste, la lecture est au PROPRIÉTAIRE : un jeton restreint reçoit 403, le
// modèle passe en `.reserved` et n'affiche rien. Un serveur antérieur, ou dont Atlassian est
// désactivé, répond 404 : `.absent`, la page est masquée. Les gestes exigent l'appareil
// approbateur : le refus du serveur (`.approverOnly`) reste dans `failure`.
//
// Il n'a ni transport ni jeton à lui : il est porté par `HarnessModel` (`server.atlassian`)
// et relit son état à chaque événement `atlassian`, `atlassian_write` ou `atlassian_plan`.
//
// Aucun texte ici : un échec est un `HarnessFailure`, que les écrans traduisent.

import Foundation

// MARK: - Contrat JSON

/// Le site Atlassian branché.
public struct AtlassianSite: Decodable, Equatable, Sendable {
    public var cloudId: String
    public var url: String

    public init(cloudId: String, url: String) {
        self.cloudId = cloudId
        self.url = url
    }
}

/// Un consentement en attente : le lien d'autorisation et son expiration (ms epoch).
public struct AtlassianPending: Decodable, Equatable, Sendable {
    public var authorizeUrl: String
    public var expiresAt: Double
}

/// Le plan automatique : l'heure locale (`nil` : pas de plan automatique), les jours ouvrés.
public struct AtlassianPlanSchedule: Decodable, Equatable, Sendable {
    public var hour: Int?
    public var weekdaysOnly: Bool
    public var lastAt: Double?

    public init(hour: Int? = nil, weekdaysOnly: Bool = true, lastAt: Double? = nil) {
        self.hour = hour
        self.weekdaysOnly = weekdaysOnly
        self.lastAt = lastAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hour = try c.decodeIfPresent(Int.self, forKey: .hour)
        weekdaysOnly = try c.decodeIfPresent(Bool.self, forKey: .weekdaysOnly) ?? true
        lastAt = try c.decodeIfPresent(Double.self, forKey: .lastAt)
    }

    private enum CodingKeys: String, CodingKey { case hour, weekdaysOnly, lastAt }
}

/// La passe de savoir : sa période (`nil` : pas de passe automatique), la dernière, son résumé.
public struct AtlassianKnowledge: Decodable, Equatable, Sendable {
    public var everyHours: Int?
    public var lastAt: Double?
    public var lastSummary: String?

    public init(everyHours: Int? = nil, lastAt: Double? = nil, lastSummary: String? = nil) {
        self.everyHours = everyHours
        self.lastAt = lastAt
        self.lastSummary = lastSummary
    }
}

/// `GET /v1/atlassian` : l'état du branchement. Un champ absent prend sa valeur neutre.
public struct AtlassianStatus: Decodable, Equatable, Sendable {
    public var enabled: Bool
    public var connected: Bool
    public var site: AtlassianSite?
    public var accountId: String?
    public var connectedAt: Double?
    public var connectedBy: String?
    public var expiresAt: Double?
    public var lastError: String?
    public var redirectUri: String
    /// Le retour du consentement arrive sur une boucle locale : l'app fait coller l'adresse.
    public var pasteBack: Bool
    public var pending: AtlassianPending?
    public var plan: AtlassianPlanSchedule
    public var knowledge: AtlassianKnowledge
    /// Les commentaires proposés qui attendent l'humain.
    public var proposed: Int
    /// L'espace de cette connexion ; `nil` : la connexion par défaut (hors espace), ou un serveur antérieur.
    public var space: String?
    /// La portée mémoire où va le savoir de cette connexion (`corpo`, ou `corpo:<espace>`) ; `nil` d'un serveur antérieur.
    public var scope: String?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        connected = try c.decodeIfPresent(Bool.self, forKey: .connected) ?? false
        site = try c.decodeIfPresent(AtlassianSite.self, forKey: .site)
        accountId = try c.decodeIfPresent(String.self, forKey: .accountId)
        connectedAt = try c.decodeIfPresent(Double.self, forKey: .connectedAt)
        connectedBy = try c.decodeIfPresent(String.self, forKey: .connectedBy)
        expiresAt = try c.decodeIfPresent(Double.self, forKey: .expiresAt)
        lastError = try c.decodeIfPresent(String.self, forKey: .lastError)
        redirectUri = try c.decodeIfPresent(String.self, forKey: .redirectUri) ?? ""
        pasteBack = try c.decodeIfPresent(Bool.self, forKey: .pasteBack) ?? false
        pending = try c.decodeIfPresent(AtlassianPending.self, forKey: .pending)
        plan = try c.decodeIfPresent(AtlassianPlanSchedule.self, forKey: .plan) ?? AtlassianPlanSchedule()
        knowledge = try c.decodeIfPresent(AtlassianKnowledge.self, forKey: .knowledge) ?? AtlassianKnowledge()
        proposed = try c.decodeIfPresent(Int.self, forKey: .proposed) ?? 0
        space = try c.decodeIfPresent(String.self, forKey: .space)
        scope = try c.decodeIfPresent(String.self, forKey: .scope)
    }

    private enum CodingKeys: String, CodingKey {
        case enabled, connected, site, accountId, connectedAt, connectedBy, expiresAt, lastError
        case redirectUri, pasteBack, pending, plan, knowledge, proposed, space, scope
    }
}

/// Une écriture Atlassian : un commentaire proposé par l'agent, ou une transition faite seule.
public struct AtlassianWrite: Decodable, Equatable, Sendable, Identifiable {
    public var id: String
    /// `comment` ou `transition`.
    public var kind: String
    public var issueKey: String
    /// Le texte du commentaire, ou le nom de la transition.
    public var body: String
    public var why: String
    /// `proposed`, `sent`, `dismissed` ou `failed`.
    public var state: String
    public var by: String
    public var error: String?
    public var decidedBy: String?
    public var createdAt: Double
    public var updatedAt: Double
    /// L'espace de la connexion qui l'a écrite ; `nil` : la connexion par défaut, ou un serveur antérieur.
    public var space: String?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "comment"
        issueKey = try c.decodeIfPresent(String.self, forKey: .issueKey) ?? ""
        body = try c.decodeIfPresent(String.self, forKey: .body) ?? ""
        why = try c.decodeIfPresent(String.self, forKey: .why) ?? ""
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? "proposed"
        by = try c.decodeIfPresent(String.self, forKey: .by) ?? ""
        error = try c.decodeIfPresent(String.self, forKey: .error)
        decidedBy = try c.decodeIfPresent(String.self, forKey: .decidedBy)
        createdAt = try c.decodeIfPresent(Double.self, forKey: .createdAt) ?? 0
        updatedAt = try c.decodeIfPresent(Double.self, forKey: .updatedAt) ?? 0
        space = try c.decodeIfPresent(String.self, forKey: .space)
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, issueKey, body, why, state, by, error, decidedBy, createdAt, updatedAt, space
    }
}

/// Un élément du plan du jour.
public struct AtlassianPlanItem: Decodable, Equatable, Sendable {
    public var title: String
    public var why: String
    /// La prochaine action concrète.
    public var next: String
    /// `jira`, `mail`, `agenda`, `confluence` ou `autre`.
    public var source: String
    public var key: String?
    public var url: String?
    /// Un dépôt déclaré où lancer la demande proposée.
    public var repo: String?
    public var request: String?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        why = try c.decodeIfPresent(String.self, forKey: .why) ?? ""
        next = try c.decodeIfPresent(String.self, forKey: .next) ?? ""
        source = try c.decodeIfPresent(String.self, forKey: .source) ?? "autre"
        key = try c.decodeIfPresent(String.self, forKey: .key)
        url = try c.decodeIfPresent(String.self, forKey: .url)
        repo = try c.decodeIfPresent(String.self, forKey: .repo)
        request = try c.decodeIfPresent(String.self, forKey: .request)
    }

    private enum CodingKeys: String, CodingKey { case title, why, next, source, key, url, repo, request }

    /// Le lien de l'élément, http(s) seulement.
    public var link: URL? { AtlassianModel.webURL(url) }

    /// La demande de run proposée, seulement avec un dépôt et un texte non vide.
    public var launch: (repo: String, request: String)? {
        guard let repo, !repo.isEmpty, let request,
              !request.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        return (repo, request)
    }
}

/// Le plan du jour.
public struct AtlassianPlan: Decodable, Equatable, Sendable, Identifiable {
    public var id: String
    public var createdAt: Double
    /// `auto` ou `manual`.
    public var trigger: String
    public var by: String
    public var summary: String
    public var items: [AtlassianPlanItem]
    /// L'espace de la connexion dont c'est le plan ; `nil` : la connexion par défaut, ou un serveur antérieur.
    public var space: String?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        createdAt = try c.decodeIfPresent(Double.self, forKey: .createdAt) ?? 0
        trigger = try c.decodeIfPresent(String.self, forKey: .trigger) ?? "auto"
        by = try c.decodeIfPresent(String.self, forKey: .by) ?? ""
        summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
        items = try c.decodeIfPresent([AtlassianPlanItem].self, forKey: .items) ?? []
        space = try c.decodeIfPresent(String.self, forKey: .space)
    }

    private enum CodingKeys: String, CodingKey { case id, createdAt, trigger, by, summary, items, space }
}

/// `POST /v1/atlassian/connect`.
public struct AtlassianConnection: Decodable, Equatable, Sendable {
    public var authorizeUrl: String
    public var redirectUri: String?
    public var expiresAt: Double?
    public var pasteBack: Bool?
}

struct AtlassianStatusReply: Decodable { var atlassian: AtlassianStatus }
struct AtlassianWritesReply: Decodable { var writes: [AtlassianWrite] }
struct AtlassianWriteReply: Decodable { var write: AtlassianWrite }
struct AtlassianPlanReply: Decodable { var plan: AtlassianPlan? }
struct AtlassianQueuedReply: Decodable { var queued: Bool? }

// MARK: - Modèle

@MainActor
public final class AtlassianModel: ObservableObject {
    /// Ce que le serveur relié dit d'Atlassian.
    public enum Availability: Equatable, Sendable {
        /// Pas encore lu.
        case unknown
        /// Le serveur sert Atlassian à ce jeton.
        case available
        /// Le serveur ne connaît pas les routes, ou Atlassian y est désactivé (404).
        case absent
        /// Le jeton n'est pas celui du propriétaire (403) : rien n'est montré.
        case reserved
    }

    /// Les gestes de la page, marqués en cours dans `busy` (les commentaires y sont par id).
    public static let connectGesture = "connect"
    public static let callbackGesture = "callback"
    public static let disconnectGesture = "disconnect"
    public static let planGesture = "plan"
    public static let knowledgeGesture = "knowledge"
    /// Les propositions lues d'un coup (le serveur borne une page à 200).
    public static let proposalsLimit = 200

    @Published public private(set) var availability: Availability = .unknown
    @Published public private(set) var status: AtlassianStatus?
    /// Les commentaires proposés (`proposed`), les plus récents d'abord.
    @Published public private(set) var proposals: [AtlassianWrite] = []
    @Published public private(set) var plan: AtlassianPlan?
    /// Les gestes (et les commentaires, par id) qui attendent la réponse du serveur.
    @Published public private(set) var busy: Set<String> = []
    /// Le dernier échec (lecture ou geste), effacé par le prochain succès.
    @Published public private(set) var failure: HarnessFailure?

    /// L'espace de cette connexion (`HarnessModel.atlassianConnection(for:)`) : chaque lecture et chaque
    /// geste de connexion portent `?space=` ; `nil` : la connexion par défaut, hors espace.
    public let space: String?

    weak var harness: HarnessModel?
    private let reloadDelay: Duration
    private var reloadTask: Task<Void, Never>?

    init(harness: HarnessModel, reloadDelay: Duration, space: String? = nil) {
        self.harness = harness
        self.reloadDelay = reloadDelay
        self.space = space
    }

    /// `path` pour cette connexion : tel quel pour la connexion par défaut, avec `?space=` pour celle d'un espace.
    private func scoped(_ path: String) -> String {
        space.map { HarnessModel.path(path, space: $0) } ?? path
    }

    /// La connexion d'un espace n'existe que sur un serveur qui l'annonce (`space-knowledge`) :
    /// ailleurs, `?space=` serait ignoré et la connexion par défaut passerait pour celle de
    /// l'espace. `nil` : les capacités du serveur n'ont pas pu être lues.
    private func isOffered(by harness: HarnessModel) async -> Bool? {
        guard space != nil else { return true }
        await harness.loadCapabilities()
        return harness.capabilities == nil ? nil : harness.serves(.spaceKnowledge)
    }

    /// Le badge : les commentaires qui attendent l'humain (0 hors d'un serveur qui les sert).
    public var pendingCount: Int {
        availability == .available ? proposals.count : 0
    }

    /// Ce jeton peut faire les gestes (sinon le serveur répond `.approverOnly`).
    public var isApprover: Bool { harness?.client?.approver ?? false }

    /// Une adresse http(s), sinon `nil`.
    nonisolated static func webURL(_ raw: String?) -> URL? {
        guard let raw, let url = URL(string: raw), let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http", url.host != nil
        else { return nil }
        return url
    }

    // MARK: - Lecture

    /// Relit l'état, les commentaires proposés et le dernier plan.
    public func refresh() async {
        guard let harness, harness.isConfigured else { return }
        guard let offered = await isOffered(by: harness) else { return }
        guard offered else {
            clear(.absent)
            return
        }
        let call = HarnessCall(method: "GET", path: scoped("/v1/atlassian"))
        do {
            let reply = try await harness.exchange(call)
            if reply.status == 404 {
                clear(.absent)
                return
            }
            let read: AtlassianStatusReply = try harness.decode(reply, for: call)
            let writes: AtlassianWritesReply = try await harness.fetch(
                HarnessCall(method: "GET", path: scoped("/v1/atlassian/writes?state=proposed&limit=\(Self.proposalsLimit)"))
            )
            let latest: AtlassianPlanReply = try await harness.fetch(HarnessCall(method: "GET", path: scoped("/v1/atlassian/plan")))
            status = read.atlassian
            proposals = writes.writes.filter { $0.state == "proposed" && $0.kind == "comment" }
            plan = latest.plan
            availability = .available
            failure = nil
        } catch HarnessFailure.forbidden {
            clear(.reserved)
        } catch {
            failure = HarnessModel.failure(of: error)
        }
    }

    /// Les événements du flux : `atlassian`, `atlassian_write`, `atlassian_plan` font relire
    /// (regroupé : une rafale ne coûte qu'une relecture).
    func receive(_ names: [String]) {
        guard names.contains(where: { $0 == "atlassian" || $0 == "atlassian_write" || $0 == "atlassian_plan" }) else { return }
        if availability == .absent || availability == .reserved { return }
        guard reloadTask == nil else { return }
        let delay = reloadDelay
        reloadTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self?.refresh()
            self?.reloadTask = nil
        }
    }

    /// Oublie tout ce qui a été lu : le serveur a changé (ou a été oublié).
    func reset() {
        reloadTask?.cancel()
        reloadTask = nil
        clear(.unknown)
        busy = []
    }

    private func clear(_ next: Availability) {
        availability = next
        status = nil
        proposals = []
        plan = nil
        failure = nil
    }

    // MARK: - Gestes de l'humain

    /// Ouvre un consentement : le lien d'autorisation à ouvrir dans le navigateur, `nil` sur
    /// un échec (dans `failure`).
    public func connect() async -> URL? {
        guard let reply: AtlassianConnection = await send("POST", scoped("/v1/atlassian/connect"), body: EmptyBody(), gesture: Self.connectGesture)
        else { return nil }
        await refresh()
        guard let url = Self.webURL(reply.authorizeUrl) else {
            failure = .unreadable
            return nil
        }
        return url
    }

    /// Donne au serveur l'adresse de retour collée (elle porte `code` et `state`).
    public func submitCallback(_ url: String) async -> Bool {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        guard let reply: AtlassianStatusReply = await send(
            "POST", scoped("/v1/atlassian/callback"), body: CallbackBody(url: trimmed), gesture: Self.callbackGesture
        ) else { return false }
        status = reply.atlassian
        await refresh()
        return true
    }

    /// Débranche : le serveur supprime ses jetons.
    @discardableResult
    public func disconnect() async -> Bool {
        guard let reply: AtlassianStatusReply = await send("DELETE", scoped("/v1/atlassian"), body: nil as EmptyBody?, gesture: Self.disconnectGesture)
        else { return false }
        status = reply.atlassian
        await refresh()
        return true
    }

    /// Publie le commentaire, avec le texte édité par l'humain (`nil` : celui de l'agent). Une
    /// écriture se tranche par son identifiant : le serveur retrouve sa connexion, sans `?space=`.
    @discardableResult
    public func approve(_ id: String, body: String? = nil) async -> Bool {
        let edited = body?.trimmingCharacters(in: .whitespacesAndNewlines)
        let path = "/v1/atlassian/writes/\(HarnessModel.pathComponent(id))/approve"
        return await decide(id, path: path, body: ApproveBody(body: edited?.isEmpty == false ? edited : nil))
    }

    /// Écarte le commentaire : rien n'est publié.
    @discardableResult
    public func dismiss(_ id: String) async -> Bool {
        await decide(id, path: "/v1/atlassian/writes/\(HarnessModel.pathComponent(id))/dismiss", body: EmptyBody())
    }

    /// Demande un nouveau plan du jour (le job tourne au prochain tour du poste).
    @discardableResult
    public func runPlan() async -> Bool {
        let reply: AtlassianQueuedReply? = await send("POST", scoped("/v1/atlassian/plan"), body: EmptyBody(), gesture: Self.planGesture)
        return reply != nil
    }

    /// Demande une passe de savoir de la boîte.
    @discardableResult
    public func runKnowledge() async -> Bool {
        let reply: AtlassianQueuedReply? = await send("POST", scoped("/v1/atlassian/knowledge"), body: EmptyBody(), gesture: Self.knowledgeGesture)
        return reply != nil
    }

    /// Un geste sur un commentaire : marqué en cours, puis la liste relue (une proposition
    /// traitée ailleurs disparaît, un échec d'Atlassian la fait passer `failed`).
    private func decide<Body: Encodable>(_ id: String, path: String, body: Body) async -> Bool {
        let reply: AtlassianWriteReply? = await send("POST", path, body: body, gesture: id)
        if reply != nil { proposals.removeAll { $0.id == id } }
        let kept = failure
        await refresh()
        if reply == nil, failure == nil { failure = kept }
        return reply != nil
    }

    /// Un envoi décodé ; un échec reste dans `failure` et rend `nil`.
    private func send<Body: Encodable, Reply: Decodable>(_ method: String, _ path: String, body: Body?, gesture: String) async -> Reply? {
        guard let harness, harness.isConfigured else {
            failure = .unreachable
            return nil
        }
        // La connexion d'un espace n'agit qu'une fois lue : jamais vers un serveur qui ignorerait `?space=`.
        guard space == nil || availability == .available else { return nil }
        var encoded: Data?
        if let body {
            guard let data = try? JSONEncoder().encode(body) else {
                failure = .unreadable
                return nil
            }
            encoded = data
        }
        busy.insert(gesture)
        defer { busy.remove(gesture) }
        let call = HarnessCall(method: method, path: path, body: encoded)
        do {
            let reply: Reply = try harness.decode(try await harness.exchange(call), for: call)
            failure = nil
            return reply
        } catch {
            failure = HarnessModel.failure(of: error)
            return nil
        }
    }
}

private struct EmptyBody: Encodable {}

private struct CallbackBody: Encodable {
    var url: String
}

/// `body` absent du JSON quand l'humain n'a rien changé.
private struct ApproveBody: Encodable {
    var body: String?
}
