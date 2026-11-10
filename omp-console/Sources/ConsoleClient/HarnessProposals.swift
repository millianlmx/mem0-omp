// Les PROPOSITIONS (omp-harness proposals.ts, capacité `proposals`) : le travail que
// l'OS a trouvé seul — issue à corriger, incident de la vigie, proposition d'audit,
// signalement d'un collègue, item du plan Jira, palier d'autonomie, feature en échec à
// relancer, PR dormante, branche principale en échec — et que l'humain accepte ou écarte
// d'un geste (`GET /v1/proposals`, `POST /v1/proposals/{id}/accept` et `/dismiss`,
// événement `proposals`). Et « refaire » : le gabarit d'une feature
// (`GET /v1/runs/{id}/template`), le corps d'un lancement qui la relancerait.
//
// Un serveur antérieur ne sert pas ces routes (404) : `availability == .absent`, rien ne
// s'affiche. Aucun texte ici.

import Combine
import Foundation

/// D'où vient une proposition.
public enum HarnessProposalSource: String, CaseIterable, Sendable {
    case issue, vigie, audit, signal, jira, autonomy, retry, pr, ci
}

/// Ce que fait l'acceptation d'une proposition.
public enum HarnessProposalAction: String, CaseIterable, Sendable {
    /// Lancer une feature (ou un projet).
    case launch
    /// Lancer une correction.
    case fix
    /// Appliquer un palier d'autonomie (admin).
    case apply
    /// Confirmer un signalement (approbateur).
    case confirm
    /// Relancer une feature en échec.
    case retry
}

/// Une proposition telle que `/v1/proposals` la rend.
public struct HarnessProposal: Codable, Equatable, Sendable, Identifiable {
    /// `<source>.<hachage stable>` : le même d'une lecture à l'autre.
    public var id: String
    /// `issue`, `vigie`, `audit`, `signal`, `jira`, `autonomy`, `retry`, `pr` ou `ci`.
    public var source: String
    public var repo: String?
    public var title: String
    public var detail: String
    public var url: String?
    public var createdAt: Double
    /// `launch`, `fix`, `apply`, `confirm` ou `retry`.
    public var action: String

    public init(
        id: String, source: String, repo: String? = nil, title: String, detail: String = "", url: String? = nil, createdAt: Double = 0,
        action: String = HarnessProposalAction.launch.rawValue
    ) {
        self.id = id
        self.source = source
        self.repo = repo
        self.title = title
        self.detail = detail
        self.url = url
        self.createdAt = createdAt
        self.action = action
    }

    /// L'origine connue, ou `nil` pour une origine apparue après cette version de l'app.
    public var origin: HarnessProposalSource? { HarnessProposalSource(rawValue: source) }

    /// Le geste connu, ou `nil` pour un geste apparu après cette version de l'app.
    public var gesture: HarnessProposalAction? { HarnessProposalAction(rawValue: action) }
}

/// `GET /v1/proposals`.
public struct HarnessProposalList: Codable, Equatable, Sendable {
    public var proposals: [HarnessProposal]
}

/// Ce qu'une acceptation a créé : `{kind, id}`.
public struct HarnessProposalCreated: Codable, Equatable, Sendable {
    /// `run`, `project`, `rule`, `signal` ou `retry`.
    public var kind: String
    public var id: String

    public init(kind: String, id: String) {
        self.kind = kind
        self.id = id
    }

    /// La feature créée ou relancée, s'il y en a une : là où mener l'humain.
    public var runId: String? { kind == "run" || kind == "retry" ? id : nil }
}

/// `POST /v1/proposals/{id}/accept` : la proposition acceptée et ce qui en est né.
public struct HarnessProposalAccepted: Codable, Equatable, Sendable {
    public var proposal: HarnessProposal
    public var created: HarnessProposalCreated?

    public init(proposal: HarnessProposal, created: HarnessProposalCreated? = nil) {
        self.proposal = proposal
        self.created = created
    }
}

private struct NoProposalBody: Encodable {}

@MainActor
public final class HarnessProposalsModel: ObservableObject {
    @Published public private(set) var availability: HarnessFeatureAvailability = .unknown
    /// Les propositions ouvertes, les plus récentes d'abord (l'ordre du serveur).
    @Published public private(set) var proposals: [HarnessProposal] = []
    @Published public private(set) var failure: HarnessFailure?
    @Published public private(set) var isLoading = false
    /// Les propositions dont un geste attend la réponse du serveur.
    @Published public private(set) var busy: Set<String> = []

    private unowned let harness: HarnessModel
    private let reloader: HarnessReloader

    init(harness: HarnessModel, reloadDelay: Duration) {
        self.harness = harness
        reloader = HarnessReloader(delay: reloadDelay)
    }

    /// Le serveur relié sert les propositions (inconnu compris : rien ne clignote).
    public var isServed: Bool { availability != .absent }

