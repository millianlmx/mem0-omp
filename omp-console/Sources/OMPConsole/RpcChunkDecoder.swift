// Cadrage v2 : réassemblage des trames `rpc_chunk` et absorption des lignes
// illisibles (S-4, D1).
//
// Après négociation v2, un objet logique plus gros que le plafond d'une ligne
// physique (1 Mio) est émis en une séquence ininterrompue de fragments. Ce type
// est la seule autorité sur la validité d'une séquence : le host lui donne
// chaque ligne et reçoit soit une ligne logique, soit `incomplete`, soit
// `invalid(raison)`.
//
// ÉCART ASSUMÉ par rapport au `RpcFrameDecoder` de référence (D1) : une séquence
// invalide n'interrompt PAS la lecture. B-6 exige qu'un incident de transport ne
// tue pas la session ; la trame logique est perdue, la session reste vivante et
// la raison est journalisée.

import Foundation

struct RpcChunkDecoder {
    enum Outcome: Equatable {
        case incomplete
        case frame(String)
        case invalid(String)
    }

    /// Plafond de réassemblage : il vient du `ready` (S-2), jamais d'une
    /// constante recopiée à côté.
    private let ceilingBytes: Int

    // État de la séquence en cours ; tout à `nil` = aucune séquence.
    private var chunkId: String?
    private var expectedCount: Int?
    private var expectedByteLength: Int?
    private var nextIndex: Int = 0
    private var payload = Data()

    init(ceilingBytes: Int) {
        self.ceilingBytes = ceilingBytes
    }

    /// Une séquence est-elle en cours ? Utile aux tests, et au host pour ne rien
    /// affirmer sur une trame partielle.
    var isReassembling: Bool { chunkId != nil }

    mutating func push(line: String) -> Outcome {
        guard
            let data = line.data(using: .utf8),
            let raw = try? JSONSerialization.jsonObject(with: data),
            let dict = raw as? [String: Any],
            (dict["type"] as? String) == "rpc_chunk"
        else {
            // Ligne ordinaire, ou interruption d'une séquence par autre chose.
            if isReassembling {
                reset()
                return .invalid("séquence de fragments interrompue")
            }
            return .frame(line)
        }

        guard
            let id = dict["chunkId"] as? String, !id.isEmpty,
            let count = integer(dict["count"]),
            let index = integer(dict["index"]),
            let byteLength = integer(dict["byteLength"]),
            let encoded = dict["data"] as? String,
            let segment = Data(base64Encoded: encoded)
        else {
            return invalid("fragment mal formé")
        }

        guard count >= 2 else { return invalid("count < 2") }
        guard byteLength > 0, byteLength <= ceilingBytes else {
            return invalid("byteLength \(byteLength) hors du plafond \(ceilingBytes)")
        }

        if let current = chunkId {
            guard current == id else { return invalid("chunkId change en cours de séquence") }
            guard expectedCount == count else { return invalid("count change en cours de séquence") }
            guard expectedByteLength == byteLength else { return invalid("byteLength change en cours de séquence") }
        } else {
            chunkId = id
            expectedCount = count
            expectedByteLength = byteLength
            nextIndex = 0
            payload = Data()
        }

        guard index == nextIndex else {
            return invalid("index \(index) attendu \(nextIndex)")
        }
        guard payload.count + segment.count <= byteLength else {
            return invalid("total des octets supérieur à byteLength")
        }

        payload.append(segment)
        nextIndex += 1

        guard nextIndex == (expectedCount ?? 0) else { return .incomplete }
        guard payload.count == (expectedByteLength ?? 0) else {
            return invalid("total des octets \(payload.count) différent de byteLength \(expectedByteLength ?? 0)")
        }
        // `String(data:encoding:.utf8)` rend `nil` sur une séquence invalide :
        // c'est le décodage UTF-8 STRICT exigé par S-4.
        guard let text = String(data: payload, encoding: .utf8) else {
            return invalid("charge utile non UTF-8")
        }
        guard isJSONObject(text) else { return invalid("charge utile non objet JSON") }

        reset()
        return .frame(text)
    }

    private mutating func reset() {
        chunkId = nil
        expectedCount = nil
        expectedByteLength = nil
        nextIndex = 0
        payload = Data()
    }

    private mutating func invalid(_ reason: String) -> Outcome {
        reset()
        return .invalid(reason)
    }

    private func isJSONObject(_ text: String) -> Bool {
        guard
            let data = text.data(using: .utf8),
            let raw = try? JSONSerialization.jsonObject(with: data)
        else { return false }
        return raw is [String: Any]
    }

    private func integer(_ raw: Any?) -> Int? {
        guard let number = raw as? NSNumber else { return nil }
        return number.intValue
    }
}
