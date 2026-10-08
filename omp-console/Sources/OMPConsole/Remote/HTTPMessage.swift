// Le moteur HTTP/1.1 de la coque : un parseur INCRÉMENTAL pur (aucune E/S, testable
// seul) et un sérialiseur de réponse. C'est le seul endroit qui connaît le framing
// du protocole — S-1 du contrat fixe ses bornes et ses interdits.
//
// Décisions (Doc-4, RFC 9112) :
//   — une seule réponse par connexion, `Connection: close` toujours présent (sauf
//     le flux SSE, S-13) : ni persistance, ni pipelining ;
//   — le corps n'est déterminé QUE par `Content-Length` ; tout `Transfer-Encoding`
//     est refusé (contrebande de requête, §6.3/§11.2) ;
//   — `Host` est requis, unique et non vide (§3.2) ;
//   — la cible doit être de forme origine (`/…`) : la forme absolue est refusée.

import ConsoleCore
import Foundation

/// Un champ d'en-tête, tel qu'écrit (la casse du NOM n'est jamais significative).
struct HTTPField: Equatable, Sendable {
    var name: String
    var value: String
}

/// Le bloc d'en-têtes d'un message : accès multi-valeurs, casse insignifiante.
struct HTTPHead: Equatable, Sendable {
    private(set) var fields: [HTTPField] = []

    func values(_ name: String) -> [String] {
        let wanted = name.lowercased()
        return fields.filter { $0.name.lowercased() == wanted }.map(\.value)
    }

    func value(_ name: String) -> String? { values(name).first }

    mutating func add(_ name: String, _ value: String) {
        fields.append(HTTPField(name: name, value: value))
    }
}

/// Les bornes de S-1 : au-delà, `400 bad_request` puis fermeture.
enum HTTPLimits {
    static let requestLine = 4096
    static let headers = 16_384
    static let body = 1_048_576
}

/// Une requête HTTP complète, décodée.
struct HTTPRequest: Equatable, Sendable {
    var method: String
    var target: String
    /// Le chemin, percent-décodé, `+` NON converti en espace.
    var path: String
    /// Les segments du chemin (sans élément vide).
    var segments: [String]
    /// Les paramètres de requête décodés : `+` EST un espace, `%XX` est décodé.
    var query: [String: String]
    var headers: HTTPHead
    var body: Data

    /// L'en-tête `Authorization`, tel quel (une seule valeur possible).
    var authorization: String? { headers.value("Authorization") }
}

/// Le verdict du parseur incrémental.
enum HTTPParseOutcome: Equatable {
    case incomplete
    case ok(HTTPRequest)
    case invalid(String)
}

/// Le parseur incrémental : on lui pousse des octets, il rend une requête dès
/// qu'une complète est disponible (même patron que le découpeur de trames SSE).
struct HTTPRequestParser {
    private var buffer: [UInt8] = []

    var isEmpty: Bool { buffer.isEmpty }
    var pending: Int { buffer.count }

    mutating func append(_ data: Data) {
        buffer.append(contentsOf: data)
    }

    mutating func reset() { buffer.removeAll(keepingCapacity: false) }

    /// La prochaine requête, ou `incomplete` s'il manque des octets.
    mutating func next() -> HTTPParseOutcome {
        guard let headEnd = Self.endOfHead(buffer) else {
            // Le bloc d'en-têtes n'est pas terminé : on ne refuse que ce qui est
            // déjà au-delà des bornes (une requête peut arriver en plusieurs fois).
            if let line = Self.firstLineEnd(buffer), line > HTTPLimits.requestLine {
                reset()
                return .invalid("ligne de requête trop longue")
            }
            if buffer.count > HTTPLimits.headers + HTTPLimits.requestLine {
                reset()
                return .invalid("en-têtes trop volumineux")
            }
            return .incomplete
        }

        let outcome = Self.parseHead(Array(buffer[0..<headEnd]))
        guard case .head(var request, let contentLength) = outcome else {
            reset()
            if case .failure(let reason) = outcome { return .invalid(reason) }
            return .invalid("requête illisible")
        }

        if contentLength > HTTPLimits.body {
            reset()
            return .invalid("corps trop volumineux")
        }
        guard buffer.count - headEnd >= contentLength else { return .incomplete }

        request.body = Data(buffer[headEnd..<(headEnd + contentLength)])
        buffer.removeFirst(headEnd + contentLength)
        return .ok(request)
    }

    // MARK: - Tête

