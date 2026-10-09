// Le moteur HTTP/1.1 (BR-2) : le parseur incrémental pur et le sérialiseur de
// réponse, prouvés SANS réseau — les cas limites de S-1 (bornes, `Host`,
// `Transfer-Encoding`, cible, `Content-Length`, tolérance `LF`), le décodage des
// cibles et la table de statuts.

import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

private func parse(_ raw: String) -> HTTPParseOutcome {
    var parser = HTTPRequestParser()
    parser.append(Data(raw.utf8))
    return parser.next()
}

private func refusalReason(_ raw: String) -> String? {
    if case .invalid(let reason) = parse(raw) { return reason }
    return nil
}

private func acceptedRequest(_ raw: String) throws -> HTTPRequest {
    try #require({
        if case .ok(let request) = parse(raw) { return request }
        return nil
    }())
}

// MARK: - Ligne de requête et hôte

@Test("moteur HTTP : une ligne de requête mal formée est refusée")
func malformedRequestLineIsRefused() {
    #expect(refusalReason("GET /v1 HTTP/1.1 extra\r\nHost: h\r\n\r\n")?.contains("mal formée") == true)
    #expect(refusalReason("GET /v1\r\nHost: h\r\n\r\n")?.contains("mal formée") == true)
    #expect(refusalReason("GET  /v1  HTTP/1.1\r\nHost: h\r\n\r\n")?.contains("mal formée") == true)
}

@Test("moteur HTTP : un `Host` absent, multiple ou vide est refusé")
func hostIsRequiredUniqueAndNonEmpty() {
    #expect(refusalReason("GET /v1 HTTP/1.1\r\nAccept: */*\r\n\r\n")?.contains("Host") == true)
    #expect(refusalReason("GET /v1 HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n")?.contains("Host") == true)
    #expect(refusalReason("GET /v1 HTTP/1.1\r\nHost: \r\n\r\n")?.contains("Host") == true)
}

@Test("moteur HTTP : la forme absolue et le `Transfer-Encoding` sont refusés")
func absoluteTargetAndTransferEncodingAreRefused() {
    #expect(refusalReason("GET http://example.test/v1 HTTP/1.1\r\nHost: h\r\n\r\n")?.contains("origine") == true)
    let chunked = "POST /v1/x HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n"
    #expect(refusalReason(chunked)?.contains("Transfer-Encoding") == true)
}

@Test("moteur HTTP : un `Content-Length` non décimal ou dupliqué est refusé")
func contentLengthMustBeASingleDecimalNumber() {
    #expect(refusalReason("POST /v1 HTTP/1.1\r\nHost: h\r\nContent-Length: 5x\r\n\r\n")?.contains("Content-Length") == true)
    #expect(refusalReason("POST /v1 HTTP/1.1\r\nHost: h\r\nContent-Length: +5\r\n\r\n")?.contains("Content-Length") == true)
    let duplicated = "POST /v1 HTTP/1.1\r\nHost: h\r\nContent-Length: 5\r\nContent-Length: 5\r\n\r\n"
    #expect(refusalReason(duplicated)?.contains("Content-Length") == true)
}

// MARK: - Bornes de S-1

@Test("moteur HTTP : la ligne de requête, les en-têtes et le corps dépassant les bornes sont refusés")
func limitsRefuseOversizedParts() {
    let longTarget = "/" + String(repeating: "a", count: 5_000)
    #expect(longTarget.utf8.count > HTTPLimits.requestLine)
    #expect(refusalReason("GET \(longTarget) HTTP/1.1\r\nHost: h\r\n\r\n")?.contains("ligne de requête") == true)

    var oversizedHeaders = "GET /v1 HTTP/1.1\r\nHost: h\r\n"
    for index in 0..<120 {
        oversizedHeaders += "X-Pad-\(index): \(String(repeating: "v", count: 200))\r\n"
    }
    oversizedHeaders += "\r\n"
    #expect(oversizedHeaders.utf8.count > HTTPLimits.headers)
    #expect(refusalReason(oversizedHeaders)?.contains("en-têtes") == true)

    let oversizedBody = "POST /v1 HTTP/1.1\r\nHost: h\r\nContent-Length: \(HTTPLimits.body + 1)\r\n\r\n"
    #expect(refusalReason(oversizedBody)?.contains("corps") == true)
}

