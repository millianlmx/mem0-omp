// La coloration syntaxique de la visionneuse de code (S-18 R5) — fonctions PURES,
// testables sans vue, sans dépendance externe.
//
// C'est un découpage LEXICAL, pas une analyse : commentaires, chaînes, nombres,
// mots-clés, types (identifiant à majuscule initiale ou type natif), attributs
// (`@MainActor`, décorateurs Python, variables shell, clés YAML/JSON). Invariant :
// la concaténation des jetons rend EXACTEMENT le texte d'entrée.

import Foundation

enum CodeLanguage: Equatable, Sendable {
    case swift
    case typescript
    case python
    case shell
    case json
    case yaml
    case markdown
    case plain

    /// La langue d'un fichier, d'après son extension (ou son nom pour les fichiers
    /// de configuration du shell).
    static func from(path: String) -> CodeLanguage {
        let name = (path as NSString).lastPathComponent.lowercased()
        if shellNames.contains(name) { return .shell }
        let ext = (name as NSString).pathExtension
        return byExtension[ext] ?? .plain
    }

    /// La langue d'un bloc de code Markdown, d'après l'étiquette de sa clôture
    /// (« ```swift », « ```bash », « ```ts »).
    static func from(fence hint: String?) -> CodeLanguage {
        guard let hint = hint?.lowercased(), !hint.isEmpty else { return .plain }
        return byFenceName[hint] ?? byExtension[hint] ?? .plain
    }

    private static let shellNames: Set<String> = [
        ".zshrc", ".zprofile", ".zshenv", ".bashrc", ".bash_profile", ".profile",
    ]

    private static let byExtension: [String: CodeLanguage] = [
        "swift": .swift,
        "ts": .typescript, "tsx": .typescript, "mts": .typescript, "cts": .typescript,
        "js": .typescript, "jsx": .typescript, "mjs": .typescript, "cjs": .typescript,
        "py": .python, "pyi": .python,
        "sh": .shell, "bash": .shell, "zsh": .shell,
        "json": .json, "jsonl": .json,
        "yml": .yaml, "yaml": .yaml,
        "md": .markdown, "markdown": .markdown,
    ]

    private static let byFenceName: [String: CodeLanguage] = [
        "typescript": .typescript, "javascript": .typescript,
        "python": .python, "shell": .shell, "console": .shell,
    ]
}

enum CodeTokenKind: Equatable, Sendable {
    case keyword
    case string
    case comment
    case number
    case type
    case attribute
    case plain
}

struct CodeToken: Equatable, Sendable {
    let kind: CodeTokenKind
    let text: String
}

enum CodeHighlighter {
    /// Les jetons du texte. Un texte vide n'a aucun jeton ; une langue sans
    /// grammaire (texte brut, Markdown source) rend UN jeton `plain`.
    static func tokens(_ text: String, language: CodeLanguage) -> [CodeToken] {
        guard !text.isEmpty else { return [] }
        guard let grammar = CodeGrammar.of(language) else {
            return [CodeToken(kind: .plain, text: text)]
        }
        var lexer = CodeLexer(text: text, grammar: grammar)
        return lexer.run()
    }

    /// Les jetons répartis par ligne (les `\n` séparent les lignes et ne figurent
    /// dans aucune) : un commentaire ou une chaîne sur plusieurs lignes est coupé
    /// en autant de morceaux de même nature. Un texte de n sauts de ligne rend n+1
    /// lignes, une ligne vide ne porte aucun jeton.
    static func lines(_ tokens: [CodeToken]) -> [[CodeToken]] {
        var lines: [[CodeToken]] = [[]]
        for token in tokens {
            let pieces = token.text.split(separator: "\n", omittingEmptySubsequences: false)
            for (index, piece) in pieces.enumerated() {
                if index > 0 { lines.append([]) }
                if !piece.isEmpty {
                    lines[lines.count - 1].append(CodeToken(kind: token.kind, text: String(piece)))
                }
            }
        }
        return lines
    }
}

// MARK: - Grammaires

private struct CodeGrammar {
    struct Delimiter {
        let mark: String
        /// La chaîne peut-elle franchir un saut de ligne ?
        let multiline: Bool
        /// `\` échappe-t-il le caractère suivant ?
        let escapes: Bool
    }

