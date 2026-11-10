// Les CONSIGNES PERMANENTES de l'humain (« toujours faire ainsi », omp-harness
// standing-rules.ts, capacité `os-autonomy`) : une phrase que le serveur injecte dans le
// prompt de chaque étape des features d'un dépôt — ou de tous, quand `repo` est `nil`.
// Lecture `GET /v1/rules`, écriture `POST /v1/rules`, `PUT`/`DELETE /v1/rules/{id}`,
// événement `standing_rule`.
//
// Un serveur antérieur ne sert pas la route (404) : `availability == .absent`, et le
// Savoir n'en montre rien. Aucun texte ici.

import Combine
import Foundation

/// D'où vient une consigne permanente.
public enum HarnessStandingRuleSource: String, CaseIterable, Codable, Sendable {
    /// Une réponse à une question, rendue permanente (`always`).
    case answer
    /// Un refus de specs ou de verdict, ou une correction, rendu permanent.
    case correction
    /// Le motif d'une annulation.
    case cancel
    /// Écrite à la main.
    case manual
}

/// Une consigne permanente telle que `/v1/rules` la rend.
public struct HarnessStandingRule: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    /// Le dépôt de la consigne ; `nil` : tous les dépôts.
    public var repo: String?
    public var text: String
    public var enabled: Bool
    /// `answer`, `correction`, `cancel` ou `manual`.
    public var source: String
    /// La feature dont la consigne est née, s'il y en a une.
    public var sourceRunId: String?
    public var by: String?
    public var createdAt: Double
    public var updatedAt: Double

    public init(
        id: String, repo: String? = nil, text: String, enabled: Bool = true, source: String = HarnessStandingRuleSource.manual.rawValue,
        sourceRunId: String? = nil, by: String? = nil, createdAt: Double = 0, updatedAt: Double = 0
    ) {
        self.id = id
        self.repo = repo
        self.text = text
        self.enabled = enabled
        self.source = source
        self.sourceRunId = sourceRunId
        self.by = by
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// L'origine connue, ou `nil` pour une origine apparue après cette version de l'app.
    public var origin: HarnessStandingRuleSource? { HarnessStandingRuleSource(rawValue: source) }

    /// La consigne vaut pour tous les dépôts.
    public var isGlobal: Bool { repo == nil }
}

/// `GET /v1/rules`.
public struct HarnessStandingRuleList: Codable, Equatable, Sendable {
    public var rules: [HarnessStandingRule]
}

/// `POST /v1/rules`, `PUT /v1/rules/{id}`.
struct HarnessStandingRuleReply: Decodable {
    var rule: HarnessStandingRule
}

/// Le corps de `POST /v1/rules` ; les champs absents (`nil`) ne partent pas.
private struct StandingRuleBody: Encodable {
    var text: String
    var repo: String?
    var source: String?
    var sourceRunId: String?
}

/// Le corps de `PUT /v1/rules/{id}` : seuls les champs donnés changent.
private struct StandingRulePatch: Encodable {
    var text: String?
    var enabled: Bool?
}

@MainActor
public final class HarnessStandingRulesModel: ObservableObject {
    /// Les bornes du serveur : la longueur d'une consigne, et les consignes actives d'un dépôt.
    public nonisolated static let maxTextLength = 600
    public nonisolated static let maxActivePerRepo = 40

    @Published public private(set) var availability: HarnessFeatureAvailability = .unknown
    /// Les consignes des dépôts visibles, les plus récentes d'abord.
    @Published public private(set) var rules: [HarnessStandingRule] = []
    @Published public private(set) var failure: HarnessFailure?
    @Published public private(set) var isLoading = false
    /// Les consignes dont un geste attend la réponse du serveur.
    @Published public private(set) var busy: Set<String> = []
    /// Une création attend la réponse du serveur.
    @Published public private(set) var isSaving = false

    private unowned let harness: HarnessModel
    private let reloader: HarnessReloader

    init(harness: HarnessModel, reloadDelay: Duration) {
        self.harness = harness
        reloader = HarnessReloader(delay: reloadDelay)
    }

