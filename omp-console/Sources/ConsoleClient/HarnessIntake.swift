// La DEMANDE côté client, partagée par la coque Mac et l'app iOS : une phrase libre
// posée au serveur (`POST /v1/intake`), classée par lui en plan (run, audit,
// planification, demande au poste), en question de clarification ou en réponse
// directe ; rien n'est créé avant que l'humain confirme le plan (routes `/v1/intake*`
// d'omp-harness, capacité `intake`).
//
// La file d'« À traiter » montre les demandes ouvertes : en classement, en
// clarification, au plan prêt, et les réponses directes ou échecs que l'humain n'a
// pas encore écartés. Le flux de la boîte (`intake_state`) la fait relire.
//
// Un serveur antérieur à la Demande rend 404 : le modèle passe en `.absent`, la file
// reste vide et l'envoi lève `HarnessIntakeFailure.unsupported`, que les écrans disent
// en français. Aucun texte ici.

import Foundation

// MARK: - Contrat JSON

/// La cible d'une planification proposée : `{cron, target, focus?, label?}`.
public struct HarnessIntakeSchedule: Codable, Equatable, Sendable {
    /// Les cibles qu'une correction du plan peut choisir.
    public static let targets = ["run", "audit", "issues"]

    public var cron: String
    /// `run`, `audit` ou `issues`.
    public var target: String
    public var focus: String?
    public var label: String?

    public init(cron: String, target: String, focus: String? = nil, label: String? = nil) {
        self.cron = cron
        self.target = target
        self.focus = focus
        self.label = label
    }
}

/// Le plan d'une demande : ce que sa confirmation créera.
public struct HarnessIntakePlan: Codable, Equatable, Sendable {
    /// Les types qu'une correction du plan peut choisir.
    public static let kinds = ["feature", "bug", "audit", "workstation_request", "schedule"]

    /// `feature`, `bug`, `audit`, `workstation_request` ou `schedule`.
    public var kind: String
    public var repo: String?
    public var title: String
    public var statement: String
    public var focus: String?
    public var schedule: HarnessIntakeSchedule?
    /// Ce qui sera créé, rédigé par le serveur (absent d'une correction envoyée).
    public var creates: String?

    public init(
        kind: String, repo: String?, title: String, statement: String, focus: String? = nil,
        schedule: HarnessIntakeSchedule? = nil, creates: String? = nil
    ) {
        self.kind = kind
        self.repo = repo
        self.title = title
        self.statement = statement
        self.focus = focus
        self.schedule = schedule
        self.creates = creates
    }
}

/// Une question de clarification et la réponse de l'humain.
public struct HarnessIntakeExchange: Codable, Equatable, Sendable {
    public var question: String
    public var answer: String
    public var at: Double
}

/// L'objet créé par la confirmation : `{kind, id}`.
public struct HarnessIntakeCreated: Codable, Equatable, Sendable {
    /// `run`, `audit`, `workstation_request` ou `schedule`.
    public var kind: String
    public var id: String
}

/// Le contexte de page d'une demande (popup Chrome, partage) : d'où elle vient. Une
/// DONNÉE pour le classeur du serveur, jamais une consigne.
public struct HarnessIntakeContext: Codable, Equatable, Sendable {
    /// Les bornes du serveur.
    public static let maxURLLength = 2000
    public static let maxTitleLength = 300
    public static let maxSelectionLength = 4000

    /// L'adresse de la page (http ou https).
    public var url: String?
    public var title: String?
    /// Le texte sélectionné dans la page.
    public var selection: String?

    public init(url: String? = nil, title: String? = nil, selection: String? = nil) {
        self.url = url
        self.title = title
        self.selection = selection
    }

    /// Le contexte tel qu'il peut partir : champs rognés et bornés, adresse http(s) seulement ;
    /// `nil` s'il ne reste rien.
    public var sendable: HarnessIntakeContext? {
        func kept(_ value: String?, _ limit: Int) -> String? {
            let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? nil : String(trimmed.prefix(limit))
        }
        let address = url?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let scheme = URL(string: address)?.scheme?.lowercased()
        let page = (scheme == "http" || scheme == "https") && address.count <= Self.maxURLLength ? address : nil
        let cleaned = HarnessIntakeContext(url: page, title: kept(title, Self.maxTitleLength), selection: kept(selection, Self.maxSelectionLength))
        return cleaned == HarnessIntakeContext() ? nil : cleaned
    }
}

