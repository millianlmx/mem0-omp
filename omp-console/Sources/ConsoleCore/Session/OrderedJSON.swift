// La valeur JSON ORDONNÉE (visionneuse-appels-outils-lisibles, S-1) : les
// arguments d'un appel d'outil s'affichent dans l'ordre où le modèle les a émis.
//
// `JSONValue` est un dictionnaire et `JSONSerialization` ne rend pas l'ordre des
// membres visible (RFC 8259 §4, Doc D-1) : un analyseur à soi est donc
// nécessaire. Il suit strictement la grammaire de la RFC (§2 espaces, §6
// nombres, §7 chaînes), garde TOUS les membres d'un objet dans l'ordre du texte,
// doublons compris, et garde le LEXÈME d'un nombre tel quel (`2`, `-0.5e3`).
// La profondeur est bornée à 512 (§9) : au-delà, l'analyse échoue.
//
// L'analyse se fait sur les octets UTF-8, en un seul passage linéaire, sans
// `String` intermédiaire du texte entier. PURE : aucune E/S, aucun état.

import Foundation

/// Valeur JSON dont les objets gardent l'ordre et les doublons de leur texte.
public indirect enum OrderedJSON: Equatable, Sendable {
    /// Les membres dans l'ordre du texte, doublons conservés.
    case object([Member])
    case array([OrderedJSON])
    /// Le contenu décodé : les échappements sont résolus.
    case string(String)
    /// Le lexème d'origine, ex. `"2"`, `"-0.5e3"`.
    case number(String)
    case bool(Bool)
    case null

    public struct Member: Equatable, Sendable {
        public let key: String
        public let value: OrderedJSON

        public init(key: String, value: OrderedJSON) {
            self.key = key
            self.value = value
        }
    }

    /// La profondeur d'imbrication maximale des conteneurs (RFC 8259 §9).
    public static let maximumDepth = 512

    /// Analyse un texte JSON entier : une seule valeur, entourée seulement des
    /// espaces permis. `nil` sur tout écart à la grammaire.
    public static func parse(_ text: String) -> OrderedJSON? {
        if let parsed = text.utf8.withContiguousStorageIfAvailable(OrderedJSONParser.parse) {
            return parsed
        }
        return Array(text.utf8).withUnsafeBufferPointer(OrderedJSONParser.parse)
    }

    /// Analyse des octets UTF-8 : `nil` sur un UTF-8 invalide, un jeton invalide,
    /// du texte en trop, une substitution UTF-16 non appariée ou une profondeur
    /// supérieure à `maximumDepth`.
    public static func parse<Bytes: Collection>(_ bytes: Bytes) -> OrderedJSON? where Bytes.Element == UInt8 {
        if let parsed = bytes.withContiguousStorageIfAvailable(OrderedJSONParser.parse) {
            return parsed
        }
        return Array(bytes).withUnsafeBufferPointer(OrderedJSONParser.parse)
    }

    /// Valeur du DERNIER membre de clé `key` (comme `JSONSerialization`) ; `nil`
    /// si `self` n'est pas un objet ou si la clé manque.
    public func member(_ key: String) -> OrderedJSON? {
        guard case .object(let members) = self else { return nil }
        return members.last { $0.key == key }?.value
    }

    /// Rendu compact : ordre conservé, aucun espace, chaînes échappées comme
    /// `renderJSON`, nombres rendus par leur lexème. Pour un contenu aux clés
    /// triées et aux nombres entiers écrits sans point, c'est exactement
    /// `renderJSON` du même contenu.
    public var rendered: String {
        var text = ""
        render(into: &text)
        return text
    }

    private func render(into text: inout String) {
        switch self {
        case .object(let members):
            text += "{"
            for (position, member) in members.enumerated() {
                if position > 0 { text += "," }
                text += "\""
                text += escapeJSON(member.key)
                text += "\":"
                member.value.render(into: &text)
            }
            text += "}"
        case .array(let items):
            text += "["
            for (position, item) in items.enumerated() {
                if position > 0 { text += "," }
                item.render(into: &text)
            }
            text += "]"
        case .string(let value):
            text += "\""
            text += escapeJSON(value)
            text += "\""
        case .number(let lexeme):
            text += lexeme
        case .bool(let flag):
            text += flag ? "true" : "false"
        case .null:
            text += "null"
        }
    }
}

// MARK: - Analyseur

