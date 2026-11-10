// Les modèles observables de la TOUR DE CONTRÔLE, portés par `HarnessModel` comme le
// poste et l'historique (même transport, même jeton) : la vigie, les planifications,
// l'administration et les issues. Chacun est lu à la demande de son écran ; le flux de
// la boîte relit ceux qu'un écran observe quand un de leurs événements arrive.
//
// Un serveur antérieur à une fonction ne sert pas sa route (404) : le modèle le dit
// (`availability == .absent`), sans échec affiché. Un jeton qui n'y a pas droit (403) :
// `.forbidden(motif)`. Aucun texte ici : les écrans traduisent.

import Combine
import ConsoleCore
import Foundation

/// Ce que le serveur relié dit d'une fonction de la tour de contrôle.
public enum HarnessFeatureAvailability: Equatable, Sendable {
    /// Pas encore lue.
    case unknown
    case available
    /// Le serveur ne sert pas la route (antérieur à la fonction).
    case absent
    /// Le jeton n'y a pas droit ; le motif du serveur.
    case forbidden(String)
}

extension HarnessModel {
    /// Une lecture d'une route qu'un serveur antérieur ne sert pas : 404 rend `nil`.
    func readIfServed<T: Decodable>(_ path: String) async throws -> T? {
        let call = HarnessCall(method: "GET", path: path)
        let reply = try await exchange(call)
        if reply.status == 404 { return nil }
        return try decode(reply, for: call)
    }

    /// Une écriture JSON décodée.
    func write<Body: Encodable, Reply: Decodable>(_ method: String, _ path: String, body: Body?, headers: [String: String] = [:]) async throws -> Reply {
        var encoded: Data?
        if let body {
            guard let data = try? JSONEncoder().encode(body) else { throw HarnessFailure.unreadable }
            encoded = data
        }
        return try await fetch(HarnessCall(method: method, path: path, body: encoded, headers: headers))
    }

    nonisolated static func pathComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#"))) ?? value
    }

    nonisolated static func queryValue(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? value
    }
}

private struct NoBody: Encodable {}

// MARK: - Vigie

/// La VIGIE : son mode, ses plafonds, son battement de cœur et ses incidents.
@MainActor
public final class HarnessVigie: ObservableObject {
    public nonisolated static let incidentsLimit = 100

    @Published public private(set) var availability: HarnessFeatureAvailability = .unknown
    @Published public private(set) var view: VigieView?
    @Published public private(set) var incidents: [VigieIncident] = []
    /// Le statut retenu dans la liste des incidents ; `nil` : tous.
    @Published public var statusFilter: VigieIncidentStatus? { didSet { if statusFilter != oldValue { Task { await refresh() } } } }
    @Published public private(set) var failure: HarnessFailure?
    @Published public private(set) var isLoading = false
    @Published public private(set) var isSaving = false
    /// Un écran observe la vigie : le flux la relit à chacun de ses événements.
    public private(set) var isWatched = false

    private unowned let harness: HarnessModel

    init(harness: HarnessModel) {
        self.harness = harness
    }

    /// La vigie est muette (plus de battement depuis 5 minutes) alors qu'elle n'est pas coupée.
    public var isSilent: Bool { view?.isSilent ?? false }

    /// Le chemin de la liste des incidents, filtrée par statut.
    public nonisolated static func incidentsPath(status: VigieIncidentStatus?) -> String {
        var path = "/v1/vigie/incidents?limit=\(incidentsLimit)"
        if let status { path += "&status=\(status.rawValue)" }
        return path
    }