    /// Relit les propositions ; un serveur antérieur (404) n'en a pas, sans échec.
    public func refresh() async {
        guard harness.isConfigured else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            guard let list: HarnessProposalList = try await harness.readBound("/v1/proposals") else {
                availability = .absent
                proposals = []
                failure = nil
                return
            }
            proposals = list.proposals
            availability = .available
            failure = nil
        } catch {
            availability = HarnessControlFailure.availability(after: error, current: availability)
            failure = HarnessModel.failure(of: error)
        }
    }

    /// Accepte une proposition : le serveur fait le geste qu'elle porte (lancer, corriger,
    /// appliquer, confirmer, relancer). `nil` : refusée (disparue, droits) ; `failure` dit pourquoi.
    @discardableResult
    public func accept(_ proposal: HarnessProposal) async -> HarnessProposalAccepted? {
        busy.insert(proposal.id)
        defer { busy.remove(proposal.id) }
        do {
            let reply: HarnessProposalAccepted = try await harness.write(
                "POST", "/v1/proposals/\(HarnessModel.pathComponent(proposal.id))/accept", body: NoProposalBody()
            )
            proposals.removeAll { $0.id == proposal.id }
            failure = nil
            // Une feature est née ou repartie : la boîte la montre.
            await harness.refresh()
            return reply
        } catch {
            failure = HarnessModel.failure(of: error)
            await reloadKeepingFailure()
            return nil
        }
    }

    /// Écarte une proposition : elle ne revient plus.
    @discardableResult
    public func dismiss(_ proposal: HarnessProposal) async -> Bool {
        busy.insert(proposal.id)
        defer { busy.remove(proposal.id) }
        do {
            let _: HarnessAck = try await harness.write(
                "POST", "/v1/proposals/\(HarnessModel.pathComponent(proposal.id))/dismiss", body: NoProposalBody()
            )
            proposals.removeAll { $0.id == proposal.id }
            failure = nil
            return true
        } catch {
            failure = HarnessModel.failure(of: error)
            await reloadKeepingFailure()
            return false
        }
    }

    /// Après un geste refusé, la liste est relue (la proposition a pu disparaître) sans
    /// effacer la raison du refus.
    private func reloadKeepingFailure() async {
        let failed = failure
        await refresh()
        failure = failed
    }

    /// L'événement `proposals` (l'ensemble a changé) fait relire.
    func receive(_ names: [String]) {
        guard availability == .available, names.contains("proposals") else { return }
        reloader.schedule { [weak self] in await self?.refresh() }
    }

    func reset() {
        reloader.cancel()
        availability = .unknown
        proposals = []
        failure = nil
        busy = []
    }
}

// MARK: - Refaire

/// Le gabarit d'une feature (`GET /v1/runs/{id}/template`) : sa demande d'ORIGINE et ses
/// options, de quoi la relancer telle quelle par `HarnessModel.launchRun`.
public struct HarnessRunTemplate: Codable, Equatable, Sendable {
    public var repo: String
    /// Le titre nettoyé (sans « Suite de « … » », ni préfixe d'issue ou de commit).
    public var title: String
    public var request: String
    public var kind: String?
    public var labels: [String]
    public var modules: [String]
    /// `full`, ou `nil` : le serveur choisit la voie.
    public var lane: String?
    public var budgetUsd: Double?
    public var autonomy: HarnessRunAutonomy?

    public init(
        repo: String, title: String, request: String, kind: String? = nil, labels: [String] = [], modules: [String] = [],
        lane: String? = nil, budgetUsd: Double? = nil, autonomy: HarnessRunAutonomy? = nil
    ) {
        self.repo = repo
        self.title = title
        self.request = request
        self.kind = kind
        self.labels = labels
        self.modules = modules
        self.lane = lane
        self.budgetUsd = budgetUsd
        self.autonomy = autonomy
    }

    private enum CodingKeys: String, CodingKey { case repo, title, request, kind, labels, modules, lane, budgetUsd, autonomy }

    /// Un niveau d'autonomie inconnu de cette version se lit comme « les règles du dépôt ».
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        repo = try container.decode(String.self, forKey: .repo)
        title = try container.decode(String.self, forKey: .title)
        request = try container.decode(String.self, forKey: .request)
        kind = try container.decodeIfPresent(String.self, forKey: .kind)
        labels = try container.decodeIfPresent([String].self, forKey: .labels) ?? []
        modules = try container.decodeIfPresent([String].self, forKey: .modules) ?? []
        lane = try container.decodeIfPresent(String.self, forKey: .lane)
        budgetUsd = try container.decodeIfPresent(Double.self, forKey: .budgetUsd)
        autonomy = try container.decodeIfPresent(String.self, forKey: .autonomy).flatMap(HarnessRunAutonomy.init(rawValue:))
    }

    /// Les options d'un lancement qui refait la feature.
    public var options: HarnessLaunchOptions {
        HarnessLaunchOptions(
            lane: lane == HarnessLane.full.rawValue ? .full : .auto, modules: modules, budgetUsd: budgetUsd,
            kind: kind.flatMap(HarnessWorkKind.init(rawValue:)), labels: labels, autonomy: autonomy
        )
    }
}

/// `GET /v1/runs/{id}/template`.
struct HarnessRunTemplateReply: Decodable {
    var template: HarnessRunTemplate
}
