// Preuves de S-1 (visionneuse-appels-outils-lisibles) : l'analyseur ordonné
// garde l'ordre, le lexème et les doublons du texte, et refuse ce qui n'est pas
// du JSON. Titres `visionneuse-appels-outils-lisibles/AC-<n>` : /review les
// relit par grep.

import ConsoleCore
import Foundation
import Testing

private func member(_ key: String, _ value: OrderedJSON) -> OrderedJSON.Member {
    OrderedJSON.Member(key: key, value: value)
}

@Test("visionneuse-appels-outils-lisibles/AC-2 : les membres d'un objet gardent l'ordre du texte, à toute profondeur")
func orderedJSONKeepsTextOrder() throws {
    let parsed = try #require(OrderedJSON.parse(#"{"zeta":1,"alpha":{"b":true,"a":null},"m":[{"y":"1","x":"2"}]}"#))
    #expect(
        parsed
            == .object([
                member("zeta", .number("1")),
                member("alpha", .object([member("b", .bool(true)), member("a", .null)])),
                member("m", .array([.object([member("y", .string("1")), member("x", .string("2"))])])),
            ])
    )
    #expect(parsed.rendered == #"{"zeta":1,"alpha":{"b":true,"a":null},"m":[{"y":"1","x":"2"}]}"#)
}

@Test("visionneuse-appels-outils-lisibles/AC-9 : le rendu redonne le texte d'origine, nombres en lexème, espaces ôtés")
func orderedJSONRendersTheOriginalText() throws {
    let parsed = try #require(OrderedJSON.parse(" {\"n\" : -0.5e3 ,\r\n\t\"m\":[ 0 , 2E+10, 1.25 ], \"z\": false } "))
    #expect(parsed.member("n") == .number("-0.5e3"))
    #expect(parsed.member("m") == .array([.number("0"), .number("2E+10"), .number("1.25")]))
    #expect(parsed.rendered == #"{"n":-0.5e3,"m":[0,2E+10,1.25],"z":false}"#)
}

@Test("visionneuse-appels-outils-lisibles/AC-9 : échappements résolus, paire de substitution, ré-échappement du rendu")
func orderedJSONDecodesEscapes() throws {
    let text = #"{"s":"a\"b\\c\/d\b\f\n\r\t\u00e9\uD834\uDD1E é/"}"#
    let parsed = try #require(OrderedJSON.parse(text))
    #expect(parsed.member("s") == .string("a\"b\\c/d\u{08}\u{0C}\n\r\té\u{1D11E} é/"))
    // `renderJSON` n'échappe ni `/` ni le non-ASCII : le rendu suit.
    #expect(parsed.rendered == #"{"s":"a\"b\\c/d\b\f\n\r\té𝄞 é/"}"#)
    #expect(OrderedJSON.parse(#""\u0001""#)?.rendered == #""\u0001""#)
}

@Test("visionneuse-appels-outils-lisibles/AC-9 : les clés en double sont toutes gardées ; member lit la dernière")
func orderedJSONKeepsDuplicates() throws {
    let parsed = try #require(OrderedJSON.parse(#"{"a":1,"b":2,"a":3}"#))
    #expect(parsed == .object([member("a", .number("1")), member("b", .number("2")), member("a", .number("3"))]))
    #expect(parsed.member("a") == .number("3"))
    #expect(parsed.member("c") == nil)
    #expect(OrderedJSON.array([]).member("a") == nil, "member sur un non-objet vaut nil")
    #expect(parsed.rendered == #"{"a":1,"b":2,"a":3}"#)
}

@Test("visionneuse-appels-outils-lisibles/AC-9 : pour des clés triées, le rendu est exactement renderJSON")
func orderedJSONMatchesRenderJSONOnSortedInput() throws {
    let value: JSONValue = .object([
        "i": .string("lire « é » \"x\"\n"),
        "offset": .number(2),
        "path": .string("/tmp/a.txt"),
        "z": .array([.bool(true), .null, .object([:])]),
    ])
    let text = renderJSON(value)
    #expect(OrderedJSON.parse(text)?.rendered == text)
}

@Test("visionneuse-appels-outils-lisibles/AC-8 : un texte qui n'est pas du JSON est refusé")
func orderedJSONRejectsInvalidText() {
    let rejected = [
        #"{"path":"#,  // tronqué
        #"{"a":1} x"#,  // texte en trop
        #"{"a":1}{"#,
        #""\uD800""#,  // substitution haute seule
        #""\uDC00""#,  // substitution basse seule
        #""\uD834\u0041""#,  // haute suivie d'un non-substitut
        "\"a\u{01}b\"",  // contrôle non échappé
        #""\x""#,  // échappement inconnu
        #"{"a":01}"#,  // zéro de tête
        #"{"a":1.}"#,
        #"{"a":-}"#,
        #"{"a":1e}"#,
        #"{"a":.5}"#,
        #"{"a":+1}"#,
        #"{"a":NaN}"#,
        #"{"a":tru}"#,
        #"{"a":1,}"#,
        #"[1,]"#,
        #"{a:1}"#,
        "",
        "   ",
    ]
    for text in rejected {
        #expect(OrderedJSON.parse(text) == nil, "accepté à tort : \(text)")
    }
    // UTF-8 invalide, dans une chaîne puis hors chaîne.
    #expect(OrderedJSON.parse([0x22, 0xC3, 0x28, 0x22]) == nil)
    #expect(OrderedJSON.parse([0x5B, 0xFF, 0x5D]) == nil)
    // Les octets valides passent par la même grammaire.
    #expect(OrderedJSON.parse(Array(#"{"é":"ü"}"#.utf8)[...]) == .object([member("é", .string("ü"))]))
}

@Test("visionneuse-appels-outils-lisibles/AC-8 : la profondeur est bornée à 512 conteneurs")
func orderedJSONBoundsDepth() {
    func nested(_ depth: Int) -> String {
        String(repeating: "[", count: depth) + String(repeating: "]", count: depth)
    }
    #expect(OrderedJSON.parse(nested(512)) != nil)
    #expect(OrderedJSON.parse(nested(513)) == nil)
    let objects = String(repeating: #"{"a":"#, count: 513) + "1" + String(repeating: "}", count: 513)
    #expect(OrderedJSON.parse(objects) == nil)
}

@Test("visionneuse-appels-outils-lisibles/AC-8 : les scalaires seuls sont des valeurs JSON entières")
func orderedJSONParsesTopLevelScalars() {
    #expect(OrderedJSON.parse("null") == .null)
    #expect(OrderedJSON.parse(" 3 ") == .number("3"))
    #expect(OrderedJSON.parse("\"\"") == .string(""))
    #expect(OrderedJSON.parse("[]") == .array([]))
    #expect(OrderedJSON.parse("{}") == .object([]))
}
