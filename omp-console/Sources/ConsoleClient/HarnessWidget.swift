// Le widget d'écran d'accueil de l'app iOS : ce qui attend l'humain sur le serveur de
// pipelines et les features en cours, avec leur étape et leurs alertes.
//
// L'app et l'extension de widgets partagent un groupe d'apps (`OMPAppGroup` de leur
// Info.plist, réglé par `OMP_APP_GROUP` dans le projet) : l'app y dépose le dernier
// instantané de la boîte et l'adresse du serveur, et copie le jeton dans un article de
// trousseau du même groupe. Le widget relit ainsi la boîte LUI-MÊME à chaque
// rafraîchissement (`HarnessInboxReader`), app fermée ; sans réseau, il montre le
// dernier instantané, daté.

import ConsoleCore
import Foundation

/// L'instantané de la boîte que montre le widget.
public struct HarnessWidgetSnapshot: Codable, Equatable, Sendable {
    /// Une feature listée par le widget.
    public struct Run: Codable, Equatable, Sendable, Identifiable {
        public var id: String
        public var title: String
        public var state: String
        public var step: String?
        /// La sorte de sa première alerte en cours.
        public var alert: String?
        public var cost: Double?

        public init(id: String, title: String, state: String, step: String? = nil, alert: String? = nil, cost: Double? = nil) {
            self.id = id
            self.title = title
            self.state = state
            self.step = step
            self.alert = alert
            self.cost = cost
        }

        public var phase: HarnessRunState? { HarnessRunState(rawValue: state) }

        /// La feature attend l'humain.
        public var needsHuman: Bool { phase == .escalated || phase == .awaitingHuman }
    }

    /// Les features gardées dans l'instantané (le grand format en montre le plus).
    public static let keep = 8

    /// Un serveur est relié à l'app.
    public var configured: Bool
    /// Ce qui bloque une feature tant que l'humain n'a pas agi (le badge de l'Accueil).
    public var pending: Int
    /// Les alertes en cours de la veille du serveur.
    public var alerts: Int
    /// Les features vivantes : celles qui attendent l'humain d'abord, puis les autres.
    public var runs: [Run]
    /// Les features vivantes en tout (la liste peut être coupée).
    public var activeCount: Int
    /// L'instant de la lecture de la boîte, en secondes depuis 1970.
    public var updatedAt: Double

    public init(configured: Bool, pending: Int = 0, alerts: Int = 0, runs: [Run] = [], activeCount: Int = 0, updatedAt: Double = 0) {
        self.configured = configured
        self.pending = pending
        self.alerts = alerts
        self.runs = runs
        self.activeCount = activeCount
        self.updatedAt = updatedAt
    }

    /// L'instantané d'une boîte lue à l'instant `now`.
    public init(inbox: HarnessInbox?, configured: Bool, now: Date = Date()) {
        guard let inbox else {
            self.init(configured: configured, updatedAt: now.timeIntervalSince1970)
            return
        }
        let living = inbox.runs.filter { run in
            guard let phase = run.phase else { return true }
            return ![.merged, .failed, .cancelled].contains(phase)
        }
        let ordered = living.filter(\.needsHumanInWidget) + living.filter { !$0.needsHumanInWidget }
        self.init(
            configured: configured,
            pending: inbox.pendingCount,
            alerts: inbox.alerts.count,
            runs: ordered.prefix(Self.keep).map { run in
                Run(id: run.id, title: run.title, state: run.state, step: run.step, alert: inbox.alerts(of: run.id).first?.kind, cost: inbox.costs[run.id])
            },
            activeCount: living.count,
            updatedAt: now.timeIntervalSince1970
        )
    }

    /// Aucun serveur relié.
    public static let unconfigured = HarnessWidgetSnapshot(configured: false)

    /// Le même contenu, à l'heure de lecture près : rien à redessiner.
    public func sameContent(as other: HarnessWidgetSnapshot?) -> Bool {
        guard var other else { return false }
        other.updatedAt = updatedAt
        return other == self
    }

