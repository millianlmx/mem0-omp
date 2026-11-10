// Le widget d'écran d'accueil de l'app iOS : ce qui attend l'humain sur le serveur de
// pipelines et les features en cours, avec leur étape et leurs alertes.
//
// L'app et l'extension de widgets partagent un groupe d'apps (`OMPAppGroup` de leur
// Info.plist, réglé par `OMP_APP_GROUP` dans le projet) : l'app y dépose le dernier
// instantané de la boîte et l'adresse du serveur, et copie le jeton dans un article de
// trousseau du même groupe. Le widget relit ainsi la boîte LUI-MÊME à chaque
// rafraîchissement (`HarnessInboxReader`), app fermée ; sans réseau, il montre le
// dernier instantané, daté.
//
// Les mêmes identifiants partagés servent ce qui se fait HORS de l'app : le bouton
// « Valider » d'une Live Activity (`HarnessRemote`) passe par un `HarnessModel` relié par
// le groupe d'apps (`HarnessModel.shared`). Les liens `ompconsole://` de ces surfaces sont
// décrits ici (`HarnessWidgetLink`).

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

/// Les liens `ompconsole://` qui ouvrent l'app à un endroit, depuis le widget, une Live
/// Activity ou un raccourci : une section (`ompconsole://inbox`), le fil d'une feature
/// (`ompconsole://threads/<id>`, et `runs/<id>`), le tri des décisions
/// (`ompconsole://decisions`), « Maintenant » (`ompconsole://now`), une page de Système
/// (`ompconsole://system/<page>`).
public enum HarnessWidgetLink {
    public static let scheme = "ompconsole"
    static let threadsHost = "threads"
    static let decisionsHost = "decisions"
    static let nowHost = "now"

    /// Où mène un lien.
    public enum Destination: Equatable, Sendable {
        case section(ConsoleSection)
        /// Le fil d'une feature.
        case thread(String)
        /// Ce qui attend l'humain, à trier.
        case decisions
        /// L'accueil : le brief et ce qui travaille.
        case now
        case system(SystemPage)

        /// La destination dans la coque à sections : un fil est la page de sa feature, le
        /// tri est « À traiter » à ce qui attend, « Maintenant » est l'accueil.
        public var command: HarnessPaletteCommand {
            switch self {
            case let .section(section): .section(section)
            case let .thread(id): .run(id)
            case .decisions: .inbox(.toDecide)
            case .now: .section(.inbox)
            case let .system(page): .system(page)
            }
        }
    }

    public static func url(_ section: ConsoleSection) -> URL { url(host: section.rawValue) }

    /// `ompconsole://threads/<id>` : le fil d'une feature.
    public static func url(thread runId: String) -> URL { url(host: threadsHost, item: runId) }

    /// `ompconsole://decisions` : le tri de ce qui attend l'humain.
    public static let decisions = url(host: decisionsHost)

    /// `ompconsole://now` : « Maintenant ».
    public static let now = url(host: nowHost)

    private static func url(host: String, item: String? = nil) -> URL {
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        if let item { components.path = "/" + item }
        return components.url ?? URL(fileURLWithPath: "/")
    }

    /// La section d'un lien du widget, ou `nil` pour tout autre lien.
    public static func section(of url: URL) -> ConsoleSection? {
        guard url.scheme == scheme, let host = url.host else { return nil }
        return ConsoleSection(rawValue: host)
    }

    /// Où mène un lien `ompconsole://`, ou `nil` pour tout autre lien. Un fil sans
    /// identifiant est la liste des features ; une page de Système inconnue, le hub.
    public static func destination(of url: URL) -> Destination? {
        guard url.scheme == scheme, let host = url.host else { return nil }
        let item = url.pathComponents.dropFirst().first
        switch host {
        case threadsHost: return item.map(Destination.thread) ?? .section(.runs)
        case decisionsHost: return .decisions
        case nowHost: return .now
        default: break
        }
        guard let section = ConsoleSection(rawValue: host) else { return nil }
        if section == .runs, let item { return .thread(item) }
        if section == .system, let page = item.flatMap(SystemPage.init(rawValue:)) { return .system(page) }
        return .section(section)
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

    /// Le serveur que l'app a relié, tel qu'elle l'a partagé : son adresse et son jeton ;
    /// `nil` tant que l'app n'en a relié aucun (ou appareil jamais déverrouillé).
    public func credentials() async -> (address: String, token: String)? {
        guard let address = address(), let token = try? await tokens.token(for: Self.tokenAccount), !token.isEmpty else { return nil }
        return (address, token)
    }
}

extension HarnessModel {
    /// Le modèle de ce qui agit hors de l'app (le bouton d'une Live Activity) : relié au serveur
    /// de l'app par le groupe d'apps, boîte lue, rien d'enregistré ni de retenu. `nil` : le
    /// groupe n'est pas déclaré, ou l'app n'a relié aucun serveur.
    public static func shared(
        _ store: HarnessWidgetStore? = .fromBundle(), transport: any HarnessTransport = URLSessionHarnessTransport()
    ) async -> HarnessModel? {
        guard let credentials = await store?.credentials() else { return nil }
        return await linked(address: credentials.address, token: credentials.token, transport: transport)
    }

    /// Un modèle relié à cette adresse et ce jeton, sans rien enregistrer ; `nil` pour une
    /// adresse illisible.
    static func linked(address: String, token: String, transport: any HarnessTransport) async -> HarnessModel? {
        guard let normalized = normalizedAddress(address) else { return nil }
        let model = HarnessModel(
            transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(),
            fallback: { (normalized, token) }
        )
        await model.load()
        return model.isConfigured ? model : nil
    }
}

/// Les gestes faits hors de l'app, sur un modèle relié par le groupe d'apps.
public enum HarnessRemote {
    /// La source d'une Demande dictée ou tapée hors de l'app (Siri, Raccourcis, bouton
    /// Action) : `INTAKE_SOURCES` d'omp-harness/intake.ts.
    public static let voiceSource = "voice"

    /// Valide la revue d'une feature depuis sa Live Activity, à la révision que le serveur
    /// vient de rendre : `false` si elle n'attend plus de validation (déjà tranchée, specs
    /// à relire, feature repartie) ou si le serveur refuse — rien n'est alors tranché.
    @MainActor
    public static func validateReview(runId: String, on model: HarnessModel) async -> Bool {
        guard let run = model.inbox?.awaiting.first(where: { $0.id == runId }), run.awaitsVerdict else { return false }
        return await model.validate(runId: runId, approve: true, reason: "", rev: run.rev)
    }
}

extension HarnessIntakeFailure {
    /// La phrase d'une Demande qui n'est pas partie, pour ce qui la pose hors de l'app
    /// (Siri, Raccourcis) : la cause, puis le remède.
    public var message: String {
        switch self {
        case .unsupported: IntakeText.unsupported
        case .server(.approverOnly): IntakeText.approverOnly
        case .server(let failure): failure.message
        }
    }
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
