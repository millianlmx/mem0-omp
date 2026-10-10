// La LECTURE des arguments d'un appel d'outil (visionneuse-appels-outils-lisibles,
// S-2 et S-4) : la source JSON (`ToolCallRow.argumentsJSON`, dans l'ordre du
// fichier) devient une liste de lignes « libellé : valeur » aplatie en
// profondeur, que les deux coques indentent par `depth`.
//
// Le classement de la source rend trois états : aucun argument, arguments
// illisibles (le texte d'origine reste consultable par le détail brut), ou des
// champs. Une valeur « code » (commande bash, contenu écrit, texte d'un edit,
// motif grep/glob — S-3) s'affiche à chasse fixe ; une valeur longue porte un
// EXTRAIT, la valeur complète s'ouvrant par « Afficher plus » (S-4).
//
// PURE : aucune E/S, aucun état ; Foundation seule.

import Foundation

/// Les arguments d'un appel, prêts à afficher en clé/valeur.
public struct ToolArguments: Equatable, Sendable {
    public enum Content: Equatable, Sendable {
        case none
        case unreadable
        case fields([ArgumentLine])
    }

    public let content: Content
    /// Texte du « détail brut » ; nil si et seulement si content == .none.
    public let raw: String?

    /// Le nombre maximal de lignes d'une valeur montrée entière (S-4).
    public static let excerptMaxLines = 4
    /// Le nombre maximal de caractères d'une valeur montrée entière (S-4).
    public static let excerptMaxCharacters = 280

    public init(tool: String, source: String) {
        guard let parsed = OrderedJSON.parse(source) else {
            self.init(content: .unreadable, raw: source)
            return
        }
        switch parsed {
        case .null:
            self.init(content: .none, raw: nil)
        case .object(let members):
            self.init(tool: tool, members: members, raw: source)
        case .string(let text):
            if text.allSatisfy(\.isWhitespace) {
                self.init(content: .none, raw: nil)
            } else if case .object(let members)? = OrderedJSON.parse(text) {
                self.init(tool: tool, members: members, raw: text)
            } else {
                self.init(content: .unreadable, raw: text)
            }
        case .array, .number, .bool:
            self.init(content: .unreadable, raw: source)
        }
    }

    private init(tool: String, members: [OrderedJSON.Member], raw: String) {
        if members.isEmpty {
            self.init(content: .none, raw: nil)
            return
        }
        var lines: [ArgumentLine] = []
        Self.flatten(members: members, tool: tool, path: "", depth: 0, into: &lines)
        self.init(content: .fields(lines), raw: raw)
    }

    private init(content: Content, raw: String?) {
        self.content = content
        self.raw = raw
    }

