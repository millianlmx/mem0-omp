// Le double de transport HTTP des preuves du service (BR-6) : il rend les
// réponses scriptées et les flux de lignes SSE décidés par le test, sans réseau ni
// process. C'est le remplaçant de l'ancien `ScriptedRpcTransport`.

import Foundation
@testable import OMPConsole

/// Une requête enregistrée : ce que le client a réellement envoyé.
struct ScriptedRequest {
    let method: String
    let path: String
    let token: String?
    let body: [String: Any]?
}

/// Le transport scripté, sûr à traverser depuis `nonisolated`.
final class ScriptedServiceTransport: ServiceTransport, @unchecked Sendable {
    private struct Route {
        let method: String
        let suffix: String
        let status: Int
        let json: [String: Any]
    }

    private struct ScriptedStream {
        let lines: [String]
        let keepOpen: Bool
    }

    private let lock = NSLock()
    private var routes: [Route] = []
    private var storedRequests: [ScriptedRequest] = []
    private var streams: [ScriptedStream] = []
    /// Le flux OUVERT courant (`keepOpen: true`) : les lignes poussées par `emit`
    /// y arrivent. La session n'a qu'une connexion à la fois, donc une seule
    /// continuation suffit.
    private var live: AsyncThrowingStream<String, Error>.Continuation?
    private var openCount = 0
    /// Posé : la prochaine ouverture de flux lève cette erreur.
    private var streamFailure: Error?
    /// Posé : la prochaine requête HTTP lève cette erreur (connexion refusée…).
    private var requestFailure: Error?

    // MARK: - Script

    func stubJSON(_ method: String, _ suffix: String, _ json: [String: Any], status: Int = 200) {
        lock.withLock {
            routes.append(Route(method: method.uppercased(), suffix: suffix, status: status, json: json))
        }
    }

    func stubStatus(_ method: String, _ suffix: String, status: Int, json: [String: Any] = [:]) {
        stubJSON(method, suffix, json, status: status)
    }

    /// Programme un flux de lignes SSE ; chaque appel le consomme dans l'ordre.
    /// `keepOpen` laisse le flux ouvert après ses lignes : la session reste vivante
    /// au lieu de repartir en reconnexion (utile pour observer un dialogue).
    func scriptStream(_ lines: [String], keepOpen: Bool = false) {
        lock.withLock { streams.append(ScriptedStream(lines: lines, keepOpen: keepOpen)) }
    }

    func failNextStream(_ error: Error) {
        lock.withLock { streamFailure = error }
    }

    /// `nil` rend le transport à nouveau sain : un service qui revient.
    func failRequests(_ error: Error?) {
        lock.withLock { requestFailure = error }
    }

    // MARK: - Relevé

    var requests: [ScriptedRequest] {
        lock.withLock { storedRequests }
    }

    var streamOpenCount: Int {
        lock.withLock { openCount }
    }

    /// Pousse des lignes dans le flux OUVERT (`scriptStream(..., keepOpen: true)`) :
    /// l'équivalent service du `emit` d'un transport de process — la session n'a
    /// qu'une connexion, et c'est le test qui décide quand la trame arrive.
    func emit(_ lines: [String]) {
        guard let live = lock.withLock({ live }) else { return }
        for line in lines { live.yield(line) }
    }

    // MARK: - ServiceTransport

    func send(_ request: URLRequest) async throws -> ServiceHTTPResponse {
        if let failure = lock.withLock({ requestFailure }) {
            throw failure
        }
        let method = (request.httpMethod ?? "GET").uppercased()
        let path = request.url?.path ?? ""
        let body = request.httpBody.flatMap { data in
            (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        }
        let route: Route? = lock.withLock {
            storedRequests.append(ScriptedRequest(
                method: method,
                path: path,
                token: request.value(forHTTPHeaderField: "X-OMP-Service-Token"),
                body: body
            ))
            return routes.first { $0.method == method && path.hasSuffix($0.suffix) }
        }
        guard let route else {
            return ServiceHTTPResponse(
                status: 404,
                body: Data(#"{"error":"not_found","reason":"route non scriptée"}"#.utf8)
            )
        }
        let payload = try? JSONSerialization.data(withJSONObject: route.json, options: [.sortedKeys])
        return ServiceHTTPResponse(status: route.status, body: payload ?? Data("{}".utf8))
    }

    func lines(_ request: URLRequest) async throws -> AsyncThrowingStream<String, Error> {
        let outcome: Result<ScriptedStream, Error> = lock.withLock {
            openCount += 1
            if let failure = streamFailure {
                streamFailure = nil
                return .failure(failure)
            }
            guard !streams.isEmpty else {
                return .failure(ServiceClientError.unavailable)
            }
            return .success(streams.removeFirst())
        }
        let scripted = try outcome.get()
        return AsyncThrowingStream { continuation in
            for line in scripted.lines { continuation.yield(line) }
            if scripted.keepOpen {
                lock.withLock { live = continuation }
                let hold = Task {
                    try? await Task.sleep(for: .seconds(3_600))
                    continuation.finish()
                }
                continuation.onTermination = { _ in hold.cancel() }
            } else {
                continuation.finish()
            }
        }
    }
}

/// Un client branché sur un transport scripté : l'endpoint est factice, seul le
/// transport compte.
func scriptedClient(
    _ transport: ScriptedServiceTransport,
    token: String = String(repeating: "a", count: 32)
) -> ServiceClient {
    ServiceClient(
        endpoint: ServiceEndpoint(
            baseURL: URL(string: "http://127.0.0.1:8788/v1")!,
            token: token,
            pid: 4_242,
            port: 8788,
            stateDir: "/tmp/omp-state"
        ),
        transport: transport
    )
}

/// Une trame SSE `event: <nom>\ndata: <json>\n\n`.
func serviceFrame(_ event: String, _ json: [String: Any]) -> [String] {
    let data = (try? JSONSerialization.data(withJSONObject: json, options: [.sortedKeys]))
        .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    return ["event: \(event)", "data: \(data)", ""]
}
