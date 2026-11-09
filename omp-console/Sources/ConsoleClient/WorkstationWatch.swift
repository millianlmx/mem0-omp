// La VEILLE PROACTIVE du poste côté client, partagée par la coque Mac et l'app iOS : les
// éléments qu'elle dépose dans « À traiter » — réponse proposée (prête ou à relire),
// relance, préparation de réunion, brief du matin (`GET /v1/workstation/watch` d'omp-harness,
// capacité `workstation-watch`).
//
// Comme tout le poste, la route est au PROPRIÉTAIRE : un jeton restreint (ou pilote) reçoit
// 403. Ce n'est pas une panne : le modèle passe en `.reserved` et n'affiche rien. Un serveur
// antérieur (404) ne montre rien non plus. Valider, modifier ou écarter une réponse viendra
// avec la validation des réponses proposées : ce modèle ne fait que lire.
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

/// Un élément de la veille tel que `GET /v1/workstation/watch` le rend.
public struct WorkstationWatchItem: Codable, Equatable, Sendable, Identifiable {
    /// `reply`, `followup`, `prep` ou `brief` ; une sorte inconnue de cette version se montre telle quelle.
    public var kind: String
    public var id: String
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
}

public struct WorkstationWatchList: Codable, Equatable, Sendable {
    public var items: [WorkstationWatchItem]
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
    /// Les éléments ouverts, les plus récents d'abord.
    @Published public private(set) var items: [WorkstationWatchItem] = []
    /// Le dernier échec de lecture, effacé par la prochaine lecture réussie.
    @Published public private(set) var failure: HarnessFailure?

    weak var harness: HarnessModel?
    private let reloadDelay: Duration
    private var reloadTask: Task<Void, Never>?

    init(harness: HarnessModel, reloadDelay: Duration) {
        self.harness = harness
        self.reloadDelay = reloadDelay
    }

    /// Le badge : les éléments qui attendent l'humain (0 hors d'un serveur qui les sert).
    public var pendingCount: Int {
        availability == .available ? items.count : 0
    }

    /// Relit les éléments ouverts. 404 (serveur antérieur ou poste désactivé) et 403 (jeton
    /// qui n'est pas celui du propriétaire) ne montrent rien, sans échec.
    public func refresh() async {
        guard let harness, harness.isConfigured else { return }
        let call = HarnessCall(method: "GET", path: "/v1/workstation/watch?state=open&limit=\(Self.itemsLimit)")
        do {
            let reply = try await harness.exchange(call)
            if reply.status == 404 {
                clear(.absent)
                return
            }
            let list: WorkstationWatchList = try harness.decode(reply, for: call)
            items = list.items.filter { $0.state == "open" }
            availability = .available
            failure = nil
        } catch HarnessFailure.forbidden {
            clear(.reserved)
        } catch {
            failure = HarnessModel.failure(of: error)
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
    }

    private func clear(_ next: Availability) {
        availability = next
        items = []
        failure = nil
    }
}