/// L'analyseur descendant récursif, sur un tampon d'octets contigu. Il avance un
/// curseur unique et ne revient jamais en arrière.
private struct OrderedJSONParser {
    private let bytes: UnsafeBufferPointer<UInt8>
    private var index = 0
    private var depth = 0

    private init(bytes: UnsafeBufferPointer<UInt8>) {
        self.bytes = bytes
    }

    static func parse(_ bytes: UnsafeBufferPointer<UInt8>) -> OrderedJSON? {
        var parser = OrderedJSONParser(bytes: bytes)
        parser.skipWhitespace()
        guard let value = parser.value() else { return nil }
        parser.skipWhitespace()
        return parser.index == bytes.count ? value : nil
    }

    private var current: UInt8? { index < bytes.count ? bytes[index] : nil }

    /// RFC 8259 §2 : espace, tabulation, saut de ligne, retour chariot.
    private mutating func skipWhitespace() {
        while let byte = current, byte == 0x20 || byte == 0x09 || byte == 0x0A || byte == 0x0D {
            index += 1
        }
    }

    private mutating func value() -> OrderedJSON? {
        guard let byte = current else { return nil }
        switch byte {
        case Byte.openBrace: return object()
        case Byte.openBracket: return array()
        case Byte.quote: return string().map(OrderedJSON.string)
        case UInt8(ascii: "t"): return literal("true", .bool(true))
        case UInt8(ascii: "f"): return literal("false", .bool(false))
        case UInt8(ascii: "n"): return literal("null", .null)
        case Byte.minus, Byte.zero...Byte.nine: return number()
        default: return nil
        }
    }

    private mutating func literal(_ word: StaticString, _ value: OrderedJSON) -> OrderedJSON? {
        let count = word.utf8CodeUnitCount
        guard bytes.count - index >= count else { return nil }
        for offset in 0..<count where bytes[index + offset] != word.utf8Start[offset] {
            return nil
        }
        index += count
        return value
    }

    // MARK: Conteneurs

    /// Entre dans un conteneur : `false` au-delà de la profondeur permise.
    private mutating func enter() -> Bool {
        depth += 1
        return depth <= OrderedJSON.maximumDepth
    }

    private mutating func object() -> OrderedJSON? {
        guard enter() else { return nil }
        defer { depth -= 1 }
        index += 1
        var members: [OrderedJSON.Member] = []
        skipWhitespace()
        if current == Byte.closeBrace {
            index += 1
            return .object(members)
        }
        while true {
            guard current == Byte.quote, let key = string() else { return nil }
            skipWhitespace()
            guard current == Byte.colon else { return nil }
            index += 1
            skipWhitespace()
            guard let value = value() else { return nil }
            members.append(OrderedJSON.Member(key: key, value: value))
            skipWhitespace()
            switch current {
            case Byte.comma:
                index += 1
                skipWhitespace()
            case Byte.closeBrace:
                index += 1
                return .object(members)
            default:
                return nil
            }
        }
    }

    private mutating func array() -> OrderedJSON? {
        guard enter() else { return nil }
        defer { depth -= 1 }
        index += 1
        var items: [OrderedJSON] = []
        skipWhitespace()
        if current == Byte.closeBracket {
            index += 1
            return .array(items)
        }
        while true {
            guard let item = value() else { return nil }
            items.append(item)
            skipWhitespace()
            switch current {
            case Byte.comma:
                index += 1
                skipWhitespace()
            case Byte.closeBracket:
                index += 1
                return .array(items)
            default:
                return nil
            }
        }
    }

    // MARK: Chaînes (§7)

    /// Lit une chaîne, curseur sur son guillemet ouvrant. Sans échappement, le
    /// contenu est validé tel quel ; sinon il est décodé octet par octet.
    private mutating func string() -> String? {
        index += 1
        let start = index
        while let byte = current {
            switch byte {
            case Byte.quote:
                let text = String(validating: UnsafeBufferPointer(rebasing: bytes[start..<index]), as: UTF8.self)
                index += 1
                return text
            case Byte.backslash:
                return escapedString(from: start)
            case ..<0x20:
                return nil
            default:
                index += 1
            }
        }
        return nil
    }

    /// La suite d'une chaîne à partir de son premier échappement.
    private mutating func escapedString(from start: Int) -> String? {
        var decoded = Array(UnsafeBufferPointer(rebasing: bytes[start..<index]))
        while let byte = current {
            switch byte {
            case Byte.quote:
                index += 1
                return String(validating: decoded, as: UTF8.self)
            case Byte.backslash:
                guard escape(into: &decoded) else { return nil }
            case ..<0x20:
                return nil
            default:
                decoded.append(byte)
                index += 1
            }
        }
        return nil
    }

