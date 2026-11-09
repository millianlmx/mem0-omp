// Les SESSIONS LOCALES (omp-harness local-sessions.ts, capacité `local-sessions`) : les
// sessions omp qui travaillent sur une machine de l'humain, rapportées au serveur par le
// plugin `omp-mem0-req` — un agent de plus dans l'OS, à côté de l'usine et du poste.
// `GET /v1/local-sessions`, passage de relais à l'usine
// (`POST /v1/local-sessions/{id}/handoff`), retrait (`DELETE`), événement `local_session`.
//
// Réservées au propriétaire : un autre jeton reçoit 403 (`.forbidden`), un serveur
// antérieur 404 (`.absent`) ; dans les deux cas rien ne s'affiche. Aucun texte ici.

import Combine
import Foundation

/// L'état d'une session locale.
public enum HarnessLocalSessionState: String, CaseIterable, Sendable {
    /// L'agent travaille.
    case working
    /// L'agent a rendu la main (ou se tait depuis 2 minutes).
    case idle
    /// La session est fermée (ou muette depuis 30 minutes).
    case ended
}

/// Une session locale telle que `/v1/local-sessions` la rend.
public struct HarnessLocalSession: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    /// Le client (jeton) qui la rapporte.
    public var client: String
    /// La machine où elle tourne.
    public var host: String
    public var cwd: String
    /// Le dépôt déclaré qu'elle touche, si le serveur l'a reconnu.
    public var repo: String?
    public var remote: String?
    public var branch: String?
    public var title: String
    /// Ce que l'agent fait à l'instant (l'intention de son dernier outil).
    public var intent: String?
    public var tool: String?
    /// `working`, `idle` ou `ended`.
    public var state: String
    public var model: String?
    public var cost: Double?
    /// La feature de l'usine qui a repris son travail, après un passage de relais.
    public var runId: String?
    public var startedAt: Double
    public var updatedAt: Double
    public var endedAt: Double?

    public init(
        id: String, client: String = "", host: String, cwd: String = "", repo: String? = nil, remote: String? = nil, branch: String? = nil,
        title: String, intent: String? = nil, tool: String? = nil, state: String = HarnessLocalSessionState.working.rawValue,
        model: String? = nil, cost: Double? = nil, runId: String? = nil, startedAt: Double = 0, updatedAt: Double = 0, endedAt: Double? = nil
    ) {
        self.id = id
        self.client = client
        self.host = host
        self.cwd = cwd
        self.repo = repo
        self.remote = remote
        self.branch = branch
        self.title = title
        self.intent = intent
        self.tool = tool
        self.state = state
        self.model = model
        self.cost = cost
        self.runId = runId
        self.startedAt = startedAt
        self.updatedAt = updatedAt
        self.endedAt = endedAt
    }

    /// L'état connu, ou `nil` pour un état apparu après cette version de l'app.
    public var phase: HarnessLocalSessionState? { HarnessLocalSessionState(rawValue: state) }

    /// La session est ouverte (elle travaille, ou attend son humain).
    public var isLive: Bool { phase != .ended }

    /// L'usine peut reprendre son travail : son dépôt est connu, et rien ne l'a encore repris.
    public var canHandOff: Bool { repo != nil && runId == nil }
}

/// `GET /v1/local-sessions`.
public struct HarnessLocalSessionList: Codable, Equatable, Sendable {
    public var sessions: [HarnessLocalSession]
}

/// `POST /v1/local-sessions/{id}/handoff` : la feature créée et la session qui la porte.
public struct HarnessLocalSessionHandoff: Codable, Equatable, Sendable {
    public var run: HarnessRun
    public var session: HarnessLocalSession
}

/// Le corps du passage de relais ; `request` absente du JSON quand elle est vide.
private struct HandoffBody: Encodable {
    var request: String?
}

@MainActor
public final class HarnessLocalSessionsModel: ObservableObject {
    @Published public private(set) var availability: HarnessFeatureAvailability = .unknown
    /// Les sessions, les plus récemment actives d'abord.
    @Published public private(set) var sessions: [HarnessLocalSession] = []
    @Published public private(set) var failure: HarnessFailure?
    @Published public private(set) var isLoading = false
    /// Les sessions dont un geste attend la réponse du serveur.
    @Published public private(set) var busy: Set<String> = []

    private unowned let harness: HarnessModel
    private let reloader: HarnessReloader

    init(harness: HarnessModel, reloadDelay: Duration) {
        self.harness = harness
        reloader = HarnessReloader(delay: reloadDelay)
    }

    /// Le serveur relié montre les sessions locales à ce jeton.
    public var isServed: Bool { availability == .available || availability == .unknown }

    /// Les sessions ouvertes (au travail ou en attente).
    public var live: [HarnessLocalSession] { sessions.filter(\.isLive) }

    /// Relit les sessions ; un serveur antérieur (404) ou un jeton qui n'en est pas le
    /// propriétaire (403) n'en montre aucune, sans échec affiché.
    public func refresh() async {
        guard harness.isConfigured else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            guard let list: HarnessLocalSessionList = try await harness.readBound("/v1/local-sessions") else {
                availability = .absent
                sessions = []
                failure = nil
                return
            }
            sessions = list.sessions.sorted { $0.updatedAt > $1.updatedAt }
            availability = .available
            failure = nil
        } catch HarnessFailure.forbidden(let motive) {
            availability = .forbidden(motive)
            sessions = []
            failure = nil
        } catch {
            failure = HarnessModel.failure(of: error)
        }
    }

    /// Passe le relais à l'usine : une feature reprend le travail de la session (son titre,
    /// sa consigne, sa branche), avec la consigne en plus si elle est donnée. Rend la feature créée.
    @discardableResult
    public func handoff(_ session: HarnessLocalSession, request: String = "") async -> HarnessRun? {
        let trimmed = request.trimmingCharacters(in: .whitespacesAndNewlines)
        busy.insert(session.id)
        defer { busy.remove(session.id) }
        do {
            let reply: HarnessLocalSessionHandoff = try await harness.write(
                "POST", "/v1/local-sessions/\(HarnessModel.pathComponent(session.id))/handoff",
                body: HandoffBody(request: trimmed.isEmpty ? nil : trimmed)
            )
            upsert(reply.session)
            failure = nil
            await harness.refresh()
            return reply.run
        } catch {
            failure = HarnessModel.failure(of: error)
            return nil
        }
    }

    /// Retire une session de la liste (elle y reviendra si elle bat encore).
    @discardableResult
    public func delete(_ session: HarnessLocalSession) async -> Bool {
        busy.insert(session.id)
        defer { busy.remove(session.id) }
        do {
            let _: HarnessAck = try await harness.write(
                "DELETE", "/v1/local-sessions/\(HarnessModel.pathComponent(session.id))", body: nil as HandoffBody?
            )
            sessions.removeAll { $0.id == session.id }
            failure = nil
            return true
        } catch {
            failure = HarnessModel.failure(of: error)
            return false
        }
    }

    private func upsert(_ session: HarnessLocalSession) {
        sessions.removeAll { $0.id == session.id }
        sessions.append(session)
        sessions.sort { $0.updatedAt > $1.updatedAt }
    }

    /// L'événement `local_session` (une session a changé d'état) fait relire.
    func receive(_ names: [String]) {
        guard availability == .available, names.contains("local_session") else { return }
        reloader.schedule { [weak self] in await self?.refresh() }
    }

    func reset() {
        reloader.cancel()
        availability = .unknown
        sessions = []
        failure = nil
        busy = []
    }
}