    /// Relit la vigie et ses incidents. Sans écran qui l'observe, seule la vue est lue
    /// (le bandeau « vigie muette » de l'Accueil en a besoin).
    public func refresh() async {
        guard harness.isConfigured else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            guard let read: VigieView = try await harness.readIfServed("/v1/vigie") else {
                availability = .absent
                view = nil
                incidents = []
                return
            }
            view = read
            availability = .available
            if isWatched {
                let list: VigieIncidentList = try await harness.fetch(HarnessCall(method: "GET", path: Self.incidentsPath(status: statusFilter)))
                incidents = list.incidents
            }
            failure = nil
        } catch {
            availability = HarnessControlFailure.availability(after: error, current: availability)
            failure = HarnessModel.failure(of: error)
        }
    }

    /// Ouvre l'écran de la vigie : vue et incidents, relus ensuite à chacun de ses événements.
    public func load() async {
        isWatched = true
        await refresh()
    }

    /// Enregistre les réglages (admin) ; seuls les champs donnés changent.
    @discardableResult
    public func save(_ settings: VigieSettings) async -> Bool {
        isSaving = true
        defer { isSaving = false }
        do {
            let reply: VigieSettingsReply = try await harness.write("PUT", "/v1/vigie", body: settings)
            view?.settings = reply.settings
            failure = nil
            await refresh()
            return true
        } catch {
            failure = HarnessModel.failure(of: error)
            return false
        }
    }

    /// Les événements du flux : un incident ou le silence de la vigie la font relire.
    func receive(_ names: [String]) {
        guard names.contains(where: { $0.hasPrefix("vigie_") }), availability != .absent else { return }
        Task { await refresh() }
    }

    func reset() {
        availability = .unknown
        view = nil
        incidents = []
        failure = nil
        isWatched = false
    }
}

/// Le passage d'un échec à la disponibilité, commun aux modèles de la tour.
enum HarnessControlFailure {
    static func availability(after error: Error, current: HarnessFeatureAvailability) -> HarnessFeatureAvailability {
        if case HarnessFailure.forbidden(let motive) = error { return .forbidden(motive) }
        return current
    }
}

// MARK: - Planifications

/// Une planification en cours de saisie.
public struct HarnessScheduleDraft: Equatable, Sendable {
    public enum Problem: Equatable, Sendable {
        case name
        case cron
        case repo
        case request
        case budget
    }

    public var name = ""
    public var cron = ""
    public var kind: HarnessScheduleKind = .run
    public var repo = ""
    public var title = ""
    public var request = ""
    public var focus = ""
    public var label = ""
    /// Le budget du run en dollars, en texte (vide : celui de la configuration).
    public var budget = ""
    public var enabled = true

    public init() {}

    /// Le premier défaut de la saisie, ou `nil` si elle peut partir.
    public var problem: Problem? {
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .name }
        if !Self.isCronShaped(cron) { return .cron }
        if repo.trimmingCharacters(in: .whitespaces).isEmpty { return .repo }
        if kind == .run {
            if title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || request.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return .request
            }
            if budgetValue == .invalid { return .budget }
        }
        return nil
    }

    enum Budget: Equatable {
        case none
        case value(Double)
        case invalid
    }

    var budgetValue: Budget {
        let text = budget.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        if text.isEmpty { return .none }
        guard let value = Double(text), value.isFinite, value > 0, value <= 10_000 else { return .invalid }
        return .value(value)
    }

    /// Cinq champs séparés par des espaces : le serveur juge le reste (plages, noms, pas).
    public static func isCronShaped(_ text: String) -> Bool {
        text.split(whereSeparator: \.isWhitespace).count == 5
    }

    /// La cible, telle que le serveur la valide.
    public var target: HarnessScheduleTarget {
        let repo = repo.trimmingCharacters(in: .whitespaces)
        switch kind {
        case .run:
            var budget: Double?
            if case .value(let value) = budgetValue { budget = value }
            return HarnessScheduleTarget(
                kind: kind.rawValue, repo: repo,
                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                request: request.trimmingCharacters(in: .whitespacesAndNewlines),
                budgetUsd: budget
            )
        case .audit:
            return HarnessScheduleTarget(kind: kind.rawValue, repo: repo, focus: focus.trimmingCharacters(in: .whitespacesAndNewlines))
        case .issues:
            let label = label.trimmingCharacters(in: .whitespaces)
            return HarnessScheduleTarget(kind: kind.rawValue, repo: repo, label: label.isEmpty ? nil : label)
        }
    }
}

/// Le corps de `POST /v1/schedules`.
struct HarnessScheduleBody: Encodable {
    var name: String
    var cron: String
    var target: HarnessScheduleTarget
    var enabled: Bool
}

/// Le corps de `PUT /v1/schedules/{id}` qui active ou désactive.
struct HarnessScheduleToggle: Encodable {
    var enabled: Bool
}

