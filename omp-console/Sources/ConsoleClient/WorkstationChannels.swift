// Les CANAUX CORPO du poste côté client, partagés par la coque Mac et l'app iOS : l'état
// de Gmail, de l'Agenda et de Slack, et leur connexion (routes `/v1/workstation/channels*`
// d'omp-harness, capacité `workstation-channels`). Le serveur fait tout le travail OAuth
// (PKCE, `state`, échange du code, jetons) ; l'app saisit le client OAuth, ouvre l'URL
// d'autorisation que le serveur rend et lui recolle l'URL de retour (ou le code, ou le
// texte d'erreur affiché), ou déclare que l'administrateur bloque l'app.
//
// Comme tout le poste, ces routes sont au PROPRIÉTAIRE : un jeton restreint reçoit 403,
// le modèle passe en `.reserved` et rien n'est montré, sans échec. Un serveur qui ne sert
// pas la route (antérieur, ou poste désactivé) rend 404 : `.absent`, l'écran disparaît.
// Les gestes exigent l'appareil approbateur : le refus du serveur (`.approverOnly`) revient
// au geste. Le serveur ne rend l'URL d'autorisation qu'à l'approbateur.
//
// Un SECRET du client Google (saisi ou dans le JSON collé) part dans le seul corps de
// `PUT …/google/client` : ce modèle n'en garde aucune copie, le serveur ne le rend jamais.
//
// Il n'a ni transport ni jeton à lui : il est porté par `HarnessModel` (`server.channels`)
// et relit l'état à chaque événement `workstation_channel` du flux de la boîte.
//
// Aucun texte ici : un échec est un `HarnessFailure`, que les écrans traduisent.

import Foundation

// MARK: - Contrat JSON

/// Un canal : `gmail`, `calendar` ou `slack`, avec la connexion qui le porte.
public struct WorkstationChannel: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    /// `google` ou `slack`.
    public var connection: String
    /// `disconnected`, `connected`, `reconnect`, `blocked` ou `error` (brut : un état
    /// inconnu de cette version se rend tel quel).
    public var state: String
    public var account: String?
    /// La dernière lecture réussie (ms).
    public var lastReadAt: Double?
    /// La phrase du serveur (blocage par l'administrateur, scope manquant, refus…).
    public var error: String?
}

/// Une connexion en cours ou terminée ; `url` n'est rendue qu'à l'appareil approbateur.
public struct WorkstationChannelLogin: Codable, Equatable, Sendable {
    public var id: String
    public var connection: String
    /// `waiting`, `done` ou `failed`.
    public var state: String
    public var url: String?
    public var startedAt: Double
    public var expiresAt: Double
    public var error: String?
}

/// Une connexion OAuth : `google` (Gmail et Agenda) ou `slack`. Jamais de secret.
public struct WorkstationChannelConnection: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var clientId: String?
    public var clientConfigured: Bool
    public var login: WorkstationChannelLogin?
}

/// `GET /v1/workstation/channels`.
public struct WorkstationChannelsReply: Codable, Equatable, Sendable {
    public var channels: [WorkstationChannel]
    public var connections: [WorkstationChannelConnection]
}

/// `PUT /v1/workstation/channels/{id}/client`.
public struct WorkstationChannelClientReply: Codable, Equatable, Sendable {
    public var connection: WorkstationChannelConnection
}

/// `POST /v1/workstation/channels/{id}/login`.
public struct WorkstationChannelLoginReply: Codable, Equatable, Sendable {
    public var login: WorkstationChannelLogin
}

/// `POST /v1/workstation/channels/{id}/login/answer`.
public struct WorkstationChannelAnswerReply: Codable, Equatable, Sendable {
    public var login: WorkstationChannelLogin
    public var channels: [WorkstationChannel]
}

// MARK: - Modèle

@MainActor
public final class WorkstationChannelsModel: ObservableObject {
    /// Ce que le serveur relié dit des canaux.
    public enum Availability: Equatable, Sendable {
        /// Pas encore lu.
        case unknown
        /// Le serveur sert les canaux à ce jeton.
        case available
        /// Le serveur ne sert pas la route (antérieur aux canaux, ou poste désactivé).
        case absent
        /// Le jeton n'est pas celui du propriétaire : rien n'est montré.
        case reserved
    }

