// Le modèle observable du POSTE DE TRAVAIL, partagé par la coque Mac et l'app iOS :
// l'état de l'extension Chrome et de l'agent 24/24, les envois qui attendent
// l'approbation de l'humain, le journal des décisions, le profil établi et les
// réunions transcrites — et les gestes de l'humain (approuver, refuser, régler
// l'autonomie, mettre en pause, déclarer ses adresses, reconstruire le profil).
//
// Il n'a NI transport, NI jeton, NI adresse à lui : il est porté par `HarnessModel`
// (`server.workstation`) et passe par son échange — même serveur, même jeton, même
// transport. Il n'ouvre pas de second flux d'événements : le flux de la boîte lui
// transmet les noms des événements reçus, et ceux du poste (`workstation_*`) le
// font relire.
//
// L'INVARIANT du poste vit au serveur et dans l'extension : envoyer un message à
// quelqu'un d'autre que l'utilisateur exige TOUJOURS un geste humain d'approbation.
// Ce modèle n'approuve jamais de lui-même : `approve(shown:)` n'est appelé que par un
// bouton que l'humain touche, avec l'action telle que l'écran la montre. Le geste porte
// `If-Match: "<updatedAt>"` de cette action : si l'envoi a changé depuis (autre appareil,
// brouillon recalculé), le serveur refuse (412) et rien n'est approuvé. Approuver,
// refuser et régler exigent le jeton APPROBATEUR (`harness.sh approver`) : avec un jeton
// ordinaire, le serveur répond 403 et l'échec est `.approverOnly`. Les gestes restent
// offerts : c'est le serveur qui décide, jamais l'app.
//
// Aucun texte ici : un échec est un `HarnessFailure`, que les écrans traduisent.

import Combine
import Foundation

@MainActor
public final class WorkstationModel: ObservableObject {
    /// Ce que le serveur relié dit du poste.
    public enum Availability: Equatable, Sendable {
        /// Pas encore lu (aucun serveur relié, ou première lecture en cours).
        case unknown
        /// Le serveur sert le poste à ce jeton.
        case available
        /// Le serveur ne connaît pas les routes du poste (antérieur à la feature).
        case absent
        /// Le jeton ne voit pas tous les dépôts : le poste est réservé au propriétaire.
        case reserved(String)
    }

    /// Les envois à approuver lus d'un coup (le serveur borne une page à 200).
    public static let approvalsLimit = 200
    /// Les entrées du journal des décisions lues à l'ouverture de la section.
    public static let journalLimit = 100
    /// Les réunions lues à l'ouverture de la section.
    public static let meetingsLimit = 20

    @Published public private(set) var availability: Availability = .unknown
    @Published public private(set) var status: WorkstationStatus?
    /// Les actions en `awaiting_approval`, les plus récentes d'abord.
    @Published public private(set) var approvals: [WorkstationAction] = []
    /// Le journal des décisions, le plus récent d'abord (lu quand la section est ouverte).
    @Published public private(set) var journal: [WorkstationAction] = []
    @Published public private(set) var profile: WorkstationProfileReply?
    @Published public private(set) var meetings: [WorkstationMeeting] = []
    /// Le dernier échec, effacé par le prochain échange réussi.
    @Published public private(set) var failure: HarnessFailure?
    @Published public private(set) var isLoading = false
    /// Les actions dont l'approbation ou le refus attend la réponse du serveur.
    @Published public private(set) var busy: Set<Int> = []
    /// Un réglage attend la réponse du serveur.
    @Published public private(set) var isSaving = false
    /// Une reconstruction du profil a été acceptée par le serveur.
    @Published public private(set) var rebuildQueued = false

    /// Le serveur annonce `workstation-requests` (`features` de `GET /v1/health`) : sans lui,
    /// ni les demandes ni les automatisations ne sont lues ni offertes.
    @Published public private(set) var requestsEnabled = false
    /// Les demandes, dans l'ordre du serveur (récentes d'abord).
    @Published public private(set) var requests: [WorkstationRequest] = []
    @Published public private(set) var automations: [WorkstationAutomation] = []
    /// La demande dépliée (une seule), et son détail une fois lu : `nil` ou celui de cette demande.
    @Published public private(set) var openRequestId: String?
    @Published public private(set) var openRequest: WorkstationRequestDetail?
    /// L'échec d'une demande (poser, annuler, lire un détail), de l'automatisation d'une
    /// tâche du profil, et des gestes sur les automatisations (lancer, supprimer).
    @Published public private(set) var requestsFailure: HarnessFailure?
    @Published public private(set) var automationsFailure: HarnessFailure?
    @Published public private(set) var automateFailure: HarnessFailure?
    /// Une consigne attend la réponse du serveur.
    @Published public private(set) var isAsking = false
    @Published public private(set) var busyRequests: Set<String> = []
    @Published public private(set) var busyAutomations: Set<String> = []
    @Published public private(set) var busyTasks: Set<Int> = []

