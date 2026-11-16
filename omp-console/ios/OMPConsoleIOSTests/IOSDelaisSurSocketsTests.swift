// Les preuves SUR SOCKETS des délais dépassés (lenteurs-et-timeouts-du-chargement-sur-i, AC-10 et AC-11) :
// le transport de PRODUCTION (`URLSessionHarnessTransport`, `URLSessionMemoryTransport`, leur configuration
// d'origine) face à un serveur HTTP local qui ouvre de vraies connexions. Une doublure de transport ne peut
// jamais produire `timedOut` : seule `URLError.timedOut`, levée par URLSession, le fait naître. Ces tests
// tournent sur le simulateur iOS, donc avec la limite de connexions par hôte d'iOS.
//
// Ce fichier est le SEUL de `ios/` à nommer URLSession et une adresse http : la garde
// `coque-ios.test.ts` (AC-8) l'exempte, nommément, de ces jetons-là et d'eux seuls.

import ConsoleClient
import Foundation
import Testing

/// Un mini-serveur HTTP sur `127.0.0.1`, port éphémère, une connexion par fil : chaque lecture est servie
/// après `delay`, ou jamais (`mute`) ; un flux `/v1/events` s'ouvre tout de suite et reste ouvert.
private final class LocalDelayServer: @unchecked Sendable {
    enum Mode {
        case delay(TimeInterval)
        case mute
    }

    let port: Int
    private let descriptor: Int32
    private let mode: Mode
    private let lock = NSLock()
    private var stopped = false
    private var served = 0

    init?(mode: Mode) {
        self.mode = mode
        let socketDescriptor = socket(AF_INET, SOCK_STREAM, 0)
        guard socketDescriptor >= 0 else { return nil }
        var reuse: Int32 = 1
        setsockopt(socketDescriptor, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr = in_addr(s_addr: INADDR_LOOPBACK.bigEndian)
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(socketDescriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0, listen(socketDescriptor, 128) == 0 else {
            close(socketDescriptor)
            return nil
        }

        var local = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &local) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(socketDescriptor, $0, &length)
            }
        }
        guard named == 0 else {
            close(socketDescriptor)
            return nil
        }
        descriptor = socketDescriptor
        port = Int(UInt16(bigEndian: local.sin_port))
    }

    /// Les lectures servies jusqu'au bout (hors flux).
    var answered: Int { lock.withLock { served } }

    private var isStopped: Bool { lock.withLock { stopped } }

    func start() {
        let thread = Thread { [self] in acceptLoop() }
        thread.name = "local-delay-server"
        thread.start()
    }

    func stop() {
        lock.withLock { stopped = true }
        shutdown(descriptor, SHUT_RDWR)
        close(descriptor)
    }

    private func acceptLoop() {
        while true {
            let client = accept(descriptor, nil, nil)
            if client < 0 { return }
            DispatchQueue.global().async { [self] in serve(client) }
        }
    }

    private func serve(_ client: Int32) {
        var quiet: Int32 = 1
        setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &quiet, socklen_t(MemoryLayout<Int32>.size))
        var request = Data()
        var buffer = [UInt8](repeating: 0, count: 2048)
        let end = Data("\r\n\r\n".utf8)
        while request.range(of: end) == nil {
            let count = Darwin.read(client, &buffer, buffer.count)
            if count <= 0 {
                close(client)
                return
            }
            request.append(contentsOf: buffer[0 ..< count])
        }
        let line = String(decoding: request.prefix(while: { $0 != 0x0D }), as: UTF8.self)
        let path = line.split(separator: " ").dropFirst().first.map(String.init) ?? ""

        if path.hasPrefix("/v1/events") {
            write(client, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n\r\n: ouvert\n\n")
            holdOpen(client)
            return
        }
        switch mode {
        case .mute:
            holdOpen(client)
        case .delay(let seconds):
            Thread.sleep(forTimeInterval: seconds)
            let body = path.hasPrefix("/memory/all") ? #"{"total":0,"results":[]}"# : "{}"
            write(
                client,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n" + body
            )
            lock.withLock { served += 1 }
            close(client)
        }
    }

    /// La connexion reste ouverte, sans un octet de plus, jusqu'à l'arrêt du serveur.
    private func holdOpen(_ client: Int32) {
        while !isStopped { Thread.sleep(forTimeInterval: 0.1) }
        close(client)
    }

    private func write(_ client: Int32, _ text: String) {
        let bytes = Array(text.utf8)
        var written = 0
        while written < bytes.count {
            let count = bytes[written...].withUnsafeBytes { Darwin.write(client, $0.baseAddress, $0.count) }
            if count <= 0 { return }
            written += count
        }
    }
}