    /// La saisie du client Google : identifiant et secret, ou le JSON téléchargé.
    public enum GoogleClient: Sendable {
        case credentials(clientId: String, clientSecret: String)
        case json(String)
    }

    @Published public private(set) var availability: Availability = .unknown
    /// Les trois canaux dans l'ordre du serveur (`gmail`, `calendar`, `slack`).
    @Published public private(set) var channels: [WorkstationChannel] = []
    /// Les deux connexions (`google`, `slack`).
    @Published public private(set) var connections: [WorkstationChannelConnection] = []
    /// Le dernier échec de lecture, effacé par la prochaine lecture réussie.
    @Published public private(set) var failure: HarnessFailure?
    /// Les connexions dont un geste attend la réponse du serveur.
    @Published public private(set) var busy: Set<String> = []

    weak var harness: HarnessModel?
    private let reloadDelay: Duration
    private var reloadTask: Task<Void, Never>?
    /// Un événement est arrivé pendant une relecture : elle sera replanifiée.
    private var reloadAgain = false

    init(harness: HarnessModel, reloadDelay: Duration) {
        self.harness = harness
        self.reloadDelay = reloadDelay
    }

    /// Ce jeton est celui de l'appareil approbateur : lui seul a les gestes (et l'URL).
    public var isApprover: Bool { harness?.client?.approver ?? false }

    /// Les canaux qui attendent l'humain : à reconnecter, en erreur (0 hors d'un serveur qui les sert).
    public var attentionCount: Int {
        guard availability == .available else { return 0 }
        return channels.filter { $0.state == "reconnect" || $0.state == "error" }.count
    }

    public func connection(_ id: String) -> WorkstationChannelConnection? {
        connections.first { $0.id == id }
    }

    // MARK: - Lecture

    /// Relit l'état des canaux. Un serveur sans la route (404) ou un jeton qui n'est pas
    /// celui du propriétaire (403) ne montre rien, sans échec.
    public func refresh() async {
        guard let harness, harness.isConfigured else { return }
        let call = HarnessCall(method: "GET", path: "/v1/workstation/channels")
        do {
            let reply = try await harness.exchange(call)
            if reply.status == 404 {
                clear(.absent)
                return
            }
            let read: WorkstationChannelsReply = try harness.decode(reply, for: call)
            channels = read.channels
            connections = read.connections
            availability = .available
            failure = nil
        } catch HarnessFailure.forbidden {
            clear(.reserved)
        } catch {
            failure = HarnessModel.failure(of: error)
        }
    }

    /// Les noms des événements reçus par le flux de la boîte : `workstation_channel` fait
    /// relire (regroupé : une rafale ne coûte qu'une relecture). Un événement arrivé PENDANT
    /// la relecture n'est pas perdu : la relecture est replanifiée.
    func receive(_ names: [String]) {
        guard names.contains("workstation_channel") else { return }
        switch availability {
        case .absent, .reserved: return
        case .unknown, .available: break
        }
        guard reloadTask == nil else {
            reloadAgain = true
            return
        }
        scheduleReload()
    }

