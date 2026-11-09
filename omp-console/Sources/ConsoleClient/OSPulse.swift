// « OS agentique » : le POULS des agents. Un seul flux `GET /v1/events?live=1` sans
// filtre de feature porte l'activité éphémère de TOUS les agents : l'outil lancé et son
// intention (`activity`, runner-session.ts) et chaque entrée de leur direct (`session`).
// Le pouls n'en garde que la dernière ligne lisible par agent : une feature, une session
// omp locale (`payload.localSession`), le poste (`payload.workstation`), un audit
// (`payload.auditId`), ou l'OS lui-même (pilote, classeur de la Demande, vigie).
//
// Le flux porte aussi le direct entier de chaque agent : c'est plus que le pouls n'en a
// besoin ; un filtre serveur `live=activity` le réduira si le paradigme est retenu.

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

    private unowned let harness: HarnessModel
    private var task: Task<Void, Never>?

    public init(harness: HarnessModel) {
        self.harness = harness
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
        isLive = false
    }

    private func loop() async {
        while !Task.isCancelled {
            guard let server = harness.server else {
                try? await Task.sleep(for: .seconds(2))
                continue
            }
            do {
                let cursor = harness.inbox?.cursor ?? 0
                let stream = try await harness.transport.events(HarnessCall(method: "GET", path: "/v1/events?live=1&after=\(cursor)"), server: server)
                isLive = true
                var parser = HarnessEventParser()
                for try await chunk in stream {
                    for event in parser.consumeEvents(chunk) where event.name == "activity" || event.name == "session" {
                        receive(event)
                    }
                }
            } catch {}
            isLive = false
            if Task.isCancelled { return }
            try? await Task.sleep(for: .seconds(3))
        }
    }

    private func receive(_ event: HarnessStreamEvent) {
        guard let envelope = try? JSONDecoder().decode(PulseEnvelope.self, from: event.data) else { return }
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
            let intent = envelope.payload.intent.map(OSThreads.firstLine) ?? ""
            // Une session locale bat à chaque intention, outil nommé ou non.
            guard tool != nil || envelope.payload.localSession != nil,
                  let line = [intent, tool ?? ""].first(where: { !$0.isEmpty })
            else { return }
            activity[key] = OSActivity(tool: tool, line: line, at: at)
            return
        }
        // Un paragraphe de l'agent (pas son raisonnement) : ce qu'il dit faire.
        guard let entry = envelope.payload.entry, entry.sort == .text else { return }
        let line = OSThreads.firstLine(entry.text)
        guard !line.isEmpty else { return }
        let previous = activity[key]
        // Un outil en cours garde la main : son intention dit mieux ce qui se passe.
        if let previous, previous.tool != nil, at.timeIntervalSince(previous.at) < 5 { return }
        activity[key] = OSActivity(tool: nil, line: String(line.prefix(140)), at: at)
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
