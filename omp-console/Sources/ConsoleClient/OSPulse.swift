// « OS agentique » : le POULS des agents. Un seul flux `GET /v1/events?live=1` sans
// filtre de feature porte l'activité éphémère de TOUS les agents : l'outil lancé et son
// intention (`activity`, runner-session.ts) et chaque entrée de leur direct (`session`).
// Le pouls n'en garde que la dernière ligne lisible par agent : une feature, une session
// omp locale (`payload.localSession`), le poste (`payload.workstation`), un audit
// (`payload.auditId`), ou l'OS lui-même (pilote, classeur de la Demande, vigie).
//
// Le flux porte aussi le direct entier de chaque agent : c'est plus que le pouls n'en a
// besoin ; un filtre serveur `live=activity` le réduira si le paradigme est retenu. En
// attendant, le flux est lu et décodé HORS du fil principal, chaque texte rogné avant d'en
// tirer la première ligne, et le pouls publie au plus une fois par `interval`, seulement
// quand une ligne a vraiment changé.

import Combine
import Foundation

/// La dernière chose qu'un agent a dite ou faite.
public struct OSActivity: Equatable, Sendable {
    /// L'outil, s'il en lance un.
    public var tool: String?
    /// Ce qu'il fait, en une phrase courte (l'intention de l'outil, sinon son dernier paragraphe).
    public var line: String
    public var at: Date
}

/// Qui agit.
public enum OSAgentKey: Hashable, Sendable {
    case run(String)
    case workstation(String)
    case audit(String)
    /// Une session omp locale (son identifiant).
    case localSession(String)
    case system
}

@MainActor
public final class OSPulse: ObservableObject {
    /// L'activité récente, par agent.
    @Published public private(set) var activity: [OSAgentKey: OSActivity] = [:]
    @Published public private(set) var isLive = false

    /// La longueur gardée d'une ligne.
    nonisolated static let lineLimit = 140
    /// Une activité inchangée est republiée quand sa date publiée a vieilli de tant : la
    /// fraîcheur (`current(_:freshness:)`) suit l'agent qui répète la même chose.
    static let refreshAge: TimeInterval = 30

    private unowned let harness: HarnessModel
    private let interval: Duration
    private var task: Task<Void, Never>?
    /// L'activité la plus récente reçue, pas encore forcément publiée.
    private var latest: [OSAgentKey: OSActivity] = [:]
    private var lastPublish: ContinuousClock.Instant?
    private var flush: Task<Void, Never>?

    public init(harness: HarnessModel) {
        self.harness = harness
        interval = .seconds(1)
    }

    /// `interval` : l'écart minimal entre deux publications.
    init(harness: HarnessModel, interval: Duration) {
        self.harness = harness
        self.interval = interval
    }

    /// L'activité d'un agent si elle date de moins de `freshness`.
    public func current(_ key: OSAgentKey, freshness: TimeInterval = 90, now: Date = Date()) -> OSActivity? {
        guard let found = activity[key], now.timeIntervalSince(found.at) < freshness else { return nil }
        return found
    }

    /// Le poste agit : sa dernière activité récente, tous jobs confondus.
    public func workstation(freshness: TimeInterval = 90, now: Date = Date()) -> (job: String, activity: OSActivity)? {
        activity.compactMap { key, value -> (String, OSActivity)? in
            guard case let .workstation(job) = key, now.timeIntervalSince(value.at) < freshness else { return nil }
            return (job, value)
        }
        .max { $0.1.at < $1.1.at }
    }

    public func start() {
        guard task == nil else { return }
        task = Task { [weak self] in await self?.loop() }
    }

    public func stop() {
        task?.cancel()
        task = nil
        flush?.cancel()
        flush = nil
        publish()
        if isLive { isLive = false }
    }

    private func loop() async {
        while !Task.isCancelled {
            guard let server = harness.server else {
                try? await Task.sleep(for: .seconds(2))
                continue
            }
            do {
                let stream = try await harness.transport.events(
                    HarnessCall(method: "GET", path: "/v1/events?live=1&after=\(harness.eventCursor)"), server: server
                )
                if !isLive { isLive = true }
                for try await readings in Self.readings(of: stream) {
                    receive(readings)
                }
            } catch {}
            publish()
            if isLive { isLive = false }
            if Task.isCancelled { return }
            try? await Task.sleep(for: .seconds(3))
        }
    }