    private func scheduleReload() {
        let delay = reloadDelay
        reloadTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self else { return }
            reloadAgain = false
            await refresh()
            guard !Task.isCancelled else { return }
            reloadTask = nil
            if reloadAgain {
                reloadAgain = false
                scheduleReload()
            }
        }
    }

    /// Oublie tout ce qui a été lu : le serveur a changé (ou a été oublié).
    func reset() {
        reloadTask?.cancel()
        reloadTask = nil
        reloadAgain = false
        clear(.unknown)
        busy = []
    }

    private func clear(_ next: Availability) {
        availability = next
        channels = []
        connections = []
        failure = nil
    }

    // MARK: - Gestes de l'appareil approbateur

    /// Saisit le client OAuth Google. Le secret part dans ce seul corps, jamais gardé ici.
    public func setGoogleClient(_ client: GoogleClient) async throws {
        let body: ClientBody = switch client {
        case let .credentials(clientId, clientSecret):
            ClientBody(clientId: clientId.trimmingCharacters(in: .whitespacesAndNewlines), clientSecret: clientSecret.trimmingCharacters(in: .whitespacesAndNewlines))
        case let .json(text):
            ClientBody(json: text.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        let _: WorkstationChannelClientReply = try await gesture(on: "google") {
            try await self.send("PUT", "/v1/workstation/channels/google/client", body: body)
        }
    }

    /// Saisit l'identifiant client de l'app Slack (PKCE : aucun secret).
    public func setSlackClient(clientId: String) async throws {
        let body = ClientBody(clientId: clientId.trimmingCharacters(in: .whitespacesAndNewlines))
        let _: WorkstationChannelClientReply = try await gesture(on: "slack") {
            try await self.send("PUT", "/v1/workstation/channels/slack/client", body: body)
        }
    }

    /// Démarre une connexion ; `channels` (Google : `gmail`, `calendar`) ne demande que
    /// ces canaux, `nil` les demande tous. Rend la connexion et son URL d'autorisation.
    @discardableResult
    public func startLogin(_ connection: String, channels: [String]? = nil) async throws -> WorkstationChannelLogin {
        let reply: WorkstationChannelLoginReply = try await gesture(on: connection) {
            try await self.send("POST", "/v1/workstation/channels/\(HarnessModel.pathComponent(connection))/login", body: LoginBody(channels: channels))
        }
        return reply.login
    }

    /// Recolle l'URL de retour, le code, ou le texte d'erreur affiché par le fournisseur.
    @discardableResult
    public func answer(_ connection: String, value: String) async throws -> WorkstationChannelLogin {
        let body = AnswerBody(value: value.trimmingCharacters(in: .whitespacesAndNewlines))
        return try await post(answer: body, on: connection)
    }

    /// Déclare que l'administrateur bloque l'app : toute la connexion en cours (`nil`), ou
    /// seulement ces canaux (Google : `gmail` ou `calendar`).
    @discardableResult
    public func declareBlocked(_ connection: String, channels: [String]? = nil) async throws -> WorkstationChannelLogin {
        try await post(answer: AnswerBody(blocked: true, channels: channels), on: connection)
    }

    private func post(answer body: AnswerBody, on connection: String) async throws -> WorkstationChannelLogin {
        let reply: WorkstationChannelAnswerReply = try await gesture(on: connection) {
            try await self.send("POST", "/v1/workstation/channels/\(HarnessModel.pathComponent(connection))/login/answer", body: body)
        }
        return reply.login
    }

    /// Un geste sur une connexion : marqué en cours, puis l'état relu (succès ou échec : un
    /// refus du fournisseur change aussi l'état d'un canal).
    private func gesture<Reply>(on connection: String, _ run: () async throws -> Reply) async throws -> Reply {
        busy.insert(connection)
        defer { busy.remove(connection) }
        do {
            let reply = try await run()
            await refresh()
            return reply
        } catch {
            await refresh()
            throw error
        }
    }

    /// Un envoi décodé ; l'erreur levée est toujours un `HarnessFailure`, sauf une annulation.
    private func send<Body: Encodable, Reply: Decodable>(_ method: String, _ path: String, body: Body) async throws -> Reply {
        guard let harness, harness.isConfigured else { throw HarnessFailure.unreachable }
        guard let encoded = try? JSONEncoder().encode(body) else { throw HarnessFailure.unreadable }
        let call = HarnessCall(method: method, path: path, body: encoded)
        do {
            return try harness.decode(try await harness.exchange(call), for: call)
        } catch {
            if let failure = HarnessModel.failure(of: error) { throw failure }
            throw error
        }
    }
}

/// `{clientId, clientSecret}`, `{json}` ou `{clientId}` : un champ `nil` est absent du JSON.
private struct ClientBody: Encodable {
    var clientId: String?
    var clientSecret: String?
    var json: String?
}

/// `{channels?}` : absent, la connexion demande tous ses canaux.
private struct LoginBody: Encodable {
    var channels: [String]?
}

/// `{value}` ou `{blocked: true, channels?}`.
private struct AnswerBody: Encodable {
    var value: String?
    var blocked: Bool?
    var channels: [String]?
}
