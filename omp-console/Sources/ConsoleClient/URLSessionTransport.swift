// Le transport de production : `URLSession`, deux sessions éphémères (Doc-7) —
// inactivité 10 s pour une requête ordinaire, 60 s pour le flux (plus de deux
// battements de 15 s). Aucun cache. Le jeton ne sort jamais autrement que par
// l'en-tête `Authorization`, jamais dans une URL.

import ConsoleCore
import Foundation

/// Le transport HTTP/SSE de production.
public struct URLSessionTransport: ClientTransport {
    private let plainSession: URLSession
    private let streamSession: URLSession

    public init(configuration: URLSessionConfiguration = .ephemeral) {
        let plain = configuration.copy() as! URLSessionConfiguration
        plain.urlCache = nil
        plain.requestCachePolicy = .reloadIgnoringLocalCacheData
        plain.timeoutIntervalForRequest = 10
        plain.timeoutIntervalForResource = 60
        plainSession = URLSession(configuration: plain)

        let streaming = configuration.copy() as! URLSessionConfiguration
        streaming.urlCache = nil
        streaming.requestCachePolicy = .reloadIgnoringLocalCacheData
        streaming.timeoutIntervalForRequest = 60
        streaming.timeoutIntervalForResource = 3600
        streamSession = URLSession(configuration: streaming)
    }

    // MARK: - Requête

    public func send(
        _ request: ClientHTTPRequest,
        to endpoint: ClientEndpoint,
        token: String?
    ) async throws -> ClientHTTPResponse {
        let urlRequest = try makeRequest(request, to: endpoint, token: token)
        do {
            let (data, response) = try await plainSession.data(for: urlRequest)
            guard let http = response as? HTTPURLResponse else {
                throw ClientError.decoding("réponse non HTTP")
            }
            guard data.count <= ClientLimits.responseBody else {
                throw ClientError.decoding("corps de réponse au-delà de la borne")
            }
            return ClientHTTPResponse(
                status: http.statusCode,
                protocolVersion: version(from: http),
                body: data
            )
        } catch let error as ClientError {
            throw error
        } catch {
            throw ClientError.transport(.unreachable(reason(from: error)))
        }
    }

    // MARK: - Flux

    public func stream(
        _ request: ClientHTTPRequest,
        to endpoint: ClientEndpoint,
        token: String?
    ) async throws -> AsyncThrowingStream<Data, Error> {
        let urlRequest = try makeRequest(request, to: endpoint, token: token)
        let bytes: URLSession.AsyncBytes
        let response: URLResponse
        do {
            (bytes, response) = try await streamSession.bytes(for: urlRequest)
        } catch {
            throw ClientError.transport(.unreachable(reason(from: error)))
        }
        guard let http = response as? HTTPURLResponse else {
            throw ClientError.decoding("réponse non HTTP")
        }
        guard http.statusCode == 200 else {
            var body = Data()
            do {
                for try await byte in bytes {
                    body.append(byte)
                    if body.count > ClientLimits.responseBody { break }
                }
            } catch {
                throw ClientError.transport(.closed(reason(from: error)))
            }
            throw ClientErrorMapping.translate(
                status: http.statusCode,
                protocolVersion: version(from: http),
                body: body
            )
        }
        return AsyncThrowingStream { continuation in
            let task = Task {
                var buffer = Data()
                // Coalescence bornée : `AsyncBytes` livre octet par octet, donc on
                // tamponne — mais une trame SSE COMPLÈTE (terminée par une ligne
                // vide `\n\n`) est livrée sans attendre. Sans cette borne, une
                // petite trame (< 256 octets) resterait dans le tampon jusqu'à ce
                // qu'un autre évènement le pousse au-delà du seuil : une escalade
                // de projet, publiée alors que le pilote attend précisément une
                // réponse, n'apparaîtrait qu'au battement de cœur suivant (15 s).
                var previousWasNewline = false
                do {
                    for try await byte in bytes {
                        buffer.append(byte)
                        let frameEnd = byte == 0x0A && previousWasNewline
                        previousWasNewline = byte == 0x0A
                        if frameEnd || buffer.count >= 256 {
                            continuation.yield(buffer)
                            buffer.removeAll(keepingCapacity: true)
                        }
                    }
                    if !buffer.isEmpty { continuation.yield(buffer) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: ClientError.transport(.closed(reason(from: error))))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: - Fabrique

    private func makeRequest(
        _ request: ClientHTTPRequest,
        to endpoint: ClientEndpoint,
        token: String?
    ) throws -> URLRequest {
        guard let url = URL(string: request.path, relativeTo: endpoint.baseURL)?.absoluteURL else {
            throw ClientError.decoding("chemin de requête invalide")
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = request.method
        urlRequest.setValue(String(ConsoleAPI.protocolVersion), forHTTPHeaderField: ConsoleAPI.Service.protocolHeader)
        let isPairing = request.method == "POST" && request.path == ConsoleAPI.Service.basePath + "/pair"
        if let token, !isPairing {
            urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body = request.body {
            urlRequest.httpBody = body
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return urlRequest
    }

    private func version(from response: HTTPURLResponse) -> Int? {
        guard let raw = response.value(forHTTPHeaderField: ConsoleAPI.Service.protocolHeader) else {
            return nil
        }
        return Int(raw.trimmingCharacters(in: .whitespaces))
    }

    private func reason(from error: Error) -> String {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .cannotConnectToHost, .cannotFindHost, .timedOut, .notConnectedToInternet,
                 .networkConnectionLost, .dnsLookupFailed, .secureConnectionFailed:
                return urlError.localizedDescription
            default:
                return urlError.localizedDescription
            }
        }
        return "\(error)"
    }
}
