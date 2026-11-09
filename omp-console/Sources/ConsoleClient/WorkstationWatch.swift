// La VEILLE PROACTIVE du poste côté client, partagée par la coque Mac et l'app iOS : les
// éléments qu'elle dépose dans « À traiter » — réponse proposée (prête ou à relire),
// relance, préparation de réunion, brief du matin (`GET /v1/workstation/watch` d'omp-harness,
// capacité `workstation-watch`) — et la VALIDATION d'une réponse ou d'une relance.
//
// Comme tout le poste, la route est au PROPRIÉTAIRE : un jeton restreint (ou pilote) reçoit
// 403. Ce n'est pas une panne : le modèle passe en `.reserved` et n'affiche rien. Un serveur
// antérieur (404) ne montre rien non plus.
//
// « À traiter » montre les éléments proposés (`open`), validés en attente d'envoi
// (`validated`, avec la raison d'attente de la demande du poste rattachée) et ceux dont
// l'envoi n'a pas abouti (`failed`, revalidables). Écarter (`…/dismiss`) et valider
// (`…/validate`, texte proposé ou modifié, `If-Match` de la révision lue) sont des gestes de
// l'appareil APPROBATEUR : le serveur refuse les autres (403, `.approverOnly`). Une réponse
// changée depuis la lecture (412) revient en `.stale` ; un état qui ne permet plus le geste
// (409) revient avec le motif du serveur. La liste est relue après chaque geste.
//
// Il est porté par `HarnessModel` (`server.watch`) et relit la file à chaque événement
// `workstation_watch` du flux de la boîte. Aucun texte ici.

import Foundation

// MARK: - Contrat JSON

/// Le brouillon d'une réponse : Gmail (créé par API, `id` absent tant qu'il ne l'est pas)
/// ou interne au serveur (Slack).
public struct WorkstationWatchDraft: Codable, Equatable, Sendable {
    public var kind: String
    public var id: String?
    public var error: String?
}

/// L'état vivant de la demande du poste qui envoie une réponse validée.
public struct WorkstationWatchRequest: Codable, Equatable, Sendable {
    public var id: String
    /// `queued`, `running`, `done`, `failed` ou `cancelled`.
    public var state: String
    /// Pourquoi elle attend (plafond, slot, extension hors ligne) ou a échoué.
    public var reason: String?
}

/// Un élément de la veille tel que `GET /v1/workstation/watch` le rend.
public struct WorkstationWatchItem: Codable, Equatable, Sendable, Identifiable {
    /// `reply`, `followup`, `prep` ou `brief` ; une sorte inconnue de cette version se montre telle quelle.
    public var kind: String
    public var id: String
    /// `open` (proposée), `validated` (en attente d'envoi), `sent`, `dismissed` ou `failed`
    /// (envoi non abouti, revalidable).
    public var state: String
    /// Une réponse « prête » : la personne est au niveau `réponse` et le message traite d'un sujet listé.
    public var ready: Bool
    /// `gmail`, `slack`, `calendar` ou absent (brief).
    public var channel: String?
    public var topic: String?
    public var subject: String?
    public var text: String
    public var draft: WorkstationWatchDraft?
    public var rev: Int
    public var createdAt: Double
    /// La demande du poste rattachée à la validation ; `nil` avant (ou serveur antérieur).
    public var requestId: String?
    public var validatedAt: Double?
    /// Pourquoi l'envoi n'a pas abouti (`failed`).
    public var sendError: String?
    /// L'état vivant de la demande rattachée.
    public var request: WorkstationWatchRequest?

    /// Une réponse ou une relance : ce qui se valide et part.
    public var isReply: Bool { kind == "reply" || kind == "followup" }

    /// Écarter ou valider est permis : une réponse proposée, ou dont l'envoi n'a pas abouti.
    public var isDecidable: Bool { isReply && (state == "open" || state == "failed") }
}

public struct WorkstationWatchList: Codable, Equatable, Sendable {
    public var items: [WorkstationWatchItem]
}

/// La réponse d'un geste : l'élément écrit (`{item}` ou `{item, request}`).
struct WorkstationWatchReply: Decodable {
    var item: WorkstationWatchItem
}

/// Le corps de `…/validate` : `{}` pour le texte proposé tel quel, `{text}` s'il est modifié.
private struct ValidateBody: Encodable {
    var text: String?
}

// MARK: - Modèle

@MainActor
public final class WorkstationWatchModel: ObservableObject {
    /// Ce que le serveur relié dit de la veille.
    public enum Availability: Equatable, Sendable {
        case unknown
        case available
        /// Le serveur ne connaît pas la route (antérieur à la veille).
        case absent
        /// Le jeton n'est pas celui du propriétaire (restreint ou pilote) : rien n'est montré.
        case reserved
    }

    /// Les éléments lus d'un coup.
    public static let itemsLimit = 200

