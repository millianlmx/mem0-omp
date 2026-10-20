// La valeur JSON générique, extraite de `SessionModel.swift` : elle est le socle
// partagé entre le lecteur de sessions et les modèles du magasin d'état (qui la
// manipulent tous deux), donc elle vit dans `ConsoleCore`.

/// Valeur JSON générique. Les arguments d'un appel d'outil sont exposés tels
/// quels, en dictionnaire : `JSONSerialization` ne garantit aucun ordre de clés
/// (Doc-4), donc aucun ordre n'est promis ici — c'est le rendu qui trie.
public indirect enum JSONValue: Equatable, Sendable {
    case object([String: JSONValue])
    case array([JSONValue])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
}

// MARK: - Codable

// La conformité est ÉCRITE, jamais synthétisée : la synthèse d'un `enum` à valeurs
// associées encode un objet interne (`{"object":{"_0":…}}`), alors que cette valeur
// est le JSON LUI-MÊME — un objet JSON s'encode en objet, une chaîne en chaîne.
// C'est ce qui permet à la charge utile d'une session de transporter les arguments
// d'un appel d'outil tels quels, sans les re-rendre en texte.
//
// `.number` reste un `Double` des deux côtés : le lecteur macOS lit déjà par
// `JSONSerialization` (donc tout nombre est un `Double`), et le serveur ré-encode le
// même `JSONValue`. Aucune distinction entier/décimal n'est promise.
extension JSONValue: Codable {
    /// La clé d'un objet JSON : son nom est le nom de la clé, il n'y a jamais de clé
    /// entière (un `CodingKey` ad hoc est donc indispensable, le nom des clés étant
    /// dynamique).
    private struct JSONCodingKey: CodingKey {
        let stringValue: String

        var intValue: Int? { nil }

        init(stringValue: String) {
            self.stringValue = stringValue
        }

        init?(intValue: Int) { nil }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        // L'ordre des essais est celui du JSON : nul, booléen, nombre, chaîne, puis
        // les conteneurs. `decodeNil` d'abord, sinon `null` serait vu comme une
        // absence de valeur par les essais suivants.
        if container.decodeNil() {
            self = .null
        } else if let flag = try? container.decode(Bool.self) {
            self = .bool(flag)
        } else if let number = try? container.decode(Double.self) {
            self = .number(number)
        } else if let text = try? container.decode(String.self) {
            self = .string(text)
        } else if let items = try? container.decode([JSONValue].self) {
            self = .array(items)
        } else if let members = try? container.decode([String: JSONValue].self) {
            self = .object(members)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "valeur JSON hors du socle (nul, booléen, nombre, chaîne, tableau, objet)"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .object(let members):
            var container = encoder.container(keyedBy: JSONCodingKey.self)
            for (key, value) in members {
                try container.encode(value, forKey: JSONCodingKey(stringValue: key))
            }
        case .array(let items):
            var container = encoder.unkeyedContainer()
            for item in items {
                try container.encode(item)
            }
        case .string(let text):
            var container = encoder.singleValueContainer()
            try container.encode(text)
        case .number(let number):
            var container = encoder.singleValueContainer()
            try container.encode(number)
        case .bool(let flag):
            var container = encoder.singleValueContainer()
            try container.encode(flag)
        case .null:
            var container = encoder.singleValueContainer()
            try container.encodeNil()
        }
    }
}