// MARK: - Framing

@Test("moteur HTTP : un `LF` nu termine les lignes comme un `CRLF`")
func bareLineFeedIsTolerated() throws {
    let request = try acceptedRequest("GET /v1/store HTTP/1.1\nHost: h\n\n")
    #expect(request.method == "GET")
    #expect(request.path == "/v1/store")
    #expect(request.headers.value("Host") == "h")
}

@Test("moteur HTTP : une requête livrée en deux fois n'est rendue qu'à la seconde")
func incrementalDeliveryYieldsOneRequest() {
    let full = "GET /v1/store HTTP/1.1\r\nHost: h\r\n\r\n"
    var parser = HTTPRequestParser()
    parser.append(Data(full.prefix(12).utf8))
    #expect(parser.isEmpty == false)
    #expect(parser.next() == .incomplete)

    parser.append(Data(full.dropFirst(12).utf8))
    guard case .ok(let request) = parser.next() else {
        Issue.record("la requête complète doit être rendue après le second apport")
        return
    }
    #expect(request.path == "/v1/store")
    #expect(parser.isEmpty)
}

@Test("moteur HTTP : le corps est délimité par `Content-Length`, les octets suivants restent en tampon")
func contentLengthFramesTheBody() throws {
    let raw = "POST /v1/x HTTP/1.1\r\nHost: h\r\nContent-Length: 4\r\n\r\nabcdefgh"
    var parser = HTTPRequestParser()
    parser.append(Data(raw.utf8))
    guard case .ok(let request) = parser.next() else {
        Issue.record("le corps de 4 octets doit être rendu")
        return
    }
    #expect(request.body == Data("abcd".utf8))
    #expect(request.path == "/v1/x")
    // Les octets excédentaires ne sont pas consommés : ils appartiennent au message
    // suivant, qui n'est pas encore complet.
    #expect(parser.next() == .incomplete)
}

// MARK: - Décodage de la cible

@Test("moteur HTTP : `+` est un `+` dans le chemin, un espace dans la requête")
func plusSignDependsOnTheTargetPart() throws {
    #expect(HTTPTarget.percentDecode("/v1/run+a", plusIsSpace: false) == "/v1/run+a")
    #expect(HTTPTarget.percentDecode("run+a", plusIsSpace: true) == "run a")
    #expect(HTTPTarget.percentDecode("caf%C3%A9", plusIsSpace: false) == "café")

    let path = try acceptedRequest("GET /v1/run+a HTTP/1.1\r\nHost: h\r\n\r\n")
    #expect(path.path == "/v1/run+a")
    let query = try acceptedRequest("GET /v1/x?q=a+b HTTP/1.1\r\nHost: h\r\n\r\n")
    #expect(query.query["q"] == "a b")
}

@Test("moteur HTTP : un `%2F` reste DANS un segment de chemin")
func encodedSlashStaysInsideOneSegment() throws {
    let request = try acceptedRequest("GET /v1/files/a%2Fb.txt HTTP/1.1\r\nHost: h\r\n\r\n")
    #expect(request.path == "/v1/files/a/b.txt")
    #expect(request.segments == ["v1", "files", "a/b.txt"])
    #expect(request.segments.count == 3)
}

@Test("moteur HTTP : les paramètres de requête sont décodés, une clé répétée garde la première valeur")
func queryParametersAreDecoded() throws {
    let request = try acceptedRequest(
        "GET /v1/memory?scope=all&q=a+b&limit=10&q=second&flag&vide= HTTP/1.1\r\nHost: h\r\n\r\n"
    )
    #expect(request.query["scope"] == "all")
    #expect(request.query["q"] == "a b")
    #expect(request.query["limit"] == "10")
    #expect(request.query["flag"] == "")
    #expect(request.query["vide"] == "")
}

