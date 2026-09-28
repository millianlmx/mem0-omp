// Preuves de S-4 : cadrage des lignes — fragments v2 et trames illisibles
// (AC-12, BR-5 step 2).
//
// Chaque cas construit la séquence de fragments à la main : la preuve ne dépend
// donc ni de `omp`, ni d'un tour de modèle. `push` est mutating : son résultat est
// toujours lu dans une variable locale avant l'assertion, pour qu'aucune
// évaluation ne se recouvre.

import Foundation
import Testing
@testable import OMPConsole

// MARK: - Outils de construction

/// Construit une trame logique découpée en `count` fragments `rpc_chunk`.
private func fragments(for payload: String, count: Int, chunkId: String = "chunk-1") -> [String] {
    let bytes = Array(payload.utf8)
    let total = bytes.count
    let size = max(1, (total + count - 1) / count)
    return (0..<count).map { index in
        let start = min(total, index * size)
        let end = min(total, start + size)
        let slice = Data(bytes[start..<end])
        return jsonLine([
            "type": "rpc_chunk",
            "chunkId": chunkId,
            "index": index,
            "count": count,
            "byteLength": total,
            "data": slice.base64EncodedString(),
        ])
    }
}

private func jsonLine(_ object: [String: Any]) -> String {
    guard
        let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
        let text = String(data: data, encoding: .utf8)
    else { return "{}" }
    return text
}

private let reply = #"{"command":"get_state","data":{"sessionId":"abc"},"id":"app-1","success":true,"type":"response"}"#

// MARK: - Cas

@Test("client-rpc-omp/AC-12 : une séquence de fragments valide rend une seule trame logique")
func validFragmentSequenceYieldsOneFrame() {
    var decoder = RpcChunkDecoder(ceilingBytes: 1_048_576)
    let lines = fragments(for: reply, count: 3)

    let first = decoder.push(line: lines[0])
    let second = decoder.push(line: lines[1])
    let third = decoder.push(line: lines[2])
    #expect(first == .incomplete)
    #expect(second == .incomplete)
    #expect(third == .frame(reply))
    #expect(decoder.isReassembling == false)
}

@Test("client-rpc-omp/AC-12 : une ligne ordinaire hors séquence est rendue telle quelle")
func ordinaryLineOutsideSequenceIsPassedThrough() {
    var decoder = RpcChunkDecoder(ceilingBytes: 1_048_576)
    let ordinary = decoder.push(line: reply)
    // Ligne vide : c'est `parse` qui la déclarera `unparsable`, pas le décodeur.
    let empty = decoder.push(line: "")
    #expect(ordinary == .frame(reply))
    #expect(empty == .frame(""))
}

@Test("client-rpc-omp/AC-12 : une séquence interrompue est invalidée sans tuer la session")
func interruptedSequenceIsInvalidated() {
    var decoder = RpcChunkDecoder(ceilingBytes: 1_048_576)
    let lines = fragments(for: reply, count: 3)

    let start = decoder.push(line: lines[0])
    let interruption = decoder.push(line: #"{"type":"agent_start"}"#)
    // La séquence est oubliée : la trame suivante est traitée normalement.
    let following = decoder.push(line: reply)
    #expect(start == .incomplete)
    #expect(interruption == .invalid("séquence de fragments interrompue"))
    #expect(following == .frame(reply))
}

@Test("client-rpc-omp/AC-12 : un index hors séquence invalide la séquence")
func outOfOrderIndexIsInvalid() {
    var decoder = RpcChunkDecoder(ceilingBytes: 1_048_576)
    let lines = fragments(for: reply, count: 3)
    let outcome = decoder.push(line: lines[1])
    #expect(outcome == .invalid("index 1 attendu 0"))
    #expect(decoder.isReassembling == false)
}

@Test("client-rpc-omp/AC-12 : un fragment en base64 invalide est invalidé")
func invalidBase64IsInvalid() {
    var decoder = RpcChunkDecoder(ceilingBytes: 1_048_576)
    let line = jsonLine([
        "type": "rpc_chunk",
        "chunkId": "c",
        "index": 0,
        "count": 2,
        "byteLength": 4,
        "data": "!!!!",
    ])
    let outcome = decoder.push(line: line)
    #expect(outcome == .invalid("fragment mal formé"))
}

@Test("client-rpc-omp/AC-12 : une charge utile non UTF-8 est invalidée")
func invalidUTF8IsInvalid() {
    var decoder = RpcChunkDecoder(ceilingBytes: 1_048_576)
    let first = jsonLine(["type": "rpc_chunk", "chunkId": "c", "index": 0, "count": 2, "byteLength": 2, "data": Data([0xFF]).base64EncodedString()])
    let second = jsonLine(["type": "rpc_chunk", "chunkId": "c", "index": 1, "count": 2, "byteLength": 2, "data": Data([0xFE]).base64EncodedString()])
    let started = decoder.push(line: first)
    let ended = decoder.push(line: second)
    #expect(started == .incomplete)
    #expect(ended == .invalid("charge utile non UTF-8"))
}

@Test("client-rpc-omp/AC-12 : une charge utile qui n'est pas un objet JSON est invalidée")
func nonObjectPayloadIsInvalid() {
    var decoder = RpcChunkDecoder(ceilingBytes: 1_048_576)
    let lines = fragments(for: "[1,2,3]", count: 2)
    let started = decoder.push(line: lines[0])
    let ended = decoder.push(line: lines[1])
    #expect(started == .incomplete)
    #expect(ended == .invalid("charge utile non objet JSON"))
}

@Test("client-rpc-omp/AC-12 : un fragment dépassant le plafond est invalidé")
func aboveCeilingIsInvalid() {
    var decoder = RpcChunkDecoder(ceilingBytes: 10)
    let line = jsonLine([
        "type": "rpc_chunk",
        "chunkId": "c",
        "index": 0,
        "count": 2,
        "byteLength": 100,
        "data": Data(repeating: 0x41, count: 100).base64EncodedString(),
    ])
    let outcome = decoder.push(line: line)
    #expect(outcome == .invalid("byteLength 100 hors du plafond 10"))
    #expect(decoder.isReassembling == false)
}

@Test("client-rpc-omp/AC-12 : une séquence dont le dernier fragment manque reste incomplète")
func missingLastFragmentStaysIncomplete() {
    var decoder = RpcChunkDecoder(ceilingBytes: 1_048_576)
    let lines = fragments(for: reply, count: 3)
    let first = decoder.push(line: lines[0])
    let second = decoder.push(line: lines[1])
    #expect(first == .incomplete)
    #expect(second == .incomplete)
    #expect(decoder.isReassembling == true)
}