    let lineComment: String?
    /// `#` ne commence un commentaire qu'en début de ligne ou après un blanc
    /// (shell, YAML : `$#`, `a#b` ne sont pas des commentaires).
    let commentNeedsBoundary: Bool
    let blockComment: (open: String, close: String)?
    /// Du plus long au plus court : `"""` avant `"`.
    let strings: [Delimiter]
    let keywords: Set<String>
    let builtinTypes: Set<String>
    let capitalizedAreTypes: Bool
    /// `@` suivi d'un identifiant : attribut ou décorateur.
    let atAttributes: Bool
    /// `#` suivi d'un identifiant : directive (`#if`, `#available`).
    let hashDirectives: Bool
    /// `$NOM`, `${…}` : variable du shell.
    let dollarVariables: Bool
    /// Une chaîne suivie de `:` est une clé (JSON, YAML).
    let quotedKeys: Bool
    /// Un mot nu en tête de ligne suivi de `:` est une clé (YAML).
    let bareKeys: Bool

    static func of(_ language: CodeLanguage) -> CodeGrammar? {
        switch language {
        case .swift: swift
        case .typescript: typescript
        case .python: python
        case .shell: shell
        case .json: json
        case .yaml: yaml
        case .markdown, .plain: nil
        }
    }

    private static func delimiter(_ mark: String, multiline: Bool = false, escapes: Bool = true) -> Delimiter {
        Delimiter(mark: mark, multiline: multiline, escapes: escapes)
    }

    static let swift = CodeGrammar(
        lineComment: "//", commentNeedsBoundary: false, blockComment: ("/*", "*/"),
        strings: [delimiter("\"\"\"", multiline: true), delimiter("\"")],
        keywords: [
            "actor", "any", "as", "associatedtype", "async", "await", "borrowing", "break", "case",
            "catch", "class", "consume", "consuming", "continue", "convenience", "default", "defer",
            "deinit", "didSet", "do", "dynamic", "else", "enum", "extension", "fallthrough", "false",
            "fileprivate", "final", "for", "func", "get", "guard", "if", "import", "in", "indirect",
            "init", "inout", "internal", "is", "isolated", "lazy", "let", "macro", "mutating", "nil",
            "nonisolated", "nonmutating", "open", "operator", "optional", "override", "package",
            "precedencegroup", "private", "protocol", "public", "repeat", "required", "rethrows",
            "return", "self", "Self", "sending", "set", "some", "static", "struct", "subscript",
            "super", "switch", "throw", "throws", "true", "try", "typealias", "unowned", "var",
            "weak", "where", "while", "willSet",
        ],
        builtinTypes: [], capitalizedAreTypes: true,
        atAttributes: true, hashDirectives: true, dollarVariables: false,
        quotedKeys: false, bareKeys: false
    )

    static let typescript = CodeGrammar(
        lineComment: "//", commentNeedsBoundary: false, blockComment: ("/*", "*/"),
        strings: [delimiter("\""), delimiter("'"), delimiter("`", multiline: true)],
        keywords: [
            "abstract", "as", "async", "await", "break", "case", "catch", "class", "const",
            "continue", "debugger", "declare", "default", "delete", "do", "else", "enum", "export",
            "extends", "false", "finally", "for", "from", "function", "if", "implements", "import",
            "in", "infer", "instanceof", "interface", "keyof", "let", "namespace", "new", "null",
            "private", "protected", "public", "readonly", "return", "satisfies", "static", "super",
            "switch", "this", "throw", "true", "try", "type", "typeof", "undefined", "var", "void",
            "while", "with", "yield",
        ],
        builtinTypes: [
            "any", "bigint", "boolean", "never", "number", "object", "string", "symbol", "unknown",
        ],
        capitalizedAreTypes: true,
        atAttributes: true, hashDirectives: false, dollarVariables: false,
        quotedKeys: false, bareKeys: false
    )

    static let python = CodeGrammar(
        lineComment: "#", commentNeedsBoundary: false, blockComment: nil,
        strings: [
            delimiter("\"\"\"", multiline: true), delimiter("'''", multiline: true),
            delimiter("\""), delimiter("'"),
        ],
        keywords: [
            "False", "None", "True", "and", "as", "assert", "async", "await", "break", "case",
            "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from",
            "global", "if", "import", "in", "is", "lambda", "match", "nonlocal", "not", "or",
            "pass", "raise", "return", "self", "try", "while", "with", "yield",
        ],
        builtinTypes: [
            "bool", "bytes", "dict", "float", "frozenset", "int", "list", "object", "set", "str",
            "tuple", "type",
        ],
        capitalizedAreTypes: true,
        atAttributes: true, hashDirectives: false, dollarVariables: false,
        quotedKeys: false, bareKeys: false
    )

