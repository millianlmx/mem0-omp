// La santé des SERVICES du serveur de pipelines, pour la carte « Services » (Stats et
// Santé, résumé en Accueil) et le rapport du matin en tête de l'Accueil :
//
// - `GET /v1/health` (servie hors de la table des routes, sans jeton) : la base, le
//   tour du scheduling, le disque — 503 au moindre échec, corps lisible quand même ;
// - `GET /v1/status` : la mémoire du projet vue par le serveur (`oracle`, écritures
//   perdues), le scheduling, et — serveurs récents — le service mem0 (`memory`) et
//   les sauvegardes (`backups`), tous décodés en optionnels ;
// - `GET /v1/digest` : ce qui s'est fait seul depuis 24 h.
//
// L'extension Chrome en ligne vient du poste (`WorkstationModel.status`). Aucun texte
// ici : `HarnessServiceLine` porte l'état et les chiffres, les écrans les disent avec
// `MonitoringText`.

import Foundation

// MARK: - Fil

/// La réponse de `GET /v1/health`.
public struct HarnessHealth: Decodable, Equatable, Sendable {
    public var ok: Bool
    public var version: String?
    public var features: [String]
    public var checks: HarnessHealthChecks

    public init(ok: Bool, version: String? = nil, features: [String] = [], checks: HarnessHealthChecks) {
        self.ok = ok
        self.version = version
        self.features = features
        self.checks = checks
    }
}

public struct HarnessHealthChecks: Decodable, Equatable, Sendable {
    public var db: HarnessHealthCheck
    public var scheduler: HarnessSchedulerCheck
    public var disk: HarnessDiskCheck

    public init(db: HarnessHealthCheck, scheduler: HarnessSchedulerCheck, disk: HarnessDiskCheck) {
        self.db = db
        self.scheduler = scheduler
        self.disk = disk
    }
}

public struct HarnessHealthCheck: Decodable, Equatable, Sendable {
    public var ok: Bool

    public init(ok: Bool) { self.ok = ok }
}

/// Le dernier tour du scheduling : son âge en secondes (`nil` : pas encore démarré).
public struct HarnessSchedulerCheck: Decodable, Equatable, Sendable {
    public var ok: Bool
    public var ageSec: Double?

    public init(ok: Bool, ageSec: Double? = nil) {
        self.ok = ok
        self.ageSec = ageSec
    }
}

/// Le disque le moins libre des dossiers du serveur, en Mio.
public struct HarnessDiskCheck: Decodable, Equatable, Sendable {
    public var ok: Bool
    public var freeMiB: Double?

    public init(ok: Bool, freeMiB: Double? = nil) {
        self.ok = ok
        self.freeMiB = freeMiB
    }
}

/// La réponse de `GET /v1/status` : les dépôts, et ce que les écrans des services lisent.
public struct HarnessStatus: Decodable, Equatable, Sendable {
    public var repos: [HarnessRepo]
    public var oracle: HarnessOracleStatus?
    public var scheduler: HarnessStats.Scheduler?
    /// Le service mem0 (serveurs récents) : absent d'un serveur plus ancien.
    public var memory: HarnessMemoryStatus?
    /// Les sauvegardes (serveurs récents) : absentes d'un serveur plus ancien.
    public var backups: HarnessBackupsStatus?
    /// Les features dues que l'admission retient en file, par cause (serveurs récents).
    public var queue: HarnessQueueStatus?
    /// Tout est suspendu (« Tout suspendre ») ; faux d'un serveur antérieur à la pause.
    public var paused: Bool = false

    public init(
        repos: [HarnessRepo] = [], oracle: HarnessOracleStatus? = nil, scheduler: HarnessStats.Scheduler? = nil,
        memory: HarnessMemoryStatus? = nil, backups: HarnessBackupsStatus? = nil, queue: HarnessQueueStatus? = nil, paused: Bool = false
    ) {
        self.repos = repos
        self.oracle = oracle
        self.scheduler = scheduler
        self.memory = memory
        self.backups = backups
        self.queue = queue
        self.paused = paused
    }

    private enum CodingKeys: String, CodingKey { case repos, oracle, scheduler, memory, backups, queue, paused }

    /// Les dépôts sont requis ; chaque bloc de service est lu à part : un bloc absent
    /// (serveur ancien) ou d'une autre forme laisse `nil`, sans perdre les dépôts.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        repos = try container.decode([HarnessRepo].self, forKey: .repos)
        oracle = (try? container.decodeIfPresent(HarnessOracleStatus.self, forKey: .oracle)) ?? nil
        scheduler = (try? container.decodeIfPresent(HarnessStats.Scheduler.self, forKey: .scheduler)) ?? nil
        memory = (try? container.decodeIfPresent(HarnessMemoryStatus.self, forKey: .memory)) ?? nil
        backups = (try? container.decodeIfPresent(HarnessBackupsStatus.self, forKey: .backups)) ?? nil
        queue = (try? container.decodeIfPresent(HarnessQueueStatus.self, forKey: .queue)) ?? nil
        paused = (try? container.decodeIfPresent(Bool.self, forKey: .paused)) ?? false
    }
}

