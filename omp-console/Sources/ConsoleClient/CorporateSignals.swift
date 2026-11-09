// Le PONT CORPO ↔ USINE côté client, partagé par la coque Mac et l'app iOS : les
// signalements des collègues devenus propositions (« Ouvrir une issue et lancer un
// correctif dans <dépôt> »), leur aperçu exact, leur confirmation ou leur rejet, et
// l'origine d'une feature lancée depuis l'une d'elles (routes `/v1/signals*` et
// `GET /v1/runs/{id}/origin` d'omp-harness, capacité `corporate-signals`).
//
// Comme tout le poste, ces routes sont au PROPRIÉTAIRE : un jeton restreint à des
// dépôts reçoit 403 « le poste est réservé au propriétaire ». Ce n'est pas une panne :
// le modèle passe en `.reserved`, n'affiche rien et ne lève aucun bandeau. Confirmer et
// écarter exigent l'appareil approbateur : le refus du serveur (`.approverOnly`) est
// rendu à la feuille qui l'a demandé, les gestes restent offerts.
//
// Il n'a ni transport ni jeton à lui : il est porté par `HarnessModel`
// (`server.signals`) et relit sa liste à chaque événement `signal` du flux de la boîte.
//
// Aucun texte ici : un échec est un `HarnessFailure`, que les écrans traduisent.

import Foundation

// MARK: - Contrat JSON

/// L'issue créée pour un signalement : `{repo, number, url}`.
public struct CorporateSignalIssue: Codable, Equatable, Sendable {
    public var repo: String
    public var number: Int
    public var url: String
}

/// Un signalement tel que `GET /v1/signals` le rend.
public struct CorporateSignal: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var createdAt: Double
    public var updatedAt: Double
    /// `slack`, `gmail`, `chrome` ou `manual`.
    public var channel: String
    public var url: String
    public var personRef: String?
    /// L'extrait caviardé par le serveur.
    public var excerpt: String
    /// `received`, `proposed`, `ignored`, `dismissed` ou `confirmed`.
    public var state: String
    public var error: String?
    /// Le dépôt proposé par la détection.
    public var repo: String?
    /// `bug` ou `feature`.
    public var kind: String?
    public var title: String?
    public var body: String?
    public var issue: CorporateSignalIssue?
    public var runId: String?
}

public struct CorporateSignalList: Codable, Equatable, Sendable {
    public var signals: [CorporateSignal]
}

public struct CorporateSignalReply: Codable, Equatable, Sendable {
    public var signal: CorporateSignal
}

/// La politique `issues.corporate` du dépôt : déclarée, appliquée, et sa note.
public struct CorporatePolicy: Codable, Equatable, Sendable {
    /// `forbid`, `redacted` ou `full`.
    public var declared: String
    /// `redacted` ou `full`.
    public var applied: String
    public var note: String?
}

/// Le texte EXACT que la confirmation enverrait à la forge (`POST /v1/signals/{id}/preview`).
public struct CorporateSignalPreview: Codable, Equatable, Sendable {
    public var repo: String
    public var policy: CorporatePolicy
    public var title: String
    public var body: String
    /// L'issue déjà créée : le texte n'est alors plus renvoyé à la forge.
    public var issue: CorporateSignalIssue?
}

/// Ce que la confirmation a créé : l'issue, la politique appliquée, et le signalement à jour
/// (qui porte l'identifiant de la feature lancée).
public struct CorporateConfirmation: Codable, Equatable, Sendable {
    public var signal: CorporateSignal
    public var issue: CorporateSignalIssue
    public var policy: CorporatePolicy
}

/// L'origine d'une feature lancée depuis un signalement (`GET /v1/runs/{id}/origin`).
public struct CorporateRunOrigin: Codable, Equatable, Sendable {
    public var signalId: String
    public var channel: String
    /// Le lien du fil (vide pour une demande du poste).
    public var url: String
    /// La personne telle que le canal l'a remise (adresse, pseudo, identifiant).
    public var personRef: String?
    public var excerpt: String
    public var issue: CorporateSignalIssue
    public var confirmedBy: String?
    public var confirmedAt: Double?
}

public struct CorporateRunOriginReply: Codable, Equatable, Sendable {
    public var origin: CorporateRunOrigin?
}

// MARK: - Modèle

@MainActor
public final class CorporateSignalsModel: ObservableObject {
    /// Ce que le serveur relié dit des signalements.
    public enum Availability: Equatable, Sendable {
        /// Pas encore lu.
        case unknown
        /// Le serveur sert les signalements à ce jeton.
        case available
        /// Le serveur ne connaît pas les routes (antérieur au pont corpo ↔ usine).
        case absent
        /// Le jeton ne voit pas tous les dépôts (ou c'est un pilote) : rien n'est montré.
        case reserved
    }

    /// Les propositions lues d'un coup (le serveur borne une page à 200).
    public static let proposalsLimit = 200

    @Published public private(set) var availability: Availability = .unknown
    /// Les propositions ouvertes (`proposed`), les plus récentes d'abord.
    @Published public private(set) var proposals: [CorporateSignal] = []
    /// L'origine des features lues, par identifiant ; absente : la feature n'en porte pas.
    @Published public private(set) var origins: [String: CorporateRunOrigin] = [:]
    /// Le dernier échec de lecture de la liste, effacé par la prochaine lecture réussie.
    @Published public private(set) var failure: HarnessFailure?
    /// Les signalements dont un geste (confirmation, rejet) attend la réponse du serveur.
    @Published public private(set) var busy: Set<String> = []