    static let shell = CodeGrammar(
        lineComment: "#", commentNeedsBoundary: true, blockComment: nil,
        strings: [delimiter("\"", multiline: true), delimiter("'", multiline: true, escapes: false)],
        keywords: [
            "alias", "break", "case", "continue", "declare", "do", "done", "elif", "else", "esac",
            "eval", "exec", "exit", "export", "fi", "for", "function", "if", "in", "local",
            "readonly", "return", "select", "set", "shift", "source", "then", "time", "trap",
            "unset", "until", "while",
        ],
        builtinTypes: [], capitalizedAreTypes: false,
        atAttributes: false, hashDirectives: false, dollarVariables: true,
        quotedKeys: false, bareKeys: false
    )

    static let json = CodeGrammar(
        lineComment: nil, commentNeedsBoundary: false, blockComment: nil,
        strings: [delimiter("\"")],
        keywords: ["false", "null", "true"],
        builtinTypes: [], capitalizedAreTypes: false,
        atAttributes: false, hashDirectives: false, dollarVariables: false,
        quotedKeys: true, bareKeys: false
    )

    static let yaml = CodeGrammar(
        lineComment: "#", commentNeedsBoundary: true, blockComment: nil,
        strings: [delimiter("\""), delimiter("'", escapes: false)],
        keywords: ["false", "False", "null", "Null", "no", "true", "True", "yes", "~"],
        builtinTypes: [], capitalizedAreTypes: false,
        atAttributes: false, hashDirectives: false, dollarVariables: false,
        quotedKeys: true, bareKeys: true
    )
}

// MARK: - Le lexer

private struct CodeLexer {
    private let scalars: [Unicode.Scalar]
    private let grammar: CodeGrammar
    private var index = 0
    /// Rien que des blancs (et le tiret d'un élément YAML) depuis le dernier saut.
    private var atLineStart = true
    private var tokens: [CodeToken] = []

    init(text: String, grammar: CodeGrammar) {
        self.scalars = Array(text.unicodeScalars)
        self.grammar = grammar
    }

    mutating func run() -> [CodeToken] {
        while index < scalars.count {
            let start = index
            let kind = scanToken()
            emit(kind, from: start)
        }
        return tokens
    }

    // MARK: Un jeton

    /// Avance d'au moins un scalaire et rend la nature du morceau lu.
    private mutating func scanToken() -> CodeTokenKind {
        let scalar = scalars[index]

        if let block = grammar.blockComment, matches(block.open) {
            index += block.open.unicodeScalars.count
            while index < scalars.count, !matches(block.close) { index += 1 }
            index = min(scalars.count, index + block.close.unicodeScalars.count)
            return .comment
        }
        if let line = grammar.lineComment, matches(line),
           !grammar.commentNeedsBoundary || index == 0
               || isBlank(scalars[index - 1]) || scalars[index - 1] == "\n" {
            while index < scalars.count, scalars[index] != "\n" { index += 1 }
            return .comment
        }
        if let delimiter = grammar.strings.first(where: { matches($0.mark) }) {
            scanString(delimiter)
            return grammar.quotedKeys && followedByColon() ? .attribute : .string
        }
        if grammar.bareKeys, atLineStart, let end = bareKeyEnd() {
            index = end
            return .attribute
        }
        if isDigit(scalar), index == 0 || !isIdentifier(scalars[index - 1]) {
            scanNumber()
            return .number
        }
        if isIdentifierStart(scalar) {
            let word = scanWord()
            if grammar.keywords.contains(word) { return .keyword }
            if grammar.builtinTypes.contains(word) { return .type }
            if grammar.capitalizedAreTypes, word.unicodeScalars.first.map(isUppercase) == true {
                return .type
            }
            return .plain
        }
        if grammar.atAttributes, scalar == "@", next(isIdentifierStart) {
            index += 1
            _ = scanWord()
            return .attribute
        }
        if grammar.hashDirectives, scalar == "#", next(isIdentifierStart) {
            index += 1
            _ = scanWord()
            return .keyword
        }
        if grammar.dollarVariables, scalar == "$", index + 1 < scalars.count {
            scanVariable()
            return .attribute
        }
        if scalar == "~", grammar.keywords.contains("~") {
            index += 1
            return .keyword
        }
        index += 1
        return .plain
    }