// MARK: - Statuts et réponses

@Test("statuts HTTP : les neuf cas d'erreur rendent le code de la table")
func errorStatusTable() throws {
    let cases: [(ConsoleAPIError, Int)] = [
        (.badRequest("x"), 400),
        (.incompatibleProtocol("x"), 400),
        (.unauthorized, 401),
        (.notFound("x"), 404),
        (.conflict("x"), 409),
        (.unavailable("x"), 503),
        (.outdatedService("x"), 503),
        (.server("x"), 500),
        (.decoding("x"), 500),
    ]
    #expect(cases.count == 9)
    for (error, code) in cases {
        #expect(HTTPStatus.of(error) == code)
    }
    #expect(HTTPStatus.reason(401) == "Unauthorized")
    #expect(HTTPStatus.reason(404) == "Not Found")
    #expect(HTTPStatus.reason(500) == "Internal Server Error")
    #expect(HTTPStatus.reason(503) == "Service Unavailable")
}

@Test("statuts HTTP : le corps d'erreur est {\"error\":{\"code\":…}} et omet `message` quand il n'y en a pas")
func errorBodyShape() throws {
    let unauthorized = try #require(try JSONSerialization.jsonObject(with: HTTPStatus.body(for: .unauthorized)) as? [String: Any])
    #expect(Set(unauthorized.keys) == ["error"])
    let unauthorizedInner = try #require(unauthorized["error"] as? [String: Any])
    #expect(unauthorizedInner["code"] as? String == "unauthorized")
    #expect(unauthorizedInner.keys.contains("message") == false)

    let notFound = try #require(try JSONSerialization.jsonObject(with: HTTPStatus.body(for: .notFound("route inconnue"))) as? [String: Any])
    let notFoundInner = try #require(notFound["error"] as? [String: Any])
    #expect(notFoundInner["code"] as? String == "not_found")
    #expect(notFoundInner["message"] as? String == "route inconnue")
}

@Test("statuts HTTP : une réponse sérialisée porte la version, la longueur et `Connection: close`")
func serializedResponseCarriesTheContractHeaders() {
    let payload = Data(#"{"ok":true}"#.utf8)
    let text = String(decoding: HTTPResponse.json(code: 200, payload: payload).serialized(), as: UTF8.self)
    #expect(text.hasPrefix("HTTP/1.1 200 OK\r\n"))
    #expect(text.contains("X-Console-Protocol-Version: 1\r\n"))
    #expect(text.contains("Content-Type: application/json; charset=utf-8\r\n"))
    #expect(text.contains("Content-Length: 11\r\n"))
    #expect(text.contains("Connection: close\r\n"))
    #expect(text.hasSuffix(#"{"ok":true}"#))

    let error = String(decoding: HTTPResponse.error(.unauthorized).serialized(), as: UTF8.self)
    #expect(error.hasPrefix("HTTP/1.1 401 Unauthorized\r\n"))
}

@Test("statuts HTTP : la réponse de flux n'a ni `Content-Length` ni `Connection: close`")
func streamResponseOmitsLengthAndConnection() {
    let text = String(decoding: HTTPResponse.stream().serialized(), as: UTF8.self)
    #expect(text.hasPrefix("HTTP/1.1 200 OK\r\n"))
    #expect(text.contains("Content-Type: text/event-stream; charset=utf-8\r\n"))
    #expect(text.contains("Cache-Control: no-store\r\n"))
    #expect(text.contains("X-Console-Protocol-Version: 1\r\n"))
    #expect(text.contains("Content-Length") == false)
    #expect(text.contains("Connection: close") == false)
    #expect(text.hasSuffix("\r\n\r\n"))
}
