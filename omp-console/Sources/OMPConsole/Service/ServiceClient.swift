// Le client HTTP du service (S-2, S-10) : un seul endroit qui parle au port
// 127.0.0.1, porte le jeton, décode les erreurs `{error,reason}` et les corps.
//
// Le transport est derrière un protocole (`ServiceTransport`) : les preuves le
// remplacent par un double scripté, et l'app utilise `URLSession`. Aucun `Process`
// n'est créé ici — l'app ne lance jamais `omp`.

import ConsoleCore
import Foundation

/// La réponse brute d'une requête : les octets et le statut.
struct ServiceHTTPResponse: Sendable {
    let status: Int
    let body: Data

    var json: JSONValue? { JSONValue.parse(body) }
}

/// Le seam de transport. `URLSessionTransport` est l'implémentation réelle ; un
/// double scripté rend des réponses décidées, sans réseau.
protocol ServiceTransport: Sendable {
    func send(_ request: URLRequest) async throws -> ServiceHTTPResponse
    /// Ouvre un flux de lignes (SSE), LIGNES VIDES COMPRISES : la ligne vide clôt
    /// une trame (`ServiceEvents.frames`). La fin du flux (ou sa levée) déclenche
    /// la reconnexion côté client.
    func lines(_ request: URLRequest) async throws -> AsyncThrowingStream<String, Error>
}

/// Le transport réel : `URLSession.data(for:)` et `URLSession.bytes(for:)`
/// (Doc-4 §1).
struct URLSessionTransport: ServiceTransport {
    let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func send(_ request: URLRequest) async throws -> ServiceHTTPResponse {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw ServiceClientError.malformed(reason: "réponse sans statut HTTP")
            }
            return ServiceHTTPResponse(status: http.statusCode, body: data)
        } catch let error as ServiceClientError {
            throw error
        } catch {
            throw Self.transportError(error)
        }
    }

    func lines(_ request: URLRequest) async throws -> AsyncThrowingStream<String, Error> {
        let bytes: URLSession.AsyncBytes
        let response: URLResponse
        do {
            (bytes, response) = try await session.bytes(for: request)
        } catch {
            throw Self.transportError(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw ServiceClientError.malformed(reason: "flux sans statut HTTP")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw ServiceClient.statusError(http.statusCode, body: nil)
        }
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    // Découpage octet par octet : `bytes.lines` (AsyncLineSequence)
                    // ne rend JAMAIS les lignes vides, et sur un flux qui reste
                    // ouvert la dernière trame attendait la fermeture — dialogues,
                    // avis et états du service n'arrivaient pas (mesuré le
                    // 2026-10-11).
                    var line: [UInt8] = []
                    for try await byte in bytes {
                        guard byte == UInt8(ascii: "\n") else {
                            line.append(byte)
                            continue
                        }
                        if line.last == UInt8(ascii: "\r") { line.removeLast() }
                        continuation.yield(String(decoding: line, as: UTF8.self))
                        line.removeAll(keepingCapacity: true)
                    }
                    if !line.isEmpty { continuation.yield(String(decoding: line, as: UTF8.self)) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: Self.transportError(error))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Une connexion refusée (service arrêté) devient `unavailable` ; tout autre
    /// échec garde son motif.
    static func transportError(_ error: Error) -> Error {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .cannotConnectToHost, .cannotFindHost, .networkConnectionLost,
                 .notConnectedToInternet, .timedOut:
                return ServiceClientError.unavailable
            default:
                return ServiceClientError.transport(reason: urlError.localizedDescription)
            }
        }
        return ServiceClientError.transport(reason: String(describing: error))
    }
}

/// Le client d'UNE session de service : endpoint + jeton + transport.
struct ServiceClient: Sendable {
    let endpoint: ServiceEndpoint
    let transport: any ServiceTransport

    init(endpoint: ServiceEndpoint, transport: any ServiceTransport = URLSessionTransport()) {
        self.endpoint = endpoint
        self.transport = transport
    }

    // MARK: - Requêtes

    func health() async throws -> Int {
        let json = try await request("GET", path: ["health"])
        return Int(json.objectValue?["pid"]?.numberValue ?? 0)
    }

    /// Réveille un dépôt : contrôleur créé au besoin, adoption, tick (S-9).
    func pilot(repo: String) async throws {
        _ = try await request("POST", path: ["repos", repo, "pilot"])
    }

    /// Applique une commande de pipeline et rend son accusé (S-9).
    func command(repo: String, body: [String: Any]) async throws -> ServiceCommandAck {
        let json = try await request("POST", path: ["repos", repo, "commands"], body: body)
        guard let ackValue = json.objectValue?["ack"], let ack = ServiceCommandAck.decode(ackValue) else {
            throw ServiceClientError.malformed(reason: "accusé illisible")
        }
        return ack
    }