/// La mémoire du projet vue par le serveur : configurée, joignable, écritures perdues.
public struct HarnessOracleStatus: Decodable, Equatable, Sendable {
    public var configured: Bool
    public var ok: Bool
    public var lostWrites: HarnessLostWrites

    public init(configured: Bool, ok: Bool, lostWrites: HarnessLostWrites = HarnessLostWrites()) {
        self.configured = configured
        self.ok = ok
        self.lostWrites = lostWrites
    }
}

/// Les écritures de mémoire perdues depuis le démarrage du serveur.
public struct HarnessLostWrites: Decodable, Equatable, Sendable {
    public var count: Int
    public var lastAt: String?
    public var lastError: String?

    public init(count: Int = 0, lastAt: String? = nil, lastError: String? = nil) {
        self.count = count
        self.lastAt = lastAt
        self.lastError = lastError
    }
}

/// Le service mem0 : `configured` faux ⇒ `ok` faux et le reste `nil`.
public struct HarnessMemoryStatus: Decodable, Equatable, Sendable {
    public var configured: Bool
    public var ok: Bool
    public var version: String?
    public var uptimeSec: Double?
    public var memories: Int?
    public var dbBytes: Double?
    /// ISO 8601.
    public var lastBackupAt: String?
    public var lastBackupError: String?
    /// L'instant de la sonde, en ms.
    public var checkedAt: Double

    public init(
        configured: Bool, ok: Bool, version: String? = nil, uptimeSec: Double? = nil, memories: Int? = nil,
        dbBytes: Double? = nil, lastBackupAt: String? = nil, lastBackupError: String? = nil, checkedAt: Double = 0
    ) {
        self.configured = configured
        self.ok = ok
        self.version = version
        self.uptimeSec = uptimeSec
        self.memories = memories
        self.dbBytes = dbBytes
        self.lastBackupAt = lastBackupAt
        self.lastBackupError = lastBackupError
        self.checkedAt = checkedAt
    }
}

/// Les sauvegardes du serveur : le dernier instantané local et la copie distante (ms).
public struct HarnessBackupsStatus: Decodable, Equatable, Sendable {
    public var lastAt: Double?
    public var lastError: String?
    public var lastErrorAt: Double?
    public var remote: HarnessRemoteBackup

    public init(lastAt: Double? = nil, lastError: String? = nil, lastErrorAt: Double? = nil, remote: HarnessRemoteBackup = HarnessRemoteBackup()) {
        self.lastAt = lastAt
        self.lastError = lastError
        self.lastErrorAt = lastErrorAt
        self.remote = remote
    }
}

public struct HarnessRemoteBackup: Decodable, Equatable, Sendable {
    public var configured: Bool
    public var lastAt: Double?
    public var lastError: String?

    public init(configured: Bool = false, lastAt: Double? = nil, lastError: String? = nil) {
        self.configured = configured
        self.lastAt = lastAt
        self.lastError = lastError
    }
}

/// Le rapport du matin (`GET /v1/digest`) : le texte du serveur et ses compteurs.
public struct HarnessDigest: Decodable, Equatable, Sendable {
    public var since: Double
    public var until: Double
    public var text: String
    public var counts: HarnessDigestCounts

    public init(since: Double, until: Double, text: String, counts: HarnessDigestCounts) {
        self.since = since
        self.until = until
        self.text = text
        self.counts = counts
    }
}

public struct HarnessDigestCounts: Decodable, Equatable, Sendable {
    public var merged: Int
    public var decisions: Int
    public var waiting: Int
    public var failed: Int

    public init(merged: Int = 0, decisions: Int = 0, waiting: Int = 0, failed: Int = 0) {
        self.merged = merged
        self.decisions = decisions
        self.waiting = waiting
        self.failed = failed
    }

    /// Rien ne s'est passé dans la fenêtre.
    public var isEmpty: Bool { merged + decisions + waiting + failed == 0 }
}

// MARK: - Lignes de la carte

/// Une ligne de la carte « Services » : un service, son niveau, et les chiffres que
/// l'écran dit avec `MonitoringText`.
public struct HarnessServiceLine: Equatable, Sendable, Identifiable {
    public enum Kind: String, CaseIterable, Sendable {
        case server, database, scheduler, disk, oracle, memory, backups, workstation
    }

    public enum Level: Int, Comparable, Sendable {
        case ok, unknown, warning, down

        public static func < (a: Level, b: Level) -> Bool { a.rawValue < b.rawValue }
    }

    public var kind: Kind
    public var level: Level
    /// Selon le service : version du serveur ou de mem0, âge du dernier tour (s), espace
    /// libre (Mio), écritures perdues, souvenirs, instant (ms) de la dernière
    /// sauvegarde ou du dernier passage de l'extension, dernière erreur.
    public var version: String?
    public var ageSec: Double?
    public var freeMiB: Double?
    public var count: Int?
    public var at: Double?
    public var error: String?

