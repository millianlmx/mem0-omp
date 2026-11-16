// La porte des appels du transport de production : au plus `limit` appels confiés à URLSession en
// même temps par hôte. Les suivants attendent ICI, dans l'ordre d'arrivée, sans tâche URLSession :
// le délai `timeoutIntervalForRequest` ne court pas pendant qu'ils attendent une connexion (un
// rapport de terrain décrit un délai qui part à la reprise de la tâche, avant l'envoi de la requête).

import Foundation

actor HarnessReadGate {
    private struct Waiter {
        let id: UUID
        let continuation: CheckedContinuation<Void, Error>
    }

    private let limit: Int
    private var running: [String: Int] = [:]
    private var waiting: [String: [Waiter]] = [:]

    init(limit: Int) {
        self.limit = limit
    }

    /// L'hôte qui partage une limite de connexions : schéma, hôte et port.
    nonisolated static func host(of url: URL) -> String {
        "\(url.scheme ?? "")://\(url.host ?? ""):\(url.port.map(String.init) ?? "")"
    }

    /// Prend une place pour `host`, ou attend la sienne. Un appelant annulé en attente lève
    /// `CancellationError` et ne prend aucune place.
    func enter(_ host: String) async throws {
        try Task.checkCancellation()
        if (running[host] ?? 0) < limit, waiting[host]?.isEmpty ?? true {
            running[host, default: 0] += 1
            return
        }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                // Ce corps s'exécute sur l'acteur : annulé avant l'inscription, il le voit ici ;
                // annulé après, `cancel` retrouve l'inscription.
                if Task.isCancelled {
                    continuation.resume(throwing: CancellationError())
                } else {
                    waiting[host, default: []].append(Waiter(id: id, continuation: continuation))
                }
            }
        } onCancel: {
            Task { await self.cancel(id, host: host) }
        }
    }

    /// Rend la place : au suivant de la file s'il y en a un (la place lui passe, le compte ne bouge pas).
    func leave(_ host: String) {
        if var queue = waiting[host], !queue.isEmpty {
            let next = queue.removeFirst()
            waiting[host] = queue.isEmpty ? nil : queue
            next.continuation.resume()
        } else {
            running[host] = max(0, (running[host] ?? 1) - 1)
        }
    }

    private func cancel(_ id: UUID, host: String) {
        guard var queue = waiting[host], let index = queue.firstIndex(where: { $0.id == id }) else { return }
        let waiter = queue.remove(at: index)
        waiting[host] = queue.isEmpty ? nil : queue
        waiter.continuation.resume(throwing: CancellationError())
    }
}