    private enum HeadOutcome {
        case head(HTTPRequest, Int)
        case failure(String)
    }

    /// Le décalage juste après la ligne vide qui termine les en-têtes, ou `nil`.
    ///
    /// Un `LF` nu est toléré comme fin de ligne (S-1) ; un `CRLF` est la norme.
    private static func endOfHead(_ bytes: [UInt8]) -> Int? {
        var index = 0
        while index < bytes.count {
            guard let newline = bytes[index...].firstIndex(of: 0x0A) else { return nil }
            var lineEnd = newline
            if lineEnd > index, bytes[lineEnd - 1] == 0x0D { lineEnd -= 1 }
            if lineEnd == index { return newline + 1 }
            index = newline + 1
        }
        return nil
    }

    /// Le décalage de la première fin de ligne : borne la ligne de requête.
    private static func firstLineEnd(_ bytes: [UInt8]) -> Int? {
        bytes.firstIndex(of: 0x0A)
    }

    /// Découpe les lignes du bloc d'en-têtes.
    private static func lines(_ bytes: [UInt8]) -> [String] {
        var out: [String] = []
        var index = 0
        while index < bytes.count {
            guard let newline = bytes[index...].firstIndex(of: 0x0A) else {
                out.append(decodeAscii(Array(bytes[index...])))
                break
            }
            var lineEnd = newline
            if lineEnd > index, bytes[lineEnd - 1] == 0x0D { lineEnd -= 1 }
            out.append(decodeAscii(Array(bytes[index..<lineEnd])))
            index = newline + 1
        }
        return out
    }

    private static func decodeAscii(_ bytes: [UInt8]) -> String {
        String(decoding: bytes, as: UTF8.self)
    }

    private static func parseHead(_ bytes: [UInt8]) -> HeadOutcome {
        let rows = lines(bytes)
        guard let start = rows.first else { return .failure("requête vide") }
        if start.utf8.count > HTTPLimits.requestLine { return .failure("ligne de requête trop longue") }

        let parts = start.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3, !parts[0].isEmpty, !parts[1].isEmpty else {
            return .failure("ligne de requête mal formée")
        }
        let method = parts[0]
        let target = parts[1]
        let version = parts[2]
        guard version.hasPrefix("HTTP/1.") else { return .failure("version HTTP non servie") }
        guard target.hasPrefix("/") else { return .failure("cible non origine") }

        var head = HTTPHead()
        var headerBytes = 0
        for row in rows.dropFirst() {
            // La ligne vide qui termine le bloc d'en-têtes est DANS la tranche (S-1 :
            // `…\r\n\r\n`) : elle clôt les champs, elle n'en est pas un.
            if row.isEmpty { break }
            headerBytes += row.utf8.count + 2
            if headerBytes > HTTPLimits.headers { return .failure("en-têtes trop volumineux") }
            if row.hasPrefix(" ") || row.hasPrefix("\t") { return .failure("en-tête replié") }
            guard let colon = row.firstIndex(of: ":") else { return .failure("en-tête mal formé") }
            let name = String(row[row.startIndex..<colon])
            let value = String(row[row.index(after: colon)...])
                .trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty, name.rangeOfCharacter(from: .whitespaces) == nil else {
                return .failure("nom d'en-tête mal formé")
            }
            head.add(name, value)
        }

        guard head.values("Host").count == 1 else { return .failure("Host absent ou multiple") }
        guard let host = head.value("Host"), !host.isEmpty else { return .failure("Host vide") }

        if !head.values("Transfer-Encoding").isEmpty {
            return .failure("Transfer-Encoding refusé")
        }

        let lengths = head.values("Content-Length")
        var contentLength = 0
        if !lengths.isEmpty {
            guard lengths.count == 1 else { return .failure("Content-Length multiple") }
            guard let parsed = Self.parseContentLength(lengths[0]) else {
                return .failure("Content-Length non décimal")
            }
            contentLength = parsed
        }

        let split = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let rawPath = String(split[0])
        let rawQuery = split.count > 1 ? String(split[1]) : ""
        let path = HTTPTarget.percentDecode(rawPath, plusIsSpace: false)
        // Les segments sont découpés AVANT décodage : un `%2F` reste DANS un
        // segment (S-1), sinon un chemin de fichier encodé se briserait en deux.
        let segments = rawPath
            .split(separator: "/", omittingEmptySubsequences: true)
            .map { HTTPTarget.percentDecode(String($0), plusIsSpace: false) }
        let query = HTTPTarget.query(rawQuery)

        let request = HTTPRequest(
            method: method,
            target: target,
            path: path,
            segments: segments,
            query: query,
            headers: head,
            body: Data()
        )
        _ = host
        return .head(request, contentLength)
    }

