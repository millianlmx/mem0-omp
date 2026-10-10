// Le modèle de la section Statistiques de l'app iOS (BR-4, S-3, S-5) : il porte le
// client partagé, un relevé (`GET /v1/stats`) et le projet choisi, et il décide de
// la surface à montrer. Aucune règle de calcul n'est refaite ici : les totaux
// viennent des extensions d'avancement de `ConsoleClient`.
//
// Quatre déclencheurs de relevé, AUCUN geste de scrutation (S-5) : l'apparition de
// la section, le changement de projet, un nouvel état du magasin publié par le
// client (`board`) et une mise à jour de session reçue du Mac (`sessionUpdates`).
// Aucun relevé n'est émis tant que le client n'est pas `.connected` (S-4).

import Combine
import ConsoleClient
import Foundation

/// La surface que la section doit montrer (S-4), décidée par l'état du client, le
/// dernier relevé et l'échec éventuel.
enum IOSStatsSurface: Equatable {
    /// Client hors `.connected` : bandeau `attention`, aucun relevé émis.
    case degraded(String)
    /// Aucun relevé encore reçu.
    case loading
    /// Relevé échoué : bandeau `danger` + « Réessayer ».
    case error(String)
    /// Le magasin ne porte aucun projet : carte « Aucun projet ».
    case noProject
    /// Un relevé est affiché, mais le projet CHOISI n'est pas celui qu'il sert :
    /// la lecture du projet choisi est en cours. En-tête, puis ligne de chargement.
    case switching
    /// Le projet affiché n'a aucune feature listée : en-tête, puis carte « Aucune
    /// donnée… ».
    case empty
    /// Le tableau : en-tête, cartes de feature, ligne de total.
    case board

    /// L'en-tête de projet (le sélecteur, qui nomme le projet choisi) est en tête
    /// du contenu de la bascule, de l'état vide et du tableau, et de ceux-là
    /// seulement : le premier chargement, la perte de connexion, l'erreur et
    /// l'absence de projet gardent leur écran propre.
    var showsProjectHeader: Bool {
        switch self {
        case .switching, .empty, .board: return true
        case .degraded, .loading, .error, .noProject: return false
        }
    }
}

/// Les quatre sources d'un relevé (S-5). Elles existent pour que chaque
/// déclencheur soit éprouvable et pour qu'aucune cinquième voie (minuterie) ne
/// s'ajoute sans qu'on s'en aperçoive.
enum StatsTrigger: Equatable {
    case appeared
    case projectChanged
    case boardChanged
    case sessionsChanged
}

@MainActor
final class IOSStatsModel: ObservableObject {
    /// La lecture d'un relevé : la SEULE route de la section (S-6).
    typealias Load = @MainActor (String?) async throws -> RemoteStatsPayload

    @Published private(set) var payload: RemoteStatsPayload?
    /// L'instant de RÉCEPTION du relevé : l'avancement des durées part de là (S-5).
    @Published private(set) var receivedAtMs: Double?
    /// La clé du projet affiché — celle du dernier relevé reçu, puis celle de
    /// l'utilisateur (S-3). `nil` : le Mac choisit.
    @Published private(set) var selectedKey: String?
    @Published private(set) var failure: String?

    /// Le nombre de relevés émis : une mesure des tests (jamais affichée).
    private(set) var loadCount = 0

    private let load: Load
    private let state: @MainActor () -> ClientState
    private let nowMs: @Sendable () -> Double
    private var task: Task<Void, Never>?

    /// Le point d'injection des tests : un relevé espion et un état forgé.
    init(
        load: @escaping Load,
        state: @escaping @MainActor () -> ClientState,
        nowMs: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }
    ) {
        self.load = load
        self.state = state
        self.nowMs = nowMs
    }

    /// Le modèle de production : le client partagé de la coque.
    convenience init(client: ConsoleClientModel) {
        self.init(
            load: { try await client.statistics(project: $0) },
            state: { [weak client] in client?.state ?? .unpaired }
        )
    }

    deinit { task?.cancel() }

    // MARK: - Décisions PURES (testables sans render)

    /// La surface choisie pour un état de client, un relevé, un échec et le projet
    /// choisi (S-1). L'ordre de priorité est celui de la lecture : hors
    /// `.connected` d'abord (aucun relevé n'a été émis), puis l'échec, puis
    /// l'absence de relevé, puis un projet choisi que le relevé ne sert pas encore.
    static func surface(
        state: ClientState,
        payload: RemoteStatsPayload?,
        failure: String?,
        selectedKey: String?
    ) -> IOSStatsSurface {
        guard case .connected = state else { return .degraded(ConnectionText.state(state)) }
        if let failure { return .error(failure) }
        guard let payload else { return .loading }
        guard payload.projectKey != nil else { return .noProject }
        guard selectedKey == payload.projectKey else { return .switching }
        return payload.features.isEmpty ? .empty : .board
    }

    /// Un relevé est émis pour CHAQUE déclencheur, et seulement client `.connected`
    /// (S-5).
    static func reloads(_ trigger: StatsTrigger, state: ClientState) -> Bool {
        _ = trigger
        guard case .connected = state else { return false }
        return true
    }

    // MARK: - Faits dérivés du relevé

    var surface: IOSStatsSurface {
        Self.surface(state: state(), payload: payload, failure: failure, selectedKey: selectedKey)
    }

    /// Les options du sélecteur : EXACTEMENT les projets servis par le Mac (S-3).
    var projects: [RemoteStatsProject] { payload?.projects ?? [] }

    /// Le temps écoulé depuis la réception du relevé (ms), pour l'avancement.
    func elapsedMs(at nowMs: Double) -> Double {
        guard let receivedAtMs else { return 0 }
        return max(0, nowMs - receivedAtMs)
    }

    // MARK: - Relevés

    /// Un relevé de plus, si le déclencheur y a droit.
    func reload(trigger: StatsTrigger) {
        guard Self.reloads(trigger, state: state()) else { return }
        loadCount += 1
        task?.cancel()
        let key = selectedKey
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let payload = try await self.load(key)
                if Task.isCancelled { return }
                self.payload = payload
                self.receivedAtMs = self.nowMs()
                self.selectedKey = payload.projectKey
                self.failure = nil
            } catch {
                if Task.isCancelled { return }
                self.failure = IOSStatsText.failure(error, state: self.state())
            }
        }
    }

    /// Le choix de l'utilisateur : un relevé IMMÉDIAT avec la clé choisie (S-3).
    func select(project key: String) {
        guard key != selectedKey else { return }
        selectedKey = key
        failure = nil
        reload(trigger: .projectChanged)
    }
}