    /// Le serveur relié sert les consignes (inconnu compris : la rangée ne clignote pas).
    public var isServed: Bool { availability != .absent }

    /// Les consignes ACTIVES qui s'imposent aux features d'un dépôt : les siennes et les globales.
    public func active(for repo: String?) -> [HarnessStandingRule] {
        rules.filter { $0.enabled && ($0.repo == nil || $0.repo == repo) }
    }

    /// Relit les consignes ; un serveur antérieur (404) n'en a pas, sans échec.
    public func refresh() async {
        guard harness.isConfigured else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            guard let list: HarnessStandingRuleList = try await harness.readBound("/v1/rules") else {
                availability = .absent
                rules = []
                failure = nil
                return
            }
            rules = list.rules.sorted { $0.createdAt > $1.createdAt }
            availability = .available
            failure = nil
        } catch {
            availability = HarnessControlFailure.availability(after: error, current: availability)
            failure = HarnessModel.failure(of: error)
        }
    }

    /// Écrit une consigne ; `repo` vide ou `nil` : tous les dépôts. Rend celle que le serveur a gardée.
    @discardableResult
    public func create(
        text: String, repo: String? = nil, source: HarnessStandingRuleSource? = nil, sourceRunId: String? = nil
    ) async -> HarnessStandingRule? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= Self.maxTextLength else {
            failure = .rejected("")
            return nil
        }
        let target = repo?.trimmingCharacters(in: .whitespaces) ?? ""
        isSaving = true
        defer { isSaving = false }
        do {
            let reply: HarnessStandingRuleReply = try await harness.write(
                "POST", "/v1/rules",
                body: StandingRuleBody(text: trimmed, repo: target.isEmpty ? nil : target, source: source?.rawValue, sourceRunId: sourceRunId)
            )
            upsert(reply.rule)
            availability = .available
            failure = nil
            return reply.rule
        } catch {
            failure = HarnessModel.failure(of: error)
            return nil
        }
    }

    /// Réécrit une consigne, ou l'active et la désactive ; seuls les champs donnés changent.
    @discardableResult
    public func update(_ rule: HarnessStandingRule, text: String? = nil, enabled: Bool? = nil) async -> Bool {
        let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let trimmed, trimmed.isEmpty || trimmed.count > Self.maxTextLength {
            failure = .rejected("")
            return false
        }
        guard trimmed != nil || enabled != nil else { return false }
        busy.insert(rule.id)
        defer { busy.remove(rule.id) }
        do {
            let reply: HarnessStandingRuleReply = try await harness.write(
                "PUT", "/v1/rules/\(HarnessModel.pathComponent(rule.id))", body: StandingRulePatch(text: trimmed, enabled: enabled)
            )
            upsert(reply.rule)
            failure = nil
            return true
        } catch {
            // Relue ou non, la liste ne doit pas effacer la raison du refus.
            let failed = HarnessModel.failure(of: error)
            await refresh()
            failure = failed
            return false
        }
    }

    /// Supprime une consigne : les prochaines étapes ne la reçoivent plus.
    @discardableResult
    public func remove(_ rule: HarnessStandingRule) async -> Bool {
        busy.insert(rule.id)
        defer { busy.remove(rule.id) }
        do {
            let _: HarnessAck = try await harness.write("DELETE", "/v1/rules/\(HarnessModel.pathComponent(rule.id))", body: nil as StandingRulePatch?)
            rules.removeAll { $0.id == rule.id }
            failure = nil
            return true
        } catch {
            let failed = HarnessModel.failure(of: error)
            await refresh()
            failure = failed
            return false
        }
    }

    private func upsert(_ rule: HarnessStandingRule) {
        rules.removeAll { $0.id == rule.id }
        rules.append(rule)
        rules.sort { $0.createdAt > $1.createdAt }
    }

    /// L'événement `standing_rule` (une réponse rendue permanente, un autre appareil) fait relire.
    func receive(_ names: [String]) {
        guard availability == .available, names.contains("standing_rule") else { return }
        reloader.schedule { [weak self] in await self?.refresh() }
    }

    func reset() {
        reloader.cancel()
        availability = .unknown
        rules = []
        failure = nil
        busy = []
    }
}
