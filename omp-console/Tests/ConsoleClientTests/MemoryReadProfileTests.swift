// Les lectures Mémoire du client (memoire-ios-expire-a-10-secondes, S-2, S-3) :
// page de liste et graphe partent au profil `.memory` (délais 60 s / 180 s), la
// recherche et le reste au profil `.standard` (10 s / 60 s) ; un délai expiré
// est un échec de transport distinct d'un Mac injoignable. Hermétique : la
// couche réseau réelle (`URLSessionTransport`) ne parle qu'à `TimeoutURLProtocol`.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@MainActor
private let mac = DiscoveredMac(
    name: "OMP Console",
    endpoint: .bonjour(name: "OMP Console", host: "192.168.1.12", port: 8787)
)

@MainActor
private let macEndpoint = ClientEndpoint.bonjour(name: "OMP Console", host: "192.168.1.12", port: 8787)

/// Un `URLProtocol` de test qui échoue toujours, sans socket. L'erreur rendue
/// dépend du SEUL chemin de la requête : aucun état partagé entre tests
/// parallèles.
final class TimeoutURLProtocol: URLProtocol, @unchecked Sendable {
    static let timedOutPath = "/delai-depasse"
    static let refusedPath = "/connexion-refusee"

    /// Une session de transport qui ne passe que par ce protocole.
    static func transport() -> URLSessionTransport {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TimeoutURLProtocol.self]
        return URLSessionTransport(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let code: URLError.Code = request.url?.path == Self.timedOutPath ? .timedOut : .cannotConnectToHost
        client?.urlProtocol(self, didFailWithError: URLError(code))
    }

    override func stopLoading() {}
}

@Suite("memoire-ios-expire-a-10-secondes — profil mémoire et délai dépassé")
@MainActor
struct MemoryReadProfileTests {
    private let endpoint = ClientEndpoint.manual(host: "127.0.0.1", port: 8787)

