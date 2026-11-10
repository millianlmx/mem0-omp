// La BOUCLE de l'OS agentique vue du client (omp-harness, capacités `os-loop`, `pause`,
// `os-autonomy`) : le curseur d'autonomie d'une feature, le motif d'une annulation, le
// geste « corriger » (`POST /v1/runs/{id}/amend`) et la PAUSE GLOBALE (« Tout suspendre »,
// `GET`/`POST /v1/pause`, événement `pause`).
//
// Un serveur antérieur ne sert pas `/v1/pause` (404) : `availability == .absent`, et le
// geste se cache. Aucun texte ici : les écrans nomment les niveaux, les motifs et les voies.

import Combine
import Foundation

// MARK: - Vocabulaire des gestes

/// Le curseur d'autonomie d'une feature (`RunAutonomy` du serveur) ; absent : les règles du dépôt.
public enum HarnessRunAutonomy: String, CaseIterable, Codable, Sendable, Identifiable {
    /// Tout demander : la porte des specs est toujours posée, rien ne fusionne seul.
    case ask
    /// Livrer et prévenir : les portes se lèvent seules quand rien d'irréversible ne s'y oppose.
    case deliver

    public var id: String { rawValue }
}

/// Le motif d'une annulation par l'humain (`CancelCause` du serveur).
public enum HarnessCancelCause: String, CaseIterable, Codable, Sendable, Identifiable {
    case offTarget = "off_target"
    case tooBig = "too_big"
    case obsolete
    case duplicate
    case tooCostly = "too_costly"
    case other

    public var id: String { rawValue }

    /// Avec une note, ce motif écrit une correction dans la mémoire du dépôt : le prochain
    /// cadrage en tient compte.
    public var teachesMemory: Bool { self == .offTarget || self == .tooBig }
}

/// Par où une correction (`amend`) est passée, selon l'état de la feature.
public enum HarnessAmendVia: String, CaseIterable, Sendable {
    /// Les specs en attente sont refusées et réécrites.
    case specs
    /// Le verdict en attente est refusé : retour en correction.
    case fix
    /// La feature en échec (ou arrêtée) est relancée avec la consigne.
    case retry
    /// La consigne rejoint la feature qui travaille, ou sa prochaine étape.
    case instruction
}

/// `POST /v1/runs/{id}/amend` : le run et la voie prise.
struct HarnessAmendReply: Decodable {
    var via: String
}

// MARK: - Lecture liée au serveur

extension HarnessModel {
    /// `readIfServed`, liée au serveur relié à son départ : si le serveur a changé (ou a été
    /// oublié) avant la réponse, elle lève `CancellationError` — ni donnée ni échec ne
    /// rejoignent alors le modèle remis à zéro.
    func readBound<T: Decodable>(_ path: String) async throws -> T? {
        let epoch = serverEpoch
        do {
            let value: T? = try await readIfServed(path)
            guard epoch == serverEpoch else { throw CancellationError() }
            return value
        } catch {
            guard epoch == serverEpoch else { throw CancellationError() }
            throw error
        }
    }
}

// MARK: - Relecture regroupée

/// Une relecture regroupée, commune aux modèles de l'OS : une rafale d'événements ne coûte
/// qu'un appel, et un événement arrivé PENDANT la relecture en replanifie une.
@MainActor
final class HarnessReloader {
    private let delay: Duration
    private var task: Task<Void, Never>?

    init(delay: Duration) {
        self.delay = delay
    }

    func schedule(_ reload: @escaping @MainActor () async -> Void) {
        guard task == nil else { return }
        let delay = delay
        task = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            self?.task = nil
            await reload()
        }
    }

    func cancel() {
        task?.cancel()
        task = nil
    }
}

// MARK: - Pause globale

/// La pause d'UN espace : ses fils ne sont plus admis, les autres espaces continuent.
public struct HarnessSpacePause: Codable, Equatable, Sendable, Identifiable {
    /// L'identifiant de l'espace.
    public var id: String
    public var name: String
    public var paused: Bool
    public var by: String?
    public var at: Double?
    public var reason: String?
    /// La pause a interrompu tout de suite les fils vivants de l'espace.
    public var now: Bool

    public init(id: String, name: String = "", paused: Bool = true, by: String? = nil, at: Double? = nil, reason: String? = nil, now: Bool = false) {
        self.id = id
        self.name = name
        self.paused = paused
        self.by = by
        self.at = at
        self.reason = reason
        self.now = now
    }

    private enum CodingKeys: String, CodingKey { case id, name, paused, by, at, reason, now }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? ""
        paused = try container.decodeIfPresent(Bool.self, forKey: .paused) ?? true
        by = try container.decodeIfPresent(String.self, forKey: .by)
        at = try container.decodeIfPresent(Double.self, forKey: .at)
        reason = try container.decodeIfPresent(String.self, forKey: .reason)
        now = try container.decodeIfPresent(Bool.self, forKey: .now) ?? false
    }
}

/// La pause globale du serveur : plus rien n'est admis ni lancé, rien n'est perdu.
public struct HarnessPause: Codable, Equatable, Sendable {
    public var paused: Bool
    /// Qui a suspendu ; `nil` hors pause.
    public var by: String?
    /// L'instant de la suspension, en millisecondes ; `nil` hors pause.
    public var at: Double?
    public var reason: String?
    /// La pause a interrompu tout de suite les fils vivants (sinon leur étape en cours finit).
    public var now: Bool
    /// Les espaces EN PAUSE (les seuls que le serveur liste) ; vide d'un serveur sans pause par espace.
    public var spaces: [HarnessSpacePause] = []