    private mutating func scanString(_ delimiter: CodeGrammar.Delimiter) {
        let mark = delimiter.mark
        index += mark.unicodeScalars.count
        while index < scalars.count {
            if delimiter.escapes, scalars[index] == "\\" {
                index = min(scalars.count, index + 2)
                continue
            }
            if matches(mark) {
                index += mark.unicodeScalars.count
                return
            }
            // Une chaîne d'une ligne non fermée s'arrête au saut de ligne.
            if !delimiter.multiline, scalars[index] == "\n" { return }
            index += 1
        }
    }

    /// Chiffres, lettres (hexadécimal, exposant, suffixe), `_` et un point suivi
    /// d'un chiffre (`1.5` mais pas `0..<n`).
    private mutating func scanNumber() {
        index += 1
        while index < scalars.count {
            let scalar = scalars[index]
            if isIdentifier(scalar) {
                index += 1
            } else if scalar == ".", next(isDigit) {
                index += 1
            } else {
                break
            }
        }
    }

    private mutating func scanWord() -> String {
        let start = index
        while index < scalars.count, isIdentifier(scalars[index]) { index += 1 }
        return string(from: start)
    }

    /// `$NOM`, `${…}`, `$1`, `$?`, `$#`…
    private mutating func scanVariable() {
        index += 1
        let scalar = scalars[index]
        if scalar == "{" {
            while index < scalars.count, scalars[index] != "}", scalars[index] != "\n" { index += 1 }
            if index < scalars.count, scalars[index] == "}" { index += 1 }
        } else if isIdentifierStart(scalar) {
            _ = scanWord()
        } else if !isBlank(scalar), scalar != "\n" {
            index += 1
        }
    }

    /// La fin d'une clé YAML nue (`nom:` suivi d'un blanc ou de la fin de ligne).
    private func bareKeyEnd() -> Int? {
        let scalar = scalars[index]
        guard !isBlank(scalar), scalar != "\n", scalar != "-", scalar != "#",
              scalar != "\"", scalar != "'" else { return nil }
        var cursor = index
        while cursor < scalars.count, scalars[cursor] != "\n", scalars[cursor] != "#" {
            if scalars[cursor] == ":" {
                let after = cursor + 1
                if after == scalars.count || isBlank(scalars[after]) || scalars[after] == "\n" {
                    return cursor
                }
            }
            cursor += 1
        }
        return nil
    }

    // MARK: Émission

    /// Ajoute le morceau lu ; deux morceaux `plain` voisins fusionnent.
    private mutating func emit(_ kind: CodeTokenKind, from start: Int) {
        let text = string(from: start)
        updateLineStart(from: start)
        if kind == .plain, let last = tokens.last, last.kind == .plain {
            tokens[tokens.count - 1] = CodeToken(kind: .plain, text: last.text + text)
        } else {
            tokens.append(CodeToken(kind: kind, text: text))
        }
    }

    private mutating func updateLineStart(from start: Int) {
        for position in start..<index {
            let scalar = scalars[position]
            if scalar == "\n" {
                atLineStart = true
            } else if !(isBlank(scalar) || (scalar == "-" && atLineStart)) {
                atLineStart = false
            }
        }
    }

    // MARK: Outils

    private func string(from start: Int) -> String {
        var view = String.UnicodeScalarView()
        view.append(contentsOf: scalars[start..<index])
        return String(view)
    }

    private func matches(_ mark: String) -> Bool {
        var cursor = index
        for scalar in mark.unicodeScalars {
            guard cursor < scalars.count, scalars[cursor] == scalar else { return false }
            cursor += 1
        }
        return true
    }

    private func next(_ predicate: (Unicode.Scalar) -> Bool) -> Bool {
        index + 1 < scalars.count && predicate(scalars[index + 1])
    }

    private func followedByColon() -> Bool {
        var cursor = index
        while cursor < scalars.count, isBlank(scalars[cursor]) { cursor += 1 }
        return cursor < scalars.count && scalars[cursor] == ":"
    }

    private func isBlank(_ scalar: Unicode.Scalar) -> Bool {
        scalar == " " || scalar == "\t" || scalar == "\r"
    }

    private func isDigit(_ scalar: Unicode.Scalar) -> Bool {
        ("0"..."9").contains(scalar)
    }

    private func isUppercase(_ scalar: Unicode.Scalar) -> Bool {
        scalar.properties.isUppercase
    }

    private func isIdentifierStart(_ scalar: Unicode.Scalar) -> Bool {
        scalar == "_" || scalar.properties.isAlphabetic
    }

    private func isIdentifier(_ scalar: Unicode.Scalar) -> Bool {
        isIdentifierStart(scalar) || isDigit(scalar)
    }
}