/// Les PLANIFICATIONS récurrentes des dépôts que le client voit.
@MainActor
public final class HarnessSchedules: ObservableObject {
    @Published public private(set) var availability: HarnessFeatureAvailability = .unknown
    @Published public private(set) var schedules: [HarnessSchedule] = []
    /// Le fuseau IANA dans lequel le serveur lit les expressions cron.
    @Published public private(set) var timezone: String?
    @Published public private(set) var failure: HarnessFailure?
    @Published public private(set) var isLoading = false
    /// Les planifications dont un geste attend la réponse du serveur.
    @Published public private(set) var busy: Set<String> = []
    @Published public private(set) var isSaving = false
    /// L'issue du dernier déclenchement à la main.
    @Published public private(set) var lastFired: HarnessScheduleFired?
    public private(set) var isWatched = false

    private unowned let harness: HarnessModel

    init(harness: HarnessModel) {
        self.harness = harness
    }

    public func refresh() async {
        isWatched = true
        guard harness.isConfigured else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            guard let list: HarnessScheduleList = try await harness.readIfServed("/v1/schedules") else {
                availability = .absent
                schedules = []
                return
            }
            schedules = list.schedules
            timezone = list.timezone
            availability = .available
            failure = nil
        } catch {
            availability = HarnessControlFailure.availability(after: error, current: availability)
            failure = HarnessModel.failure(of: error)
        }
    }

    /// Crée une planification ; rend celle que le serveur a retenue (avec sa prochaine échéance).
    @discardableResult
    public func create(_ draft: HarnessScheduleDraft) async -> HarnessSchedule? {
        guard draft.problem == nil else {
            failure = .rejected("")
            return nil
        }
        let body = HarnessScheduleBody(
            name: draft.name.trimmingCharacters(in: .whitespacesAndNewlines),
            cron: draft.cron.split(whereSeparator: \.isWhitespace).joined(separator: " "),
            target: draft.target,
            enabled: draft.enabled
        )
        isSaving = true
        defer { isSaving = false }
        do {
            let reply: HarnessScheduleReply = try await harness.write("POST", "/v1/schedules", body: body)
            failure = nil
            await refresh()
            return reply.schedule
        } catch {
            failure = HarnessModel.failure(of: error)
            return nil
        }
    }

    /// Active ou désactive (réactivée, sa prochaine échéance repart de maintenant).
    @discardableResult
    public func setEnabled(_ schedule: HarnessSchedule, _ enabled: Bool) async -> Bool {
        let reply: HarnessScheduleReply? = await gesture(schedule, "PUT", "/v1/schedules/\(HarnessModel.pathComponent(schedule.id))", body: HarnessScheduleToggle(enabled: enabled))
        return reply != nil
    }

    /// Déclenche tout de suite, hors échéance (même désactivée).
    @discardableResult
    public func runNow(_ schedule: HarnessSchedule) async -> HarnessScheduleFired? {
        let fired: HarnessScheduleFired? = await gesture(schedule, "POST", "/v1/schedules/\(HarnessModel.pathComponent(schedule.id))/run", body: NoBody())
        if let fired { lastFired = fired }
        return fired
    }

    /// Supprime une planification (refusée si elle a changé depuis sa lecture).
    @discardableResult
    public func delete(_ schedule: HarnessSchedule) async -> Bool {
        let reply: HarnessDeleted? = await gesture(schedule, "DELETE", "/v1/schedules/\(HarnessModel.pathComponent(schedule.id))", body: nil as NoBody?)
        return reply != nil
    }

    private func gesture<Body: Encodable, Reply: Decodable>(_ schedule: HarnessSchedule, _ method: String, _ path: String, body: Body?) async -> Reply? {
        busy.insert(schedule.id)
        defer { busy.remove(schedule.id) }
        do {
            let reply: Reply = try await harness.write(method, path, body: body, headers: ["If-Match": "\"\(schedule.rev)\""])
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

    /// Les événements des planifications font relire la liste observée.
    func receive(_ names: [String]) {
        guard isWatched, availability != .absent, names.contains(where: { $0.hasPrefix("schedule_") }) else { return }
        Task { await refresh() }
    }

    func reset() {
        availability = .unknown
        schedules = []
        timezone = nil
        failure = nil
        lastFired = nil
        isWatched = false
    }
}

/// `DELETE /v1/schedules/{id}` : `{deleted}`.
struct HarnessDeleted: Decodable {}

// MARK: - Administration

/// Le corps de `POST /v1/clients` ; `repos` absent : tous les dépôts ; `spaces` : borné à ces
/// espaces à la place d'une liste de dépôts (jamais les deux).
struct HarnessClientBody: Encodable {
    var name: String
    var role: String
    var repos: [String]?
    var spaces: [String]?
}

/// Le corps de `POST /v1/repos` ; `name` absent : celui de l'adresse.
struct HarnessRepoBody: Encodable {
    var url: String
    var name: String?
}

/// L'ADMINISTRATION du serveur (admin seulement) : clients, dépôts, rechargement de la
/// configuration, erreurs remontées par les clients.
@MainActor
public final class HarnessAdmin: ObservableObject {
    /// Les erreurs des clients lues d'un coup.
    public nonisolated static let errorsLimit = 200

    @Published public private(set) var clients: [HarnessManagedClient] = []
    @Published public private(set) var repos: [HarnessServedRepo] = []
    /// Les erreurs des clients, les plus récentes d'abord ; `nil` : le serveur ne les sert pas.
    @Published public private(set) var clientErrors: [HarnessClientErrorRecord]?
    /// La source retenue pour les erreurs des clients (`mac`, `ios`, `chrome`, `omp`, `vigie`) ; `nil` : toutes.
    @Published public var errorSource: String? { didSet { if errorSource != oldValue { Task { await refresh() } } } }
    /// Le client tout juste créé et son jeton, montré UNE fois.
    @Published public var created: HarnessClientCreated?
    /// Le dernier dépôt déclaré (et la clé à poser s'il le faut).
    @Published public var declared: HarnessRepoDeclared?
    /// Le dernier rechargement de la configuration.
    @Published public private(set) var reloaded: HarnessReloadSummary?
    @Published public private(set) var failure: HarnessFailure?
    @Published public private(set) var isLoading = false
    @Published public private(set) var isSaving = false

    private unowned let harness: HarnessModel

    init(harness: HarnessModel) {
        self.harness = harness
    }

    public nonisolated static func errorsPath(source: String?) -> String {
        var path = "/v1/client-errors?limit=\(errorsLimit)"
        if let source { path += "&source=\(HarnessModel.queryValue(source))" }
        return path
    }

    public func refresh() async {
        guard harness.isConfigured, harness.isAdmin else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let list: HarnessClientList = try await harness.fetch(HarnessCall(method: "GET", path: "/v1/clients"))
            clients = list.clients
            let served: HarnessServedRepoList = try await harness.fetch(HarnessCall(method: "GET", path: "/v1/repos"))
            repos = served.repos
            let errors: HarnessClientErrorList? = try await harness.readIfServed(Self.errorsPath(source: errorSource))
            clientErrors = errors?.errors
            failure = nil
        } catch {
            failure = HarnessModel.failure(of: error)
        }
    }

    /// Crée un client ; `repos` vide : tous les dépôts. `spaces` (identifiants d'espaces) : le
    /// client est borné à ces espaces — il voit leurs dépôts du moment — à la place d'une
    /// liste de dépôts ; rien ne part vers un serveur qui n'annonce pas `space-scope`. Son
    /// jeton n'est montré qu'ici.
    @discardableResult
    public func createClient(name: String, role: String, repos: [String], spaces: [String] = []) async -> HarnessClientCreated? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if !spaces.isEmpty {
            guard await harness.supports(.spaceScope) else {
                failure = .rejected("")
                return nil
            }
        }
        let body = spaces.isEmpty
            ? HarnessClientBody(name: trimmed, role: role, repos: repos.isEmpty ? nil : repos)
            : HarnessClientBody(name: trimmed, role: role, spaces: spaces)
        let reply: HarnessClientCreated? = await save("POST", "/v1/clients", body: body)
        if let reply { created = reply }
        return reply
    }

    /// Révoque un client : son jeton cesse aussitôt de servir.
    @discardableResult
    public func revoke(_ client: HarnessManagedClient) async -> Bool {
        let reply: HarnessRevoked? = await save("DELETE", "/v1/clients/\(HarnessModel.pathComponent(client.name))", body: nil as NoBody?)
        return reply != nil
    }

    /// Déclare un dépôt par son adresse (SSH ou HTTPS) : la clé de déploiement à poser
    /// revient si la forge refuse la lecture ou l'écriture.
    @discardableResult
    public func declareRepo(url: String, name: String = "") async -> HarnessRepoDeclared? {
        let address = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty else { return nil }
        let short = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let reply: HarnessRepoDeclared? = await save("POST", "/v1/repos", body: HarnessRepoBody(url: address, name: short.isEmpty ? nil : short))
        if let reply {
            declared = reply
            await harness.refreshCatalog()
        }
        return reply
    }

    /// Relit la configuration du serveur (comme SIGHUP) ; invalide, rien ne change.
    @discardableResult
    public func reload() async -> HarnessReloadSummary? {
        let reply: HarnessReloadReply? = await save("POST", "/v1/reload", body: NoBody())
        if let reply {
            reloaded = reply.reload
            await harness.refreshCatalog()
        }
        return reply?.reload
    }

    private func save<Body: Encodable, Reply: Decodable>(_ method: String, _ path: String, body: Body?) async -> Reply? {
        isSaving = true
        defer { isSaving = false }
        do {
            let reply: Reply = try await harness.write(method, path, body: body)
            failure = nil
            await refresh()
            return reply
        } catch {
            failure = HarnessModel.failure(of: error)
            return nil
        }
    }

    func reset() {
        clients = []
        repos = []
        clientErrors = nil
        created = nil
        declared = nil
        reloaded = nil
        failure = nil
    }
}

