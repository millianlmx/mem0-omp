// La porte des lectures du transport de production : au plus N appels confiés à URLSession en même
// temps par hôte, les suivants attendent dans l'app, hors du minuteur de la requête. La session est
// servie par un `URLProtocol` de test qui relève le nombre de requêtes en cours ; la limite de connexions
// d'URLSession est relevée à 32, pour que la borne observée soit celle de la porte.

@testable import ConsoleClient
import Foundation
import Testing

/// Un `URLProtocol` qui compte les chargements en cours et leur maximum, et répond selon le chemin :
/// `/ok` en 200 après 200 ms, `/fail` en 500 tout de suite, `/hold` jamais tant que le test ne le libère pas.
/// Recopié de `StubURLProtocol` (`OMPConsoleTests`) : les cibles de tests sont séparées.
final class GateURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) private static var active = 0
    nonisolated(unsafe) private static var peak = 0
    nonisolated(unsafe) private static var begun: [String] = []
    nonisolated(unsafe) private static var held: [GateURLProtocol] = []
    private static let lock = NSLock()
    /// Cette requête compte encore dans `active` (protégé par `lock`).
    private var counted = true

    static func reset() {
        lock.withLock {
            active = 0
            peak = 0
            begun = []
            held = []
        }
    }

    /// Le plus de requêtes en cours en même temps.
    static var maxActive: Int { lock.withLock { peak } }
    /// Les chemins des requêtes qui ont atteint le protocole, dans l'ordre.
    static var started: [String] { lock.withLock { begun } }

    /// Répond 200 aux requêtes retenues par `/hold`.
    static func releaseHeld() {
        let pending = lock.withLock { () -> [GateURLProtocol] in
            defer { held = [] }
            return held
        }
        for request in pending { request.respond(status: 200) }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path ?? ""
        Self.lock.withLock {
            Self.active += 1
            Self.peak = max(Self.peak, Self.active)
            Self.begun.append(path)
            if path == "/hold" { Self.held.append(self) }
        }
        switch path {
        case "/fail": respond(status: 500)
        case "/hold": break
        default:
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { [self] in respond(status: 200) }
        }
    }

    override func stopLoading() {
        // Une requête annulée ou coupée n'est plus en cours non plus.
        leave()
        Self.lock.withLock { Self.held.removeAll { $0 === self } }
    }

    /// La requête n'est plus « en cours » dès que sa réponse part : URLSession appelle `stopLoading` APRÈS avoir
    /// rendu la réponse à l'appelant, donc après que la porte a laissé passer la suivante. Compter jusqu'à
    /// `stopLoading` ferait lire un pic de 3 là où la porte n'a jamais confié que 2 requêtes.
    private func leave() {
        Self.lock.withLock {
            guard counted else { return }
            counted = false
            Self.active -= 1
        }
    }

    private func respond(status: Int) {
        leave()
        guard let url = request.url,
              let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)
        else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

@Suite("Porte des lectures du transport", .serialized)
struct ReadGateTests {
    private let server = HarnessServer(baseURL: URL(string: "http://gate.test")!, token: "t")

    private func makeTransport(readsInFlight: Int) -> URLSessionHarnessTransport {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [GateURLProtocol.self]
        configuration.httpMaximumConnectionsPerHost = 32
        return URLSessionHarnessTransport(configuration: configuration, readsInFlight: readsInFlight)
    }

    private func get(_ path: String) -> HarnessCall { HarnessCall(method: "GET", path: path) }

    /// Attend que `count` requêtes aient atteint le protocole (au plus 3 s).
    private func waitForStarted(_ count: Int) async {
        for _ in 0..<600 where GateURLProtocol.started.count < count { try? await Task.sleep(for: .milliseconds(5)) }
    }

    @Test("lenteurs-et-timeouts-du-chargement-sur-i/AC-167 : le transport de production confie au plus N lectures à la fois à URLSession, les suivantes attendent hors de son minuteur")
    func gatesReads() async throws {
        GateURLProtocol.reset()
        let transport = makeTransport(readsInFlight: 2)
        let server = server

        // 8 lectures à la fois : jamais plus de 2 en cours, toutes en 200.
        let statuses = try await withThrowingTaskGroup(of: Int.self) { group in
            for index in 0..<8 {
                group.addTask { try await transport.send(HarnessCall(method: "GET", path: "/ok?n=\(index)"), server: server).status }
            }
            var all: [Int] = []
            for try await status in group { all.append(status) }
            return all
        }
        #expect(statuses == Array(repeating: 200, count: 8))
        #expect(GateURLProtocol.maxActive == 2)

        // Une lecture en attente annulée lève CancellationError sans atteindre le protocole, et ne prend aucune place.
        GateURLProtocol.reset()
        let holds = (0..<2).map { _ in Task { try await transport.send(HarnessCall(method: "GET", path: "/hold"), server: server).status } }
        await waitForStarted(2)
        let waiting = Task { try await transport.send(HarnessCall(method: "GET", path: "/ok"), server: server).status }
        try await Task.sleep(for: .milliseconds(50))
        waiting.cancel()
        let outcome = await waiting.result
        #expect(throws: CancellationError.self) { try outcome.get() }
        #expect(GateURLProtocol.started == ["/hold", "/hold"])
        GateURLProtocol.releaseHeld()
        for hold in holds { #expect(try await hold.value == 200) }

        // Les places rendues : un 500 libère la sienne, la lecture suivante passe.
        GateURLProtocol.reset()
        let single = makeTransport(readsInFlight: 1)
        let failed = try await single.send(get("/fail"), server: server)
        #expect(failed.status == 500)
        let after = try await single.send(get("/ok"), server: server)
        #expect(after.status == 200)
    }
}