    /// Ce qu'un événement dit d'un agent, lu hors du fil principal.
    struct Reading: Sendable {
        var key: OSAgentKey
        var tool: String?
        var line: String
        var at: Date
        /// Une activité (outil, intention) plutôt qu'un paragraphe du direct.
        var isActivity: Bool
    }

    /// Le flux décodé sur l'exécuteur global : seules ses lectures utiles rejoignent l'acteur
    /// principal, par lot (un morceau du flux).
    nonisolated static func readings(of stream: AsyncThrowingStream<Data, Error>) -> AsyncThrowingStream<[Reading], Error> {
        AsyncThrowingStream { continuation in
            let reader = Task.detached {
                do {
                    let decoder = JSONDecoder()
                    var parser = HarnessEventParser()
                    for try await chunk in stream {
                        let readings = parser.consumeEvents(chunk).compactMap { reading(of: $0, decoder: decoder) }
                        if !readings.isEmpty { continuation.yield(readings) }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in reader.cancel() }
        }
    }

    /// La lecture d'un événement `activity` ou `session`, ou `nil` (rien de lisible).
    nonisolated static func reading(of event: HarnessStreamEvent, decoder: JSONDecoder) -> Reading? {
        guard event.name == "activity" || event.name == "session",
              let envelope = try? decoder.decode(PulseEnvelope.self, from: event.data)
        else { return nil }
        let key: OSAgentKey
        if let session = envelope.payload.localSession {
            key = .localSession(session)
        } else if let runId = envelope.runId {
            key = .run(runId)
        } else if let job = envelope.payload.workstation {
            key = .workstation(job)
        } else if let audit = envelope.payload.auditId {
            key = .audit(audit)
        } else {
            key = .system
        }
        let at = Date(timeIntervalSince1970: (envelope.at ?? Date().timeIntervalSince1970 * 1000) / 1000)
        if event.name == "activity" {
            let tool = envelope.payload.tool
            let intent = envelope.payload.intent.map { OSThreads.firstLineUncached(String($0.prefix(lineLimit * 4))) } ?? ""
            // Une session locale bat à chaque intention, outil nommé ou non.
            guard tool != nil || envelope.payload.localSession != nil,
                  let line = [intent, tool ?? ""].first(where: { !$0.isEmpty })
            else { return nil }
            return Reading(key: key, tool: tool, line: line, at: at, isActivity: true)
        }
        // Un paragraphe de l'agent (pas son raisonnement) : ce qu'il dit faire.
        guard let entry = envelope.payload.entry, entry.sort == .text else { return nil }
        let line = OSThreads.firstLineUncached(String(entry.text.prefix(lineLimit * 4)))
        guard !line.isEmpty else { return nil }
        return Reading(key: key, tool: nil, line: String(line.prefix(lineLimit)), at: at, isActivity: false)
    }

    private func receive(_ readings: [Reading]) {
        var changed = false
        for reading in readings {
            let previous = latest[reading.key]
            // Un outil en cours garde la main : son intention dit mieux ce qui se passe.
            if !reading.isActivity, let previous, previous.tool != nil, reading.at.timeIntervalSince(previous.at) < 5 { continue }
            let next = OSActivity(tool: reading.tool, line: reading.line, at: reading.at)
            latest[reading.key] = next
            if Self.differs(activity[reading.key], next) { changed = true }
        }
        guard changed else { return }
        if let lastPublish, ContinuousClock.now - lastPublish < interval {
            scheduleFlush()
        } else {
            publish()
        }
    }

    /// Ce qui mérite une publication : une autre ligne, un autre outil, ou une date publiée trop vieille.
    private static func differs(_ shown: OSActivity?, _ next: OSActivity) -> Bool {
        guard let shown else { return true }
        return shown.line != next.line || shown.tool != next.tool || next.at.timeIntervalSince(shown.at) >= refreshAge
    }

    private func scheduleFlush() {
        guard flush == nil else { return }
        let interval = interval
        flush = Task { [weak self] in
            try? await Task.sleep(for: interval)
            guard !Task.isCancelled, let self else { return }
            self.flush = nil
            self.publish()
        }
    }

    private func publish() {
        lastPublish = .now
        if activity != latest { activity = latest }
    }
}

private struct PulseEnvelope: Decodable {
    struct Payload: Decodable {
        var tool: String?
        var intent: String?
        var workstation: String?
        var auditId: String?
        var localSession: String?
        var entry: HarnessSessionEntry?
    }

    var at: Double?
    var runId: String?
    var payload: Payload
}
