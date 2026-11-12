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
// bouton que l'humain touche, avec l'action telle que l'écran la montre, et
// `decideFromNotification` que par l'action « Approuver » d'une notification qu'il
// touche, appareil déverrouillé. Le geste porte `If-Match: "<updatedAt>"` de cette
// action : si l'envoi a changé depuis (autre appareil, brouillon recalculé), le serveur
// refuse (412) et rien n'est approuvé. Approuver,
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
    /// Les demandes lues à l'ouverture de la section.
    public static let requestsLimit = 50

    @Published public private(set) var availability: Availability = .unknown
    @Published public internal(set) var status: WorkstationStatus?
    /// Les actions en `awaiting_approval`, les plus récentes d'abord.
    @Published public private(set) var approvals: [WorkstationAction] = []
    /// Le journal des décisions, le plus récent d'abord (lu quand la section est ouverte).
    @Published public internal(set) var journal: [WorkstationAction] = []
    @Published public private(set) var profile: WorkstationProfileReply?
    @Published public private(set) var meetings: [WorkstationMeeting] = []
    /// Les demandes de l'humain au poste, récentes d'abord ; `nil` : le serveur ne les sert pas.
    @Published public internal(set) var requests: [WorkstationRequest]?
    /// Les automatisations gardées ; `nil` : le serveur ne les sert pas.
    @Published public internal(set) var automations: [WorkstationAutomation]?
    /// Le dernier échec, effacé par le prochain échange réussi.
    @Published public internal(set) var failure: HarnessFailure?
    @Published public private(set) var isLoading = false
    /// Les actions dont un geste (approbation, refus, annulation) attend la réponse du serveur.
    @Published public internal(set) var busy: Set<Int> = []
    /// Un réglage (ou une commande, une demande, une automatisation) attend la réponse du serveur.
    @Published public internal(set) var isSaving = false
    /// L'arrêt d'urgence attend la réponse du serveur.
    @Published public internal(set) var isStopping = false
    /// La dernière action commandée depuis l'app, telle que le serveur l'a déposée.
    @Published public internal(set) var lastCommand: WorkstationAction?
    /// Une reconstruction du profil a été acceptée par le serveur.
    @Published public private(set) var rebuildQueued = false

    /// Le porteur de l'échange ; il possède ce modèle (référence faible : pas de cycle).
    weak var harness: HarnessModel?
    private let reloadDelay: Duration
    /// La section est ouverte : profil, journal et réunions sont relus avec l'état.
    private var wantsDetails = false
    private var reloadTask: Task<Void, Never>?

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
        await refresh()
    }

    /// Relit l'état et les envois à approuver (et le reste si la section a été ouverte).
    /// Un échec garde les dernières données lues. Sans serveur relié, rien ne part.
    public func refresh() async {
        guard let harness, harness.isConfigured else { return }
        isLoading = true
        defer { isLoading = false }
        await reload()
    }

    /// `refresh()` sans rien dire de la lecture (le flux) : l'état d'abord (un serveur sans
    /// poste s'arrête là), puis le reste en parallèle ; rien n'est republié à l'identique.
    func reload() async {
        guard let harness, harness.isConfigured else { return }
        do {
            let call = HarnessCall(method: "GET", path: "/v1/workstation")
            let reply = try await harness.exchange(call)
            // Un serveur antérieur au poste n'a pas la route : la section le dit, sans échec.
            if reply.status == 404 {
                clear(.absent)
                return
            }
            let current: WorkstationStatus = try await harness.decodeOffMain(reply, for: call)
            update(\.status, current)
            update(\.availability, .available)
            async let pending: WorkstationActionList = get("/v1/workstation/actions?state=awaiting_approval&limit=\(Self.approvalsLimit)")
            if wantsDetails {
                async let recent: WorkstationActionList = get("/v1/workstation/actions?limit=\(Self.journalLimit)")
                async let readProfile: WorkstationProfileReply = get("/v1/workstation/profile")
                async let list: WorkstationMeetingList = get("/v1/workstation/meetings?limit=\(Self.meetingsLimit)")
                async let asked: WorkstationRequestList? = optional("/v1/workstation/requests?limit=\(Self.requestsLimit)")
                async let kept: WorkstationAutomationList? = optional("/v1/workstation/automations")
                let details = try await (recent, readProfile, list, asked, kept)
                update(\.journal, details.0.actions)
                update(\.profile, details.1)
                update(\.meetings, details.2.meetings)
                update(\.requests, details.3?.requests)
                update(\.automations, details.4?.automations)
            }
            update(\.approvals, try await pending.actions)
            update(\.failure, nil)
        } catch HarnessFailure.forbidden(let motive) {
            clear(.reserved(motive))
        } catch {
            update(\.failure, HarnessModel.failure(of: error))
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
        guard reloadTask == nil else { return }
        let delay = reloadDelay
        reloadTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self?.reload()
            self?.reloadTask = nil
        }
    }

    /// Oublie tout ce qui a été lu : le serveur a changé (ou a été oublié).
    func reset() {
        reloadTask?.cancel()
        reloadTask = nil
        clear(.unknown)
        failure = nil
        busy = []
    }

    private func clear(_ next: Availability) {
        availability = next
        status = nil
        approvals = []
        journal = []
        profile = nil
        meetings = []
        rebuildQueued = false
        requests = nil
        automations = nil
        lastCommand = nil
        failure = nil
    }

    // MARK: - Gestes de l'humain

    /// Approuve l'envoi TEL QUE L'HUMAIN LE VOIT : l'action repart en file avec
    /// `approved: true`, et l'extension l'exécute. Seul un geste humain l'appelle. Si
    /// l'envoi a changé depuis son affichage, le serveur refuse : la liste est relue et
    /// l'échec `.approvalChanged` demande de relire avant d'approuver.
    @discardableResult
    public func approve(shown action: WorkstationAction) async -> Bool {
        let seq = action.seq
        return await decide(seq: seq, revisionTag: action.revisionTag, path: "/v1/workstation/actions/\(seq)/approve", body: EmptyBody())
    }

    /// Refuse l'envoi tel que l'humain l'a vu ; la raison, facultative, est gardée au journal.
    @discardableResult
    public func refuse(shown action: WorkstationAction, reason: String = "") async -> Bool {
        let seq = action.seq
        let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        return await decide(
            seq: seq, revisionTag: action.revisionTag, path: "/v1/workstation/actions/\(seq)/refuse",
            body: RefuseBody(reason: trimmed.isEmpty ? nil : trimmed)
        )
    }

    /// Approuve ou refuse l'envoi `seq` depuis l'action d'une notification que l'humain a
    /// touchée, appareil déverrouillé (`HarnessModel.execute`). `revision` : l'`updatedAt`
    /// que portait la notification ; absente (Mac), celle de la liste relue. Si l'envoi a
    /// bougé depuis, le serveur refuse (412) : rien n'est tranché.
    func decideFromNotification(seq: Int, revision: Int?, approve: Bool) async -> Bool {
        var tag = revision.map { "\"\($0)\"" }
        if tag == nil {
            await refresh()
            tag = approvals.first { $0.seq == seq }?.revisionTag
        }
        guard let tag else {
            failure = .approvalChanged
            return false
        }
        return approve
            ? await decide(seq: seq, revisionTag: tag, path: "/v1/workstation/actions/\(seq)/approve", body: EmptyBody())
            : await decide(seq: seq, revisionTag: tag, path: "/v1/workstation/actions/\(seq)/refuse", body: RefuseBody(reason: nil))
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
            let call = HarnessCall(method: "POST", path: "/v1/workstation/profile/rebuild", body: Data("{}".utf8))
            let _: QueuedReply = try harness.decode(try await harness.exchange(call), for: call)
            rebuildQueued = true
            failure = nil
            return true
        } catch {
            failure = HarnessModel.failure(of: error)
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

    func get<T: Decodable>(_ path: String) async throws -> T {
        guard let harness else { throw HarnessFailure.unreachable }
        let call = HarnessCall(method: "GET", path: path)
        return try await harness.decodeOffMain(try await harness.exchange(call), for: call)
    }

    /// Une lecture d'une route qu'un serveur antérieur ne sert pas : 404 rend `nil`, sans échec.
    func optional<T: Decodable>(_ path: String) async throws -> T? {
        guard let harness else { throw HarnessFailure.unreachable }
        let call = HarnessCall(method: "GET", path: path)
        let reply = try await harness.exchange(call)
        if reply.status == 404 { return nil }
        return try await harness.decodeOffMain(reply, for: call)
    }
    private func decide<Body: Encodable>(seq: Int, revisionTag: String, path: String, body: Body) async -> Bool {
        guard let harness, harness.isConfigured else { return false }
        guard let encoded = try? JSONEncoder().encode(body) else {
            failure = .unreadable
            return false
        }
        busy.insert(seq)
        defer { busy.remove(seq) }
        do {
            let call = HarnessCall(method: "POST", path: path, body: encoded, headers: ["If-Match": revisionTag])
            let reply = try await harness.exchange(call)
            // 412 : l'envoi a changé depuis son affichage ; 428 : le serveur n'a pas reçu la
            // révision. Dans les deux cas rien n'est tranché : relire, puis le dire.
            if reply.status == 412 || reply.status == 428 {
                await refresh()
                failure = .approvalChanged
                return false
            }
            let decided: WorkstationActionReply = try harness.decode(reply, for: call)
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
    func apply(_ action: WorkstationAction) {
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
            let call = HarnessCall(method: "PUT", path: "/v1/workstation/settings", body: encoded)
            status = try harness.decode(try await harness.exchange(call), for: call)
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