    public var updatedDate: Date { Date(timeIntervalSince1970: updatedAt) }
}

private extension HarnessRun {
    var needsHumanInWidget: Bool { phase == .escalated || phase == .awaitingHuman }
}

/// Le lien qui ouvre l'app sur une section (`ompconsole://home`), depuis le widget.
public enum HarnessWidgetLink {
    public static let scheme = "ompconsole"

    public static func url(_ section: ConsoleSection) -> URL {
        var components = URLComponents()
        components.scheme = scheme
        components.host = section.rawValue
        return components.url ?? URL(fileURLWithPath: "/")
    }

    /// La section d'un lien du widget, ou `nil` pour tout autre lien.
    public static func section(of url: URL) -> ConsoleSection? {
        guard url.scheme == scheme, let host = url.host else { return nil }
        return ConsoleSection(rawValue: host)
    }
}

/// Le groupe d'apps partagé par l'app et son extension de widgets.
public struct HarnessWidgetStore: Sendable {
    /// La clé de l'Info.plist qui porte l'identifiant du groupe (`$(OMP_APP_GROUP)`).
    public static let infoKey = "OMPAppGroup"
    static let snapshotKey = "harness.widget.snapshot"
    static let addressKey = "harness.widget.address"
    /// L'article de trousseau partagé qui porte le jeton du serveur.
    public static let tokenService = "com.omp.console.harness.shared"
    public static let tokenAccount = "harness"

    public let group: String

    public init(group: String) {
        self.group = group
    }

    /// Le groupe déclaré par l'Info.plist du bundle courant ; `nil` s'il n'en déclare
    /// pas (build sans groupe d'apps : le widget montre alors « relier le serveur »).
    public static func fromBundle(_ bundle: Bundle = .main) -> HarnessWidgetStore? {
        guard let group = bundle.object(forInfoDictionaryKey: infoKey) as? String,
              !group.isEmpty, !group.contains("$(")
        else { return nil }
        return HarnessWidgetStore(group: group)
    }

    private var defaults: UserDefaults? { UserDefaults(suiteName: group) }

    /// Le jeton du serveur, dans le trousseau du groupe, lisible écran verrouillé.
    public var tokens: KeychainTokenStore {
        KeychainTokenStore(service: Self.tokenService, accessGroup: group, readableWhileLocked: true)
    }

    public func save(_ snapshot: HarnessWidgetSnapshot) {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        defaults?.set(data, forKey: Self.snapshotKey)
    }

    public func snapshot() -> HarnessWidgetSnapshot? {
        guard let data = defaults?.data(forKey: Self.snapshotKey) else { return nil }
        return try? JSONDecoder().decode(HarnessWidgetSnapshot.self, from: data)
    }

    public func saveAddress(_ address: String?) {
        if let address { defaults?.set(address, forKey: Self.addressKey) } else { defaults?.removeObject(forKey: Self.addressKey) }
    }

    public func address() -> String? { defaults?.string(forKey: Self.addressKey) }
}

/// La lecture de la boîte hors du modèle de l'app : celle du widget, qui n'a ni flux ni état.
public enum HarnessInboxReader {
    public static func read(address: String, token: String, transport: any HarnessTransport = URLSessionHarnessTransport()) async throws -> HarnessInbox {
        guard let url = URL(string: address) else { throw HarnessFailure.invalidAddress }
        let reply = try await transport.send(HarnessCall(method: "GET", path: "/v1/inbox"), server: HarnessServer(baseURL: url, token: token))
        switch reply.status {
        case 200:
            guard let inbox = try? JSONDecoder().decode(HarnessInbox.self, from: reply.body) else { throw HarnessFailure.unreadable }
            return inbox
        case 401:
            throw HarnessFailure.unauthorized
        default:
            throw HarnessFailure.rejected("")
        }
    }
}