/// Une demande telle que `/v1/intake` la rend.
public struct HarnessIntake: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var text: String
    public var source: String
    public var repo: String?
    public var requestedRepo: String?
    /// Le contexte de page posé avec la demande ; `nil` sans contexte, ou d'un serveur antérieur.
    public var context: HarnessIntakeContext?
    /// `classifying`, `clarifying`, `planned`, `answered`, `confirmed`, `cancelled` ou `failed`.
    public var state: String
    public var kind: String?
    public var plan: HarnessIntakePlan?
    public var question: String?
    public var answer: String?
    public var exchanges: [HarnessIntakeExchange]
    public var statement: String
    public var created: HarnessIntakeCreated?
    public var reason: String?
    public var by: String?
    public var createdAt: Double
    public var updatedAt: Double

    /// L'humain peut confirmer, modifier ou annuler le plan.
    public var isPlanned: Bool { state == "planned" && plan != nil }
    /// Le serveur attend la réponse de l'humain à une question.
    public var isClarifying: Bool { state == "clarifying" }
    /// Le classement est en cours.
    public var isClassifying: Bool { state == "classifying" }
    /// Une réponse directe ou un échec : il ne reste qu'à l'écarter.
    public var isSettled: Bool { state == "answered" || state == "failed" }
}

public struct HarnessIntakeList: Codable, Equatable, Sendable {
    public var intakes: [HarnessIntake]
}

public struct HarnessIntakeReply: Codable, Equatable, Sendable {
    public var intake: HarnessIntake
}

/// Ce qui a empêché un geste sur une demande.
public enum HarnessIntakeFailure: Error, Equatable, Sendable {
    /// Le serveur ne connaît pas la Demande (404 sur `/v1/intake`).
    case unsupported
    /// Le serveur a refusé ou n'a pas répondu.
    case server(HarnessFailure)
}

// MARK: - Modèle

@MainActor
public final class HarnessIntakes: ObservableObject {
    /// Ce que le serveur relié dit de la Demande.
    public enum Availability: Equatable, Sendable {
        case unknown
        case available
        /// Le serveur est antérieur à la Demande (404).
        case absent
    }

    /// Les états montrés dans « À traiter ».
    public static let openStates = ["classifying", "clarifying", "planned", "answered", "failed"]

    @Published public private(set) var availability: Availability = .unknown
    /// Les demandes ouvertes, la plus ancienne d'abord.
    @Published public private(set) var open: [HarnessIntake] = []
    /// Le dernier échec de lecture, effacé par la prochaine lecture réussie.
    @Published public private(set) var failure: HarnessFailure?
    /// Les demandes dont un geste attend la réponse du serveur.
    @Published public private(set) var busy: Set<String> = []

    weak var harness: HarnessModel?
    private let reloadDelay: Duration
    private var reloadTask: Task<Void, Never>?

    init(harness: HarnessModel, reloadDelay: Duration) {
        self.harness = harness
        self.reloadDelay = reloadDelay
    }

    /// Les demandes qui attendent l'humain : une question ou un plan.
    public var pendingCount: Int { open.filter { $0.isClarifying || $0.isPlanned }.count }

    // MARK: Lecture

    /// Relit les demandes ouvertes ; un serveur antérieur (404) ne montre rien, sans échec.
    public func refresh() async {
        guard let harness, harness.isConfigured else { return }
        let call = HarnessCall(method: "GET", path: "/v1/intake?state=\(Self.openStates.joined(separator: ","))&limit=200")
        do {
            let reply = try await harness.exchange(call)
            if reply.status == 404 {
                availability = .absent
                open = []
                failure = nil
                return
            }
            let list: HarnessIntakeList = try harness.decode(reply, for: call)
            open = list.intakes.filter { Self.openStates.contains($0.state) }.sorted { $0.createdAt < $1.createdAt }
            availability = .available
            failure = nil
        } catch {
            failure = HarnessModel.failure(of: error)
        }
    }

