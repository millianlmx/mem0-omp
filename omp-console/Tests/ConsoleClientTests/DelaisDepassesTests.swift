// Ce que l'app dit quand URLSession lève `URLError(.timedOut)` : l'écran annonce « délai dépassé »
// (le texte existant), garde les données déjà lues et se relit au geste suivant ; une annulation, elle,
// n'est jamais annoncée. La doublure est celle d'URLSession (un `URLProtocol`), pas celle du transport :
// seule la correspondance d'erreurs du transport de production (`HarnessFailure.timedOut`) peut produire
// un délai dépassé, une doublure de `HarnessTransport` ne le peut pas.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

/// Un `URLProtocol` qui rend la boîte, ou lève ce que URLSession lèverait : `fail(with:)` pose le code.
final class ExpiryURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) private static var code: URLError.Code?
    private static let lock = NSLock()

    /// `nil` : la boîte est servie ; sinon la requête échoue avec ce code, comme sous URLSession.
    static func fail(with code: URLError.Code?) { lock.withLock { Self.code = code } }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        if let code = Self.lock.withLock({ Self.code }) {
            client?.urlProtocol(self, didFailWithError: URLError(code))
            return
        }
        guard let url = request.url,
              let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)
        else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(osInboxJSON.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor
@Suite("Délais dépassés : annoncés, jamais une annulation", .serialized)
struct DelaisDepassesTests {
    /// Un modèle relié, sur le transport de production servi par `ExpiryURLProtocol`.
    private func makeModel() -> HarnessModel {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ExpiryURLProtocol.self]
        return HarnessModel(
            transport: URLSessionHarnessTransport(configuration: configuration),
            preferences: InMemoryClientPreferences([HarnessModel.addressKey: "https://vps.example"]),
            tokens: InMemoryTokenStore([HarnessModel.tokenAccount: "t"]),
            retryDelay: .seconds(3600), refreshDelay: .milliseconds(10), reporter: .off
        )
    }

    @Test("lenteurs-et-timeouts-du-chargement-sur-i/AC-11 : un délai dépassé d'URLSession est annoncé tel quel par la boîte, qui garde sa dernière lecture et se relit au geste suivant")
    func harnessAnnouncesTimeoutAndKeepsData() async {
        ExpiryURLProtocol.fail(with: nil)
        let model = makeModel()
        await model.load()
        let read = model.inbox
        #expect(read != nil)
        #expect(model.failure == nil)

        ExpiryURLProtocol.fail(with: .timedOut)
        await model.refresh()
        #expect(model.failure == .timedOut)
        #expect(model.failure?.message == PipelineServerText.timedOut)
        #expect(model.inbox == read)

        ExpiryURLProtocol.fail(with: nil)
        await model.refresh()
        #expect(model.failure == nil)
        #expect(model.inbox == read)
    }

    @Test("lenteurs-et-timeouts-du-chargement-sur-i/AC-11 : une lecture annulée sous URLSession n'est jamais annoncée")
    func harnessNeverAnnouncesCancellation() async {
        ExpiryURLProtocol.fail(with: nil)
        let model = makeModel()
        await model.load()
        let read = model.inbox

        ExpiryURLProtocol.fail(with: .cancelled)
        await model.refresh()
        #expect(model.failure == nil)
        #expect(model.inbox == read)
        ExpiryURLProtocol.fail(with: nil)
    }

    @Test("lenteurs-et-timeouts-du-chargement-sur-i/AC-11 : la Mémoire dit « délai dépassé » et garde sa lecture, une annulation n'est jamais une panne")
    func memoryAnnouncesTimeoutAndKeepsData() async throws {
        let transport = ScriptedMemoryTransport()
        let rows = (0 ..< 150).map { #"{"id":"m\#($0)","memory":"souvenir","agent_id":"produit"}"# }
        transport.reply("/memory/all?agent_id=produit", json: #"{"total":150,"results":[\#(rows.joined(separator: ","))]}"#)
        transport.reply("/memory/all", json: #"{"total":150,"results":[\#(rows.joined(separator: ","))]}"#)
        let preferences = InMemoryClientPreferences()
        preferences.set("produit", forKey: MemoryAccess.scopeKey)
        let access = MemoryAccess(preferences: preferences, tokens: InMemoryTokenStore(), transport: transport)
        await access.configure(address: "https://vps:8443", token: "jeton")
        await access.load()
        _ = try await access.memoryPage(scope: nil, offset: 0, limit: nil)

        transport.fail("/memory/all?agent_id=produit", URLError(.timedOut))
        await #expect(throws: MemoryReadError.timedOut) { try await access.memoryPage(scope: nil, offset: 0, limit: nil) }
        let kept = try await access.memoryPage(scope: "produit", offset: 100, limit: nil)
        #expect(kept.rows.count == 50)

        transport.fail("/memory/all?agent_id=produit", URLError(.cancelled))
        await #expect(throws: CancellationError.self) { try await access.memoryPage(scope: nil, offset: 0, limit: nil) }
        #expect(try await access.memoryPage(scope: "produit", offset: 100, limit: nil).rows.count == 50)
    }
}

@MainActor
@Suite("Délais dépassés : la suspension de l'app", .serialized)
struct SuspensionDesLecturesTests {
    @Test("lenteurs-et-timeouts-du-chargement-sur-i/AC-11 : une lecture en vol quand toute l'app passe en arrière-plan est annulée, sans bandeau, et le retour la relit")
    func suspensionCancelsReadsInFlight() async throws {
        let transport = LatencyHarnessTransport(latency: .milliseconds(300)) { _ in osJSON(osInboxJSON) }
        let model = HarnessModel(
            transport: transport,
            preferences: InMemoryClientPreferences([HarnessModel.addressKey: "https://vps.example"]),
            tokens: InMemoryTokenStore([HarnessModel.tokenAccount: "t"]),
            retryDelay: .seconds(3600), refreshDelay: .milliseconds(10), reporter: .off
        )
        await model.load()
        let read = model.inbox
        #expect(read != nil)

        // Une lecture qui irait au bout rendrait un 500 et poserait un bandeau : la suspension l'annule avant.
        transport.respond { _ in osJSON(#"{"error":"panne"}"#, status: 500) }
        let reading = Task { await model.refresh() }
        try await Task.sleep(for: .milliseconds(100))
        model.suspendStreams()
        await reading.value
        #expect(model.failure == nil)
        #expect(model.inbox == read)

        // Le retour relit : une lecture neuve ne rejoint pas la lecture coupée.
        transport.respond { _ in osJSON(osInboxJSON) }
        await model.refresh()
        #expect(model.failure == nil)
        #expect(model.inbox == read)
        #expect(transport.count("GET", "/v1/inbox") == 3)
    }
}