    public init(
        paused: Bool, by: String? = nil, at: Double? = nil, reason: String? = nil, now: Bool = false, spaces: [HarnessSpacePause] = []
    ) {
        self.paused = paused
        self.by = by
        self.at = at
        self.reason = reason
        self.now = now
        self.spaces = spaces
    }

    private enum CodingKeys: String, CodingKey { case paused, by, at, reason, now, spaces }

    /// `now` absent se lit `false`, `spaces` absent : aucun espace en pause.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        paused = try container.decode(Bool.self, forKey: .paused)
        by = try container.decodeIfPresent(String.self, forKey: .by)
        at = try container.decodeIfPresent(Double.self, forKey: .at)
        reason = try container.decodeIfPresent(String.self, forKey: .reason)
        now = try container.decodeIfPresent(Bool.self, forKey: .now) ?? false
        spaces = try container.decodeIfPresent([HarnessSpacePause].self, forKey: .spaces) ?? []
    }

    /// La pause de cet espace, s'il est suspendu.
    public func spacePause(_ id: String) -> HarnessSpacePause? {
        spaces.first { $0.id == id && $0.paused }
    }
}

/// `GET`/`POST /v1/pause`.
struct HarnessPauseReply: Decodable {
    var pause: HarnessPause
}

/// Le corps de `POST /v1/pause` ; `space`, `reason` et `now` absents du JSON quand ils ne disent rien.
private struct PauseBody: Encodable {
    var paused: Bool
    var space: String?
    var reason: String?
    var now: Bool?
}

/// « Tout suspendre » : l'état de la pause, relu sur l'événement `pause`, et son geste.
@MainActor
public final class HarnessPauseModel: ObservableObject {
    /// La longueur que le serveur accepte pour la raison.
    public nonisolated static let maxReasonLength = 200

    @Published public private(set) var availability: HarnessFeatureAvailability = .unknown
    @Published public private(set) var pause: HarnessPause?
    @Published public private(set) var failure: HarnessFailure?
    /// Le geste attend la réponse du serveur.
    @Published public private(set) var isSaving = false

    private unowned let harness: HarnessModel
    private let reloader: HarnessReloader

    init(harness: HarnessModel, reloadDelay: Duration) {
        self.harness = harness
        reloader = HarnessReloader(delay: reloadDelay)
    }

    /// Le serveur relié sert la pause (inconnu compris : le geste ne clignote pas).
    public var isServed: Bool { availability != .absent }

    /// Tout est suspendu (la pause globale).
    public var isPaused: Bool { pause?.paused ?? false }

    /// La pause de cet espace, s'il est suspendu (la pause globale se lit dans `isPaused`).
    public func spacePause(_ id: String) -> HarnessSpacePause? {
        pause?.spacePause(id)
    }

    /// Rien ne part dans la portée : tout est suspendu, ou l'espace donné l'est (`nil` : aucun espace choisi).
    public func isSuspended(in space: HarnessSpace?) -> Bool {
        isPaused || space.map { spacePause($0.id) != nil } ?? false
    }

    /// Relit l'état de la pause ; un serveur antérieur (404) n'en a pas, sans échec.
    public func refresh() async {
        guard harness.isConfigured else { return }
        do {
            guard let read: HarnessPauseReply = try await harness.readBound("/v1/pause") else {
                availability = .absent
                pause = nil
                failure = nil
                return
            }
            pause = read.pause
            availability = .available
            failure = nil
        } catch {
            availability = HarnessControlFailure.availability(after: error, current: availability)
            failure = HarnessModel.failure(of: error)
        }
    }

    /// Suspend tout (`true`) ou relance le tour (`false`) ; la raison, facultative, est rognée.
    /// `space` : l'identifiant d'UN espace à suspendre ou à relancer — les autres continuent ;
    /// `nil` : tout, quelle que soit la portée de l'écran. `now` : interrompre tout de suite
    /// les fils vivants, au lieu de laisser finir l'étape en cours. Réservé au propriétaire : un
    /// client borné est refusé (403, dit par `failure`). Sur un serveur qui n'annonce pas
    /// `space-scope`, la pause d'un espace ne part pas (elle suspendrait tout) : `false`.
    @discardableResult
    public func setPause(paused: Bool, space: String? = nil, reason: String = "", now: Bool = false) async -> Bool {
        let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        if space != nil {
            guard await harness.supports(.spaceScope) else { return false }
        }
        isSaving = true
        defer { isSaving = false }
        do {
            let reply: HarnessPauseReply = try await harness.write(
                "POST", "/v1/pause",
                body: PauseBody(
                    paused: paused, space: space, reason: trimmed.isEmpty ? nil : String(trimmed.prefix(Self.maxReasonLength)),
                    now: paused && now ? true : nil
                )
            )
            pause = reply.pause
            availability = .available
            failure = nil
            // La file change d'un coup : la boîte et ce qui la retient sont relus.
            await harness.refresh()
            return true
        } catch {
            failure = HarnessModel.failure(of: error)
            return false
        }
    }

    /// L'événement `pause` (un autre appareil a suspendu ou relancé) fait relire.
    func receive(_ names: [String]) {
        guard availability == .available, names.contains("pause") else { return }
        reloader.schedule { [weak self] in await self?.refresh() }
    }

    func reset() {
        reloader.cancel()
        availability = .unknown
        pause = nil
        failure = nil
    }
}