    /// Les noms des événements du flux : `intake_state` fait relire (une rafale, une relecture).
    func receive(_ names: [String]) {
        guard names.contains("intake_state"), availability != .absent, reloadTask == nil else { return }
        let delay = reloadDelay
        reloadTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self?.refresh()
            self?.reloadTask = nil
        }
    }

    /// Oublie tout : le serveur a changé (ou a été oublié).
    func reset() {
        reloadTask?.cancel()
        reloadTask = nil
        availability = .unknown
        open = []
        failure = nil
        busy = []
    }

    // MARK: Gestes de l'humain

    /// Pose une demande. `source` : `console` (Mac) ou `ios` ; `repo` vide : le serveur le déduit.
    /// `context` : la page d'où vient la demande (adresse, titre, sélection), s'il y en a une.
    @discardableResult
    public func submit(text: String, source: String, repo: String? = nil, context: HarnessIntakeContext? = nil) async throws -> HarnessIntake {
        let trimmed = repo?.trimmingCharacters(in: .whitespaces) ?? ""
        let reply: HarnessIntakeReply = try await post(
            "/v1/intake", body: SubmitBody(
                text: text.trimmingCharacters(in: .whitespacesAndNewlines), source: source, repo: trimmed.isEmpty ? nil : trimmed,
                context: context?.sendable
            )
        )
        upsert(reply.intake)
        return reply.intake
    }

    /// Confirme le plan, corrigé par `plan` s'il est donné : le serveur crée l'objet.
    /// `autonomy` : le curseur de la feature créée ; `nil` : celui de l'espace, sinon les règles du dépôt.
    @discardableResult
    public func confirm(_ intake: HarnessIntake, plan: HarnessIntakePlan? = nil, autonomy: HarnessRunAutonomy? = nil) async throws -> HarnessIntake {
        var patch = plan
        patch?.creates = nil
        return try await gesture(on: intake, path: "confirm", body: ConfirmBody(plan: patch, autonomy: autonomy?.rawValue))
    }

    /// Annule une demande (ou écarte une réponse directe, un échec).
    @discardableResult
    public func cancel(_ intake: HarnessIntake) async throws -> HarnessIntake {
        try await gesture(on: intake, path: "cancel", body: EmptyIntakeBody())
    }

    /// Répond à la question de clarification : la même demande repart en classement.
    @discardableResult
    public func answer(_ intake: HarnessIntake, text: String) async throws -> HarnessIntake {
        try await gesture(on: intake, path: "answer", body: AnswerIntakeBody(text: text.trimmingCharacters(in: .whitespacesAndNewlines)))
    }

    private func gesture<Body: Encodable>(on intake: HarnessIntake, path: String, body: Body) async throws -> HarnessIntake {
        busy.insert(intake.id)
        defer { busy.remove(intake.id) }
        do {
            let reply: HarnessIntakeReply = try await post("/v1/intake/\(HarnessModel.pathComponent(intake.id))/\(path)", body: body)
            upsert(reply.intake)
            return reply.intake
        } catch {
            await refresh()
            throw error
        }
    }

    /// Range la demande rendue : gardée tant qu'elle est ouverte, retirée sinon.
    private func upsert(_ intake: HarnessIntake) {
        open.removeAll { $0.id == intake.id }
        if Self.openStates.contains(intake.state) {
            open.append(intake)
            open.sort { $0.createdAt < $1.createdAt }
        }
    }

    /// Un envoi décodé ; l'erreur levée est un `HarnessIntakeFailure`, sauf une annulation.
    private func post<Body: Encodable, Reply: Decodable>(_ path: String, body: Body) async throws -> Reply {
        guard let harness, harness.isConfigured else { throw HarnessIntakeFailure.server(.unreachable) }
        guard let encoded = try? JSONEncoder().encode(body) else { throw HarnessIntakeFailure.server(.unreadable) }
        let call = HarnessCall(method: "POST", path: path, body: encoded)
        do {
            let reply = try await harness.exchange(call)
            if reply.status == 404, Self.isUnknownRoute(reply.body) {
                availability = .absent
                throw HarnessIntakeFailure.unsupported
            }
            return try harness.decode(reply, for: call)
        } catch let failure as HarnessIntakeFailure {
            throw failure
        } catch {
            guard let failure = HarnessModel.failure(of: error) else { throw error }
            throw HarnessIntakeFailure.server(failure)
        }
    }

    /// Un 404 « route inconnue » (serveur antérieur), pas « demande inconnue ».
    nonisolated static func isUnknownRoute(_ body: Data) -> Bool {
        let message = (try? JSONDecoder().decode(HarnessErrorBody.self, from: body))?.error ?? ""
        return !message.hasPrefix("demande inconnue")
    }
}

private struct SubmitBody: Encodable {
    var text: String
    var source: String
    var repo: String?
    var context: HarnessIntakeContext?
}

private struct ConfirmBody: Encodable {
    var plan: HarnessIntakePlan?
    var autonomy: String?
}

private struct AnswerIntakeBody: Encodable {
    var text: String
}

private struct EmptyIntakeBody: Encodable {}