/// `DELETE /v1/clients/{name}` : `{revoked}`.
struct HarnessRevoked: Decodable {}

// MARK: - Issues

/// Les ISSUES ouvertes d'un dépôt, lues et corrigées par le MCP du serveur.
@MainActor
public final class HarnessIssues: ObservableObject {
    @Published public private(set) var issues: [HarnessIssue] = []
    /// Le dépôt dont les issues sont montrées ; `nil` : aucun lu encore.
    @Published public private(set) var repo: String?
    @Published public private(set) var failure: HarnessFailure?
    @Published public private(set) var isLoading = false
    /// Les issues dont la correction attend la réponse du serveur.
    @Published public private(set) var busy: Set<Int> = []
    /// La dernière correction lancée (ou trouvée déjà en cours).
    @Published public private(set) var lastFix: HarnessIssueFix?

    private unowned let harness: HarnessModel

    init(harness: HarnessModel) {
        self.harness = harness
    }

    /// Relit les issues ouvertes de `repo` (le dépôt choisi, sinon le premier déclaré).
    public func refresh(repo chosen: String?) async {
        guard harness.isConfigured, let chosen, !chosen.isEmpty else { return }
        if chosen != repo { issues = [] }
        repo = chosen
        isLoading = true
        defer { isLoading = false }
        do {
            let result: HarnessIssueListResult = try await harness.callTool("issues_list", arguments: ["repo": .string(chosen)])
            guard repo == chosen else { return }
            issues = result.issues
            failure = nil
        } catch {
            failure = HarnessModel.failure(of: error)
        }
    }

    /// Lance le pipeline qui corrige l'issue (rien de neuf si un run vivant la porte déjà).
    @discardableResult
    public func fix(_ issue: HarnessIssue) async -> HarnessIssueFix? {
        guard let repo else { return nil }
        busy.insert(issue.number)
        defer { busy.remove(issue.number) }
        do {
            let fixed: HarnessIssueFix = try await harness.callTool(
                "issue_fix", arguments: ["repo": .string(repo), "number": .number(Double(issue.number))]
            )
            lastFix = fixed
            failure = nil
            await refresh(repo: repo)
            await harness.refresh()
            return fixed
        } catch {
            failure = HarnessModel.failure(of: error)
            return nil
        }
    }

    func reset() {
        issues = []
        repo = nil
        failure = nil
        lastFix = nil
    }
}
