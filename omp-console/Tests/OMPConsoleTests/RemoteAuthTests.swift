// Preuves de S-3 : la garde d'authentification — aucune donnée, aucun geste,
// sans jeton valide. Tout passe par la pile réelle du harnais.

import ConsoleCore
import Foundation
import Network
import Testing

@testable import OMPConsole

@Suite("Remote authentification")
@MainActor
struct RemoteAuthTests {
    @Test("api-distante-du-console/AC-16 : un jeton absent, inconnu ou révoqué est refusé sans servir de données")
    func absentUnknownOrRevokedTokenIsRefusedWithoutData() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }

        // Le corps EXACT du refus : le code stable, pas de message, AUCUNE donnée.
        let envelope = #"{"error":{"code":"unauthorized"}}"#

        // (1) Jeton absent.
        let absent = try await stack.call("GET", "/v1/store")
        #expect(absent.status == 401)
        #expect(absent.text == envelope)
        #expect(absent.errorMessage == nil)
        #expect(!absent.text.contains("snapshot"))

        // (2) Jeton inconnu.
        let unknown = try await stack.call("GET", "/v1/store", token: "jeton-inconnu-du-registre")
        #expect(unknown.status == 401)
        #expect(unknown.text == envelope)

        // (3) Jeton révoqué : le registre EN MÉMOIRE suffit, rien n'est redémarré.
        let token = try await stack.pair(name: "Téléphone")
        let deviceId = try #require(stack.registry.devices.first?.id)
        await stack.registry.revoke(id: deviceId)
        let revoked = try await stack.call("GET", "/v1/store", token: token)
        #expect(revoked.status == 401)
        #expect(revoked.text == envelope)
    }

    @Test("api-distante-du-console/AC-17 : toute route hors appairage exige un jeton")
    func everyNonPairingRouteRequiresAToken() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }

        // Une route servie sans jeton : refusée.
        let read = try await stack.call("GET", "/v1/devices")
        #expect(read.status == 401)
        #expect(read.errorCode == "unauthorized")

        // Une route INEXISTANTE sans jeton : refusée AUSSI — jamais 404.
        let unknown = try await stack.call("GET", "/v1/route-qui-n-existe-pas")
        #expect(unknown.status == 401)
        #expect(unknown.status != 404)
    }

    // MARK: - Cas limites de la garde

    @Test func duplicateAuthorizationHeaderIsRejected() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        _ = try await stack.pair(name: "Téléphone")

        // `URLRequest` ne sait pas écrire deux fois le même en-tête : on parle brut.
        let request = """
            GET /v1/devices HTTP/1.1\r
            Host: 127.0.0.1\r
            X-Console-Protocol-Version: 1\r
            Authorization: Bearer premier\r
            Authorization: Bearer second\r
            \r

            """
        let response = try await rawConsoleExchange(port: stack.port, request)
        #expect(rawConsoleStatus(response) == 400)
        #expect(response.contains("\"bad_request\""))
        #expect(!response.contains("devices\":["))
    }

    @Test func veryLongTokenIsRefusedWithoutPanic() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }

        let long = String(repeating: "a", count: 600)
        let reply = try await stack.call("GET", "/v1/devices", token: long)
        #expect(reply.status == 401)
        #expect(reply.errorCode == "unauthorized")
    }

    @Test func twoAuthorizationValuesAreRefused() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let token = try await stack.pair(name: "Téléphone")

        // Deux valeurs sur UNE ligne : le jeton n'est plus celui du registre.
        let reply = try await stack.call("GET", "/v1/devices", headers: ["Authorization": "Bearer \(token), Bearer autre"])
        #expect(reply.status == 401)
    }

    @Test func revokedDeviceIsRefusedOnTheNextRequestWithoutRestart() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let token = try await stack.pair(name: "Téléphone")
        let deviceId = try #require(stack.registry.devices.first?.id)

        let before = try await stack.call("GET", "/v1/devices", token: token)
        #expect(before.status == 200)

        await stack.registry.revoke(id: deviceId)

        let after = try await stack.call("GET", "/v1/devices", token: token)
        #expect(after.status == 401)
        #expect(stack.registry.devices.isEmpty)
    }
}

// MARK: - Requête HTTP BRUTE

/// Le harnais `RemoteStack.call` s'appuie sur `URLRequest`, qui refuse de porter
/// deux fois le même en-tête. Or le contrat teste ce cas : on écrit donc les
/// octets EXACTS sur une connexion `NWConnection` et on lit la réponse brute.
func rawConsoleExchange(port: UInt16, _ request: String, timeout: Double = 5) async throws -> String {
    let data = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
        let exchange = RawConsoleExchange(
            port: port,
            request: Data(request.utf8),
            timeout: timeout,
            continuation: continuation
        )
        exchange.start()
    }
    return String(decoding: data, as: UTF8.self)
}

/// Le code de la ligne de statut (`HTTP/1.1 400 Bad Request` → `400`).
func rawConsoleStatus(_ response: String) -> Int? {
    guard let line = response.split(separator: "\r\n", maxSplits: 1, omittingEmptySubsequences: true).first else {
        return nil
    }
    let parts = line.split(separator: " ")
    guard parts.count >= 2 else { return nil }
    return Int(parts[1])
}

/// L'échec d'une requête brute qui n'a jamais vu sa fin.
struct RawConsoleTimeout: Error {}

/// L'échange brut : un seul envoi, lecture jusqu'à la fermeture du serveur (le
/// contrat répond toujours avec `Connection: close`).
private final class RawConsoleExchange: @unchecked Sendable {
    private let lock = NSLock()
    private var buffer = Data()
    private var finished = false
    private let connection: NWConnection
    private let continuation: CheckedContinuation<Data, Error>

    init(port: UInt16, request: Data, timeout: Double, continuation: CheckedContinuation<Data, Error>) {
        self.continuation = continuation
        self.connection = NWConnection(
            host: "127.0.0.1",
            port: NWEndpoint.Port(rawValue: port) ?? .any,
            using: .tcp
        )
        connection.stateUpdateHandler = { [self] state in
            switch state {
            case .ready:
                connection.send(content: request, completion: .contentProcessed { [self] error in
                    if let error { finish(.failure(error)) }
                })
                receive()
            case .failed(let error):
                finish(.failure(error))
            case .cancelled:
                finish(.success(Data()))
            default:
                break
            }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [self] in
            finish(.failure(RawConsoleTimeout()))
        }
    }

    func start() {
        connection.start(queue: .global())
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [self] data, _, isComplete, error in
            if let data, !data.isEmpty {
                lock.lock()
                buffer.append(data)
                lock.unlock()
            }
            if error != nil || isComplete {
                finish(.success(snapshot()))
            } else {
                receive()
            }
        }
    }

    private func snapshot() -> Data {
        lock.lock()
        defer { lock.unlock() }
        return buffer
    }

    private func finish(_ result: Result<Data, Error>) {
        lock.lock()
        if finished {
            lock.unlock()
            return
        }
        finished = true
        let payload = buffer
        lock.unlock()
        connection.cancel()
        switch result {
        case .success:
            continuation.resume(returning: payload)
        case .failure(let error):
            continuation.resume(throwing: error)
        }
    }
}
