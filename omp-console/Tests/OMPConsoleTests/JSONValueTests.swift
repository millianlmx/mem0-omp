// La valeur JSON générique est le socle transporté par la charge utile d'une session
// (S-3) : les arguments d'un appel d'outil traversent l'API sous cette forme. La
// conformité `Codable` est ÉCRITE, jamais synthétisée — un `enum` à valeurs associées
// s'encoderait autrement en objet interne, et le fil perdrait les arguments.

import ConsoleCore
import Foundation
import Testing

@Suite("Valeur JSON")
struct JSONValueTests {
    /// Chaque forme du socle, à la RACINE : c'est là que l'encodeur d'un `enum` à
    /// valeurs associées se trahirait le plus vite.
    private static let shapes: [JSONValue] = [
        .null,
        .bool(true),
        .bool(false),
        .number(0),
        .number(-2.5),
        .number(1e20),
        .string(""),
        .string("é\"\\\n"),
        .array([]),
        .array([.number(1), .string("a"), .null, .bool(false)]),
        .object([:]),
        .object(["b": .number(2), "a": .array([.object(["c": .null])])]),
    ]

    @Test("boucle complète : objet, tableau, nombre, chaîne, booléen et nul se ré-encodent à l'identique")
    func roundTripsEveryShape() throws {
        for value in Self.shapes {
            let data = try JSONEncoder().encode(value)
            let decoded = try JSONDecoder().decode(JSONValue.self, from: data)
            #expect(decoded == value, "\(value) → \(String(decoding: data, as: UTF8.self))")
        }
    }

    @Test("l'encodage est le JSON LUI-MÊME, pas l'enveloppe d'un `enum` à valeurs associées")
    func encodesAsPlainJSON() throws {
        let data = try JSONEncoder().encode(
            JSONValue.object(["a": .number(1), "flag": .bool(true), "items": .array([.string("x")])])
        )
        let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["a"] as? Double == 1)
        #expect(object["flag"] as? Bool == true)
        #expect(object["items"] as? [String] == ["x"])
        // Le nom des cas de l'enum n'apparaît nulle part : ce sont des clés de JSON.
        let text = String(decoding: data, as: UTF8.self)
        for caseName in ["_0", "object", "array", "number", "bool"] {
            #expect(!text.contains("\"\(caseName)\""), "l'enveloppe synthétisée de `\(caseName)` s'est invitée")
        }
    }

    @Test("un objet à clés dynamiques se décode sous les MÊMES noms de clés")
    func dynamicKeysSurvive() throws {
        let decoded = try JSONDecoder().decode(
            JSONValue.self,
            from: Data(#"{"clé accentuéé":"valeur","nested":{"0":"zéro"},"list":[1,2]}"#.utf8)
        )
        #expect(
            decoded
                == .object([
                    "clé accentuéé": .string("valeur"),
                    "nested": .object(["0": .string("zéro")]),
                    "list": .array([.number(1), .number(2)]),
                ])
        )
    }

    @Test("un entier reste un nombre, un booléen reste un booléen — aucune confusion de pont")
    func numbersAndBooleansStayDistinct() throws {
        func decode(_ json: String) throws -> JSONValue {
            try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        }

        let one = try decode("1")
        let zero = try decode("0")
        let yes = try decode("true")
        let nil_ = try decode("null")
        #expect(one == .number(1), "`1` est un nombre, jamais un booléen")
        #expect(zero == .number(0))
        #expect(yes == .bool(true), "`true` est un booléen, jamais le nombre 1")
        #expect(nil_ == .null)

        // Et un objet qui mêle les deux ne les échange pas au passage.
        let data = try JSONEncoder().encode(JSONValue.object(["n": .number(1), "b": .bool(true)]))
        let decoded = try JSONDecoder().decode(JSONValue.self, from: data)
        #expect(decoded == .object(["n": .number(1), "b": .bool(true)]))
    }
}