    /// Décode un échappement, curseur sur sa barre oblique inverse.
    private mutating func escape(into decoded: inout [UInt8]) -> Bool {
        index += 1
        guard let byte = current else { return false }
        index += 1
        switch byte {
        case Byte.quote, Byte.backslash, UInt8(ascii: "/"): decoded.append(byte)
        case UInt8(ascii: "b"): decoded.append(0x08)
        case UInt8(ascii: "f"): decoded.append(0x0C)
        case UInt8(ascii: "n"): decoded.append(0x0A)
        case UInt8(ascii: "r"): decoded.append(0x0D)
        case UInt8(ascii: "t"): decoded.append(0x09)
        case UInt8(ascii: "u"):
            guard let scalar = unicodeEscape() else { return false }
            UTF8.encode(scalar) { decoded.append($0) }
        default:
            return false
        }
        return true
    }

    /// `\uXXXX`, curseur après le `u` : un caractère hors BMP arrive en paire de
    /// substitution UTF-16 ; une moitié seule est refusée.
    private mutating func unicodeEscape() -> Unicode.Scalar? {
        guard let unit = hexQuad() else { return nil }
        switch unit {
        case 0xD800...0xDBFF:
            guard current == Byte.backslash, index + 1 < bytes.count, bytes[index + 1] == UInt8(ascii: "u")
            else { return nil }
            index += 2
            guard let low = hexQuad(), (0xDC00...0xDFFF).contains(low) else { return nil }
            return Unicode.Scalar(0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00))
        case 0xDC00...0xDFFF:
            return nil
        default:
            return Unicode.Scalar(unit)
        }
    }

    private mutating func hexQuad() -> UInt32? {
        guard bytes.count - index >= 4 else { return nil }
        var unit: UInt32 = 0
        for _ in 0..<4 {
            let byte = bytes[index]
            let digit: UInt8
            switch byte {
            case Byte.zero...Byte.nine: digit = byte - Byte.zero
            case UInt8(ascii: "a")...UInt8(ascii: "f"): digit = byte - UInt8(ascii: "a") + 10
            case UInt8(ascii: "A")...UInt8(ascii: "F"): digit = byte - UInt8(ascii: "A") + 10
            default: return nil
            }
            unit = unit << 4 | UInt32(digit)
            index += 1
        }
        return unit
    }

    // MARK: Nombres (§6)

    /// `[ minus ] int [ frac ] [ exp ]` : le lexème est gardé tel quel.
    private mutating func number() -> OrderedJSON? {
        let start = index
        if current == Byte.minus { index += 1 }
        guard let first = current, isDigit(first) else { return nil }
        index += 1
        // `int = zero / ( digit1-9 *DIGIT )` : un zéro de tête n'a pas de suite.
        if first != Byte.zero { skipDigits() }
        if current == UInt8(ascii: ".") {
            index += 1
            guard requireDigits() else { return nil }
        }
        if current == UInt8(ascii: "e") || current == UInt8(ascii: "E") {
            index += 1
            if current == UInt8(ascii: "+") || current == Byte.minus { index += 1 }
            guard requireDigits() else { return nil }
        }
        return .number(String(decoding: UnsafeBufferPointer(rebasing: bytes[start..<index]), as: UTF8.self))
    }

    private func isDigit(_ byte: UInt8) -> Bool { (Byte.zero...Byte.nine).contains(byte) }

    private mutating func skipDigits() {
        while let byte = current, isDigit(byte) { index += 1 }
    }

    /// `1*DIGIT` : au moins un chiffre.
    private mutating func requireDigits() -> Bool {
        let start = index
        skipDigits()
        return index > start
    }
}

/// Les octets structurants de la grammaire.
private enum Byte {
    static let openBrace = UInt8(ascii: "{")
    static let closeBrace = UInt8(ascii: "}")
    static let openBracket = UInt8(ascii: "[")
    static let closeBracket = UInt8(ascii: "]")
    static let quote = UInt8(ascii: "\"")
    static let backslash = UInt8(ascii: "\\")
    static let colon = UInt8(ascii: ":")
    static let comma = UInt8(ascii: ",")
    static let minus = UInt8(ascii: "-")
    static let zero = UInt8(ascii: "0")
    static let nine = UInt8(ascii: "9")
}