    /// `Content-Length` : forme décimale canonique UNIQUEMENT (pas de `+`, pas de
    /// zéro de tête inutile refusé — seul `+`/espace/lettre le sont).
    private static func parseContentLength(_ raw: String) -> Int? {
        guard !raw.isEmpty else { return nil }
        for scalar in raw.unicodeScalars where !(scalar.value >= 48 && scalar.value <= 57) {
            return nil
        }
        return Int(raw)
    }
}

/// Le décodage des cibles : chemin et chaîne de requête.
enum HTTPTarget {
    /// Percent-décodage UTF-8. `plusIsSpace` n'est vrai QUE dans la chaîne de
    /// requête (S-1) : un `+` dans un chemin est un `+`.
    static func percentDecode(_ raw: String, plusIsSpace: Bool) -> String {
        var out: [UInt8] = []
        var bytes = Array(raw.utf8)
        var index = 0
        while index < bytes.count {
            let byte = bytes[index]
            if byte == 0x25, index + 2 < bytes.count,
               let high = hex(bytes[index + 1]), let low = hex(bytes[index + 2]) {
                out.append(high << 4 | low)
                index += 3
                continue
            }
            if byte == 0x2B, plusIsSpace {
                out.append(0x20)
                index += 1
                continue
            }
            out.append(byte)
            index += 1
        }
        return String(decoding: out, as: UTF8.self)
    }

    private static func hex(_ byte: UInt8) -> UInt8? {
        switch byte {
        case 0x30...0x39: return byte - 0x30
        case 0x41...0x46: return byte - 0x41 + 10
        case 0x61...0x66: return byte - 0x61 + 10
        default: return nil
        }
    }

    /// Les paramètres de requête : `&`, `k=v`, `+` espace, `%XX` décodé. Une clé
    /// répétée garde la PREMIÈRE valeur (l'API n'a besoin que d'une par nom).
    static func query(_ raw: String) -> [String: String] {
        var out: [String: String] = [:]
        for chunk in raw.split(separator: "&", omittingEmptySubsequences: true) {
            let pair = chunk.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let key = percentDecode(String(pair[0]), plusIsSpace: true)
            let value = pair.count > 1 ? percentDecode(String(pair[1]), plusIsSpace: true) : ""
            if out[key] == nil { out[key] = value }
        }
        return out
    }
}

/// Une réponse prête à écrire.
struct HTTPResponse: Equatable {
    var code: Int
    var reason: String
    var contentType: String? = "application/json; charset=utf-8"
    var headers: [HTTPField] = []
    var body: Data = Data()
    /// Un flux SSE : ni `Content-Length`, ni `Connection: close` (S-13).
    var streams: Bool = false

    static func json(code: Int, payload: Data) -> HTTPResponse {
        HTTPResponse(code: code, reason: HTTPStatus.reason(code), body: payload)
    }

    static func error(_ error: ConsoleAPIError) -> HTTPResponse {
        let code = HTTPStatus.of(error)
        return HTTPResponse(code: code, reason: HTTPStatus.reason(code), body: HTTPStatus.body(for: error))
    }

    /// La réponse du flux SSE : en-têtes de S-13, reste ouverte.
    static func stream() -> HTTPResponse {
        HTTPResponse(
            code: 200,
            reason: HTTPStatus.reason(200),
            contentType: "text/event-stream; charset=utf-8",
            headers: [HTTPField(name: "Cache-Control", value: "no-store")],
            body: Data(),
            streams: true
        )
    }

    /// La trame d'en-têtes + le corps. `Connection: close` est TOUJOURS écrit sauf
    /// pour un flux ; la version du protocole est sur TOUTE réponse.
    func serialized() -> Data {
        var head = "HTTP/1.1 \(code) \(reason)\r\n"
        head += "\(ConsoleAPI.Service.protocolHeader): \(ConsoleAPI.protocolVersion)\r\n"
        if let contentType { head += "Content-Type: \(contentType)\r\n" }
        for field in headers { head += "\(field.name): \(field.value)\r\n" }
        if !streams {
            head += "Content-Length: \(body.count)\r\n"
            head += "Connection: close\r\n"
        }
        head += "\r\n"
        var out = Data(head.utf8)
        out.append(body)
        return out
    }
}
