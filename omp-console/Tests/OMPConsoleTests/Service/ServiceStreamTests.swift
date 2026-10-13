// Preuve du flux SSE RÉEL du service (S-2) : une trame close par sa ligne vide
// arrive alors que le flux reste OUVERT, comme celui du service. Mesuré le
// 2026-10-11 (recette réelle `scripts/recette/mac-recette-ui.sh`, surface
// session-omp-dialogue) : `URLSession.AsyncBytes.lines` ne rend jamais les lignes
// vides, et la dernière trame attendait la fermeture du flux.
//
// Aucun réseau : un `URLProtocol` livre la trame puis garde la réponse ouverte.

import Foundation
import Testing
@testable import OMPConsole

private final class OpenStreamURLProtocol: URLProtocol, @unchecked Sendable {
    /// Le format exact du service (`omp-mem0-req/serviceHttp.ts`).
    static let body = Data(
        "event: dialog\ndata: {\"id\":\"d1\",\"method\":\"select\",\"title\":\"Quel modèle ?\",\"options\":[\"A\",\"B\"]}\n\n".utf8
    )

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OpenStreamURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url,
              let response = HTTPURLResponse(
                  url: url,
                  statusCode: 200,
                  httpVersion: "HTTP/1.1",
                  headerFields: ["Content-Type": "text/event-stream"]
              ) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.body)
        // Jamais `urlProtocolDidFinishLoading` : le flux reste ouvert.
    }

    override func stopLoading() {}
}

@Test("coque-service : un dialogue du flux SSE arrive alors que le flux reste ouvert")
func openStreamDeliversDialog() async throws {
    let client = projectServiceClient(URLSessionTransport(session: OpenStreamURLProtocol.session()))
    let stream = ServiceEvents(client: client, maxAttempts: 1, retryDelay: { _ in .zero }).stream(sessionID: "s1")
    let reader = Task { () -> ServiceFrame? in
        for try await frame in stream { return frame }
        return nil
    }
    // Le flux ne se ferme jamais : sans trame en 5 s, la lecture est abandonnée.
    let watchdog = Task {
        try await Task.sleep(for: .seconds(5))
        reader.cancel()
    }
    let frame = try? await reader.value
    watchdog.cancel()
    guard case let .dialog(dialog)? = frame else {
        Issue.record("aucune trame délivrée, flux ouvert : \(String(describing: frame))")
        return
    }
    #expect(dialog.id == "d1")
    #expect(dialog.title == "Quel modèle ?")
    #expect(dialog.options == ["A", "B"])
}

@Test("coque-service : une trame dialog porte l'instant de création du service, absent chez un service antérieur")
func dialogFrameCarriesCreationInstant() throws {
    let stamped = ServiceFrame.decode(
        event: "dialog",
        data: #"{"id":"dlg-1","method":"input","title":"Une question","options":[],"optionDescriptions":[],"at":1700000000123}"#
    )
    guard case let .dialog(dialog)? = stamped else {
        Issue.record("trame horodatée non décodée : \(String(describing: stamped))")
        return
    }
    #expect(dialog.at == 1_700_000_000_123)

    let legacy = ServiceFrame.decode(
        event: "dialog",
        data: #"{"id":"dlg-1","method":"input","title":"Une question","options":[],"optionDescriptions":[]}"#
    )
    guard case let .dialog(old)? = legacy else {
        Issue.record("trame sans instant refusée : \(String(describing: legacy))")
        return
    }
    #expect(old.at == nil)

    // Un instant non numérique est ignoré : la trame reste acceptée.
    let garbled = ServiceFrame.decode(
        event: "dialog",
        data: #"{"id":"dlg-2","method":"confirm","title":"Livrer ?","at":"hier"}"#
    )
    guard case let .dialog(odd)? = garbled else {
        Issue.record("trame à instant illisible refusée : \(String(describing: garbled))")
        return
    }
    #expect(odd.at == nil)
}