    public var id: Kind { kind }

    public init(
        kind: Kind, level: Level, version: String? = nil, ageSec: Double? = nil, freeMiB: Double? = nil,
        count: Int? = nil, at: Double? = nil, error: String? = nil
    ) {
        self.kind = kind
        self.level = level
        self.version = version
        self.ageSec = ageSec
        self.freeMiB = freeMiB
        self.count = count
        self.at = at
        self.error = error
    }
}

public enum HarnessServices {
    /// Les lignes de la carte, dans l'ordre affiché. `health` absent : le serveur ne
    /// répond pas (ligne « serveur » en panne) ; un service que le serveur ne décrit
    /// pas (serveur plus ancien, poste désactivé) n'a pas de ligne.
    public static func lines(
        health: HarnessHealth?, status: HarnessStatus?, workstation: WorkstationStatus?, reachable: Bool
    ) -> [HarnessServiceLine] {
        var lines: [HarnessServiceLine] = []
        if let health {
            lines.append(HarnessServiceLine(kind: .server, level: health.ok ? .ok : .warning, version: health.version))
            lines.append(HarnessServiceLine(kind: .database, level: health.checks.db.ok ? .ok : .down))
            lines.append(HarnessServiceLine(kind: .scheduler, level: health.checks.scheduler.ok ? .ok : .warning, ageSec: health.checks.scheduler.ageSec))
            lines.append(HarnessServiceLine(kind: .disk, level: health.checks.disk.ok ? .ok : .warning, freeMiB: health.checks.disk.freeMiB))
        } else {
            lines.append(HarnessServiceLine(kind: .server, level: reachable ? .unknown : .down))
        }
        if let oracle = status?.oracle {
            let level: HarnessServiceLine.Level =
                !oracle.configured ? .unknown : !oracle.ok ? .down : oracle.lostWrites.count > 0 ? .warning : .ok
            lines.append(HarnessServiceLine(kind: .oracle, level: level, count: oracle.lostWrites.count, error: oracle.lostWrites.lastError))
        }
        if let memory = status?.memory {
            let level: HarnessServiceLine.Level = !memory.configured ? .unknown : memory.ok ? .ok : .down
            lines.append(HarnessServiceLine(kind: .memory, level: level, version: memory.version, count: memory.memories))
        }
        if let backups = status?.backups {
            let failedLast = backups.lastError != nil && (backups.lastErrorAt ?? 0) >= (backups.lastAt ?? 0)
            let remoteFailed = backups.remote.configured && backups.remote.lastError != nil
            let level: HarnessServiceLine.Level = backups.lastAt == nil && backups.lastError == nil
                ? .unknown
                : failedLast || remoteFailed ? .warning : .ok
            lines.append(HarnessServiceLine(
                kind: .backups,
                level: level,
                at: backups.lastAt,
                error: failedLast ? backups.lastError : remoteFailed ? backups.remote.lastError : nil
            ))
        }
        if let workstation {
            lines.append(HarnessServiceLine(kind: .workstation, level: workstation.online ? .ok : .warning, version: workstation.extensionVersion, at: workstation.lastSeenAt))
        }
        return lines
    }

    /// Le pire niveau des lignes, `ok` sans ligne.
    public static func worst(_ lines: [HarnessServiceLine]) -> HarnessServiceLine.Level {
        lines.map(\.level).max() ?? .ok
    }
}

// MARK: - Lecture

extension HarnessModel {
    /// Relit la santé, l'état des services et le rapport du matin. Un échec laisse la
    /// dernière lecture (aucun bandeau : la carte dit elle-même ce qu'elle n'a pas).
    public func refreshServices() async {
        guard let server else { return }
        if let reply = try? await transport.send(HarnessCall(method: "GET", path: "/v1/health"), server: server) {
            // 503 au moindre échec, corps lisible quand même.
            if reply.status == 200 || reply.status == 503 {
                health = try? JSONDecoder().decode(HarnessHealth.self, from: reply.body)
                if health == nil { reportUnreadable(HarnessCall(method: "GET", path: "/v1/health"), type: HarnessHealth.self) }
            } else {
                health = nil
                reportIfUnexpected(reply, for: HarnessCall(method: "GET", path: "/v1/health"))
            }
            healthReached = true
        } else {
            health = nil
            healthReached = false
        }
        if let read: HarnessStatus = try? await perform(HarnessCall(method: "GET", path: "/v1/status"), on: server) {
            status = read
        }
        digest = try? await perform(HarnessCall(method: "GET", path: "/v1/digest"), on: server)
    }

    /// Les lignes de la carte « Services », extension du poste comprise.
    public var serviceLines: [HarnessServiceLine] {
        HarnessServices.lines(health: health, status: status, workstation: workstation.status, reachable: healthReached)
    }
}