    @Published public private(set) var availability: Availability = .unknown
    /// Les éléments proposés, validés en attente d'envoi ou non envoyés, les plus récents d'abord.
    @Published public private(set) var items: [WorkstationWatchItem] = []
    /// Le dernier échec de lecture (ou d'un geste venu d'une notification), effacé par la
    /// prochaine lecture réussie.
    @Published public private(set) var failure: HarnessFailure?
    /// Les éléments dont un geste est en vol.
    @Published public private(set) var busy: Set<String> = []

    weak var harness: HarnessModel?
    private let reloadDelay: Duration
    private var reloadTask: Task<Void, Never>?

    init(harness: HarnessModel, reloadDelay: Duration) {
        self.harness = harness
        self.reloadDelay = reloadDelay
    }

    /// Ce jeton est celui de l'appareil approbateur : lui seul écarte et valide.
    public var isApprover: Bool { harness?.client?.approver ?? false }

    /// Le badge : les éléments qui attendent l'humain — proposés ou non envoyés ; une réponse
    /// validée attend l'envoi, pas lui (0 hors d'un serveur qui les sert).
    public var pendingCount: Int {
        availability == .available ? items.filter { $0.state != "validated" }.count : 0
    }

    /// Relit les éléments à traiter. 404 (serveur antérieur ou poste désactivé) et 403 (jeton
    /// qui n'est pas celui du propriétaire) ne montrent rien, sans échec.
    public func refresh() async {
        guard let harness, harness.isConfigured else { return }
        let call = HarnessCall(method: "GET", path: "/v1/workstation/watch?state=open,validated,failed&limit=\(Self.itemsLimit)")
        do {
            let reply = try await harness.exchange(call)
            if reply.status == 404 {
                clear(.absent)
                return
            }
            let list: WorkstationWatchList = try harness.decode(reply, for: call)
            items = list.items.filter { Self.shownStates.contains($0.state) }
            availability = .available
            failure = nil
        } catch HarnessFailure.forbidden {
            clear(.reserved)
        } catch {
            failure = HarnessModel.failure(of: error)
        }
    }

    /// Les états que « À traiter » montre (ceux que la lecture demande).
    private static let shownStates: Set<String> = ["open", "validated", "failed"]

    // MARK: - Gestes (appareil approbateur)

    /// Écarte la réponse LUE : le serveur supprime son brouillon Gmail ; elle ne revient pas.
    public func dismiss(_ item: WorkstationWatchItem) async throws {
        let call = HarnessCall(method: "POST", path: "/v1/workstation/watch/\(HarnessModel.pathComponent(item.id))/dismiss")
        try await gesture(on: item.id, call)
    }

    /// Valide la réponse LUE (`item.rev` part en If-Match) : le texte proposé tel quel (`nil`
    /// ou inchangé : corps `{}`), ou le texte modifié, que le serveur reporte au brouillon
    /// Gmail avant de confier l'envoi au poste.
    public func validate(_ item: WorkstationWatchItem, text: String?) async throws {
        let edited = text.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        let changed = edited == item.text.trimmingCharacters(in: .whitespacesAndNewlines) ? nil : edited
        guard let encoded = try? JSONEncoder().encode(ValidateBody(text: changed)) else { throw HarnessFailure.unreadable }
        let call = HarnessCall(
            method: "POST",
            path: "/v1/workstation/watch/\(HarnessModel.pathComponent(item.id))/validate",
            body: encoded,
            headers: ["If-Match": "\"\(item.rev)\""]
        )
        try await gesture(on: item.id, call)
    }

    /// L'action « Valider » d'une notification `omp.reply` que l'humain a touchée, appareil
    /// déverrouillé : le texte proposé tel quel, SANS corps ni If-Match (la notification ne
    /// porte pas de révision). `false` si le serveur a refusé : l'échec est dans `failure`.
    func validateFromNotification(watchId: String) async -> Bool {
        let call = HarnessCall(method: "POST", path: "/v1/workstation/watch/\(HarnessModel.pathComponent(watchId))/validate")
        do {
            try await gesture(on: watchId, call)
            return true
        } catch {
            failure = HarnessModel.failure(of: error)
            return false
        }
    }

    /// Un geste sur un élément : la liste est relue après, qu'il ait abouti ou non (412 :
    /// la réponse a changé ; 409 : son état ne permet plus le geste).
    private func gesture(on id: String, _ call: HarnessCall) async throws {
        guard let harness, harness.isConfigured else { throw HarnessFailure.unreachable }
        busy.insert(id)
        defer { busy.remove(id) }
        do {
            let _: WorkstationWatchReply = try harness.decode(try await harness.exchange(call), for: call)
            await refresh()
        } catch {
            await refresh()
            if let failure = HarnessModel.failure(of: error) { throw failure }
            throw error
        }
    }

    /// Les noms des événements du flux : `workstation_watch` fait relire (regroupé).
    func receive(_ names: [String]) {
        guard names.contains("workstation_watch") else { return }
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
        busy = []
    }

    private func clear(_ next: Availability) {
        availability = next
        items = []
        failure = nil
    }
}