    /// Crée une session servie (S-6). `resume` est le CHEMIN du fichier de session
    /// à continuer, jamais un booléen : le service refuse toute autre forme en 400
    /// (« chemin de fichier de session attendu »), et `nil` ouvre une session
    /// neuve (le champ n'est alors pas envoyé).
    func createSession(cwd: String, resume: String? = nil, purpose: String = "session") async throws -> ServiceSessionInfo {
        var body: [String: Any] = ["cwd": cwd, "purpose": purpose]
        if let resume { body["resume"] = resume }
        let json = try await request("POST", path: ["sessions"], body: body)
        guard let info = ServiceSessionInfo.decode(json) else {
            throw ServiceClientError.malformed(reason: "session illisible")
        }
        return info
    }

    /// Les sessions servies (`run` est interne au service, S-2) : l'app y retrouve
    /// la conduite DÉJÀ vivante d'un dépôt — celle que le service a reprise après
    /// un redémarrage — au lieu d'en créer une seconde (S-7).
    func sessions() async throws -> [ServiceSessionInfo] {
        let json = try await request("GET", path: ["sessions"])
        guard let list = json.objectValue?["sessions"]?.arrayValue else {
            throw ServiceClientError.malformed(reason: "sessions illisibles")
        }
        return list.compactMap(ServiceSessionInfo.decode)
    }

    func session(id: String) async throws -> ServiceSessionInfo {
        let json = try await request("GET", path: ["sessions", id])
        guard let info = ServiceSessionInfo.decode(json) else {
            throw ServiceClientError.malformed(reason: "session illisible")
        }
        return info
    }

    func prompt(id: String, text: String) async throws {
        _ = try await request("POST", path: ["sessions", id, "prompt"], body: ["text": text])
    }

    func abort(id: String) async throws {
        _ = try await request("POST", path: ["sessions", id, "abort"])
    }

    func answerDialog(id: String, dialogId: String, answer: RpcDialogResponse) async throws {
        _ = try await request("POST", path: ["sessions", id, "dialogs", dialogId], body: answer.body)
    }

    func closeSession(id: String) async throws {
        _ = try await request("DELETE", path: ["sessions", id])
    }

    func startConduite(repo: String, name: String) async throws -> ServiceSessionInfo {
        let json = try await request("POST", path: ["projects", repo, "conduite"], body: ["name": name])
        guard let object = json.objectValue,
              let sessionId = object["sessionId"]?.stringValue,
              let state = object["state"]?.stringValue.flatMap(SessionRunState.init(rawValue:)) else {
            throw ServiceClientError.malformed(reason: "conduite illisible")
        }
        return ServiceSessionInfo(id: sessionId, cwd: repo, purpose: "project", state: state, sessionFile: nil)
    }

    func stopConduite(repo: String) async throws {
        _ = try await request("DELETE", path: ["projects", repo, "conduite"])
    }

    /// Le flux SSE des trames d'une session (S-6).
    func eventsRequest(id: String) -> URLRequest {
        var request = makeRequest("GET", path: ["sessions", id, "events"])
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        return request
    }

    // MARK: - Exécution

    private func request(_ method: String, path: [String], body: [String: Any]? = nil) async throws -> JSONValue {
        var request = makeRequest(method, path: path)
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        }
        let response: ServiceHTTPResponse
        do {
            response = try await transport.send(request)
        } catch let error as ServiceClientError {
            throw error
        } catch {
            throw URLSessionTransport.transportError(error)
        }
        guard (200..<300).contains(response.status) else {
            throw Self.statusError(response.status, body: response.json)
        }
        return response.json ?? .null
    }

    private func makeRequest(_ method: String, path: [String]) -> URLRequest {
        var url = endpoint.baseURL
        for segment in path {
            url.appendPathComponent(segment, isDirectory: false)
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(endpoint.token, forHTTPHeaderField: "X-OMP-Service-Token")
        request.timeoutInterval = 30
        return request
    }

    /// La table d'erreurs de S-2 : chaque code a son cas typé.
    static func statusError(_ status: Int, body: JSONValue?) -> ServiceClientError {
        let reason = body?.objectValue?["reason"]?.stringValue
        switch status {
        case 401: return .unauthorized
        case 400: return .badRequest(reason: reason ?? "requête refusée")
        case 404: return .notFound(reason: reason ?? "inconnu")
        case 409: return .conflict(reason: reason ?? "conflit d'état")
        case 503: return .stopping
        default: return .transport(reason: "statut HTTP \(status)")
        }
    }
}