    private func connectedHarness() async -> ClientHarness {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"]
        )
        harness.transport.script(.hold)
        harness.model.start()
        #expect(await eventually { harness.model.state == .searching })
        harness.discovery.emit([mac])
        #expect(await eventually { harness.model.state == .connected(endpoint: macEndpoint) })
        return harness
    }

    private func transportFailure(_ body: () async throws -> Void) async -> ClientTransportFailure? {
        do {
            try await body()
        } catch ClientError.transport(let failure) {
            return failure
        } catch {
            Issue.record("échec de transport attendu, reçu \(error)")
            return nil
        }
        Issue.record("la requête devait échouer")
        return nil
    }

    @Test("memoire-ios-expire-a-10-secondes/AC-1, AC-3, AC-4 : memoryReadsUseTheMemoryProfile — page et graphe partent au profil mémoire, la recherche au profil standard")
    func memoryReadsUseTheMemoryProfile() async {
        let harness = await connectedHarness()
        harness.transport.respond { _ in .failure(ClientError.transport(.unreachable("route non scriptée"))) }

        _ = try? await harness.model.memoryPage(scope: "mem0-omp", offset: 100, limit: nil)
        _ = try? await harness.model.memoryGraph(scope: "mem0-omp")
        _ = try? await harness.model.memorySearch(query: "delai", scope: "mem0-omp", limit: nil)

        let sent = harness.transport.requests.filter { $0.path.hasPrefix("/v1/memory") }
        // Clé : le chemin SANS sa chaîne de requête (le format de la requête est
        // prouvé par les tests de route, pas ici).
        let profiles = Dictionary(
            sent.map { (String($0.path.prefix { $0 != "?" }), $0.profile) },
            uniquingKeysWith: { first, _ in first }
        )
        #expect(profiles["/v1/memory/page"] == .memory, "\(sent.map(\.path))")
        #expect(profiles["/v1/memory/graph"] == .memory)
        #expect(profiles["/v1/memory/search"] == .standard)
        #expect(sent.count == 3, "une requête par lecture, aucune autre : \(sent.map(\.path))")
        #expect(
            harness.transport.requests.filter { !$0.path.hasPrefix("/v1/memory") }.allSatisfy { $0.profile == .standard },
            "toute autre requête reste au profil standard"
        )
        harness.stop()
    }

    @Test("memoire-ios-expire-a-10-secondes/AC-4 : profilesConfigureTheirSessions — 10 s / 60 s au profil standard, 60 s / 180 s au profil mémoire, sans cache")
    func profilesConfigureTheirSessions() {
        let base = URLSessionConfiguration.ephemeral
        base.protocolClasses = [TimeoutURLProtocol.self]

        let standard = URLSessionTransport.configuration(base, profile: .standard)
        #expect(standard.timeoutIntervalForRequest == 10)
        #expect(standard.timeoutIntervalForResource == 60)

        let memory = URLSessionTransport.configuration(base, profile: .memory)
        #expect(memory.timeoutIntervalForRequest == 60)
        #expect(memory.timeoutIntervalForResource == 180)
        #expect(memory.timeoutIntervalForRequest == ClientLimits.memoryRequestTimeout)
        #expect(memory.timeoutIntervalForResource == ClientLimits.memoryResourceTimeout)

        for configured in [standard, memory] {
            #expect(configured !== base, "la base est copiée, jamais modifiée")
            #expect(configured.urlCache == nil)
            #expect(configured.requestCachePolicy == .reloadIgnoringLocalCacheData)
            #expect(
                configured.protocolClasses?.first.map(ObjectIdentifier.init) == ObjectIdentifier(TimeoutURLProtocol.self),
                "la copie garde la base"
            )
        }
        #expect(base.urlCache != nil || base.requestCachePolicy != .reloadIgnoringLocalCacheData, "la base n'est pas modifiée")
    }

    @Test("memoire-ios-expire-a-10-secondes/AC-5, AC-7 : timedOutIsItsOwnTransportFailure — URLError.timedOut rend .transport(.timedOut), au texte inchangé, sur les deux profils et à l'ouverture d'un flux")
    func timedOutIsItsOwnTransportFailure() async {
        let transport = TimeoutURLProtocol.transport()
        let expected = ClientTransportFailure.timedOut(URLError(.timedOut).localizedDescription)

        for profile in [ClientRequestProfile.memory, .standard] {
            let failure = await transportFailure {
                _ = try await transport.send(
                    ClientHTTPRequest(method: "GET", path: TimeoutURLProtocol.timedOutPath, profile: profile),
                    to: endpoint,
                    token: "tok"
                )
            }
            #expect(failure == expected, "profil \(profile)")
            #expect(failure?.reason == ClientTransportFailure.unreachable(URLError(.timedOut).localizedDescription).reason)
        }

        let opening = await transportFailure {
            _ = try await transport.stream(
                ClientHTTPRequest(method: "GET", path: TimeoutURLProtocol.timedOutPath, isStream: true),
                to: endpoint,
                token: "tok"
            )
        }
        #expect(opening == expected)
    }

    @Test("memoire-ios-expire-a-10-secondes/AC-6 : refusedConnectionStaysUnreachable — une connexion refusée reste .transport(.unreachable), jamais un délai dépassé")
    func refusedConnectionStaysUnreachable() async {
        let transport = TimeoutURLProtocol.transport()
        let expected = ClientTransportFailure.unreachable(URLError(.cannotConnectToHost).localizedDescription)

        let memoryRead = await transportFailure {
            _ = try await transport.send(
                ClientHTTPRequest(method: "GET", path: TimeoutURLProtocol.refusedPath, profile: .memory),
                to: endpoint,
                token: "tok"
            )
        }
        #expect(memoryRead == expected)

        let opening = await transportFailure {
            _ = try await transport.stream(
                ClientHTTPRequest(method: "GET", path: TimeoutURLProtocol.refusedPath, isStream: true),
                to: endpoint,
                token: "tok"
            )
        }
        #expect(opening == expected)
    }
}