    /// Le porteur de l'échange ; il possède ce modèle (référence faible : pas de cycle).
    private weak var harness: HarnessModel?
    private let reloadDelay: Duration
    /// La section est ouverte : profil, journal et réunions sont relus avec l'état.
    private var wantsDetails = false
    private var reloadTask: Task<Void, Never>?
    /// Le drapeau est lu au moins une fois pour ce serveur (sa dernière valeur est gardée).
    private var featuresRead = false
    /// Un événement est arrivé pendant une relecture : une de plus suit.
    private var reloadPending = false

    init(harness: HarnessModel, reloadDelay: Duration) {
        self.harness = harness
        self.reloadDelay = reloadDelay
    }

    /// Le badge : les envois qui attendent l'humain (0 hors d'un poste servi).
    public var pendingCount: Int {
        guard availability == .available else { return 0 }
        return status?.pending ?? approvals.count
    }

    /// Les gestes sont permis à ce jeton (un lecteur voit, n'agit pas).
    public var canAct: Bool { harness?.canAct ?? false }

    // MARK: - Lecture

    /// Ouvre la section : l'état, les envois à approuver, puis le profil, le journal et
    /// les réunions — relus ensuite à chaque événement du poste.
    public func load() async {
        wantsDetails = true
        await readFeatures()
        await refresh()
    }