    /// L'extrait d'une valeur LONGUE (plus de `excerptMaxLines` lignes ou plus de
    /// `excerptMaxCharacters` caractères) : ses premières lignes, bornées en
    /// caractères, suivies de « … » ; `nil` pour une valeur montrée entière.
    /// Une fin de ligne CRLF compte pour UNE coupure (Doc D-4).
    public static func excerpt(of value: String) -> String? {
        let lines = value.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline)
        guard lines.count > excerptMaxLines || value.count > excerptMaxCharacters else { return nil }
        var head = lines.prefix(excerptMaxLines).joined(separator: "\n")
        if head.count > excerptMaxCharacters {
            head = String(head.prefix(excerptMaxCharacters))
        }
        return head + ToolArgumentsText.ellipsis
    }

    // MARK: - Aplatissement

    private static func flatten(
        members: [OrderedJSON.Member],
        tool: String,
        path: String,
        depth: Int,
        into lines: inout [ArgumentLine]
    ) {
        for (position, member) in members.enumerated() {
            append(
                member.value,
                label: ToolArgumentsText.label(tool: tool, key: member.key) ?? member.key,
                isCode: isCodeKey(tool: tool, key: member.key),
                tool: tool,
                id: identifier(path, position),
                depth: depth,
                into: &lines
            )
        }
    }

    private static func append(
        _ value: OrderedJSON,
        label: String,
        isCode: Bool,
        tool: String,
        id: String,
        depth: Int,
        into lines: inout [ArgumentLine]
    ) {
        switch value {
        case .object(let members) where !members.isEmpty:
            lines.append(ArgumentLine(id: id, depth: depth, label: label, value: .group))
            flatten(members: members, tool: tool, path: id, depth: depth + 1, into: &lines)
        case .array(let items) where !items.isEmpty:
            lines.append(ArgumentLine(id: id, depth: depth, label: label, value: .group))
            for (position, item) in items.enumerated() {
                // Un élément de liste hérite du caractère « code » de sa liste.
                append(
                    item,
                    label: String(position + 1),
                    isCode: isCode,
                    tool: tool,
                    id: identifier(id, position),
                    depth: depth + 1,
                    into: &lines
                )
            }
        case .object, .array:
            lines.append(ArgumentLine(id: id, depth: depth, label: label, value: .plain(ToolArgumentsText.empty)))
        case .bool(let flag):
            lines.append(
                ArgumentLine(id: id, depth: depth, label: label, value: .plain(flag ? ToolArgumentsText.yes : ToolArgumentsText.no))
            )
        case .null:
            lines.append(ArgumentLine(id: id, depth: depth, label: label, value: .plain(ToolArgumentsText.null)))
        case .number(let lexeme):
            lines.append(ArgumentLine(id: id, depth: depth, label: label, value: .plain(lexeme)))
        case .string(let text) where text.isEmpty:
            lines.append(ArgumentLine(id: id, depth: depth, label: label, value: .plain(ToolArgumentsText.empty)))
        case .string(let text):
            lines.append(ArgumentLine(id: id, depth: depth, label: label, value: isCode ? .code(text) : .plain(text)))
        }
    }

    private static func identifier(_ path: String, _ position: Int) -> String {
        path.isEmpty ? String(position) : path + "." + String(position)
    }

    // MARK: - Valeurs « code » (S-3)

    /// Vrai si la valeur de `key` est du code pour l'outil `tool` : elle
    /// s'affiche alors à chasse fixe. Le nom d'outil est comparé EXACTEMENT.
    static func isCodeKey(tool: String, key: String) -> Bool {
        codeKeys[tool]?.contains(key) ?? false
    }

    private static let codeKeys: [String: Set<String>] = [
        "write": ["content"],
        "edit": ["old_string", "new_string", "input", "diff"],
        "bash": ["command"],
        "grep": ["pattern"],
        "glob": ["path"],
    ]
}

/// Une ligne de la vue des arguments : un membre d'objet ou un élément de liste.
public struct ArgumentLine: Equatable, Sendable, Identifiable {
    /// Positions 0-based jointes par ".", ex. "0", "0.0", "0.0.1" : unique dans un appel.
    public let id: String
    /// 0 = membre de premier niveau.
    public let depth: Int
    /// Libellé français (S-3), clé brute, ou numéro "1", "2"… d'un élément de liste.
    public let label: String
    public let value: ArgumentValue
    /// L'extrait d'une valeur longue (S-4) ; toujours nil pour `.group`.
    public let excerpt: String?

    public init(id: String, depth: Int, label: String, value: ArgumentValue) {
        self.id = id
        self.depth = depth
        self.label = label
        self.value = value
        switch value {
        case .group: self.excerpt = nil
        case .plain(let text), .code(let text): self.excerpt = ToolArguments.excerpt(of: text)
        }
    }
}

/// La valeur d'une ligne d'arguments.
public enum ArgumentValue: Equatable, Sendable {
    /// Objet ou liste NON vide : ses enfants suivent, à `depth + 1`.
    case group
    /// Police système.
    case plain(String)
    /// Chasse fixe.
    case code(String)
}