/// Le transport de production, qui compte ses envois et les `timedOut` qu'il lève.
private final class RecordingTransport: HarnessTransport, @unchecked Sendable {
    private let inner = URLSessionHarnessTransport()
    private let lock = NSLock()
    private var sentCount = 0
    private var timeoutCount = 0

    var sent: Int { lock.withLock { sentCount } }
    var timedOut: Int { lock.withLock { timeoutCount } }

    func send(_ call: HarnessCall, server: HarnessServer) async throws -> HarnessReply {
        lock.withLock { sentCount += 1 }
        do {
            return try await inner.send(call, server: server)
        } catch let failure as HarnessFailure {
            if failure == .timedOut { lock.withLock { timeoutCount += 1 } }
            throw failure
        }
    }

    func events(_ call: HarnessCall, server: HarnessServer) async throws -> AsyncThrowingStream<Data, Error> {
        try await inner.events(call, server: server)
    }
}

@MainActor
@Suite("Délais dépassés sur vraies sockets", .serialized)
struct IOSDelaisSurSocketsTests {
    @Test(
        "lenteurs-et-timeouts-du-chargement-sur-i/AC-10 : le chargement initial et une lecture de la Mémoire, lancés ensemble sur le transport de production face à un serveur qui sert en 3 s, flux ouverts, ne finissent jamais en délai dépassé",
        .timeLimit(.minutes(2))
    )
    func initialLoadAndMemoryNeverTimeOut() async throws {
        let server = try #require(LocalDelayServer(mode: .delay(3)))
        server.start()
        defer { server.stop() }
        let address = "http://127.0.0.1:\(server.port)"
        let transport = RecordingTransport()
        let model = HarnessModel(
            transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(),
            fallback: { (address, "t") }, reporter: .off
        )
        let reader = MemoryReader(
            server: MemoryServer(baseURL: try #require(URL(string: address)), token: "t"), transport: URLSessionMemoryTransport()
        )

        let memoryRead = Task { () -> MemoryReadError? in
            do {
                _ = try await reader.page(scope: "produit", offset: 0)
                return nil
            } catch let error as MemoryReadError {
                return error
            } catch {
                return .failed
            }
        }
        async let inbox: Void = model.load()
        while !model.isConfigured { await Task.yield() }
        model.startLive()
        await model.readShell(.opening)
        await inbox
        let memoryFailure = await memoryRead.value
        model.suspendStreams()

        #expect(transport.timedOut == 0)
        #expect(memoryFailure != .timedOut)
        // Le chargement a bien eu lieu : les lectures sont parties et le serveur les a servies.
        #expect(transport.sent > 10)
        #expect(server.answered > 10)
    }

    @Test(
        "lenteurs-et-timeouts-du-chargement-sur-i/AC-11 : face à un serveur qui accepte la connexion sans jamais répondre, la lecture échoue en délai dépassé au délai de production, ni avant ni en injoignable",
        .timeLimit(.minutes(2))
    )
    func silentServerFailsAsTimedOutAtTheProductionDelay() async throws {
        let server = try #require(LocalDelayServer(mode: .mute))
        server.start()
        defer { server.stop() }
        let target = HarnessServer(baseURL: try #require(URL(string: "http://127.0.0.1:\(server.port)")), token: "t")
        let clock = ContinuousClock()
        let started = clock.now

        var failure: HarnessFailure?
        do {
            _ = try await URLSessionHarnessTransport().send(HarnessCall(method: "GET", path: "/v1/inbox"), server: target)
        } catch let error as HarnessFailure {
            failure = error
        }
        let elapsed = clock.now - started

        #expect(failure == .timedOut)
        // Le délai de la requête : 15 s (`timeoutIntervalForRequest`), jamais une coupure plus tôt.
        #expect(elapsed >= .seconds(14))
        #expect(elapsed < .seconds(30))
    }
}
