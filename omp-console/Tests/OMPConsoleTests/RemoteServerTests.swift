// Le serveur Network.framework (BR-3, S-1) : un VRAI listener sur un port
// éphémère, une vraie requête loopback lue sur la socket, la garde d'acceptation
// prouvée sur une connexion synthétique, l'échec d'un port occupé et l'arrêt.

import ConsoleCore
import Darwin
import Foundation
import Network
import Testing
@testable import OMPConsole

/// Une sonde de client : une connexion TCP réelle dont le test lit les octets.
@MainActor
private final class LoopbackProbe {
    private let connection: NWConnection
    private var buffer = Data()
    private(set) var finished = false

    var text: String { String(decoding: buffer, as: UTF8.self) }

    init(host: String, port: UInt16) {
        connection = NWConnection(
            host: NWEndpoint.Host(host),
            port: NWEndpoint.Port(rawValue: port)!,
            using: .tcp
        )
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            MainActor.assumeIsolated {
                if case .failed = state { self?.finished = true }
                if case .cancelled = state { self?.finished = true }
            }
        }
        connection.start(queue: .main)
        receive()
    }

    func send(_ text: String) {
        connection.send(content: Data(text.utf8), completion: .contentProcessed { _ in })
    }

    func cancel() { connection.cancel() }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
            MainActor.assumeIsolated {
                guard let self else { return }
                if let data, !data.isEmpty { self.buffer.append(data) }
                if error != nil || isComplete { self.finished = true; return }
                self.receive()
            }
        }
    }
}

/// Tente une connexion TCP nue vers 127.0.0.1:port : rend 0 si elle est acceptée,
/// sinon `errno` (`ECONNREFUSED` quand plus personne n'écoute).
private func connectVerdict(port: UInt16) -> Int32 {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return -1 }
    defer { close(fd) }
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = port.bigEndian
    address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
    let outcome = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    return outcome == 0 ? 0 : errno
}

private func jsonResponse(_ payload: String) -> RemoteServer.Handler {
    { _, _ in .respond(HTTPResponse.json(code: 200, payload: Data(payload.utf8))) }
}

@Test("serveur distant : une requête loopback reçoit la réponse complète sur la socket, puis la fermeture")
@MainActor
func loopbackRequestIsAnsweredOnTheSocket() async throws {
    let handled = Recorder<HTTPRequest>()
    let server = RemoteServer(handler: { request, _ in
        handled.append(request)
        return .respond(HTTPResponse.json(code: 200, payload: Data(#"{"ok":true}"#.utf8)))
    })
    try await server.start(port: 0)
    let port = try #require(server.port)
    #expect(server.state.isRunning)
    #expect(server.address?.hasSuffix(":\(port)") == true)

    let probe = LoopbackProbe(host: "127.0.0.1", port: port)
    probe.start()
    probe.send("GET /v1/version HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
    defer {
        probe.cancel()
        server.stop()
    }

    // La réponse est lue OCTET PAR OCTET sur la socket : on attend la fermeture
    // (`Connection: close`) pour tenir la trame complète, puis on l'examine.
    #expect(await awaitMainTrue(timeout: 5.0) { probe.finished })
    #expect(probe.text.hasPrefix("HTTP/1.1 200 OK\r\n"))
    #expect(probe.text.contains("X-Console-Protocol-Version: 1\r\n"))
    #expect(probe.text.contains("Content-Length: 11\r\n"))
    #expect(probe.text.contains("Connection: close\r\n"))
    #expect(probe.text.hasSuffix(#"{"ok":true}"#))
    #expect(handled.values.map(\.path) == ["/v1/version"])
}

@Test("serveur distant : une source non locale est coupée sans jamais recevoir de réponse")
@MainActor
func nonLocalSourceIsCancelledWithoutAnswer() async throws {
    let handled = Recorder<HTTPRequest>()
    let server = RemoteServer(handler: { request, _ in
        handled.append(request)
        return .respond(HTTPResponse.json(code: 200, payload: Data("{}".utf8)))
    })

    // Le synthon porte l'endpoint d'une source PUBLIQUE : la garde doit le couper.
    let cancelled = Recorder<String>()
    let synthon = NWConnection(host: NWEndpoint.Host("8.8.8.8"), port: 9999, using: .tcp)
    synthon.stateUpdateHandler = { state in
        if case .cancelled = state { cancelled.append("cancelled") }
    }
    synthon.start(queue: DispatchQueue(label: "remote-server-synthon"))
    defer { synthon.cancel() }

    server.acceptConnection(synthon)
    #expect(await awaitTrue(timeout: 5.0) { cancelled.count == 1 })

    // Le serveur n'a rien lu, rien répondu : le handler n'est jamais appelé.
    try? await Task.sleep(for: .milliseconds(200))
    #expect(handled.values.isEmpty)
}

@Test("serveur distant : un second listener sur un port occupé échoue en nommant le port")
@MainActor
func busyPortFailsAndNamesThePort() async throws {
    let first = RemoteServer(handler: jsonResponse("{}"))
    try await first.start(port: 0)
    let port = try #require(first.port)
    defer { first.stop() }

    let second = RemoteServer(handler: jsonResponse("{}"))
    var reason: String?
    do {
        try await second.start(port: Int(port))
        Issue.record("un second listener ne doit pas démarrer sur un port occupé")
    } catch let failure as RemoteServiceFailure {
        reason = failure.reason
    } catch {
        reason = String(describing: error)
    }
    let message = try #require(reason)
    #expect(message.contains("\(port)"))
    #expect(second.state == .failed(reason: message))
    second.stop()
}

@Test("serveur distant : stop() repasse à off et le port cesse de répondre")
@MainActor
func stopTurnsOffAndReleasesThePort() async throws {
    let server = RemoteServer(handler: jsonResponse("{}"))
    try await server.start(port: 0)
    let port = try #require(server.port)
    #expect(server.state.isRunning)
    // Le port répond avant l'arrêt.
    #expect(connectVerdict(port: port) == 0)

    server.stop()
    #expect(server.state == .off)
    #expect(server.address == nil)
    #expect(server.port == nil)
    // Plus personne n'écoute : la connexion est refusée.
    #expect(await awaitTrue(timeout: 5.0) { connectVerdict(port: port) == ECONNREFUSED })
}