    weak var harness: HarnessModel?
    private let reloadDelay: Duration
    private var reloadTask: Task<Void, Never>?

    init(harness: HarnessModel, reloadDelay: Duration) {
        self.harness = harness
        self.reloadDelay = reloadDelay
    }

    /// Le badge : les propositions qui attendent l'humain (0 hors d'un serveur qui les sert).
    public var pendingCount: Int {
        availability == .available ? proposals.count : 0
    }

    // MARK: - Lecture

    /// Relit les propositions ouvertes. Un serveur antérieur (404) ou un jeton qui n'est
    /// pas celui du propriétaire (403) ne montre rien, sans échec.
    public func refresh() async {
        guard let harness, harness.isConfigured else { return }
        let call = HarnessCall(method: "GET", path: "/v1/signals?state=proposed&limit=\(Self.proposalsLimit)")
        do {
            let reply = try await harness.exchange(call)
            if reply.status == 404 {
                clear(.absent)
                return
            }
            let list: CorporateSignalList = try harness.decode(reply, for: call)
            proposals = list.signals.filter { $0.state == "proposed" }
            availability = .available
            failure = nil
        } catch HarnessFailure.forbidden {
            clear(.reserved)
        } catch {
            failure = HarnessModel.failure(of: error)
        }
    }

    /// Lit l'origine d'une feature. Sans origine, sur un serveur antérieur ou pour un jeton
    /// restreint (403), rien n'est gardé et rien n'est dit : la page ne montre rien de plus.
    public func loadOrigin(runId: String) async {
        guard let harness, harness.isConfigured else { return }
        switch availability {
        case .absent, .reserved: return
        case .unknown, .available: break
        }
        let call = HarnessCall(method: "GET", path: "/v1/runs/\(HarnessModel.pathComponent(runId))/origin")
        guard let reply = try? await harness.exchange(call) else { return }
        guard reply.status == 200, let read = try? JSONDecoder().decode(CorporateRunOriginReply.self, from: reply.body) else {
            origins[runId] = nil
            return
        }
        origins[runId] = read.origin
    }

    /// Les noms des événements reçus par le flux de la boîte : `signal` fait relire
    /// (regroupé : une rafale ne coûte qu'une relecture).
    func receive(_ names: [String]) {
        guard names.contains("signal") else { return }
        switch availability {
        case .absent, .reserved: return
        case .unknown, .available: break
        }
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
        origins = [:]
        busy = []
    }

    private func clear(_ next: Availability) {
        availability = next
        proposals = []
        failure = nil
    }

    // MARK: - Gestes de l'humain

    /// Le titre et le corps EXACTS que la confirmation enverrait à la forge, pour ce dépôt
    /// et ce texte (`nil` : ceux de la proposition). Ne crée rien.
    public func preview(_ signal: CorporateSignal, repo: String?, title: String?, body: String?) async throws -> CorporateSignalPreview {
        try await post("/v1/signals/\(HarnessModel.pathComponent(signal.id))/preview", body: TextBody(repo: repo, title: title, body: body))
    }

    /// Confirme la proposition vers `repo` avec ce titre et ce corps : le serveur crée
    /// l'issue puis la feature liée. Seul un bouton que l'humain touche l'appelle.
    public func confirm(_ signal: CorporateSignal, repo: String, title: String, body: String) async throws -> CorporateConfirmation {
        try await gesture(on: signal) {
            try await self.post("/v1/signals/\(HarnessModel.pathComponent(signal.id))/confirm", body: TextBody(repo: repo, title: title, body: body))
        }
    }

    /// Écarte la proposition (jamais reproposée) ; la raison, facultative, est gardée.
    public func dismiss(_ signal: CorporateSignal, reason: String = "") async throws {
        let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        let _: CorporateSignalReply = try await gesture(on: signal) {
            try await self.post("/v1/signals/\(HarnessModel.pathComponent(signal.id))/dismiss", body: DismissBody(reason: trimmed.isEmpty ? nil : trimmed))
        }
    }

    /// Un geste sur un signalement : marqué en cours, puis la liste relue (succès ou échec :
    /// une proposition traitée ailleurs disparaît, une forge en échec garde la sienne).
    private func gesture<Reply>(on signal: CorporateSignal, _ send: () async throws -> Reply) async throws -> Reply {
        busy.insert(signal.id)
        defer { busy.remove(signal.id) }
        do {
            let reply = try await send()
            proposals.removeAll { $0.id == signal.id }
            await refresh()
            return reply
        } catch {
            await refresh()
            throw error
        }
    }

    /// Un envoi décodé ; l'erreur levée est toujours un `HarnessFailure`, sauf une annulation.
    private func post<Body: Encodable, Reply: Decodable>(_ path: String, body: Body) async throws -> Reply {
        guard let harness, harness.isConfigured else { throw HarnessFailure.unreachable }
        guard let encoded = try? JSONEncoder().encode(body) else { throw HarnessFailure.unreadable }
        let call = HarnessCall(method: "POST", path: path, body: encoded)
        do {
            return try harness.decode(try await harness.exchange(call), for: call)
        } catch {
            if let failure = HarnessModel.failure(of: error) { throw failure }
            throw error
        }
    }
}

/// `repo`, `title`, `body` : un champ `nil` est absent du JSON (aperçu de la proposition).
private struct TextBody: Encodable {
    var repo: String?
    var title: String?
    var body: String?
}

/// `reason` absent du JSON quand il est `nil`.
private struct DismissBody: Encodable {
    var reason: String?
}