    /// Relit l'état et les envois à approuver (et le reste si la section a été ouverte).
    /// Un échec garde les dernières données lues. Sans serveur relié, rien ne part.
    public func refresh() async {
        guard let harness, harness.isConfigured else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let reply = try await harness.exchange(HarnessCall(method: "GET", path: "/v1/workstation"))
            // Un serveur antérieur au poste n'a pas la route : la section le dit, sans échec.
            if reply.status == 404 {
                clear(.absent)
                return
            }
            let read: WorkstationStatus = try HarnessModel.decoded(reply)
            status = read
            availability = .available
            let pending: WorkstationActionList = try await get("/v1/workstation/actions?state=awaiting_approval&limit=\(Self.approvalsLimit)")
            approvals = pending.actions
            if wantsDetails {
                if !featuresRead { await readFeatures() }
                let recent: WorkstationActionList = try await get("/v1/workstation/actions?limit=\(Self.journalLimit)")
                journal = recent.actions
                profile = try await get("/v1/workstation/profile")
                let list: WorkstationMeetingList = try await get("/v1/workstation/meetings?limit=\(Self.meetingsLimit)")
                meetings = list.meetings
                if requestsEnabled { try await readRequests() }
            }
            failure = nil
        } catch HarnessFailure.forbidden(let motive) {
            clear(.reserved(motive))
        } catch {
            failure = HarnessModel.failure(of: error)
        }
    }

    /// Les noms des événements reçus par le flux de la boîte : ceux du poste font
    /// relire (regroupés : une rafale ne coûte qu'une relecture).
    func receive(_ names: [String]) {
        guard names.contains(where: { $0.hasPrefix("workstation_") }) else { return }
        switch availability {
        case .absent, .reserved: return
        case .unknown, .available: break
        }
        // Un événement reçu pendant une relecture n'est pas perdu : il en demande une de plus.
        guard reloadTask == nil else {
            reloadPending = true
            return
        }
        let delay = reloadDelay
        reloadTask = Task { [weak self] in
            var again = true
            while again {
                try? await Task.sleep(for: delay)
                guard !Task.isCancelled, let model = self else { return }
                model.reloadPending = false
                await model.refresh()
                guard !Task.isCancelled else { return }
                again = model.reloadPending
            }
            self?.reloadTask = nil
        }
    }

    /// Oublie tout ce qui a été lu : le serveur a changé (ou a été oublié).
    func reset() {
        reloadTask?.cancel()
        reloadTask = nil
        reloadPending = false
        requestsEnabled = false
        featuresRead = false
        clear(.unknown)
        failure = nil
        busy = []
        busyRequests = []
        busyAutomations = []
        busyTasks = []
        isAsking = false
    }

    private func clear(_ next: Availability) {
        availability = next
        status = nil
        approvals = []
        journal = []
        profile = nil
        meetings = []
        rebuildQueued = false
        failure = nil
        requests = []
        automations = []
        openRequestId = nil
        openRequest = nil
        requestsFailure = nil
        automationsFailure = nil
        automateFailure = nil
    }

    // MARK: - Gestes de l'humain

    /// Approuve l'envoi TEL QUE L'HUMAIN LE VOIT : l'action repart en file avec
    /// `approved: true`, et l'extension l'exécute. Seul un geste humain l'appelle. Si
    /// l'envoi a changé depuis son affichage, le serveur refuse : la liste est relue et
    /// l'échec `.approvalChanged` demande de relire avant d'approuver.
    @discardableResult
    public func approve(shown action: WorkstationAction) async -> Bool {
        let seq = action.seq
        return await decide(action, path: "/v1/workstation/actions/\(seq)/approve", body: EmptyBody())
    }

    /// Refuse l'envoi tel que l'humain l'a vu ; la raison, facultative, est gardée au journal.
    @discardableResult
    public func refuse(shown action: WorkstationAction, reason: String = "") async -> Bool {
        let seq = action.seq
        let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        return await decide(action, path: "/v1/workstation/actions/\(seq)/refuse", body: RefuseBody(reason: trimmed.isEmpty ? nil : trimmed))
    }

    /// Règle l'autonomie de l'agent 24/24. La garde d'envoi reste entière dans tous les modes.
    @discardableResult
    public func setAutonomy(_ setting: WorkstationAutonomySetting) async -> Bool {
        await saveSettings(SettingsBody(autonomy: setting.rawValue))
    }

    /// Met le poste en pause (aucune action ne part, l'observation est refusée), ou l'en sort.
    @discardableResult
    public func setPaused(_ paused: Bool) async -> Bool {
        await saveSettings(SettingsBody(paused: paused))
    }

    /// Déclare les adresses et pseudos de l'utilisateur (nettoyés, sans doublon).
    @discardableResult
    public func setSelfIdentities(_ identities: [String]) async -> Bool {
        await saveSettings(SettingsBody(selfIdentities: Self.normalized(identities)))
    }

    /// Demande au serveur de reconstruire le profil (un runner s'en charge).
    @discardableResult
    public func rebuildProfile() async -> Bool {
        guard let harness, harness.isConfigured else { return false }
        isSaving = true
        defer { isSaving = false }
        do {
            let _: QueuedReply = try HarnessModel.decoded(
                try await harness.exchange(HarnessCall(method: "POST", path: "/v1/workstation/profile/rebuild", body: Data("{}".utf8)))
            )
            rebuildQueued = true
            failure = nil
            return true
        } catch {
            failure = HarnessModel.failure(of: error)
            return false
        }
    }

    // MARK: - Demandes

    /// La saisie peut être posée : une consigne non vide une fois les blancs ôtés.
    public static func canAsk(_ text: String) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Une demande en file ou en cours peut être annulée ; une demande finie, ou d'un état
    /// inconnu de cette version, non.
    public static func canCancel(_ phase: WorkstationRequestState?) -> Bool {
        phase == .queued || phase == .running
    }

    /// Pose une consigne en texte libre : l'agent du poste l'exécute dans le navigateur,
    /// par l'extension Chrome. Aucun run ni pipeline.
    @discardableResult
    public func ask(_ instruction: String) async -> Bool {
        guard let harness, harness.isConfigured, requestsEnabled else { return false }
        let trimmed = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        guard let encoded = try? JSONEncoder().encode(AskBody(instruction: trimmed)) else {
            requestsFailure = .unreadable
            return false
        }
        requestsFailure = nil
        isAsking = true
        defer { isAsking = false }
        do {
            let _: WorkstationRequestReply = try HarnessModel.decoded(
                try await harness.exchange(HarnessCall(method: "POST", path: "/v1/workstation/requests", body: encoded))
            )
            await refresh()
            return true
        } catch {
            requestsFailure = HarnessModel.failure(of: error)
            return false
        }
    }

    /// Annule une demande en file ou en cours. Sur un échec la liste est relue, puis l'échec dit.
    @discardableResult
    public func cancel(_ request: WorkstationRequest) async -> Bool {
        guard let harness, harness.isConfigured, requestsEnabled, Self.canCancel(request.phase) else { return false }
        let id = request.id
        requestsFailure = nil
        busyRequests.insert(id)
        defer { busyRequests.remove(id) }
        do {
            let _: WorkstationRequestReply = try HarnessModel.decoded(
                try await harness.exchange(HarnessCall(method: "POST", path: "/v1/workstation/requests/\(id)/cancel", body: Data("{}".utf8)))
            )
            await refresh()
            return true
        } catch {
            let failed = HarnessModel.failure(of: error)
            await refresh()
            requestsFailure = failed
            return false
        }
    }

    /// Ouvre le détail d'une demande (une seule à la fois) : les actions déposées pour elle
    /// et son compte rendu. Le détail d'une autre demande n'est jamais montré.
    public func open(request id: String) async {
        guard let harness, harness.isConfigured, requestsEnabled else { return }
        openRequestId = id
        openRequest = nil
        do {
            try await readDetail(of: id)
        } catch {
            if openRequestId == id { requestsFailure = HarnessModel.failure(of: error) }
        }
    }

    /// Referme le détail ouvert (sans requête).
    public func closeRequest() {
        openRequestId = nil
        openRequest = nil
    }

    // MARK: - Automatisations

    /// Crée une automatisation depuis la tâche répétitive `index` (base 0, dans l'ordre servi)
    /// du profil affiché, si elle est marquée automatisable. Le serveur contrôle la version.
    @discardableResult
    public func automate(taskAt index: Int, of profile: WorkstationProfile) async -> Bool {
        guard let harness, harness.isConfigured, requestsEnabled,
              profile.repetitiveTasks.indices.contains(index), profile.repetitiveTasks[index].automatable
        else { return false }
        guard let encoded = try? JSONEncoder().encode(AutomateBody(version: profile.version, task: index)) else {
            automateFailure = .unreadable
            return false
        }
        automateFailure = nil
        busyTasks.insert(index)
        defer { busyTasks.remove(index) }
        do {
            let _: WorkstationAutomationReply = try HarnessModel.decoded(
                try await harness.exchange(HarnessCall(method: "POST", path: "/v1/workstation/automations", body: encoded))
            )
            await refresh()
            return true
        } catch {
            automateFailure = HarnessModel.failure(of: error)
            return false
        }
    }

    /// Lance une automatisation : une nouvelle demande en file apparaît.
    @discardableResult
    public func launch(_ automation: WorkstationAutomation) async -> Bool {
        guard let harness, harness.isConfigured, requestsEnabled else { return false }
        let id = automation.id
        automationsFailure = nil
        busyAutomations.insert(id)
        defer { busyAutomations.remove(id) }
        do {
            let _: WorkstationRequestReply = try HarnessModel.decoded(
                try await harness.exchange(HarnessCall(method: "POST", path: "/v1/workstation/automations/\(id)/launch", body: Data("{}".utf8)))
            )
            await refresh()
            return true
        } catch {
            automationsFailure = HarnessModel.failure(of: error)
            return false
        }
    }

    /// Supprime une automatisation ; les demandes déjà lancées restent lisibles.
    @discardableResult
    public func delete(_ automation: WorkstationAutomation) async -> Bool {
        guard let harness, harness.isConfigured, requestsEnabled else { return false }
        let id = automation.id
        automationsFailure = nil
        busyAutomations.insert(id)
        defer { busyAutomations.remove(id) }
        do {
            let reply = try await harness.exchange(HarnessCall(method: "DELETE", path: "/v1/workstation/automations/\(id)"))
            if reply.status != 204 {
                let _: Acknowledgement = try HarnessModel.decoded(reply)
            }
            automations.removeAll { $0.id == id }
            await refresh()
            return true
        } catch {
            automationsFailure = HarnessModel.failure(of: error)
            return false
        }
    }

    // MARK: - Adresses de l'utilisateur

    /// Les adresses d'une saisie : une par ligne (ou séparées par des virgules), sans
    /// espace autour, sans ligne vide, sans doublon (casse ignorée, première forme gardée).
    public static func identities(from text: String) -> [String] {
        normalized(text.split(whereSeparator: { $0 == "\n" || $0 == "," }).map(String.init))
    }

    /// La saisie qui montre des adresses : une par ligne.
    public static func identitiesText(_ identities: [String]) -> String {
        identities.joined(separator: "\n")
    }

    private static func normalized(_ identities: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for raw in identities {
            let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty, seen.insert(value.lowercased()).inserted else { continue }
            out.append(value)
        }
        return out
    }

    // MARK: - Échange

    /// Les fonctionnalités annoncées par `GET /v1/health` (servi avant l'authentification,
    /// en 200 comme en 503). Une lecture qui échoue garde la valeur précédente.
    private func readFeatures() async {
        guard let harness, harness.isConfigured else { return }
        guard let reply = try? await harness.exchange(HarnessCall(method: "GET", path: "/v1/health")),
              reply.status == 200 || reply.status == 503,
              let health = try? JSONDecoder().decode(HealthFeatures.self, from: reply.body)
        else { return }
        requestsEnabled = health.features.contains("workstation-requests")
        featuresRead = true
    }

    /// Relit les demandes, les automatisations et le détail ouvert.
    private func readRequests() async throws {
        let listed: WorkstationRequestList = try await get("/v1/workstation/requests")
        requests = listed.requests
        let saved: WorkstationAutomationList = try await get("/v1/workstation/automations")
        automations = saved.automations
        if let id = openRequestId { try await readDetail(of: id) }
    }

    /// Lit le détail de la demande `id` ; l'issue n'est appliquée que si cette demande est
    /// encore celle qui est ouverte. 404 : la demande a disparu, elle se referme sans échec.
    private func readDetail(of id: String) async throws {
        guard let harness else { throw HarnessFailure.unreachable }
        let reply = try await harness.exchange(HarnessCall(method: "GET", path: "/v1/workstation/requests/\(id)"))
        guard openRequestId == id else { return }
        if reply.status == 404 {
            closeRequest()
            return
        }
        openRequest = try HarnessModel.decoded(reply)
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        guard let harness else { throw HarnessFailure.unreachable }
        return try HarnessModel.decoded(try await harness.exchange(HarnessCall(method: "GET", path: path)))
    }

    private func decide<Body: Encodable>(_ shown: WorkstationAction, path: String, body: Body) async -> Bool {
        guard let harness, harness.isConfigured else { return false }
        guard let encoded = try? JSONEncoder().encode(body) else {
            failure = .unreadable
            return false
        }
        let seq = shown.seq
        busy.insert(seq)
        defer { busy.remove(seq) }
        do {
            let reply = try await harness.exchange(
                HarnessCall(method: "POST", path: path, body: encoded, headers: ["If-Match": shown.revisionTag])
            )
            // 412 : l'envoi a changé depuis son affichage ; 428 : le serveur n'a pas reçu la
            // révision. Dans les deux cas rien n'est tranché : relire, puis le dire.
            if reply.status == 412 || reply.status == 428 {
                await refresh()
                failure = .approvalChanged
                return false
            }
            let decided: WorkstationActionReply = try HarnessModel.decoded(reply)
            apply(decided.action)
            failure = nil
            await refresh()
            return true
        } catch {
            // Déjà tranchée ailleurs, expirée : la relecture montre la vérité, l'échec reste dit.
            let failed = HarnessModel.failure(of: error)
            await refresh()
            failure = failed
            return false
        }
    }

    /// L'action rendue par un geste remplace celle qu'on montrait ; elle quitte les envois
    /// à approuver dès qu'elle n'attend plus.
    private func apply(_ action: WorkstationAction) {
        if let index = journal.firstIndex(where: { $0.seq == action.seq }) { journal[index] = action }
        if action.awaitsApproval {
            if let index = approvals.firstIndex(where: { $0.seq == action.seq }) { approvals[index] = action }
        } else {
            approvals.removeAll { $0.seq == action.seq }
        }
    }

    private func saveSettings(_ body: SettingsBody) async -> Bool {
        guard let harness, harness.isConfigured else { return false }
        guard let encoded = try? JSONEncoder().encode(body) else {
            failure = .unreadable
            return false
        }
        isSaving = true
        defer { isSaving = false }
        do {
            status = try HarnessModel.decoded(
                try await harness.exchange(HarnessCall(method: "PUT", path: "/v1/workstation/settings", body: encoded))
            )
            failure = nil
            return true
        } catch {
            failure = HarnessModel.failure(of: error)
            return false
        }
    }
}

private struct EmptyBody: Encodable {}

/// `reason` absent du JSON quand il est `nil`.
private struct RefuseBody: Encodable {
    var reason: String?
}

/// Seuls les réglages posés partent : un champ `nil` est absent du JSON.
private struct SettingsBody: Encodable {
    var autonomy: String?
    var selfIdentities: [String]?
    var paused: Bool?

    init(autonomy: String? = nil, selfIdentities: [String]? = nil, paused: Bool? = nil) {
        self.autonomy = autonomy
        self.selfIdentities = selfIdentities
        self.paused = paused
    }
}

private struct QueuedReply: Decodable {
    var queued: Bool
}

private struct AskBody: Encodable {
    var instruction: String
}

/// Le corps de « Automatiser » : la version du profil affichée et l'indice (base 0) de la
/// tâche dans `repetitiveTasks` tel que servi.
private struct AutomateBody: Encodable {
    var version: Int
    var task: Int
}

/// Le corps d'une réponse dont seul le succès compte (`{removed}`).
private struct Acknowledgement: Decodable {
    init(from decoder: Decoder) throws {}
}

/// `GET /v1/health` : seul `features` est lu.
private struct HealthFeatures: Decodable {
    var features: [String]
}
