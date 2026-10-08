// Le flux d'évènements d'une session (S-6, Doc-4 §1) : le client SSE de l'app.
//
// `URLSession.bytes(for:).lines` rend les lignes du flux ; deux lignes `event:` /
// `data:` terminées par une ligne vide forment une trame, et une ligne `:` est un
// battement ignoré (S-2). La connexion fermée par le client ne ferme jamais la
// session ; une connexion perdue est retentée avec un repli borné, et un service
// définitivement absent rend l'erreur typée « service arrêté ».

import Foundation

/// Le lecteur SSE d'une session. La reconnexion vit ici : le consommateur reçoit
/// des trames sans connaître les coupures.
struct ServiceEvents: Sendable {
    let client: ServiceClient
    /// Le délai avant la nième réouverture (repli borné, S-2).
    let retryDelay: @Sendable (Int) -> Duration
    /// Au-delà, le flux rend `ServiceClientError.unavailable` : le service est
    /// considéré arrêté.
    let maxAttempts: Int

    init(
        client: ServiceClient,
        maxAttempts: Int = 5,
        retryDelay: @escaping @Sendable (Int) -> Duration = { attempt in
            .milliseconds(min(2_000, 250 * attempt))
        }
    ) {
        self.client = client
        self.maxAttempts = maxAttempts
        self.retryDelay = retryDelay
    }

    /// Le flux de trames d'une session. Se termine en levant `unavailable` quand
    /// le service ne répond plus, ou proprement à l'annulation.
    func stream(sessionID: String) -> AsyncThrowingStream<ServiceFrame, Error> {
        let client = client
        let retryDelay = retryDelay
        let maxAttempts = maxAttempts
        return AsyncThrowingStream { continuation in
            let task = Task {
                var attempt = 0
                while !Task.isCancelled {
                    do {
                        let lines = try await client.transport.lines(client.eventsRequest(id: sessionID))
                        attempt = 0
                        for try await frame in ServiceEvents.frames(from: lines) {
                            if Task.isCancelled { break }
                            continuation.yield(frame)
                        }
                    } catch is CancellationError {
                        break
                    } catch let error as ServiceClientError {
                        switch error {
                        case .unavailable, .unauthorized, .notFound, .malformed:
                            continuation.finish(throwing: error)
                            return
                        default:
                            break
                        }
                    } catch {
                        // Une coupure de transport est retentée comme une fin.
                    }
                    if Task.isCancelled { break }
                    attempt += 1
                    if attempt >= maxAttempts {
                        continuation.finish(throwing: ServiceClientError.unavailable)
                        return
                    }
                    try? await Task.sleep(for: retryDelay(attempt))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Traduit les lignes SSE en trames (S-2). Les battements `: ping` et les
    /// évènements inconnus sont ignorés.
    static func frames(from lines: AsyncThrowingStream<String, Error>) -> AsyncThrowingStream<ServiceFrame, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var event: String?
                var data: [String] = []
                do {
                    for try await line in lines {
                        if line.hasPrefix(":") { continue }
                        if line.isEmpty {
                            if let event, let decoded = ServiceFrame.decode(event: event, data: data.joined(separator: "\n")) {
                                continuation.yield(decoded)
                            }
                            event = nil
                            data = []
                            continue
                        }
                        if line.hasPrefix("event:") {
                            event = String(line.dropFirst("event:".count)).trimmingCharacters(in: .whitespaces)
                        } else if line.hasPrefix("data:") {
                            data.append(String(line.dropFirst("data:".count)).trimmingCharacters(in: .whitespaces))
                        }
                    }
                    // Un flux clos sans ligne vide finale ne perd pas sa dernière trame.
                    if let event, let decoded = ServiceFrame.decode(event: event, data: data.joined(separator: "\n")) {
                        continuation.yield(decoded)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
